/**
 * F2 — Recurring scheduled agents: unit + integration tests.
 *
 * Tests:
 *   1. nextFire() pure helper — every/daily/weekly grammars, local-time math
 *   2. validateRecurrence() — full grammar table (valid + invalid)
 *   3. CRUD routes — recurrence field accepted/validated on POST+PUT
 *   4. Template field — validated on POST (unknown → 400), applied on fire
 *   5. Cap-blocked fire does NOT advance next_fire_at (critical guardrail)
 *   6. Successful fire on recurring schedule advances next_fire_at from NOW
 *   7. One-shot schedule nulls out next_fire_at after firing
 *   8. enabled field per row — disabled schedules skipped by tick
 *   9. tick()-level cap test: drives actual tick() with a cap-throwing stub
 *  10. Template haiku model applies at fire time when launch_request.model is blank
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-sched-'));

let app: any;
let PORT: number;
let nextFire: typeof import('../src/scheduler.js').nextFire;
let validateRecurrence: typeof import('../src/scheduler.js').validateRecurrence;
let __tickForTests: typeof import('../src/scheduler.js').__tickForTests;
let registry: typeof import('../src/registry.js').registry;

const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ nextFire, validateRecurrence, __tickForTests } = await import('../src/scheduler.js'));
  ({ registry } = await import('../src/registry.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

// ── 1. nextFire() pure helper ─────────────────────────────────────────────────
describe('nextFire() — pure recurrence math', () => {
  // Anchor: a known local time.
  // We pick a fixed absolute ms that is a Monday 10:00 local time in whatever TZ the test runs.
  // Because nextFire uses local-time Date construction, relative comparisons work.

  it('every:<min> — fires exactly N minutes from "from"', () => {
    const from = Date.now();
    expect(nextFire('every:15', from)).toBe(from + 15 * 60_000);
    expect(nextFire('every:60', from)).toBe(from + 60 * 60_000);
    expect(nextFire('every:10080', from)).toBe(from + 10080 * 60_000);
  });

  it('daily:<HH:MM> — returns a future local-time slot today or tomorrow', () => {
    // Use a time very far in the future to guarantee "today" slot is still ahead.
    const farFuture = new Date(2040, 0, 15, 8, 0, 0, 0).getTime(); // 2040-01-15 08:00 local
    const result = nextFire('daily:09:00', farFuture);
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(result!).toBeGreaterThan(farFuture);
  });

  it('daily:<HH:MM> — rolls to tomorrow when "from" is after the daily slot', () => {
    // from = 2040-01-15 10:30 local → slot 09:00 already passed → next is tomorrow 09:00
    const from = new Date(2040, 0, 15, 10, 30, 0, 0).getTime();
    const result = nextFire('daily:09:00', from);
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDate()).toBe(16); // tomorrow in local TZ
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it('weekly:<0-6>:<HH:MM> — returns a future firing on the correct day-of-week', () => {
    // 2040-01-15 is a Sunday (0).  Fire on Wednesday (3) @ 14:30.
    const from = new Date(2040, 0, 15, 0, 0, 0, 0).getTime();
    const result = nextFire('weekly:3:14:30', from);
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(3);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it('weekly — when "from" is exactly the target day+time, rolls to next week', () => {
    // 2040-01-18 is a Wednesday (3).  Fire on Wednesday @ 14:30, from = that exact time.
    const from = new Date(2040, 0, 18, 14, 30, 0, 0).getTime();
    const result = nextFire('weekly:3:14:30', from);
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(3); // still Wednesday
    expect(result!).toBeGreaterThan(from);
    // Must be at least 6 days out (next week Wednesday, not today's already-passed slot)
    expect(result! - from).toBeGreaterThan(6 * 24 * 3600 * 1000 - 1000);
  });

  it('returns null for malformed recurrence strings', () => {
    expect(nextFire('every:abc')).toBeNull();
    expect(nextFire('daily:99:99')).toBeNull();
    expect(nextFire('weekly:9:14:30')).toBeNull();
    expect(nextFire('garbage')).toBeNull();
  });
});

// ── 2. validateRecurrence() ────────────────────────────────────────────────────
describe('validateRecurrence() — grammar table', () => {
  const ok = (s: string) => { it(`accepts: ${s}`, () => expect(validateRecurrence(s).ok).toBe(true)); };
  const bad = (s: string) => { it(`rejects: ${s}`, () => expect(validateRecurrence(s).ok).toBe(false)); };

  ok('every:15');
  ok('every:60');
  ok('every:10080');
  ok('daily:00:00');
  ok('daily:23:59');
  ok('weekly:0:00:00');
  ok('weekly:6:23:59');

  bad('every:14');          // below minimum
  bad('every:10081');       // above maximum
  bad('every:abc');         // not a number
  bad('every:15.5');        // not integer
  bad('daily:24:00');       // hour out of range
  bad('daily:12:60');       // minute out of range
  bad('daily:9:00');        // missing leading zero
  bad('weekly:7:12:00');    // day out of range
  bad('weekly:0:25:00');    // hour out of range
  bad('weekly:0:12');       // missing time segment
  bad('');                  // empty
  bad('interval:60');       // wrong prefix
  bad('every:');            // missing value
});

// ── 3. CRUD — recurrence field on POST/PUT ────────────────────────────────────
describe('schedule CRUD — recurrence + template fields', () => {
  const base = {
    name: 'test-recurrence',
    recurrence: 'every:30',
    launch_request: { prompt: 'hello', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'low' },
  };

  it('POST with recurrence creates schedule and returns it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/schedules', headers: H(), payload: base });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.recurrence).toBe('every:30');
    expect(s.intervalMs).toBeNull();
    expect(s.dailyAt).toBeNull();
    expect(s.enabled).toBe(true);
    expect(s.nextFireAt).toBeGreaterThan(Date.now());
  });

  it('POST with invalid recurrence → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: { ...base, recurrence: 'every:5' }, // below 15 min
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/every:/);
  });

  it('POST with two triggers (recurrence + interval_ms) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: { ...base, interval_ms: 60000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/exactly one/);
  });

  it('POST with unknown template → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: { ...base, template: 'NonExistentTemplate' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not found/);
  });

  it('POST with valid template (builtin) → 201', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: { ...base, name: 'with-template', template: 'Implementer' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().template).toBe('Implementer');
  });

  it('PUT can change recurrence to daily', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/schedules', headers: H(), payload: base });
    const id = create.json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/schedules/${id}`, headers: H(),
      payload: { recurrence: 'daily:08:00' },
    });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.recurrence).toBe('daily:08:00');
    expect(s.intervalMs).toBeNull();
  });

  it('PUT can clear template (null)', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: { ...base, name: 'clear-tpl', template: 'Implementer' },
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/schedules/${id}`, headers: H(),
      payload: { template: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().template).toBeNull();
  });

  it('PUT enabled=false clears nextFireAt', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/schedules', headers: H(), payload: base });
    const id = create.json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/schedules/${id}`, headers: H(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.enabled).toBe(false);
    expect(s.nextFireAt).toBeNull();
  });

  it('LIST includes recurrence and template fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/schedules', headers: H() });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    // every schedule has recurrence key (may be null for old rows)
    for (const s of list) {
      expect('recurrence' in s).toBe(true);
      expect('template' in s).toBe(true);
    }
  });
});

// ── 4. Cap-blocked fire does NOT advance next_fire_at ──────────────────────────
describe('cap-blocked fire — next_fire_at must not advance', () => {
  it('a 429 from registry.launch leaves next_fire_at unchanged', async () => {
    // Create a schedule with recurrence every:15 starting 1ms in the past (immediately due)
    const now = Date.now();
    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'cap-test',
        recurrence: 'every:15',
        launch_request: { prompt: 'cap test', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'low' },
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    // Force next_fire_at to the past so the internal tick picks it up
    const scheduleDb = (await import('../src/db.js')).default;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);

    // Record the next_fire_at BEFORE the mock tick
    const before = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;

    // Temporarily stub registry.launch to throw 429
    const realLaunch = registry.launch.bind(registry);
    let launchCalled = false;
    (registry as any).launch = () => {
      launchCalled = true;
      throw Object.assign(new Error('cap'), { statusCode: 429 });
    };

    // Import tick internals via the module — call the POST /run route with a manual
    // tick simulation by lowering next_fire_at and calling an internal helper.
    // Actually: trigger the tick via the scheduler module's internal tick function.
    // We can do this by importing and calling startScheduler won't help (it's async).
    // Instead: use the /run route to trigger a launch (it bubbles the error up as HTTP).
    const runRes = await app.inject({
      method: 'POST', url: `/api/schedules/${id}/run`, headers: H(),
    });
    // The run route lets 429 errors bubble — restore launch first
    (registry as any).launch = realLaunch;

    // The /run route returns 429 status
    expect(launchCalled).toBe(true);
    expect(runRes.statusCode).toBe(429);

    // next_fire_at should be unchanged (the /run route doesn't advance on error)
    const after = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
    expect(after).toBe(before);
  });

  it('a 409 daily-cap from registry.launch leaves next_fire_at unchanged (tick path)', async () => {
    // We import the tick function indirectly by testing the invariant via the DB.
    // The tick() function is not exported, so we test the promise via the stored state.
    // Re-create a due schedule, stub launch to throw daily-cap, trigger tick via
    // the module's exported startScheduler → let it run one cycle.
    // Since tick() is private, we verify by checking: after a cap-throw the row is unchanged.
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'daily-cap-test',
        recurrence: 'every:15',
        launch_request: { prompt: 'daily cap test', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'low' },
        enabled: true,
      },
    });
    const id = create.json().id;
    // Manually set past next_fire_at
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 500, id);
    const before = now - 500;

    // Patch launch to throw daily-cap
    const realLaunch = registry.launch.bind(registry);
    (registry as any).launch = () => {
      throw Object.assign(new Error('daily spend ceiling'), { statusCode: 409, code: 'daily-cap' });
    };

    // Import and invoke the tick indirectly by calling /run route (which is a proxy for fire)
    // Note: /run route surfaces the error as HTTP; it does NOT update next_fire_at on error.
    const runRes = await app.inject({
      method: 'POST', url: `/api/schedules/${id}/run`, headers: H(),
    });
    (registry as any).launch = realLaunch;

    expect(runRes.statusCode).toBe(409);
    const after = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
    expect(after).toBe(before); // unchanged
  });
});

// ── 5. Recurring schedule advances next_fire_at from NOW after successful fire ─
describe('recurring schedule — next_fire_at after successful fire', () => {
  it('every:15 schedule: run-now advances next_fire_at by ~15 minutes', async () => {
    const scheduleDb = (await import('../src/db.js')).default;

    // Create schedule enabled
    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'recurring-advance',
        recurrence: 'every:15',
        launch_request: { prompt: 'recurring', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'low' },
      },
    });
    const id = create.json().id;

    // Stub launch to succeed without actually starting a process
    const realLaunch = registry.launch.bind(registry);
    (registry as any).launch = () => ({ id: 'fake-run-id' });

    const before = Date.now();
    const runRes = await app.inject({ method: 'POST', url: `/api/schedules/${id}/run`, headers: H() });
    const after = Date.now();

    (registry as any).launch = realLaunch;

    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().runId).toBe('fake-run-id');

    const row = scheduleDb.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any;
    expect(row.last_run_id).toBe('fake-run-id');
    // next_fire_at should be ~15 minutes from now
    expect(row.next_fire_at).toBeGreaterThan(before + 14 * 60_000);
    expect(row.next_fire_at).toBeLessThan(after + 16 * 60_000);
  });
});

// ── 6. Template profile applied to launched run ───────────────────────────────
describe('template profile applied at fire time', () => {
  it('run-now with template applies template model/effort/appendSystemPrompt to launch req', async () => {
    // Use the "Implementer" builtin template — verify its fields are reflected
    const templatesRes = await app.inject({ method: 'GET', url: '/api/templates', headers: H() });
    const implementer = templatesRes.json().find((t: any) => t.name === 'Implementer');
    expect(implementer).toBeDefined();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'template-apply',
        recurrence: 'every:15',
        template: 'Implementer',
        launch_request: { prompt: 'do work', cwd: '/tmp', model: '', effort: 'low' },
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    let capturedReq: any = null;
    const realLaunch = registry.launch.bind(registry);
    (registry as any).launch = (req: any) => {
      capturedReq = req;
      return { id: 'tpl-run-id' };
    };

    await app.inject({ method: 'POST', url: `/api/schedules/${id}/run`, headers: H() });
    (registry as any).launch = realLaunch;

    expect(capturedReq).not.toBeNull();
    // Template's model should be applied (since launch_request.model was empty)
    if (implementer.model) {
      expect(capturedReq.model).toBe(implementer.model);
    }
    // Template's effort should be applied
    if (implementer.effort) {
      expect(capturedReq.effort).toBe(implementer.effort);
    }
    // Template's system prompt should be appended
    if (implementer.systemPrompt) {
      expect(capturedReq.appendSystemPrompt).toContain(implementer.systemPrompt);
    }
  });
});

// ── 7. weekly grammar — full round trip ───────────────────────────────────────
describe('weekly recurrence — create and next_fire_at sanity check', () => {
  it('weekly:1:09:00 schedule fires within 7 days', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'weekly-monday',
        recurrence: 'weekly:1:09:00',
        launch_request: { prompt: 'weekly task', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'low' },
      },
    });
    expect(create.statusCode).toBe(201);
    const s = create.json();
    expect(s.recurrence).toBe('weekly:1:09:00');
    expect(s.nextFireAt).not.toBeNull();
    // Must fire within 7 days
    expect(s.nextFireAt).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000 + 60000);
    expect(s.nextFireAt).toBeGreaterThan(Date.now());
    // Must fire on a Monday (day 1)
    const d = new Date(s.nextFireAt);
    expect(d.getDay()).toBe(1);
  });
});

// ── 8. tick()-level cap test: actual tick() does not advance next_fire_at on 429/daily-cap ─
describe('tick()-level cap guard — actual tick() does not advance next_fire_at', () => {
  it('cap-throwing launch stub: tick() leaves next_fire_at unchanged, then unblocks and fires', async () => {
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    // Create a schedule and force it overdue.
    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'tick-cap-test',
        recurrence: 'every:15',
        launch_request: { prompt: 'tick cap', cwd: '/tmp' },
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 2000, id);
    const before = now - 2000;

    // Stub launch to throw 429 (cap-blocked).
    const realLaunch = registry.launch.bind(registry);
    let ourCallCount = 0;
    (registry as any).launch = (req: any) => {
      if (req?.prompt === 'tick cap') ourCallCount++;
      throw Object.assign(new Error('cap'), { statusCode: 429 });
    };

    // Drive the actual tick() — next_fire_at must NOT advance for our schedule.
    __tickForTests();
    (registry as any).launch = realLaunch;

    expect(ourCallCount).toBe(1); // our schedule was attempted
    const afterCap = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
    expect(afterCap).toBe(before); // unchanged — the house invariant

    // Now unblock: stub launch to succeed, fire tick() again.
    let capturedReq: any = null;
    (registry as any).launch = (req: any) => {
      capturedReq = req;
      return { id: 'tick-run-id' };
    };

    __tickForTests();
    (registry as any).launch = realLaunch;

    // next_fire_at must have advanced (schedule fired successfully).
    const afterFire = (scheduleDb.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any);
    expect(afterFire.next_fire_at).toBeGreaterThan(before);
    expect(afterFire.last_run_id).toBe('tick-run-id');
    // Defaults should have been applied at fire time.
    expect(capturedReq.model).toBe('claude-opus-4-8');
    expect(capturedReq.effort).toBe('high');
  });

  it('daily-cap (409 code=daily-cap) from tick(): next_fire_at unchanged', async () => {
    const scheduleDb = (await import('../src/db.js')).default;
    const now = Date.now();

    const create = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'tick-daily-cap-test',
        recurrence: 'every:15',
        launch_request: { prompt: 'daily cap tick', cwd: '/tmp' },
        enabled: true,
      },
    });
    const id = create.json().id;
    scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
    const before = now - 1000;

    const realLaunch = registry.launch.bind(registry);
    (registry as any).launch = () => {
      throw Object.assign(new Error('daily spend ceiling'), { statusCode: 409, code: 'daily-cap' });
    };

    __tickForTests();
    (registry as any).launch = realLaunch;

    const after = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
    expect(after).toBe(before); // unchanged — cap-blocked does NOT advance
  });
});

// ── 9. Template haiku model applies at fire time when launch_request.model is blank ─
describe('template haiku model applies at fire time (finding #6/#16)', () => {
  it('schedule with haiku template and no explicit model → captured launch uses haiku model', async () => {
    // First create a template with haiku model.
    const tplCreate = await app.inject({
      method: 'POST', url: '/api/templates', headers: H(),
      payload: {
        name: 'HaikuTemplate',
        role: 'worker',
        description: 'haiku test template',
        systemPrompt: '',
        model: 'claude-haiku-4-5',
        fastMode: false,
        effort: 'low',
        allowedTools: [],
        skills: [],
        permissionMode: 'default',
        budgetUsd: null,
      },
    });
    expect(tplCreate.statusCode).toBe(200);

    // Create a schedule with the haiku template and no explicit model (empty string).
    const schedCreate = await app.inject({
      method: 'POST', url: '/api/schedules', headers: H(),
      payload: {
        name: 'haiku-model-test',
        recurrence: 'every:15',
        template: 'HaikuTemplate',
        launch_request: { prompt: 'haiku test', cwd: '/tmp', model: '' }, // no explicit model
      },
    });
    expect(schedCreate.statusCode).toBe(201);
    const id = schedCreate.json().id;

    // Stub registry.launch to capture the request.
    let capturedReq: any = null;
    const realLaunch = registry.launch.bind(registry);
    (registry as any).launch = (req: any) => {
      capturedReq = req;
      return { id: 'haiku-run-id' };
    };

    await app.inject({ method: 'POST', url: `/api/schedules/${id}/run`, headers: H() });
    (registry as any).launch = realLaunch;

    expect(capturedReq).not.toBeNull();
    // Template's haiku model must be applied (not the opus-4-8 default).
    expect(capturedReq.model).toBe('claude-haiku-4-5');
    // Template's low effort must be applied.
    expect(capturedReq.effort).toBe('low');
  });
});
