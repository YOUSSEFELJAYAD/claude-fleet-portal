import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── DB isolation + mock-claude wiring ──────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR / CLAUDE_BIN at load).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-plan-'));
// SPIKE-VERIFIED (yes-fixture): CLAUDE_BIN=mock-claude spawns, replays the orchestrator-plan
// fixture (3 tasks, t3 depends on t1+t2), and lands structuredOutput on the run terminal —
// driving the planning run end to end with zero spend, exactly like the spec's "existing
// mock-claude plan fixture (deterministic)" requirement (§4 #3).
process.env.CLAUDE_BIN = join(repoRoot, 'tools', 'mock-claude.mjs');
process.env.MOCK_DELAY_MS = '0';
process.env.FLEET_OTEL = '0';

let app: any;
let PORT: number;
let registry: any;
let repo: any;
let projectsRepo: any;
let kanbanRepo: any;
let planboardRepo: any;

const repoDirs: string[] = [];
const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  ({ planboardRepo } = await import('../src/planboard.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const d of repoDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── git fixture (real repo so registry.launch's cwd check + projectsRepo create pass) ──
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-plan-repo-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}
// A PAUSED project: planning + apply are allowed under pause (gating applies to execution),
// and pm.tick no-ops on a paused project — so apply→Ready can never spawn a stray build run.
function makeProject(patch: Partial<any> = {}): any {
  const root = makeRepo('p');
  const p = projectsRepo.createProject({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    rootDir: root,
    defaultBranch: 'master',
    wipLimit: 3,
    ...patch,
  });
  return projectsRepo.updateProject(p.id, { paused: true });
}

/** Await the next terminal for a specific run id (used to know when the planner finished). */
function awaitTerminal(runId: string): Promise<any> {
  return new Promise((resolve) => {
    const off = registry.onRunTerminal((run: any) => {
      if (run.id === runId) {
        off();
        resolve(run);
      }
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// plan → draft → orchestrator terminal yields a parseable plan → apply → cards
// ════════════════════════════════════════════════════════════════════════════
describe('plan-board happy path (yes-fixture: mock-claude drives the planner)', () => {
  it('POST /plan creates a planning draft and launches the orchestrator run', async () => {
    const project = makeProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/plan`,
      headers: H(),
      payload: { objective: 'Build a thing in three steps' },
    });
    expect(res.statusCode).toBe(200);
    const draft = res.json();
    expect(draft.id).toBeTruthy();
    expect(draft.projectId).toBe(project.id);
    expect(draft.targetColumn).toBe('Ready'); // default
    expect(draft.orchestratorRunId).toBeTruthy();
    // the planning run carries campaignId:null (partition) — assert it on the launched run.
    const run = registry.getRun(draft.orchestratorRunId);
    expect(run.campaignId).toBeNull();
  });

  it('the orchestrator terminal flips the draft to ready with the parsed DAG', async () => {
    const project = makeProject();
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/plan`,
        headers: H(),
        payload: { objective: 'Decompose me' },
      })
    ).json();

    await awaitTerminal(created.orchestratorRunId);

    const res = await app.inject({ method: 'GET', url: `/api/plans/${created.id}`, headers: H() });
    expect(res.statusCode).toBe(200);
    const draft = res.json();
    expect(draft.status).toBe('ready');
    expect(draft.error).toBeNull();
    expect(draft.plan).toHaveLength(3); // orchestrator-plan fixture: t1, t2, t3
    const ids = draft.plan.map((t: any) => t.id);
    expect(ids).toEqual(['t1', 't2', 't3']);
    // t3 depends on the two roots — a real DAG, not a flat list.
    const t3 = draft.plan.find((t: any) => t.id === 't3');
    expect(t3.dependsOn.sort()).toEqual(['t1', 't2']);
  });

  it('POST /apply creates one Ready card per task with depends_on mapped from the DAG edges', async () => {
    const project = makeProject();
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/plan`,
        headers: H(),
        payload: { objective: 'apply me' },
      })
    ).json();
    await awaitTerminal(created.orchestratorRunId);

    const applyRes = await app.inject({ method: 'POST', url: `/api/plans/${created.id}/apply`, headers: H(), payload: {} });
    expect(applyRes.statusCode).toBe(200);
    const applied = applyRes.json();
    expect(applied.status).toBe('applied');
    expect(applied.appliedCardIds).toHaveLength(3);

    const cards = kanbanRepo.listTasks(project.id);
    expect(cards).toHaveLength(3);
    for (const c of cards) {
      expect(c.column).toBe('Ready');
    }
    // the dependent card's depends_on points at the two ROOT cards' real ids (not plan ids t1/t2).
    const byTitle = new Map(cards.map((c: any) => [c.title, c]));
    const t1Card = byTitle.get('Research the existing architecture') as any;
    const t2Card = byTitle.get('Audit accessibility') as any;
    const t3Card = byTitle.get('Implement the fix') as any;
    expect(t1Card).toBeTruthy();
    expect(t3Card.dependsOn.sort()).toEqual([t1Card.id, t2Card.id].sort());
    // root cards carry no deps.
    expect(t1Card.dependsOn).toEqual([]);
    expect(t2Card.dependsOn).toEqual([]);
    // the created cards' depends_on is a VALID graph in kanban's own validator (no cycle/dup).
  });

  it('apply is idempotent: re-applying returns the same cards without creating duplicates', async () => {
    const project = makeProject();
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/plan`,
        headers: H(),
        payload: { objective: 'idempotent' },
      })
    ).json();
    await awaitTerminal(created.orchestratorRunId);

    const first = (await app.inject({ method: 'POST', url: `/api/plans/${created.id}/apply`, headers: H(), payload: {} })).json();
    const second = (await app.inject({ method: 'POST', url: `/api/plans/${created.id}/apply`, headers: H(), payload: {} })).json();
    expect(second.status).toBe('applied');
    expect(second.appliedCardIds.sort()).toEqual(first.appliedCardIds.sort());
    // no second batch of cards.
    expect(kanbanRepo.listTasks(project.id)).toHaveLength(3);
  });

  it('supports a targetColumn override on create and lists a project\'s drafts', async () => {
    const project = makeProject();
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/plan`,
        headers: H(),
        payload: { objective: 'into backlog', targetColumn: 'Backlog' },
      })
    ).json();
    expect(created.targetColumn).toBe('Backlog');
    await awaitTerminal(created.orchestratorRunId);
    await app.inject({ method: 'POST', url: `/api/plans/${created.id}/apply`, headers: H(), payload: {} });
    const cards = kanbanRepo.listTasks(project.id);
    expect(cards.every((c: any) => c.column === 'Backlog')).toBe(true);

    const list = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/plans`, headers: H() })).json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// apply re-validation — cycle / dup rejection (seed a ready draft directly)
// ════════════════════════════════════════════════════════════════════════════
describe('apply re-validates the plan graph (cycle / dup rejection)', () => {
  function seedReadyDraft(projectId: string, plan: any[]): any {
    const now = Date.now();
    return planboardRepo.insert({
      id: `seed-${Math.random().toString(36).slice(2, 9)}`,
      projectId,
      objective: 'seeded',
      targetColumn: 'Ready',
      status: 'ready',
      orchestratorRunId: null,
      plan,
      error: null,
      appliedCardIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  it('rejects (400) a plan whose DAG contains a cycle and creates NO cards', async () => {
    const project = makeProject();
    const draft = seedReadyDraft(project.id, [
      { id: 't1', title: 'A', prompt: 'a', dependsOn: ['t2'] },
      { id: 't2', title: 'B', prompt: 'b', dependsOn: ['t1'] },
    ]);
    const res = await app.inject({ method: 'POST', url: `/api/plans/${draft.id}/apply`, headers: H(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('cycle');
    expect(kanbanRepo.listTasks(project.id)).toHaveLength(0);
    expect(planboardRepo.get(draft.id)!.status).toBe('ready'); // not flipped to applied
  });

  it('rejects (400) a plan with duplicate task ids and creates NO cards', async () => {
    const project = makeProject();
    const draft = seedReadyDraft(project.id, [
      { id: 't1', title: 'A', prompt: 'a', dependsOn: [] },
      { id: 't1', title: 'dup', prompt: 'dup', dependsOn: [] },
    ]);
    const res = await app.inject({ method: 'POST', url: `/api/plans/${draft.id}/apply`, headers: H(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('duplicate');
    expect(kanbanRepo.listTasks(project.id)).toHaveLength(0);
  });

  it('rejects (409) apply on a draft that is not ready', async () => {
    const project = makeProject();
    const now = Date.now();
    const draft = planboardRepo.insert({
      id: `seed-planning-${Math.random().toString(36).slice(2, 9)}`,
      projectId: project.id,
      objective: 'still planning',
      targetColumn: 'Ready',
      status: 'planning',
      orchestratorRunId: null,
      plan: null,
      error: null,
      appliedCardIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const res = await app.inject({ method: 'POST', url: `/api/plans/${draft.id}/apply`, headers: H(), payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it('accepts an edited subset of tasks on apply (override the stored plan)', async () => {
    const project = makeProject();
    const draft = seedReadyDraft(project.id, [
      { id: 't1', title: 'A', prompt: 'a', dependsOn: [] },
      { id: 't2', title: 'B', prompt: 'b', dependsOn: ['t1'] },
      { id: 't3', title: 'C', prompt: 'c', dependsOn: ['t2'] },
    ]);
    // apply only t1 + t2 (drop t3); t2's dep on t1 still maps.
    const res = await app.inject({
      method: 'POST',
      url: `/api/plans/${draft.id}/apply`,
      headers: H(),
      payload: { tasks: [{ id: 't1', title: 'A', prompt: 'a', dependsOn: [] }, { id: 't2', title: 'B', prompt: 'b', dependsOn: ['t1'] }] },
    });
    expect(res.statusCode).toBe(200);
    const cards = kanbanRepo.listTasks(project.id);
    expect(cards).toHaveLength(2);
    const a = cards.find((c: any) => c.title === 'A')!;
    const b = cards.find((c: any) => c.title === 'B')!;
    expect(b.dependsOn).toEqual([a.id]);
  });

  it('drops a dangling dependency when its target task is removed from the applied subset', async () => {
    const project = makeProject();
    const draft = seedReadyDraft(project.id, [
      { id: 't1', title: 'A', prompt: 'a', dependsOn: [] },
      { id: 't2', title: 'B', prompt: 'b', dependsOn: ['t1'] },
    ]);
    // apply ONLY t2 (drop t1, which t2 depends on): the dep on the now-absent t1 must be
    // filtered out (planIds.has filter), leaving t2's card with no deps — not a dangling/unknown ref.
    const res = await app.inject({
      method: 'POST',
      url: `/api/plans/${draft.id}/apply`,
      headers: H(),
      payload: { tasks: [{ id: 't2', title: 'B', prompt: 'b', dependsOn: ['t1'] }] },
    });
    expect(res.statusCode).toBe(200);
    const cards = kanbanRepo.listTasks(project.id);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('B');
    expect(cards[0].dependsOn).toEqual([]); // t1 dropped → dep filtered, no dangling id
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3.7 PARTITION INVARIANT — a planning run is claimed by NO other engine
// ════════════════════════════════════════════════════════════════════════════
describe('§3.7 partition invariant — planning run touches neither campaign nor pm', () => {
  it('a planning run produces no campaign_tasks row and is claimed by neither engine', async () => {
    const db = (await import('../src/db.js')).default;
    const { campaigns } = await import('../src/campaigns.js');

    const campaignTasksBefore = (db.prepare('SELECT COUNT(*) AS n FROM campaign_tasks').get() as any).n;
    const campaignsBefore = repo.listCampaigns().length;

    const project = makeProject();
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/plan`,
        headers: H(),
        payload: { objective: 'partition check' },
      })
    ).json();
    const runId = created.orchestratorRunId;

    // the run carries campaignId:null (so campaigns.ts no-ops) and no card (so pm.ts no-ops).
    const run = registry.getRun(runId);
    expect(run.campaignId).toBeNull();

    await awaitTerminal(runId);

    // 1) the planboard claimed it → draft is ready.
    expect(planboardRepo.get(created.id)!.status).toBe('ready');
    // 2) NO campaign row was created by the planning run.
    expect(repo.listCampaigns().length).toBe(campaignsBefore);
    // 3) NO campaign_tasks row was created.
    const campaignTasksAfter = (db.prepare('SELECT COUNT(*) AS n FROM campaign_tasks').get() as any).n;
    expect(campaignTasksAfter).toBe(campaignTasksBefore);
    // 4) the campaign engine does not recognize the run (getCampaign on a null/orchestrator id is empty).
    expect(campaigns.view(runId)).toBeNull();
    // 5) the PM's getTaskByRunId does NOT match it (no kanban card links to a planning run).
    expect(kanbanRepo.getTaskByRunId(runId)).toBeNull();
    // 6) §3.7 (#4): the campaign-card resolver does NOT match the planning run either — a planning
    //    run carries campaignId:null and no card links a campaign_id to it.
    expect(kanbanRepo.getTaskByCampaignId(runId)).toBeNull();
  });
});
