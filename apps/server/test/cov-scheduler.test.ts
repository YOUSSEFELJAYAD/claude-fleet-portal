/**
 * cov-scheduler — raises real coverage of scheduler.ts branches the existing
 * scheduler-recurrence.test.ts left uncovered:
 *
 *   • rowToView() JSON-parse catch fallback                    (98-99)
 *   • computeNextFire() legacy interval_ms / daily_at branches (221-236)  [via POST route]
 *   • validateLaunchRequest() bad-cwd branch                   (247-248)  [via POST route]
 *   • validateTrigger() interval_ms + daily_at branches        (277-289)  [via POST route]
 *   • applyTemplateProfile() appendSystemPrompt-merge branch   (312)      [via run-now]
 *   • tick() permanent-failure advance + dueStmt catch         (341-374,392)
 *   • POST route error paths (name / lr / template)            (419-439)
 *   • PUT route error paths (404 / name / trigger / lr / tpl)  (475-536)
 *   • DELETE 404 + run-now 404 + bad stored launch_request     (569-593)
 *
 * Every test asserts a real OUTPUT (HTTP status + body) or a real DB side-effect.
 * No mocks of internal logic — only registry.launch is swapped to avoid spawning a
 * real engine process, mirroring the existing scheduler test's approach.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-covsched-'));

let app: any;
let PORT: number;
let __tickForTests: typeof import('../src/scheduler.js').__tickForTests;
let registry: typeof import('../src/registry.js').registry;
let db: typeof import('../src/db.js').default;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: H(), payload });
const put = (url: string, payload: any) => app.inject({ method: 'PUT', url, headers: H(), payload });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H() });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });

const baseLr = { prompt: 'hello', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'low' };

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ __tickForTests } = await import('../src/scheduler.js'));
  ({ registry } = await import('../src/registry.js'));
  db = (await import('../src/db.js')).default;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

// ── POST validation error paths (419-439) + legacy triggers (221-236, 277-289) ──
describe('POST /api/schedules — validation + legacy trigger branches', () => {
  it('rejects a missing/blank name with 400 (419-421)', async () => {
    const a = await post('/api/schedules', { recurrence: 'every:30', launch_request: baseLr });
    expect(a.statusCode).toBe(400);
    expect(a.json().error).toMatch(/name is required/);

    const b = await post('/api/schedules', { name: '   ', recurrence: 'every:30', launch_request: baseLr });
    expect(b.statusCode).toBe(400);
    expect(b.json().error).toMatch(/name is required/);
  });

  it('creates a legacy interval_ms schedule and precomputes next_fire_at = now+interval (221-222, 277-282)', async () => {
    const before = Date.now();
    const res = await post('/api/schedules', {
      name: 'legacy-interval',
      interval_ms: 90_000,
      launch_request: baseLr,
    });
    const after = Date.now();
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.intervalMs).toBe(90_000);
    expect(s.recurrence).toBeNull();
    expect(s.dailyAt).toBeNull();
    // computeNextFire interval branch: from + interval_ms
    expect(s.nextFireAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(s.nextFireAt).toBeLessThanOrEqual(after + 90_000);
  });

  it('rejects interval_ms below MIN_INTERVAL_MS / non-integer (279-281)', async () => {
    const low = await post('/api/schedules', { name: 'too-fast', interval_ms: 1000, launch_request: baseLr });
    expect(low.statusCode).toBe(400);
    expect(low.json().error).toMatch(/interval_ms must be an integer/);

    const frac = await post('/api/schedules', { name: 'fractional', interval_ms: 60_000.5, launch_request: baseLr });
    expect(frac.statusCode).toBe(400);
    expect(frac.json().error).toMatch(/interval_ms/);
  });

  it('creates a legacy daily_at schedule with a real future local slot (224-233, 285-288)', async () => {
    const res = await post('/api/schedules', {
      name: 'legacy-daily',
      daily_at: '23:59',
      launch_request: baseLr,
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.dailyAt).toBe('23:59');
    expect(s.recurrence).toBeNull();
    expect(s.intervalMs).toBeNull();
    expect(s.nextFireAt).toBeGreaterThan(Date.now());
    const d = new Date(s.nextFireAt);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
  });

  it('rejects a malformed daily_at (285-286)', async () => {
    const res = await post('/api/schedules', { name: 'bad-daily', daily_at: '9:5', launch_request: baseLr });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/daily_at must be/);
  });

  it('rejects zero triggers and rejects multiple triggers (267-268)', async () => {
    const none = await post('/api/schedules', { name: 'no-trigger', launch_request: baseLr });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/exactly one/);

    const two = await post('/api/schedules', {
      name: 'two-trigger', interval_ms: 90_000, daily_at: '08:00', launch_request: baseLr,
    });
    expect(two.statusCode).toBe(400);
    expect(two.json().error).toMatch(/exactly one/);
  });

  it('rejects an invalid launch_request (missing prompt → 429-431)', async () => {
    const res = await post('/api/schedules', {
      name: 'bad-lr', recurrence: 'every:30', launch_request: { cwd: '/tmp' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/prompt is required/);
  });

  it('rejects launch_request with a non-absolute / traversal cwd (247-248)', async () => {
    const rel = await post('/api/schedules', {
      name: 'rel-cwd', recurrence: 'every:30', launch_request: { prompt: 'x', cwd: 'relative/path' },
    });
    expect(rel.statusCode).toBe(400);
    expect(rel.json().error).toMatch(/cwd must be an absolute path/);

    const trav = await post('/api/schedules', {
      name: 'trav-cwd', recurrence: 'every:30', launch_request: { prompt: 'x', cwd: '/tmp/../etc' },
    });
    expect(trav.statusCode).toBe(400);
    expect(trav.json().error).toMatch(/cwd must be an absolute path/);
  });

  it('rejects a non-string template (437-439) and an unknown template name (440-444)', async () => {
    const nonStr = await post('/api/schedules', {
      name: 'tpl-num', recurrence: 'every:30', launch_request: baseLr, template: 123,
    });
    expect(nonStr.statusCode).toBe(400);
    expect(nonStr.json().error).toMatch(/template must be a string/);

    const unknown = await post('/api/schedules', {
      name: 'tpl-unknown', recurrence: 'every:30', launch_request: baseLr, template: 'NoSuchTpl_xyz',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/not found/);
  });
});

// ── PUT error paths (475-536) ─────────────────────────────────────────────────
describe('PUT /api/schedules/:id — validation + branch coverage', () => {
  let id: string;
  beforeAll(async () => {
    const c = await post('/api/schedules', { name: 'put-base', recurrence: 'every:30', launch_request: baseLr });
    id = c.json().id;
  });

  it('404 when the schedule does not exist (475-477)', async () => {
    const res = await put('/api/schedules/does-not-exist', { name: 'whatever' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it('rejects a blank name (483-487)', async () => {
    const res = await put(`/api/schedules/${id}`, { name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-empty string/);
  });

  it('accepts and trims a valid name rename (487-488)', async () => {
    const res = await put(`/api/schedules/${id}`, { name: '  renamed-sched  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('renamed-sched');
  });

  it('rejects an invalid trigger change (501-503)', async () => {
    const res = await put(`/api/schedules/${id}`, { recurrence: 'every:5' }); // below min
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/every:/);
  });

  it('changes the trigger to a legacy interval_ms and recomputes next_fire_at (504-506, 544-550)', async () => {
    const res = await put(`/api/schedules/${id}`, { interval_ms: 120_000 });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.intervalMs).toBe(120_000);
    expect(s.recurrence).toBeNull();
    expect(s.nextFireAt).toBeGreaterThan(Date.now());
  });

  it('rejects an invalid launch_request (512-516)', async () => {
    const res = await put(`/api/schedules/${id}`, { launch_request: { prompt: '', cwd: '/tmp' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/prompt is required/);
  });

  it('accepts a valid launch_request edit (517)', async () => {
    const res = await put(`/api/schedules/${id}`, { launch_request: { prompt: 'edited', cwd: '/var' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().launchRequest.prompt).toBe('edited');
    expect(res.json().launchRequest.cwd).toBe('/var');
  });

  it('rejects a non-string template (526-528) and unknown template (530-534)', async () => {
    const nonStr = await put(`/api/schedules/${id}`, { template: 42 });
    expect(nonStr.statusCode).toBe(400);
    expect(nonStr.json().error).toMatch(/template must be a string/);

    const unknown = await put(`/api/schedules/${id}`, { template: 'GhostTemplate_zzz' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/not found/);
  });

  it('sets a valid template then clears it via empty string (522-536, 523-524)', async () => {
    const set = await put(`/api/schedules/${id}`, { template: 'Implementer' });
    expect(set.statusCode).toBe(200);
    expect(set.json().template).toBe('Implementer');

    const clear = await put(`/api/schedules/${id}`, { template: '' });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().template).toBeNull();
  });

  it('disabling clears next_fire_at; re-enabling (no trigger change) reschedules (540-551)', async () => {
    const c = await post('/api/schedules', { name: 'toggle', recurrence: 'every:30', launch_request: baseLr });
    const tid = c.json().id;
    expect(c.json().nextFireAt).toBeGreaterThan(Date.now());

    // Disable → 547-548: nextFire = null
    const off = await put(`/api/schedules/${tid}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    expect(off.json().nextFireAt).toBeNull();

    // Re-enable with no trigger change → 549-550 recomputes a fresh slot.
    const on = await put(`/api/schedules/${tid}`, { enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().enabled).toBe(true);
    expect(on.json().nextFireAt).toBeGreaterThan(Date.now());
  });

  it('a no-op PUT on an enabled schedule keeps the existing next_fire_at slot (546, 549-false)', async () => {
    const c = await post('/api/schedules', { name: 'keep-slot', recurrence: 'every:30', launch_request: baseLr });
    const kid = c.json().id;
    const slot = c.json().nextFireAt;
    expect(slot).toBeGreaterThan(Date.now());

    // PUT that changes nothing material (same name) and no trigger change while enabled
    // with an existing slot → none of the recompute conditions fire; slot is preserved.
    const res = await put(`/api/schedules/${kid}`, { name: 'keep-slot' });
    expect(res.statusCode).toBe(200);
    expect(res.json().nextFireAt).toBe(slot);
  });
});

// ── DELETE + run-now error paths (569-593) ─────────────────────────────────────
describe('DELETE + run-now — 404 and bad-state paths', () => {
  it('DELETE 404 for an unknown id (571-572)', async () => {
    const res = await del('/api/schedules/nope-not-here');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it('DELETE removes a real schedule (575-576)', async () => {
    const c = await post('/api/schedules', { name: 'to-delete', recurrence: 'every:30', launch_request: baseLr });
    const id = c.json().id;
    const res = await del(`/api/schedules/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Gone from the list
    const list = (await get('/api/schedules')).json();
    expect(list.find((s: any) => s.id === id)).toBeUndefined();
  });

  it('run-now 404 for an unknown id (584-586)', async () => {
    const res = await post('/api/schedules/ghost-run/run', {});
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it('run-now reports a bad stored launch_request as 400 (591-593)', async () => {
    const c = await post('/api/schedules', { name: 'corrupt-lr', recurrence: 'every:30', launch_request: baseLr });
    const id = c.json().id;
    // Corrupt the stored JSON directly in the DB.
    db.prepare('UPDATE schedules SET launch_request=? WHERE id=?').run('{not valid json', id);

    const res = await post(`/api/schedules/${id}/run`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/stored launch_request is invalid/);
  });

  it('run-now surfaces a launch error with its statusCode and message (611-614)', async () => {
    const c = await post('/api/schedules', { name: 'run-err', recurrence: 'every:30', launch_request: baseLr });
    const id = c.json().id;

    const real = registry.launch.bind(registry);
    (registry as any).launch = () => {
      throw Object.assign(new Error('engine exploded'), { statusCode: 503 });
    };
    const res = await post(`/api/schedules/${id}/run`, {});
    (registry as any).launch = real;

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('engine exploded');
  });

  it('run-now on an enabled recurring schedule advances next_fire_at (606-610)', async () => {
    const c = await post('/api/schedules', { name: 'run-advance', recurrence: 'every:15', launch_request: baseLr });
    const id = c.json().id;
    const before = (db.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;

    const real = registry.launch.bind(registry);
    (registry as any).launch = () => ({ id: 'advance-run' });
    const t0 = Date.now();
    const res = await post(`/api/schedules/${id}/run`, {});
    (registry as any).launch = real;

    const t1 = Date.now();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, runId: 'advance-run' });
    const row = db.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any;
    expect(row.last_run_id).toBe('advance-run');
    // run-now recomputes next_fire_at from "now" for an enabled recurring schedule:
    // it must land in the every:15 window [t0+15m, t1+15m]. (It may equal `before` if
    // the create and run happened in the same millisecond — so we assert the window,
    // not strict inequality against the original slot.)
    expect(row.next_fire_at).toBeGreaterThanOrEqual(before);
    expect(row.next_fire_at).toBeGreaterThanOrEqual(t0 + 15 * 60_000);
    expect(row.next_fire_at).toBeLessThanOrEqual(t1 + 15 * 60_000);
  });
});

// ── rowToView() catch fallback (98-99) ─────────────────────────────────────────
describe('rowToView — corrupt launch_request JSON falls back to an empty LaunchRequest', () => {
  it('LIST returns the default fallback shape for a row with unparseable launch_request', async () => {
    const c = await post('/api/schedules', { name: 'view-corrupt', recurrence: 'every:30', launch_request: baseLr });
    const id = c.json().id;
    db.prepare('UPDATE schedules SET launch_request=? WHERE id=?').run('}{', id);

    const list = (await get('/api/schedules')).json();
    const row = list.find((s: any) => s.id === id);
    expect(row).toBeDefined();
    // catch branch: returns { prompt:'', cwd:'', model:'', effort:'high', permissionMode:'default' }
    expect(row.launchRequest).toEqual({
      prompt: '', cwd: '', model: '', effort: 'high', permissionMode: 'default',
    });
  });
});

// ── applyTemplateProfile appendSystemPrompt merge branch (312) ─────────────────
describe('applyTemplateProfile — merges existing appendSystemPrompt with template systemPrompt', () => {
  it('run-now concatenates launch_request.appendSystemPrompt + template.systemPrompt (310-313)', async () => {
    // Create a template with a non-empty system prompt.
    const tpl = await post('/api/templates', {
      name: 'MergeTpl', role: 'worker', description: 'merge test',
      systemPrompt: 'TEMPLATE_SYS', model: 'claude-haiku-4-5', fastMode: false,
      effort: 'low', allowedTools: [], skills: [], permissionMode: 'default', budgetUsd: null,
    });
    expect(tpl.statusCode).toBe(200);

    // Schedule carries its own appendSystemPrompt — the branch concatenates both.
    const c = await post('/api/schedules', {
      name: 'merge-sched', recurrence: 'every:30', template: 'MergeTpl',
      launch_request: { prompt: 'merge', cwd: '/tmp', appendSystemPrompt: 'OWN_PROMPT' },
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;

    let captured: any = null;
    const real = registry.launch.bind(registry);
    (registry as any).launch = (req: any) => { captured = req; return { id: 'merge-run' }; };
    await post(`/api/schedules/${id}/run`, {});
    (registry as any).launch = real;

    expect(captured).not.toBeNull();
    expect(captured.appendSystemPrompt).toBe('OWN_PROMPT\n\nTEMPLATE_SYS');
  });
});

// ── tick() permanent-failure path advances next_fire_at (363-374, 386-392) ─────
describe('tick() — a permanent launch failure advances next_fire_at past the broken slot', () => {
  // Isolate each tick test: disable every pre-existing schedule so __tickForTests()
  // only ever sees the single due row the test creates afterward. dueStmt selects
  // enabled=1 AND next_fire_at<=now, so disabling clears the field deterministically.
  beforeEach(() => {
    db.prepare('UPDATE schedules SET enabled=0, next_fire_at=NULL').run();
  });

  it('a thrown non-cap error logs, treats as fired, and recomputes next_fire_at', async () => {
    const now = Date.now();
    const c = await post('/api/schedules', {
      name: 'perm-fail', recurrence: 'every:15',
      launch_request: { prompt: 'perm fail tick', cwd: '/tmp' }, enabled: true,
    });
    const id = c.json().id;
    db.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 3000, id);
    const before = now - 3000;

    const real = registry.launch.bind(registry);
    let attempted = 0;
    (registry as any).launch = (req: any) => {
      if (req?.prompt === 'perm fail tick') attempted++;
      // A plain error (no statusCode 429, no code 'daily-cap') = permanent failure.
      throw Object.assign(new Error('bad request'), { statusCode: 400 });
    };
    await __tickForTests();
    (registry as any).launch = real;

    expect(attempted).toBe(1);
    const row = db.prepare('SELECT next_fire_at, last_run_id, last_fired_at FROM schedules WHERE id=?').get(id) as any;
    // Permanent failure → treated as "fired": next_fire_at advanced past the old slot.
    expect(row.next_fire_at).toBeGreaterThan(before);
    expect(row.next_fire_at).toBeGreaterThan(now); // ~15 min out
    expect(row.last_fired_at).toBeGreaterThanOrEqual(now);
    // runId is null because launch threw before returning a run.
    expect(row.last_run_id).toBeNull();
  });

  it('a cap-blocked (429) launch in tick does NOT advance next_fire_at (366-367, 377-379)', async () => {
    const now = Date.now();
    const c = await post('/api/schedules', {
      name: 'tick-cap', recurrence: 'every:15',
      launch_request: { prompt: 'tick cap block', cwd: '/tmp' }, enabled: true,
    });
    const id = c.json().id;
    db.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 2000, id);
    const before = now - 2000;

    const real = registry.launch.bind(registry);
    let attempted = 0;
    (registry as any).launch = (req: any) => {
      if (req?.prompt === 'tick cap block') attempted++;
      throw Object.assign(new Error('cap'), { statusCode: 429 });
    };
    await __tickForTests();
    (registry as any).launch = real;

    expect(attempted).toBe(1);
    const row = db.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any;
    // capBlocked → continue: row untouched (no advance, no last_run_id).
    expect(row.next_fire_at).toBe(before);
    expect(row.last_run_id).toBeNull();
  });

  it('tick applies the row template profile before launching (350-352)', async () => {
    // Template with a haiku model + low effort so we can detect it was applied.
    const tpl = await post('/api/templates', {
      name: 'TickTpl', role: 'worker', description: 'tick tpl',
      systemPrompt: '', model: 'claude-haiku-4-5', fastMode: false,
      effort: 'low', allowedTools: [], skills: [], permissionMode: 'default', budgetUsd: null,
    });
    expect(tpl.statusCode).toBe(200);

    const now = Date.now();
    const c = await post('/api/schedules', {
      name: 'tick-tpl-sched', recurrence: 'every:15', template: 'TickTpl',
      launch_request: { prompt: 'tick with template', cwd: '/tmp', model: '' }, enabled: true,
    });
    const id = c.json().id;
    db.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1500, id);

    const real = registry.launch.bind(registry);
    let captured: any = null;
    (registry as any).launch = (req: any) => {
      if (req?.prompt === 'tick with template') captured = req;
      return { id: 'tick-tpl-run' };
    };
    await __tickForTests();
    (registry as any).launch = real;

    expect(captured).not.toBeNull();
    // Template applied at fire time: haiku model + low effort (default opus/high NOT used).
    expect(captured.model).toBe('claude-haiku-4-5');
    expect(captured.effort).toBe('low');
    const row = db.prepare('SELECT last_run_id FROM schedules WHERE id=?').get(id) as any;
    expect(row.last_run_id).toBe('tick-tpl-run');
  });

  it('a successful one-shot (no recurrence/interval/daily) nulls out next_fire_at after firing (386-392)', async () => {
    const now = Date.now();
    // Build a one-shot row directly: enabled, due, but with NO trigger fields set.
    // Routes require a trigger, so insert a recurring row then strip the trigger in the DB.
    const c = await post('/api/schedules', {
      name: 'oneshot', recurrence: 'every:15',
      launch_request: { prompt: 'one shot fire', cwd: '/tmp' }, enabled: true,
    });
    const id = c.json().id;
    db.prepare('UPDATE schedules SET recurrence=NULL, interval_ms=NULL, daily_at=NULL, next_fire_at=? WHERE id=?')
      .run(now - 1000, id);

    const real = registry.launch.bind(registry);
    let captured: any = null;
    (registry as any).launch = (req: any) => { captured = req; return { id: 'oneshot-run' }; };
    await __tickForTests();
    (registry as any).launch = real;

    expect(captured?.prompt).toBe('one shot fire');
    const row = db.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any;
    // One-shot consumed: next_fire_at becomes null.
    expect(row.next_fire_at).toBeNull();
    expect(row.last_run_id).toBe('oneshot-run');
  });
});
