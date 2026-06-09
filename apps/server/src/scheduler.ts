/**
 * Portal-side scheduler (Feature A4): recurring / one-shot launches of agent runs,
 * with NO cron dependency. Two trigger types:
 *   • interval_ms  — fire every N ms (N >= 60_000)
 *   • daily_at     — fire once per day at a local "HH:MM"
 *
 * A single 30s tick (unref'd, so it never keeps the process alive on its own) finds
 * enabled, due schedules and calls registry.launch(...). next_fire_at is precomputed
 * on create / enable / edit and recomputed after every firing.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import db from './db.js';
import { registry } from './registry.js';
import type { LaunchRequest } from '@fleet/shared';

db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  interval_ms INTEGER,
  daily_at TEXT,
  launch_request TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_id TEXT,
  last_fired_at INTEGER,
  next_fire_at INTEGER,
  created_at INTEGER NOT NULL
);
`);

// ── shapes ─────────────────────────────────────────────────────────────────────
interface ScheduleRow {
  id: string;
  name: string;
  interval_ms: number | null;
  daily_at: string | null;
  launch_request: string;
  enabled: number;
  last_run_id: string | null;
  last_fired_at: number | null;
  next_fire_at: number | null;
  created_at: number;
}

interface ScheduleView {
  id: string;
  name: string;
  intervalMs: number | null;
  dailyAt: string | null;
  launchRequest: LaunchRequest;
  enabled: boolean;
  lastRunId: string | null;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  createdAt: number;
}

const MIN_INTERVAL_MS = 60_000;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function rowToView(row: ScheduleRow): ScheduleView {
  let launchRequest: LaunchRequest;
  try {
    launchRequest = JSON.parse(row.launch_request);
  } catch {
    launchRequest = { prompt: '', cwd: '', model: '', effort: 'high', permissionMode: 'default' } as LaunchRequest;
  }
  return {
    id: row.id,
    name: row.name,
    intervalMs: row.interval_ms,
    dailyAt: row.daily_at,
    launchRequest,
    enabled: !!row.enabled,
    lastRunId: row.last_run_id,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
  };
}

// ── statements ───────────────────────────────────────────────────────────────
const insertStmt = db.prepare(`
INSERT INTO schedules (id, name, interval_ms, daily_at, launch_request, enabled, last_run_id, last_fired_at, next_fire_at, created_at)
VALUES (@id, @name, @interval_ms, @daily_at, @launch_request, @enabled, @last_run_id, @last_fired_at, @next_fire_at, @created_at)
`);
const listStmt = db.prepare('SELECT * FROM schedules ORDER BY created_at DESC');
const getStmt = db.prepare('SELECT * FROM schedules WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM schedules WHERE id = ?');
const dueStmt = db.prepare(
  'SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?',
);
const updateStmt = db.prepare(`
UPDATE schedules SET name=@name, interval_ms=@interval_ms, daily_at=@daily_at, launch_request=@launch_request,
  enabled=@enabled, next_fire_at=@next_fire_at WHERE id=@id
`);
const updateFiredStmt = db.prepare(
  'UPDATE schedules SET last_run_id=@last_run_id, last_fired_at=@last_fired_at, next_fire_at=@next_fire_at WHERE id=@id',
);

// ── next_fire_at math ──────────────────────────────────────────────────────────

/** Next firing time given a trigger, computed from `from` (default: now). */
function computeNextFire(row: { interval_ms: number | null; daily_at: string | null }, from = Date.now()): number | null {
  if (row.interval_ms != null) {
    return from + row.interval_ms;
  }
  if (row.daily_at != null) {
    const m = HHMM_RE.exec(row.daily_at);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const d = new Date(from);
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
    // If today's slot already passed (or is exactly now), roll to tomorrow.
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  return null;
}

// ── validation ─────────────────────────────────────────────────────────────────

/** Validate a launch_request has the minimum shape the scheduler needs (prompt + cwd). */
function validateLaunchRequest(lr: any): { ok: true; value: LaunchRequest } | { ok: false; error: string } {
  if (!lr || typeof lr !== 'object') return { ok: false, error: 'launch_request must be an object' };
  if (typeof lr.prompt !== 'string' || !lr.prompt.trim()) return { ok: false, error: 'launch_request.prompt is required' };
  if (typeof lr.cwd !== 'string' || !lr.cwd.startsWith('/') || lr.cwd.includes('..') || lr.cwd.includes('\0')) {
    return { ok: false, error: 'launch_request.cwd must be an absolute path' };
  }
  const value: LaunchRequest = {
    ...lr,
    prompt: lr.prompt,
    cwd: lr.cwd,
    model: typeof lr.model === 'string' && lr.model ? lr.model : 'claude-opus-4-8',
    effort: lr.effort || 'high',
    permissionMode: lr.permissionMode || 'default',
  };
  return { ok: true, value };
}

/** Validate the trigger: exactly one of interval_ms | daily_at. */
function validateTrigger(body: any): { ok: true; intervalMs: number | null; dailyAt: string | null } | { ok: false; error: string } {
  const hasInterval = body?.interval_ms != null;
  const hasDaily = body?.daily_at != null && body?.daily_at !== '';
  if (hasInterval === hasDaily) {
    return { ok: false, error: 'provide exactly one of interval_ms or daily_at' };
  }
  if (hasInterval) {
    const n = Number(body.interval_ms);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_INTERVAL_MS) {
      return { ok: false, error: `interval_ms must be an integer >= ${MIN_INTERVAL_MS}` };
    }
    return { ok: true, intervalMs: n, dailyAt: null };
  }
  if (!HHMM_RE.test(String(body.daily_at))) {
    return { ok: false, error: 'daily_at must be "HH:MM" (00:00–23:59)' };
  }
  return { ok: true, intervalMs: null, dailyAt: String(body.daily_at) };
}

// ── tick ──────────────────────────────────────────────────────────────────────
function tick() {
  const now = Date.now();
  let due: ScheduleRow[];
  try {
    due = dueStmt.all(now) as ScheduleRow[];
  } catch {
    return;
  }
  for (const row of due) {
    let runId: string | null = null;
    try {
      const parsed = JSON.parse(row.launch_request);
      const run = registry.launch(parsed as LaunchRequest);
      runId = run?.id ?? null;
    } catch (e) {
      // Launch failed (bad request, concurrency cap, etc.) — log to stderr, still
      // advance next_fire_at so a broken schedule doesn't hot-loop every tick.
      // eslint-disable-next-line no-console
      console.error(`[scheduler] launch failed for "${row.name}" (${row.id}):`, (e as Error)?.message ?? e);
    }
    const next = computeNextFire(row, now);
    try {
      updateFiredStmt.run({ id: row.id, last_run_id: runId, last_fired_at: now, next_fire_at: next });
    } catch {
      /* row deleted mid-tick */
    }
  }
}

/** Wire the recurring scheduler tick. Called once by the main loop on boot. */
export function startScheduler() {
  const t = setInterval(tick, 30_000);
  // Never keep the Node process alive solely for the scheduler.
  t.unref();
  return t;
}

// ── routes ──────────────────────────────────────────────────────────────────────
export function registerScheduleRoutes(app: FastifyInstance) {
  // List all schedules (newest first).
  app.get('/api/schedules', async () => {
    return (listStmt.all() as ScheduleRow[]).map(rowToView);
  });

  // Create a schedule.
  app.post('/api/schedules', async (req, reply) => {
    const body = (req.body as any) ?? {};
    if (typeof body.name !== 'string' || !body.name.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const trig = validateTrigger(body);
    if (!trig.ok) {
      reply.code(400);
      return { error: trig.error };
    }
    const lr = validateLaunchRequest(body.launch_request);
    if (!lr.ok) {
      reply.code(400);
      return { error: lr.error };
    }
    const enabled = body.enabled === undefined ? true : !!body.enabled;
    const now = Date.now();
    const next = enabled ? computeNextFire({ interval_ms: trig.intervalMs, daily_at: trig.dailyAt }, now) : null;
    const id = randomUUID();
    insertStmt.run({
      id,
      name: body.name.trim(),
      interval_ms: trig.intervalMs,
      daily_at: trig.dailyAt,
      launch_request: JSON.stringify(lr.value),
      enabled: enabled ? 1 : 0,
      last_run_id: null,
      last_fired_at: null,
      next_fire_at: next,
      created_at: now,
    });
    reply.code(201);
    return rowToView(getStmt.get(id) as ScheduleRow);
  });

  // Update: enable/disable and/or edit a schedule.
  app.put('/api/schedules/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const existing = getStmt.get(id) as ScheduleRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = (req.body as any) ?? {};

    // name (optional)
    let name = existing.name;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        reply.code(400);
        return { error: 'name must be a non-empty string' };
      }
      name = body.name.trim();
    }

    // trigger (optional, but if either trigger field is present we re-validate the pair)
    let intervalMs = existing.interval_ms;
    let dailyAt = existing.daily_at;
    if (body.interval_ms !== undefined || body.daily_at !== undefined) {
      const trig = validateTrigger({
        interval_ms: body.interval_ms !== undefined ? body.interval_ms : null,
        daily_at: body.daily_at !== undefined ? body.daily_at : null,
      });
      if (!trig.ok) {
        reply.code(400);
        return { error: trig.error };
      }
      intervalMs = trig.intervalMs;
      dailyAt = trig.dailyAt;
    }

    // launch_request (optional)
    let launchRequestStr = existing.launch_request;
    if (body.launch_request !== undefined) {
      const lr = validateLaunchRequest(body.launch_request);
      if (!lr.ok) {
        reply.code(400);
        return { error: lr.error };
      }
      launchRequestStr = JSON.stringify(lr.value);
    }

    // enabled (optional)
    const enabled = body.enabled === undefined ? !!existing.enabled : !!body.enabled;

    // Recompute next_fire_at: when enabling (from off→on) or when the trigger changed,
    // schedule fresh from now; when disabling, clear it; otherwise keep the existing slot.
    const triggerChanged = intervalMs !== existing.interval_ms || dailyAt !== existing.daily_at;
    const wasEnabled = !!existing.enabled;
    let nextFire = existing.next_fire_at;
    if (!enabled) {
      nextFire = null;
    } else if (!wasEnabled || triggerChanged || existing.next_fire_at == null) {
      nextFire = computeNextFire({ interval_ms: intervalMs, daily_at: dailyAt }, Date.now());
    }

    updateStmt.run({
      id,
      name,
      interval_ms: intervalMs,
      daily_at: dailyAt,
      launch_request: launchRequestStr,
      enabled: enabled ? 1 : 0,
      next_fire_at: nextFire,
    });
    return rowToView(getStmt.get(id) as ScheduleRow);
  });

  // Delete a schedule.
  app.delete('/api/schedules/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const existing = getStmt.get(id) as ScheduleRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    deleteStmt.run(id);
    return { ok: true };
  });

  // Run-now: launch immediately, record it, advance next_fire_at, leave the schedule as-is.
  app.post('/api/schedules/:id/run', async (req, reply) => {
    const id = (req.params as any).id;
    const existing = getStmt.get(id) as ScheduleRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    let parsed: LaunchRequest;
    try {
      parsed = JSON.parse(existing.launch_request);
    } catch {
      reply.code(400);
      return { error: 'stored launch_request is invalid' };
    }
    try {
      const run = registry.launch(parsed);
      const now = Date.now();
      // Advance the next slot only for an enabled schedule (manual run counts as a firing).
      const next = existing.enabled ? computeNextFire(existing, now) : existing.next_fire_at;
      updateFiredStmt.run({ id, last_run_id: run?.id ?? null, last_fired_at: now, next_fire_at: next });
      return { ok: true, runId: run?.id ?? null };
    } catch (e: any) {
      reply.code(e?.statusCode ?? 500);
      return { error: e?.message ?? 'launch failed' };
    }
  });
}
