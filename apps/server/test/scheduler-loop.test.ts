/**
 * Slice 04 — scheduler loop_id extension.
 * 1. POST /api/schedules accepts loop_id and round-trips it on the view (loopId).
 * 2. A due schedule with loop_id calls loops.fire(loopId), NOT registry.launch.
 * 3. A loop with no work (hasWork=false) is skipped but next_fire_at still advances.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ __tickForTests } = await import('../src/scheduler.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ loops } = await import('../src/loops.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
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
    let launchCalled = false;
    const realFire = loops.fire.bind(loops);
    const realHasWork = loops.hasWork.bind(loops);
    const realLaunch = registry.launch.bind(registry);
    (loops as any).hasWork = async (lid: string) => lid === 'loop-fires';
    (loops as any).fire = async (lid: string) => { firedLoopId = lid; };
    (registry as any).launch = () => { launchCalled = true; return { id: 'should-not-happen' }; };

    await __tickForTests();

    (loops as any).fire = realFire;
    (loops as any).hasWork = realHasWork;
    (registry as any).launch = realLaunch;

    expect(firedLoopId).toBe('loop-fires');
    expect(launchCalled).toBe(false);
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

    let fireCalled = false;
    const realFire = loops.fire.bind(loops);
    const realHasWork = loops.hasWork.bind(loops);
    (loops as any).hasWork = async () => false; // no work
    (loops as any).fire = async () => { fireCalled = true; };

    await __tickForTests();

    (loops as any).fire = realFire;
    (loops as any).hasWork = realHasWork;

    expect(fireCalled).toBe(false); // skipped — no spend
    const after = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
    expect(after).toBeGreaterThan(before); // advanced normally — retries next cadence
  });
});
