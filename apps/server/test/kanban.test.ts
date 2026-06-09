import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js, which reads
// FLEET_DATA_DIR at module-load) is imported. All src imports are lazy (in beforeAll).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-kanban-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let app: any;
let PORT: number;
let kanban: any; // src/kanban.js module namespace
let kanbanRepo: any;
let projectsRepo: any;
let pm: any;

const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;

  // Import the PM singleton and NO-OP every method the kanban routes fire into. The routes
  // compute all of their logic (title/deps/column/409 gate/attemptCount/lastError/rank) BEFORE
  // the `void pm.*` call, so pm is a collaborator, not the module under test. Stubbing it (a) makes
  // a card that reaches Ready under a real project never spawn claude via launchBuild, and (b)
  // removes the async git merge (`void pm.approve`) that would otherwise mutate cards in the DB
  // after our assertions return. Same property-reassign seam campaigns.test.ts uses on registry.stop.
  ({ pm } = await import('../src/pm.js'));
  pm.tick = async () => {};
  pm.approve = async () => {};
  pm.requestChanges = () => {};
  pm.cancel = () => {};

  ({ projectsRepo } = await import('../src/projects.js'));
  kanban = await import('../src/kanban.js');
  ({ kanbanRepo } = kanban);

  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// A project is required first. With pm stubbed, rootDir need not be a real git repo —
// projectsRepo.createProject does not validate it; the kanban route never touches it.
function makeProject(): string {
  const p = projectsRepo.createProject({ name: 'kanban-test-' + randomUUID().slice(0, 8), rootDir: '/tmp' });
  return p.id;
}

async function createCardViaRoute(pid: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/projects/${pid}/tasks`, headers: H(), payload: body });
}

// ── W1: lexorank primitive (rankBetween is exported) ──────────────────────────
describe('W1 — lexorank rankBetween() yields a key strictly between neighbours', () => {
  it('first card in an empty column gets the window midpoint "U"', () => {
    // rankAfter(null) === FIRST === 'U'; rankBetween(null, null) hits the same midpoint window.
    expect(kanban.rankBetween(null, null)).toBe('U');
  });

  it('appending after the last rank produces a strictly-greater key (end-of-column)', () => {
    const after = kanban.rankBetween('U', null);
    expect(after > 'U').toBe(true);
  });

  it('between two ordered keys returns a key strictly between them (string compare)', () => {
    const a = 'U';
    const b = kanban.rankBetween('U', null); // some key > U
    const mid = kanban.rankBetween(a, b);
    expect(a < mid).toBe(true);
    expect(mid < b).toBe(true);
  });

  it('LENGTHENS rather than colliding when neighbours are adjacent (no char between)', () => {
    // 'a' and 'b' are adjacent ASCII codes → must descend a level → 'aU'.
    const mid = kanban.rankBetween('a', 'b');
    expect(mid).toBe('aU');
    expect('a' < mid).toBe(true);
    expect(mid < 'b').toBe(true);
  });
});

// ── W1: create defaults + persistence ─────────────────────────────────────────
describe('W1 — createTask defaults (Backlog / idle / end-of-column rank) + persistence', () => {
  it('first card defaults to Backlog/idle/rank "U" and the documented field defaults', () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'first card' });
    expect(card.column).toBe('Backlog');
    expect(card.executionPhase).toBe('idle');
    expect(card.rank).toBe('U'); // first card in a fresh column
    expect(card.attemptCount).toBe(0);
    expect(card.maxAttempts).toBe(3);
    expect(card.assignee).toBe('human');
    expect(card.dependsOn).toEqual([]);
    expect(card.labels).toEqual([]);
    expect(card.priority).toBe(0);
    expect(card.runId).toBeNull();
    expect(card.campaignId).toBeNull();
  });

  it('a second card in the same column is appended at the END (rank strictly greater)', () => {
    const pid = makeProject();
    const a = kanbanRepo.createTask({ projectId: pid, title: 'a' });
    const b = kanbanRepo.createTask({ projectId: pid, title: 'b' });
    expect(a.rank).toBe('U');
    expect(b.rank > a.rank).toBe(true); // end-of-column append
  });

  it('persists across a fresh kanbanRepo read (real DB round-trip via getTaskStmt)', () => {
    const pid = makeProject();
    const created = kanbanRepo.createTask({
      projectId: pid,
      title: 'persist me',
      description: 'desc',
      acceptanceCriteria: 'ac',
      validationCommand: 'npm test',
      priority: 3,
      maxAttempts: 5,
      budgetUsd: 2.5,
    });
    const reread = kanbanRepo.getTask(created.id);
    expect(reread).not.toBeNull();
    expect(reread.id).toBe(created.id);
    expect(reread.projectId).toBe(pid);
    expect(reread.title).toBe('persist me');
    expect(reread.description).toBe('desc');
    expect(reread.acceptanceCriteria).toBe('ac');
    expect(reread.validationCommand).toBe('npm test');
    expect(reread.priority).toBe(3);
    expect(reread.maxAttempts).toBe(5);
    expect(reread.budgetUsd).toBe(2.5);
    expect(reread.column).toBe('Backlog');
    expect(reread.rank).toBe('U');
  });
});

// ── W1: create via the route ──────────────────────────────────────────────────
describe('W1 — POST /api/projects/:pid/tasks (create via the route)', () => {
  it('creates with defaults and returns the persisted card', async () => {
    const pid = makeProject();
    const res = await createCardViaRoute(pid, { title: 'route card' });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.id).toBeTruthy();
    expect(card.projectId).toBe(pid); // taken from URL, never body
    expect(card.column).toBe('Backlog');
    expect(card.executionPhase).toBe('idle');
    expect(card.rank).toBe('U');
    expect(card.attemptCount).toBe(0);
    expect(card.maxAttempts).toBe(3);
    // round-trips through the DB
    expect(kanbanRepo.getTask(card.id)).not.toBeNull();
  });

  it('rejects an empty title with 400', async () => {
    const pid = makeProject();
    const res = await createCardViaRoute(pid, { title: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/title/i);
  });

  it('honours an explicit valid column from the body', async () => {
    const pid = makeProject();
    const res = await createCardViaRoute(pid, { title: 'ready card', column: 'Ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().column).toBe('Ready');
  });
});

// ── v2 foundation: new kanban columns round-trip + defaults ───────────────────
describe('v2 foundation — new kanban columns round-trip + defaults', () => {
  it('applies v1-equivalent defaults for every new column on create (route → GET)', async () => {
    const pid = makeProject();
    const res = await createCardViaRoute(pid, { title: 'v2-defaults' });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    // #4
    expect(card.mode).toBe('single');
    // #2
    expect(card.prUrl).toBeNull();
    expect(card.prState).toBeNull();
    // #5
    expect(card.serverStartCommand).toBeNull();
    expect(card.healthCheckUrl).toBeNull();
    expect(card.healthCheckRegex).toBeNull();
    // #9
    expect(card.resolveAttemptCount).toBe(0);
    expect(card.maxResolveAttempts).toBe(2);

    // round-trips through the DB (rowToTask) too.
    const reread = kanbanRepo.getTask(card.id);
    expect(reread.mode).toBe('single');
    expect(reread.maxResolveAttempts).toBe(2);
    expect(reread.resolveAttemptCount).toBe(0);
  });

  it('round-trips explicit create-request mirrors (mode/server overrides/maxResolveAttempts)', async () => {
    const pid = makeProject();
    const res = await createCardViaRoute(pid, {
      title: 'v2-explicit',
      mode: 'campaign',
      serverStartCommand: 'pnpm dev',
      healthCheckUrl: 'http://127.0.0.1:$PORT/',
      healthCheckRegex: 'listening',
      maxResolveAttempts: 5,
    });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.mode).toBe('campaign');
    expect(card.serverStartCommand).toBe('pnpm dev');
    expect(card.healthCheckUrl).toBe('http://127.0.0.1:$PORT/');
    expect(card.healthCheckRegex).toBe('listening');
    expect(card.maxResolveAttempts).toBe(5);
    // persisted via rowToTask/taskToRow.
    const reread = kanbanRepo.getTask(card.id);
    expect(reread.mode).toBe('campaign');
    expect(reread.serverStartCommand).toBe('pnpm dev');
    expect(reread.maxResolveAttempts).toBe(5);
  });

  it('PUT patches per-card server overrides + maxResolveAttempts and persists', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'v2-put' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${card.id}`,
      headers: H(),
      payload: { serverStartCommand: 'make run', healthCheckUrl: 'http://localhost/h', maxResolveAttempts: 3 },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.serverStartCommand).toBe('make run');
    expect(out.healthCheckUrl).toBe('http://localhost/h');
    expect(out.maxResolveAttempts).toBe(3);
    const reread = kanbanRepo.getTask(card.id);
    expect(reread.serverStartCommand).toBe('make run');
    expect(reread.maxResolveAttempts).toBe(3);
  });

  it('mode is editable in Backlog but immutable once out of Backlog (409)', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'mode-edit' }); // Backlog
    const ok = await app.inject({ method: 'PUT', url: `/api/tasks/${card.id}`, headers: H(), payload: { mode: 'campaign' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mode).toBe('campaign');

    // move it out of Backlog, then attempting to switch mode is rejected.
    kanbanRepo.updateTask(card.id, { column: 'InProgress' });
    const rej = await app.inject({ method: 'PUT', url: `/api/tasks/${card.id}`, headers: H(), payload: { mode: 'single' } });
    expect(rej.statusCode).toBe(409);
    expect(kanbanRepo.getTask(card.id).mode).toBe('campaign'); // unchanged
  });
});

// ── W1: edit content fields ───────────────────────────────────────────────────
describe('W1 — PUT /api/tasks/:id edits content fields', () => {
  it('patches title / description / acceptanceCriteria / validationCommand / priority / labels', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'orig' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${card.id}`,
      headers: H(),
      payload: {
        title: 'edited',
        description: 'new description',
        acceptanceCriteria: 'new ac',
        validationCommand: 'pnpm test',
        priority: 4,
        labels: ['bug', 'urgent'],
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.title).toBe('edited');
    expect(out.description).toBe('new description');
    expect(out.acceptanceCriteria).toBe('new ac');
    expect(out.validationCommand).toBe('pnpm test');
    expect(out.priority).toBe(4);
    expect(out.labels).toEqual(['bug', 'urgent']);
    // updatedAt bumped, immutable fields preserved
    expect(out.id).toBe(card.id);
    expect(out.projectId).toBe(pid);
    expect(out.createdAt).toBe(card.createdAt);
    // persisted
    expect(kanbanRepo.getTask(card.id).title).toBe('edited');
  });

  it('rejects an empty title on edit with 400 and 404 for a missing card', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'keep' });
    const empty = await app.inject({ method: 'PUT', url: `/api/tasks/${card.id}`, headers: H(), payload: { title: '  ' } });
    expect(empty.statusCode).toBe(400);
    expect(kanbanRepo.getTask(card.id).title).toBe('keep'); // unchanged
    const missing = await app.inject({ method: 'PUT', url: `/api/tasks/${randomUUID()}`, headers: H(), payload: { title: 'x' } });
    expect(missing.statusCode).toBe(404);
  });

  it('clears validationCommand when set to null', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'vc', validationCommand: 'a' });
    const res = await app.inject({ method: 'PUT', url: `/api/tasks/${card.id}`, headers: H(), payload: { validationCommand: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().validationCommand).toBeNull();
  });
});

// ── W1: move column ───────────────────────────────────────────────────────────
describe('W1 — PUT /api/tasks/:id move column', () => {
  it('moves a card to a new column and appends it to the end of that column', async () => {
    const pid = makeProject();
    // seed two cards already in Ready so the moved card must land AFTER them.
    const r1 = kanbanRepo.createTask({ projectId: pid, title: 'ready1', column: 'Ready' });
    const r2 = kanbanRepo.createTask({ projectId: pid, title: 'ready2', column: 'Ready' });
    const mover = kanbanRepo.createTask({ projectId: pid, title: 'mover' }); // Backlog

    const res = await app.inject({ method: 'PUT', url: `/api/tasks/${mover.id}`, headers: H(), payload: { column: 'Ready' } });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.column).toBe('Ready');
    // appended to the end → rank strictly greater than both existing Ready ranks.
    expect(out.rank > r1.rank).toBe(true);
    expect(out.rank > r2.rank).toBe(true);
    expect(kanbanRepo.getTask(mover.id).column).toBe('Ready');
  });
});

// ── W1: reorder via beforeId/afterId yields a rank strictly between neighbours ──
describe('W1 — PUT /api/tasks/:id reorder via beforeId/afterId', () => {
  it('places the moved card strictly between the two neighbour ranks (lexorank)', async () => {
    const pid = makeProject();
    // three cards in Backlog in rank order A < B < C
    const A = kanbanRepo.createTask({ projectId: pid, title: 'A' });
    const B = kanbanRepo.createTask({ projectId: pid, title: 'B' });
    const C = kanbanRepo.createTask({ projectId: pid, title: 'C' });
    expect(A.rank < B.rank).toBe(true);
    expect(B.rank < C.rank).toBe(true);

    // Move C to sit between A and B. Route semantics: rank = rankBetween(beforeRank, afterRank),
    // so beforeId = the lower-rank neighbour (A), afterId = the higher-rank neighbour (B).
    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${C.id}`,
      headers: H(),
      payload: { beforeId: A.id, afterId: B.id },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(A.rank < out.rank).toBe(true);
    expect(out.rank < B.rank).toBe(true);
    expect(kanbanRepo.getTask(C.id).rank).toBe(out.rank); // persisted
  });
});

// ── W1: listing is ordered ────────────────────────────────────────────────────
describe('W1 — listTasks ordering', () => {
  it('orders cards within a column by rank ascending', () => {
    const pid = makeProject();
    const a = kanbanRepo.createTask({ projectId: pid, title: 'a', column: 'Ready' });
    const b = kanbanRepo.createTask({ projectId: pid, title: 'b', column: 'Ready' });
    const c = kanbanRepo.createTask({ projectId: pid, title: 'c', column: 'Ready' });
    const ready = kanbanRepo.listTasks(pid).filter((t: any) => t.column === 'Ready');
    expect(ready.map((t: any) => t.id)).toEqual([a.id, b.id, c.id]);
    // and ranks are strictly ascending
    for (let i = 1; i < ready.length; i++) {
      expect(ready[i - 1].rank < ready[i].rank).toBe(true);
    }
  });

  it('GET /api/projects/:pid/tasks returns the same ordered list, scoped to the project', async () => {
    const pid = makeProject();
    const a = kanbanRepo.createTask({ projectId: pid, title: 'a', column: 'Ready' });
    const b = kanbanRepo.createTask({ projectId: pid, title: 'b', column: 'Ready' });
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/tasks`, headers: H() });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((t: any) => t.id);
    expect(ids).toEqual([a.id, b.id]); // dedicated pid → no pollution from other tests
  });
});

// ── W1: depends_on validation REJECTS self / unknown / cycle with 400 ──────────
describe('W1 — validateDependsOn rejects self-dep, unknown-id, and cycles with 400', () => {
  it('rejects an unknown dependency id on create (POST) with 400', async () => {
    const pid = makeProject();
    const res = await createCardViaRoute(pid, { title: 'dep on nothing', dependsOn: ['does-not-exist'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown dependency/i);
  });

  it('accepts a valid dependency on an existing card (positive path, 200)', async () => {
    const pid = makeProject();
    const a = await (await createCardViaRoute(pid, { title: 'A' })).json();
    const res = await createCardViaRoute(pid, { title: 'B', dependsOn: [a.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().dependsOn).toEqual([a.id]);
  });

  it('rejects a self-dependency via PUT with 400', async () => {
    const pid = makeProject();
    const x = kanbanRepo.createTask({ projectId: pid, title: 'X' });
    const res = await app.inject({ method: 'PUT', url: `/api/tasks/${x.id}`, headers: H(), payload: { dependsOn: [x.id] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cannot depend on itself/i);
    expect(kanbanRepo.getTask(x.id).dependsOn).toEqual([]); // unchanged
  });

  it('rejects a dependency cycle via PUT with 400', async () => {
    const pid = makeProject();
    // A, then B depends on A (valid). Now make A depend on B → cycle A→B→A.
    const a = await (await createCardViaRoute(pid, { title: 'A' })).json();
    const bRes = await createCardViaRoute(pid, { title: 'B', dependsOn: [a.id] });
    expect(bRes.statusCode).toBe(200);
    const b = bRes.json();
    const res = await app.inject({ method: 'PUT', url: `/api/tasks/${a.id}`, headers: H(), payload: { dependsOn: [b.id] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cycle/i);
    expect(kanbanRepo.getTask(a.id).dependsOn).toEqual([]); // unchanged
  });
});

// ── W1: Review actions ────────────────────────────────────────────────────────
describe('W1 — Review actions (approve / request-changes)', () => {
  it('approve acts only on a Review card (409 otherwise) and sets phase=merging', async () => {
    const pid = makeProject();
    // not in Review → 409
    const backlog = kanbanRepo.createTask({ projectId: pid, title: 'backlog' });
    const reject = await app.inject({ method: 'POST', url: `/api/tasks/${backlog.id}/approve`, headers: H() });
    expect(reject.statusCode).toBe(409);

    // in Review → 200 + phase merging
    const review = kanbanRepo.createTask({ projectId: pid, title: 'in review' });
    kanbanRepo.updateTask(review.id, { column: 'Review' });
    const ok = await app.inject({ method: 'POST', url: `/api/tasks/${review.id}/approve`, headers: H() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().executionPhase).toBe('merging');
    expect(ok.json().column).toBe('Review');
  });

  it('approve on a missing card returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${randomUUID()}/approve`, headers: H() });
    expect(res.statusCode).toBe(404);
  });

  it('request-changes increments attemptCount, stashes the comment in lastError, moves to InProgress', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'needs work' });
    kanbanRepo.updateTask(card.id, { column: 'Review' });
    const before = kanbanRepo.getTask(card.id);
    expect(before.attemptCount).toBe(0);

    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${card.id}/request-changes`,
      headers: H(),
      payload: { comment: 'please fix the tests' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.column).toBe('InProgress');
    expect(out.executionPhase).toBe('idle');
    expect(out.attemptCount).toBe(before.attemptCount + 1);
    expect(out.lastError).toContain('[human request-changes]');
    expect(out.lastError).toContain('please fix the tests');
    // persisted
    const reread = kanbanRepo.getTask(card.id);
    expect(reread.column).toBe('InProgress');
    expect(reread.attemptCount).toBe(1);
  });

  it('request-changes only acts on a Review card (409 otherwise) and 404 for missing', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'not in review' }); // Backlog
    const reject = await app.inject({ method: 'POST', url: `/api/tasks/${card.id}/request-changes`, headers: H(), payload: { comment: 'x' } });
    expect(reject.statusCode).toBe(409);
    expect(kanbanRepo.getTask(card.id).attemptCount).toBe(0); // untouched

    const missing = await app.inject({ method: 'POST', url: `/api/tasks/${randomUUID()}/request-changes`, headers: H(), payload: {} });
    expect(missing.statusCode).toBe(404);
  });
});

// ── W1: board pub/sub (synchronous, no SSE timing) ────────────────────────────
describe('W1 — subscribeBoard emits synchronously', () => {
  it('sends board-hello immediately, then a task frame on createTask (both synchronous)', () => {
    const pid = makeProject();
    const seed = kanbanRepo.createTask({ projectId: pid, title: 'seed' });
    const msgs: any[] = [];
    const unsub = kanban.subscribeBoard(pid, (m: any) => msgs.push(m));
    // board-hello arrives synchronously inside subscribeBoard, with a snapshot of existing cards.
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('board-hello');
    expect(msgs[0].tasks.map((t: any) => t.id)).toContain(seed.id);

    // a subsequent create broadcasts a `task` frame synchronously to the subscriber.
    const fresh = kanbanRepo.createTask({ projectId: pid, title: 'fresh' });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].kind).toBe('task');
    expect(msgs[1].task.id).toBe(fresh.id);

    // unsubscribe stops further frames.
    unsub();
    kanbanRepo.createTask({ projectId: pid, title: 'after unsub' });
    expect(msgs).toHaveLength(2);
  });
});
