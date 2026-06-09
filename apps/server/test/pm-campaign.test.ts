import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── DB isolation + mock-claude wiring ──────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR / CLAUDE_BIN at load).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pmcamp-'));
// yes-fixture (mockDrivesCampaign): CLAUDE_BIN=mock-claude spawns real runs. The orchestrator run
// carries --json-schema → mock replays orchestrator-plan.jsonl (3 tasks, t3 after t1+t2). Campaign
// WORKER runs have no schema → MOCK_FIXTURE=worker → worker.jsonl completes cleanly. So a whole
// campaign-per-card drives orchestrator → 3 workers → finalize(completed) with zero spend.
process.env.CLAUDE_BIN = join(repoRoot, 'tools', 'mock-claude.mjs');
process.env.MOCK_FIXTURE = 'worker';
process.env.MOCK_DELAY_MS = '0';
process.env.FLEET_OTEL = '0';

let app: any;
let PORT: number;
let registry: any;
let projectsRepo: any;
let kanbanRepo: any;
let campaigns: any;
let disallowedToolsForProject: any;

const repoDirs: string[] = [];
const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ registry } = await import('../src/registry.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  ({ campaigns } = await import('../src/campaigns.js'));
  ({ disallowedToolsForProject } = await import('../src/pm.js'));
  const { buildServer } = await import('../src/server.js');
  // buildServer() calls campaigns.init() AND pm.init() — the latter installs the onCampaignTerminal
  // subscription this whole feature rides on. (We deliberately do NOT use the pm.test.ts harness:
  // it stubs registry.launch globally, which would defeat the real mock-claude spawn.)
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
  const dir = mkdtempSync(join(tmpdir(), `fleet-pmcamp-repo-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}
// A NON-paused project so pm.tick() actually launches the campaign on card create. autoMerge:false
// (default) → a validated card parks in Review for a human (the gate we assert).
function makeProject(patch: Partial<any> = {}): any {
  const root = makeRepo('p');
  return projectsRepo.createProject({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    rootDir: root,
    defaultBranch: 'master',
    autoMerge: false,
    wipLimit: 5,
    ...patch,
  });
}

/** Poll the card until `pred` holds or the deadline passes. The validate→gate pipeline runs in
 *  void'd async work AFTER the campaign terminal fires, so we cannot await a single run terminal —
 *  we poll the card's column. */
async function waitForCard(cardId: string, pred: (c: any) => boolean, ms = 4000): Promise<any> {
  const deadline = Date.now() + ms;
  for (;;) {
    const c = kanbanRepo.getTask(cardId);
    if (c && pred(c)) return c;
    if (Date.now() > deadline) return c; // return last seen for a useful assertion failure
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function createCard(projectId: string, body: Record<string, unknown>): Promise<any> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/tasks`,
    headers: H(),
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

// ════════════════════════════════════════════════════════════════════════════
// #4 — campaign-per-card: launch → drive → gate ONCE (yes-fixture, mock-claude)
// ════════════════════════════════════════════════════════════════════════════
describe('campaign-per-card end-to-end (yes-fixture)', () => {
  it('a campaign-mode Ready card launches a campaign (campaign_id set, run_id null), runs to completion, and routes through validateAndGate → Review', async () => {
    const project = makeProject();
    const card = await createCard(project.id, {
      title: 'campaign card',
      description: 'do it as a campaign',
      acceptanceCriteria: 'all subtasks complete',
      mode: 'campaign',
      column: 'Ready',
    });

    // 1) launchBuild branched on mode==='campaign' → started a campaign scoped to THIS card:
    //    campaign_id set (NOT run_id), InProgress/building, worktree named for the card.
    const launched = await waitForCard(card.id, (c) => c.campaignId != null, 4000);
    expect(launched.campaignId).toBeTruthy();
    expect(launched.runId).toBeNull(); // a campaign-mode card links by campaign_id, never run_id
    expect(launched.worktreeName).toBe(`task-${card.id}`);
    const campaignId = launched.campaignId as string;

    // the campaign is scoped to the card: project + worktree cwd + UNRELAXED deny-list + perm mode.
    const camp = campaigns.view(campaignId)!;
    expect(camp.projectId).toBe(project.id);
    expect(camp.cwd).toContain(`task-${card.id}`); // the card's OWN worktree, not project root
    expect(camp.disallowedTools).toContain('Bash(git push *)'); // workers never push (unrelaxed)
    expect(camp.disallowedTools).toContain('Bash(git remote *)');
    expect(camp.permissionMode).toBe('bypassPermissions'); // non-interactive workers don't stall

    // 2) the whole campaign runs to completion and the card lands in Review (auto_merge off → human gate).
    const gated = await waitForCard(card.id, (c) => c.column === 'Review');
    expect(gated.column).toBe('Review');
    expect(gated.executionPhase).toBe('idle'); // parked for human approve (not 'merging' yet)

    // the campaign itself finished 'completed' (orchestrator → 3 workers → finalize), proving the
    // mock drove a MULTI-task campaign, not just the orchestrator.
    const done = campaigns.view(campaignId)!;
    expect(done.status).toBe('completed');
    expect(done.taskCount).toBe(3); // orchestrator-plan fixture: t1, t2, t3
    expect(done.doneCount).toBe(3);

    // 3) gated EXACTLY ONCE, not per worker: 3 worker runs carried the campaignId (escaping the PM
    //    run-terminal gate), yet the card hit Review a single time with attemptCount still 0.
    const workerRuns = registry.listRuns().filter((r: any) => r.campaignId === campaignId);
    expect(workerRuns.length).toBeGreaterThanOrEqual(4); // 1 orchestrator + 3 workers
    expect(gated.attemptCount).toBe(0); // never reworked → one clean pass through validateAndGate

    // 4) getTaskByCampaignId resolves the owning card.
    expect(kanbanRepo.getTaskByCampaignId(campaignId)!.id).toBe(card.id);
  }, 15000);

  it('§3.4 SECURITY: campaign workers keep the push/remote deny-list EVEN when the project has pushEnabled (no relaxation leak)', async () => {
    // The discriminating case: a project with pushEnabled:true (single-mode build/fix WOULD get the
    // relaxed list). launchCampaignBuild must force the UNRELAXED list for the campaign so workers can
    // never push — the engine pushes as fleet-pm. With pushEnabled:false the relaxed/unrelaxed lists are
    // identical, so only pushEnabled:true actually exercises the override.
    const project = makeProject({ pushEnabled: true });
    // sanity: single-mode WOULD be relaxed for this project (the boundary we must NOT cross for workers).
    expect(disallowedToolsForProject(project)).not.toContain('Bash(git push *)');

    const card = await createCard(project.id, {
      title: 'campaign on a push-enabled project',
      description: 'workers must still be push-denied',
      mode: 'campaign',
      column: 'Ready',
    });
    const launched = await waitForCard(card.id, (c) => c.campaignId != null, 4000);
    const camp = campaigns.view(launched.campaignId as string)!;
    // workers STILL get both denies despite project.pushEnabled — the relaxation never leaks to campaigns.
    expect(camp.disallowedTools).toContain('Bash(git push *)');
    expect(camp.disallowedTools).toContain('Bash(git remote *)');
  }, 15000);

  it('§3.7 partition: getTaskByCampaignId never matches a falsy id (a #3 planning run / single card)', () => {
    // a planning run / single-mode card carries campaign_id null → getTaskByCampaignId('') is null.
    expect(kanbanRepo.getTaskByCampaignId('')).toBeNull();
    expect(kanbanRepo.getTaskByCampaignId('no-such-campaign')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SINGLE-MODE UNAFFECTED — one build run on the RUN-terminal partition, NO campaign
// ════════════════════════════════════════════════════════════════════════════
// NOTE: the FULL single-mode validate→gate→merge over a real worktree is exhaustively covered in
// pm.test.ts (pre-built worktrees + pm.approve). mock-claude does not honor `claude --worktree`
// (it neither creates the worktree dir nor commits files), so a single-mode E2E driven by mock
// cannot reach Review (ensureCommitted has no worktree to commit). Here we lock the part #4 could
// regress: the launch PARTITION — a single card still launches exactly ONE build run with
// campaign_id null + run_id set, the run is NOT a campaign run (campaignId null → campaigns.ts
// no-ops on it), and #4 creates NO campaign for it.
describe('single-mode cards are unaffected by #4 (launch partition)', () => {
  it('a single-mode (default) Ready card launches ONE build run with campaign_id null + run_id set, and creates no campaign', async () => {
    const project = makeProject();
    const campaignsBefore = campaigns.list().length;
    const card = await createCard(project.id, {
      title: 'single card',
      acceptanceCriteria: 'build it',
      // mode omitted → defaults to 'single'
      column: 'Ready',
    });

    // single mode: ONE build run (run_id set), campaign_id stays null (the v1 path, unchanged).
    const launched = await waitForCard(card.id, (c) => c.runId != null, 4000);
    expect(launched.runId).toBeTruthy();
    expect(launched.campaignId).toBeNull(); // partition: PM single owns campaignId==null + run_id
    expect(launched.mode).toBe('single');
    expect(launched.worktreeName).toBe(`task-${card.id}`);

    // the build run carries campaignId:null (so campaigns.ts no-ops on its terminal) + the project.
    const run = registry.getRun(launched.runId);
    expect(run.campaignId).toBeNull();
    expect(run.projectId).toBe(project.id);

    // #4 created NO campaign for a single-mode card, and getTaskByCampaignId can't reach it.
    expect(campaigns.list().length).toBe(campaignsBefore);
    expect(kanbanRepo.getTaskByCampaignId(launched.runId)).toBeNull(); // run_id is not a campaign id
  }, 15000);
});

// ════════════════════════════════════════════════════════════════════════════
// MODE IMMUTABILITY — mode can only change while the card is in Backlog
// ════════════════════════════════════════════════════════════════════════════
describe('mode is immutable once the card leaves Backlog (#4)', () => {
  it('PUT mode on a Backlog card succeeds; PUT mode on a non-Backlog card → 409', async () => {
    const project = makeProject({ paused: true } as any);
    // paused project so the Ready card is NOT picked up — isolates the mode-edit gate.
    projectsRepo.updateProject(project.id, { paused: true });

    // a Backlog card: mode IS editable.
    const backlog = await createCard(project.id, { title: 'editable mode', mode: 'single', column: 'Backlog' });
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${backlog.id}`,
      headers: H(),
      payload: { mode: 'campaign' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mode).toBe('campaign');

    // a non-Backlog card (Ready): mode edit is rejected 409.
    const ready = await createCard(project.id, { title: 'locked mode', mode: 'single', column: 'Ready' });
    const blocked = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${ready.id}`,
      headers: H(),
      payload: { mode: 'campaign' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain('Backlog');
    // mode unchanged.
    expect(kanbanRepo.getTask(ready.id)!.mode).toBe('single');
  });
});
