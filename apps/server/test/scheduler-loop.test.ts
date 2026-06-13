/**
 * Slice 04 — scheduler loop_id extension.
 * 1. POST /api/schedules accepts loop_id and round-trips it on the view (loopId).
 * 2. A due schedule with loop_id calls loops.fire(loopId), NOT registry.launch.
 * 3. A loop with no work (hasWork=false) is skipped but next_fire_at still advances.
 * 4. A cap-rethrowing loop fire (429 / daily-cap) does NOT advance next_fire_at (retries next tick).
 * 5. POST with an unknown loop_id → 400 (validation).
 * 6. run-now on a loop schedule calls loops.fire (not registry.launch).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-sched-loop-'));

let app: any;
let PORT: number;
let __tickForTests: typeof import('../src/scheduler.js').__tickForTests;
let registry: typeof import('../src/registry.js').registry;
let loops: typeof import('../src/loops.js').loops;
let loopsRepo: typeof import('../src/loops.js').loopsRepo;

const H = () => ({ host: `127.0.0.1:${PORT}` });

/** Minimal loop record insert — bypasses POST /api/loops validation for test isolation. */
function seedLoop(db: any, id: string) {
  db.prepare(`
    INSERT OR IGNORE INTO loops
      (id, name, project_id, kind, control_plane, schedule_id, contract, mode,
       consecutive_good_runs, escalation_threshold, merge_posture, review_policy,
       risk_rubric, routable_ceiling, enabled, last_run_id, last_eval, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, `test-loop-${id}`, 'proj-test', 'worker', 'board', null,
    JSON.stringify({ job: 'test', inputs: '', allowed: [], forbidden: [], output: '', evaluation: '' }),
    'dry-run', 0, 3, 'human-gate', 'always', '[]', 'low', 1, null, null, null, Date.now(),
  );
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ __tickForTests } = await import('../src/scheduler.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ loops, loopsRepo } = await import('../src/loops.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();

  // Seed all loop IDs used across these tests so loop_id validation passes.
  const scheduleDb = (await import('../src/db.js')).default;
  for (const id of ['loop-abc', 'loop-fires', 'loop-empty', 'loop-429', 'loop-daily-cap', 'loop-runnow']) {
    seedLoop(scheduleDb, id);
  }
});

afterAll(async () => {
  await app?.close();
});

// Restore every spy after each test so a singleton stub (loops.fire/hasWork, registry.launch)
// never bleeds into a later test — guaranteed even if a test throws before an inline restore.
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Fix 2: unknown loop_id → 400 ──────────────────────────────────────────────
describe('schedule POST — unknown loop_id → 400', () => {
  it('POST with a loop_id that does not reference an existing loop returns 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'bad-loop-sched',
        recurrence: 'every:15',
        loop_id: 'does-not-exist-ever',
        launch_request: { prompt: 'unused', cwd: '/tmp' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not found/);
  });
});

describe('schedule loop_id — CRUD round-trip', () => {
  it('POST with loop_id stores it and returns loopId on the view', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'loop-sched',
        recurrence: 'every:15',
        loop_id: 'loop-abc',
        launch_request: { prompt: 'ignored for loop schedules', cwd: '/tmp' },
      },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.loopId).toBe('loop-abc');
    expect(s.recurrence).toBe('every:15');
  });

  it('LIST includes loopId key (null for non-loop rows)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/schedules', headers: H() });
    expect(res.statusCode).toBe(200);
    for (const s of res.json()) {
      expect('loopId' in s).toBe(true);
    }
  });
});

// ── Tick fires loops.fire(loopId) for a loop-targeted, due schedule ────────────
describe('tick() — loop-targeted schedule fires loops.fire, not registry.launch', () => {
  it('a due loop schedule with work calls loops.fire(loopId) and advances next_fire_at', async () => {
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'tick-loop-fires',
        recurrence: 'every:15',
        loop_id: 'loop-fires',
        launch_request: { prompt: 'unused', cwd: '/tmp' },
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
    const before = now - 1000;

    // Spy: loop has work, and capture the fired loop id. registry.launch must NOT be called.
    let firedLoopId: string | null = null;
    const hasWorkSpy = vi.spyOn(loops, 'hasWork').mockImplementation(async (lid: string) => lid === 'loop-fires');
    const fireSpy = vi.spyOn(loops, 'fire').mockImplementation(async (lid: string) => { firedLoopId = lid; });
    const launchSpy = vi.spyOn(registry, 'launch').mockImplementation((() => ({ id: 'should-not-happen' })) as any);

    await __tickForTests();

    expect(firedLoopId).toBe('loop-fires');
    expect(hasWorkSpy).toHaveBeenCalledWith('loop-fires');
    expect(fireSpy).toHaveBeenCalledWith('loop-fires');
    expect(launchSpy).not.toHaveBeenCalled();
    const after = (scheduleDb.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any);
    expect(after.next_fire_at).toBeGreaterThan(before); // cadence advanced from NOW
    expect(after.last_run_id).toBeNull(); // loop fires don't set a scheduler run id
  });
});

// ── An empty-work loop is skipped but the cadence still advances ───────────────
describe('tick() — empty-work loop schedule is skipped (no fire) but advances cadence', () => {
  it('hasWork=false: loops.fire is NOT called, yet next_fire_at advances so it retries next cadence', async () => {
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'tick-loop-empty',
        recurrence: 'every:15',
        loop_id: 'loop-empty',
        launch_request: { prompt: 'unused', cwd: '/tmp' },
        enabled: true,
      },
    });
    const id = create.json().id;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
    const before = now - 1000;

    vi.spyOn(loops, 'hasWork').mockImplementation(async () => false); // no work
    const fireSpy = vi.spyOn(loops, 'fire').mockImplementation(async () => {});

    await __tickForTests();

    expect(fireSpy).not.toHaveBeenCalled(); // skipped — no spend
    const after = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
    expect(after).toBeGreaterThan(before); // advanced normally — retries next cadence
  });
});

// ── A cap-rethrowing loop fire defers the cadence (capBlocked path) ────────────
describe('tick() — loop fire cap rethrow does NOT advance next_fire_at', () => {
  it('429 from loops.fire: next_fire_at + last_fired_at unchanged (retry next tick)', async () => {
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'tick-loop-429',
        recurrence: 'every:15',
        loop_id: 'loop-429',
        launch_request: { prompt: 'unused', cwd: '/tmp' },
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
    const before = (scheduleDb.prepare('SELECT next_fire_at, last_fired_at FROM schedules WHERE id=?').get(id) as any);

    vi.spyOn(loops, 'hasWork').mockImplementation(async () => true);
    const fireSpy = vi.spyOn(loops, 'fire').mockImplementation(async () => {
      throw Object.assign(new Error('cap'), { statusCode: 429 });
    });

    await __tickForTests();

    expect(fireSpy).toHaveBeenCalledWith('loop-429');
    const after = (scheduleDb.prepare('SELECT next_fire_at, last_fired_at FROM schedules WHERE id=?').get(id) as any);
    expect(after.next_fire_at).toBe(before.next_fire_at); // unchanged — capBlocked deferral
    expect(after.last_fired_at).toBe(before.last_fired_at); // unchanged — never marked as fired
  });

  it('daily-cap (409 code=daily-cap) from loops.fire: next_fire_at + last_fired_at unchanged', async () => {
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'tick-loop-daily-cap',
        recurrence: 'every:15',
        loop_id: 'loop-daily-cap',
        launch_request: { prompt: 'unused', cwd: '/tmp' },
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
    const before = (scheduleDb.prepare('SELECT next_fire_at, last_fired_at FROM schedules WHERE id=?').get(id) as any);

    vi.spyOn(loops, 'hasWork').mockImplementation(async () => true);
    const fireSpy = vi.spyOn(loops, 'fire').mockImplementation(async () => {
      throw Object.assign(new Error('daily spend ceiling'), { statusCode: 409, code: 'daily-cap' });
    });

    await __tickForTests();

    expect(fireSpy).toHaveBeenCalledWith('loop-daily-cap');
    const after = (scheduleDb.prepare('SELECT next_fire_at, last_fired_at FROM schedules WHERE id=?').get(id) as any);
    expect(after.next_fire_at).toBe(before.next_fire_at); // unchanged — capBlocked deferral
    expect(after.last_fired_at).toBe(before.last_fired_at); // unchanged
  });
});

// ── Fix 1: run-now on a loop schedule calls loops.fire, not registry.launch ────
describe('POST /api/schedules/:id/run — loop schedule fires loops.fire, not registry.launch', () => {
  it('run-now on a loop-targeted schedule calls loops.fire (not registry.launch) and advances last_fired_at', async () => {
    const scheduleDb = (await import('../src/db.js')).default;

    // Create a loop-targeted schedule (loop-runnow was seeded in beforeAll).
    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'run-now-loop',
        recurrence: 'every:15',
        loop_id: 'loop-runnow',
        launch_request: { prompt: 'unused', cwd: '/tmp' },
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    let firedLoopId: string | null = null;
    const hasWorkSpy = vi.spyOn(loops, 'hasWork').mockImplementation(async (lid: string) => lid === 'loop-runnow');
    const fireSpy = vi.spyOn(loops, 'fire').mockImplementation(async (lid: string) => { firedLoopId = lid; });
    const launchSpy = vi.spyOn(registry, 'launch').mockImplementation((() => ({ id: 'should-not-happen' })) as any);

    const before = Date.now();
    const res = await app.inject({ method: 'POST', url: `/api/schedules/${id}/run`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // loops.fire must be called with the correct loop id; registry.launch must NOT be called.
    expect(firedLoopId).toBe('loop-runnow');
    expect(hasWorkSpy).toHaveBeenCalledWith('loop-runnow');
    expect(fireSpy).toHaveBeenCalledWith('loop-runnow');
    expect(launchSpy).not.toHaveBeenCalled();

    // last_fired_at must have been recorded and next_fire_at must have advanced.
    const row = scheduleDb.prepare('SELECT last_fired_at, next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any;
    expect(row.last_fired_at).toBeGreaterThanOrEqual(before);
    expect(row.next_fire_at).toBeGreaterThan(before);
    expect(row.last_run_id).toBeNull(); // loop fires never set a run id
  });
});
