/**
 * Coverage tests for planboard.ts — targets the currently-uncovered LOGIC that the
 * happy-path suite (planboard.test.ts) leaves out:
 *   • safeJsonArray catch → fallback on a malformed stored JSON column          (69-70)
 *   • parsePlan resultText JSON fallback (structuredOutput absent)             (192-197)
 *   • handleRunTerminal error branches: failed run / no plan / dup ids / cycle (251-268)
 *   • create() launch-throw catch resolves the draft to error + rethrows       (323-325)
 *   • POST /plan route catch → statusCode + {error}                            (429-431)
 *   • GET /api/plans/:id 404 path                                              (445-447)
 *
 * Real/behavioral: every case drives real inputs (raw rows, real planner subprocesses
 * via mock-claude fixtures, real route injects) and asserts the resulting draft
 * state / HTTP status / error text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── DB isolation + mock-claude wiring (BEFORE importing any src module) ─────────
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-covplan-'));
process.env.CLAUDE_BIN = join(repoRoot, 'tools', 'mock-claude.mjs');
process.env.MOCK_DELAY_MS = '0';
process.env.FLEET_OTEL = '0';

let app: any;
let PORT: number;
let registry: any;
let db: any;
let projectsRepo: any;
let kanbanRepo: any;
let planboardRepo: any;

const repoDirs: string[] = [];
let fixtureDir: string;
const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ registry } = await import('../src/registry.js'));
  db = (await import('../src/db.js')).default;
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  ({ planboardRepo } = await import('../src/planboard.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
  fixtureDir = mkdtempSync(join(tmpdir(), 'fleet-covplan-fixtures-'));
});

afterAll(async () => {
  await app?.close();
  for (const d of [...repoDirs, fixtureDir, process.env.FLEET_DATA_DIR!]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── git fixture (real repo so registry.launch's cwd check + project create pass) ──
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-covplan-repo-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}
// Paused project: planning is allowed under pause; pm.tick no-ops so apply never spawns.
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

/** Resolve once the terminal for a specific run id has fired (planboard's handler is
 *  registered at boot BEFORE this one, so the draft is already resolved here). */
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

/** Write a one-line stream-json fixture and return its ABSOLUTE path (mock-claude
 *  accepts absolute MOCK_PLAN_FIXTURE values). The result event drives the planner
 *  terminal; supply structuredOutput XOR a JSON-string result to hit each parse path. */
function writeFixture(
  name: string,
  resultEvent: Record<string, unknown>,
): string {
  const initLine = {
    type: 'system',
    subtype: 'init',
    cwd: '/tmp',
    session_id: '00000000-0000-0000-0000-000000000000',
    model: 'claude-opus-4-8',
    uuid: 'init',
  };
  const path = join(fixtureDir, `${name}.jsonl`);
  writeFileSync(path, JSON.stringify(initLine) + '\n' + JSON.stringify(resultEvent) + '\n');
  return path;
}

/** Launch a planning run whose terminal output comes from `fixturePath`, then wait
 *  for the planner terminal and return the (now-resolved) draft. */
async function planWithFixture(projectId: string, objective: string, fixturePath: string): Promise<any> {
  const prev = process.env.MOCK_PLAN_FIXTURE;
  process.env.MOCK_PLAN_FIXTURE = fixturePath;
  try {
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan`,
        headers: H(),
        payload: { objective },
      })
    ).json();
    await awaitTerminal(created.orchestratorRunId);
    return planboardRepo.get(created.id);
  } finally {
    if (prev === undefined) delete process.env.MOCK_PLAN_FIXTURE;
    else process.env.MOCK_PLAN_FIXTURE = prev;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// safeJsonArray catch → fallback (lines 69-70) via a malformed stored column
// ════════════════════════════════════════════════════════════════════════════
describe('rowToDraft tolerates malformed JSON columns (safeJsonArray fallback)', () => {
  it('returns [] for appliedCardIds and null-safe plan when the stored JSON is corrupt', () => {
    const project = makeProject();
    const id = `corrupt-${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    // Write a row DIRECTLY with invalid JSON in both array columns (bypassing the repo
    // mappers that would serialize valid JSON) so JSON.parse throws → catch → fallback.
    db.prepare(
      `INSERT INTO plan_drafts
        (id, project_id, objective, target_column, status, orchestrator_run_id, plan, error, applied_card_ids, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, project.id, 'corrupt row', 'Ready', 'ready', null, '{not json', null, 'definitely[not]json', now, now);

    const draft = planboardRepo.get(id)!;
    expect(draft).toBeTruthy();
    expect(draft.appliedCardIds).toEqual([]); // corrupt applied_card_ids → fallback []
    expect(draft.plan).toEqual([]); // corrupt plan parsed via safeJsonArray → fallback []
  });

  it('also recovers an unparseable target_column to the default Ready', () => {
    const project = makeProject();
    const id = `badcol-${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO plan_drafts
        (id, project_id, objective, target_column, status, orchestrator_run_id, plan, error, applied_card_ids, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, project.id, 'bad col', 'NotAColumn', 'ready', null, null, null, '[]', now, now);
    const draft = planboardRepo.get(id)!;
    expect(draft.targetColumn).toBe('Ready'); // KANBAN_COLS.has(...) false → default
  });
});

// ════════════════════════════════════════════════════════════════════════════
// handleRunTerminal — error branches driven by real planner terminals (251-268)
// + parsePlan resultText JSON fallback (192-197)
// ════════════════════════════════════════════════════════════════════════════
describe('handleRunTerminal resolves a draft to error on a bad/failed planner run', () => {
  it('flips to error when the planner run FAILS (error result + non-zero exit)', async () => {
    const project = makeProject();
    // is_error:true sets resultError; with a non-zero exit, onExit derives status 'failed'.
    const fx = writeFixture('failed-run', {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'the planner crashed',
      session_id: '00000000-0000-0000-0000-000000000000',
      total_cost_usd: 0.0,
      uuid: 'res',
    });
    const prevExit = process.env.MOCK_EXIT_CODE;
    process.env.MOCK_EXIT_CODE = '1';
    let draft: any;
    try {
      draft = await planWithFixture(project.id, 'will fail', fx);
    } finally {
      if (prevExit === undefined) delete process.env.MOCK_EXIT_CODE;
      else process.env.MOCK_EXIT_CODE = prevExit;
    }
    // run.status !== 'completed' branch (251-253): error = run.error || `planner ${status}`.
    expect(draft.status).toBe('error');
    expect(draft.error).toBeTruthy();
    expect(draft.error).toMatch(/failed|planner|crashed/i);
  });

  it('flips to error when a completed run carries NO usable plan (empty tasks)', async () => {
    const project = makeProject();
    // structured_output present but tasks empty → parsePlan returns null → "no usable plan"
    const fx = writeFixture('empty-plan', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      structured_output: { tasks: [] },
      session_id: '00000000-0000-0000-0000-000000000000',
      total_cost_usd: 0.01,
      uuid: 'res',
    });
    const draft = await planWithFixture(project.id, 'no plan', fx);
    expect(draft.status).toBe('error'); // 255-258
    expect(draft.error).toBe('planner produced no usable plan');
  });

  it('parses a plan from resultText JSON when structuredOutput is absent (parsePlan fallback)', async () => {
    const project = makeProject();
    // No structured_output; result is a JSON STRING → parsePlan's resultText branch (192-197).
    const planJson = JSON.stringify({
      tasks: [
        { id: 't1', title: 'Root', prompt: 'do root', dependsOn: [] },
        { id: 't2', title: 'Leaf', prompt: 'do leaf', dependsOn: ['t1'] },
      ],
    });
    const fx = writeFixture('resulttext-plan', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planJson, // a JSON string, NOT structured_output
      session_id: '00000000-0000-0000-0000-000000000000',
      total_cost_usd: 0.01,
      uuid: 'res',
    });
    const draft = await planWithFixture(project.id, 'resulttext path', fx);
    expect(draft.status).toBe('ready'); // parsed from resultText → valid DAG → ready
    expect(draft.error).toBeNull();
    expect(draft.plan).toHaveLength(2);
    expect(draft.plan.map((t: any) => t.id)).toEqual(['t1', 't2']);
    expect(draft.plan.find((t: any) => t.id === 't2').dependsOn).toEqual(['t1']);
  });

  it('flips to error when the resultText is non-JSON (parsePlan JSON.parse catch → null)', async () => {
    const project = makeProject();
    const fx = writeFixture('garbage-result', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'this is not json at all', // JSON.parse throws → plan = null → no usable plan
      session_id: '00000000-0000-0000-0000-000000000000',
      total_cost_usd: 0.01,
      uuid: 'res',
    });
    const draft = await planWithFixture(project.id, 'garbage', fx);
    expect(draft.status).toBe('error');
    expect(draft.error).toBe('planner produced no usable plan');
  });

  it('flips to error on a plan with DUPLICATE task ids (planHasDupIds)', async () => {
    const project = makeProject();
    const fx = writeFixture('dup-plan', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      structured_output: {
        tasks: [
          { id: 't1', title: 'A', prompt: 'a', dependsOn: [] },
          { id: 't1', title: 'dup', prompt: 'dup', dependsOn: [] },
        ],
      },
      session_id: '00000000-0000-0000-0000-000000000000',
      total_cost_usd: 0.01,
      uuid: 'res',
    });
    const draft = await planWithFixture(project.id, 'dup ids', fx);
    expect(draft.status).toBe('error'); // 261-264
    expect(draft.error).toBe('plan has duplicate task ids');
  });

  it('flips to error on a plan whose DAG has a CYCLE (planHasCycle)', async () => {
    const project = makeProject();
    const fx = writeFixture('cycle-plan', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      structured_output: {
        tasks: [
          { id: 't1', title: 'A', prompt: 'a', dependsOn: ['t2'] },
          { id: 't2', title: 'B', prompt: 'b', dependsOn: ['t1'] },
        ],
      },
      session_id: '00000000-0000-0000-0000-000000000000',
      total_cost_usd: 0.01,
      uuid: 'res',
    });
    const draft = await planWithFixture(project.id, 'cycle', fx);
    expect(draft.status).toBe('error'); // 265-268
    expect(draft.error).toBe('plan has a dependency cycle');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// create() launch-throw catch (323-325) + POST /plan route catch (429-431)
// ════════════════════════════════════════════════════════════════════════════
describe('POST /plan surfaces a synchronous launch failure as an error + resolves the draft', () => {
  it('a project whose rootDir is gone → launch throws 400 → draft error + route {error}', async () => {
    const project = makeProject();
    // Remove the project's worktree so registry.launch's cwd guard throws synchronously.
    rmSync(project.rootDir, { recursive: true, force: true });

    const before = planboardRepo.list(project.id).length;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/plan`,
      headers: H(),
      payload: { objective: 'launch will throw' },
    });
    // route catch maps statusCode (400) and returns {error}  (429-431)
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Working directory does not exist/i);

    // create()'s catch resolved the already-inserted draft to 'error' (323-325), not wedged 'planning'.
    const drafts = planboardRepo.list(project.id);
    expect(drafts.length).toBe(before + 1);
    const draft = drafts[0];
    expect(draft.status).toBe('error');
    expect(draft.error).toMatch(/Working directory does not exist/i);
    expect(draft.orchestratorRunId).toBeNull(); // never got a run id
  });

  it('POST /plan with an unknown project → route catch maps the 404 statusCode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/no-such-project/plan`,
      headers: H(),
      payload: { objective: 'whatever' },
    });
    expect(res.statusCode).toBe(404); // create throws 404 before insert → route catch (429-431)
    expect(res.json().error).toMatch(/project not found/i);
  });

  it('POST /plan with a blank objective → 400 from create, surfaced by the route catch', async () => {
    const project = makeProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/plan`,
      headers: H(),
      payload: { objective: '   ' }, // trims to '' → 400 'objective is required'
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/objective is required/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/plans/:id 404 path (445-447)
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/plans/:id', () => {
  it('returns 404 + {error} for an unknown draft id', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/plans/does-not-exist`, headers: H() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('plan draft not found');
  });
});
