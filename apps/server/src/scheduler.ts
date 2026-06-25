/**
 * Portal-side scheduler (Feature A4 + F2): recurring / one-shot launches of agent runs,
 * with NO cron dependency. Three trigger types:
 *   • interval_ms  — fire every N ms (N >= 60_000)           [legacy field, still supported]
 *   • daily_at     — fire once per day at a local "HH:MM"    [legacy field, still supported]
 *   • recurrence   — F2 grammar: every:<minutes> | daily:<HH:MM> | weekly:<0-6>:<HH:MM>
 *
 * A single 30s tick (unref'd) finds enabled, due schedules and calls registry.launch().
 * next_fire_at is precomputed on create / enable / edit and recomputed after every firing.
 *
 * F2 guardrails:
 *   - A fire blocked by 429 or 409 'daily-cap' does NOT advance next_fire_at (retry next tick).
 *   - Only after a successful or permanently-failed launch is next_fire_at advanced.
 *   - one-shot schedules (recurrence NULL) null out next_fire_at after firing (legacy behavior).
 *   - catch-up policy = SKIP missed windows: recurring schedules always schedule from NOW.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import db from './db.js';
import { repo } from './db.js';
import { registry } from './registry.js';
import type { LaunchRequest } from '@fleet/shared';
import { loopsRepo } from './loops.js';

// ── F2: add new columns if they don't exist (migration-safe) ────────────────
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

// F2 — add columns that may not exist in an older DB (idempotent migrations).
for (const [col, def] of [
  ['recurrence', 'TEXT'],
  ['template', 'TEXT'],
  // Slice 04: a schedule may target a Loop instead of a raw launch_request. NOTE: a loop-targeted
  // schedule still stores an (unused) placeholder launch_request — the loop fire path ignores it
  // (known v1 API wart; launch_request stays NOT NULL for backward-compat with raw-launch rows).
  ['loop_id', 'TEXT'],
] as [string, string][]) {
  try {
    db.exec(`ALTER TABLE schedules ADD COLUMN ${col} ${def}`);
  } catch {
    /* column already exists — ignore */
  }
}

// ── shapes ─────────────────────────────────────────────────────────────────────
interface ScheduleRow {
  id: string;
  name: string;
  interval_ms: number | null;
  daily_at: string | null;
  /** F2: every:<min> | daily:<HH:MM> | weekly:<0-6>:<HH:MM> | null = one-shot */
  recurrence: string | null;
  /** F2: template NAME whose profile fields apply at fire time */
  template: string | null;
  /** Slice 04: FK → loops.id; when set the tick fires loops.fire(loop_id) instead of registry.launch */
  loop_id: string | null;
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
  /** F2 recurrence grammar string or null for one-shot */
  recurrence: string | null;
  /** F2 template name or null */
  template: string | null;
  /** Slice 04: target Loop id or null for a raw launch_request schedule */
  loopId: string | null;
  launchRequest: LaunchRequest;
  enabled: boolean;
  lastRunId: string | null;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  createdAt: number;
}

const MIN_INTERVAL_MS = 60_000;
/** F2: every:<min> bounds (15–10080 minutes = 15 min – 7 days) */
const EVERY_MIN_LOWER = 15;
const EVERY_MIN_UPPER = 10080;
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
    recurrence: row.recurrence ?? null,
    template: row.template ?? null,
    loopId: row.loop_id ?? null,
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
INSERT INTO schedules (id, name, interval_ms, daily_at, recurrence, template, loop_id, launch_request, enabled, last_run_id, last_fired_at, next_fire_at, created_at)
VALUES (@id, @name, @interval_ms, @daily_at, @recurrence, @template, @loop_id, @launch_request, @enabled, @last_run_id, @last_fired_at, @next_fire_at, @created_at)
`);
const listStmt = db.prepare('SELECT * FROM schedules ORDER BY created_at DESC');
const getStmt = db.prepare('SELECT * FROM schedules WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM schedules WHERE id = ?');
const dueStmt = db.prepare(
  'SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?',
);
const updateStmt = db.prepare(`
UPDATE schedules SET name=@name, interval_ms=@interval_ms, daily_at=@daily_at, recurrence=@recurrence, template=@template,
  loop_id=@loop_id, launch_request=@launch_request, enabled=@enabled, next_fire_at=@next_fire_at WHERE id=@id
`);
const updateFiredStmt = db.prepare(
  'UPDATE schedules SET last_run_id=@last_run_id, last_fired_at=@last_fired_at, next_fire_at=@next_fire_at WHERE id=@id',
);

// ── F2: recurrence grammar ─────────────────────────────────────────────────────

/**
 * Validate the F2 recurrence grammar string.
 * Returns {ok:true} or {ok:false, error}.
 * Grammar:
 *   every:<minutes>       15–10080 (integer)
 *   daily:<HH:MM>         server-local time
 *   weekly:<0-6>:<HH:MM>  0=Sunday, server-local time
 */
export function validateRecurrence(s: string): { ok: true } | { ok: false; error: string } {
  if (s.startsWith('every:')) {
    const n = Number(s.slice(6));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < EVERY_MIN_LOWER || n > EVERY_MIN_UPPER) {
      return { ok: false, error: `every:<minutes> must be integer ${EVERY_MIN_LOWER}–${EVERY_MIN_UPPER}` };
    }
    return { ok: true };
  }
  if (s.startsWith('daily:')) {
    const t = s.slice(6);
    if (!HHMM_RE.test(t)) return { ok: false, error: 'daily:<HH:MM> — time must be HH:MM (00:00–23:59)' };
    return { ok: true };
  }
  if (s.startsWith('weekly:')) {
    const rest = s.slice(7);
    const m = /^([0-6]):([01]\d|2[0-3]):([0-5]\d)$/.exec(rest);
    if (!m) return { ok: false, error: 'weekly:<0-6>:<HH:MM> — day 0=Sun…6=Sat, time HH:MM' };
    return { ok: true };
  }
  return { ok: false, error: 'recurrence must start with every: | daily: | weekly:' };
}

/**
 * Pure helper — compute the next firing time for a recurrence string.
 * Uses server-local time (DST-safe: uses Date constructor not arithmetic).
 * `from` defaults to Date.now().
 *
 * Exported for unit tests.
 */
export function nextFire(recurrence: string, from = Date.now()): number | null {
  if (recurrence.startsWith('every:')) {
    const minutes = Number(recurrence.slice(6));
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) return null;
    return from + minutes * 60_000;
  }
  if (recurrence.startsWith('daily:')) {
    const t = recurrence.slice(6);
    const m = HHMM_RE.exec(t);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const d = new Date(from);
    // Build candidate in LOCAL time — respects DST
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
    // If today's slot already passed (or is exactly now), roll to tomorrow
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  if (recurrence.startsWith('weekly:')) {
    const rest = recurrence.slice(7);
    const m = /^([0-6]):([01]\d|2[0-3]):([0-5]\d)$/.exec(rest);
    if (!m) return null;
    const targetDay = Number(m[1]); // 0=Sun
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    const d = new Date(from);
    // Try each of the next 7 days (inclusive of today) in local time
    for (let i = 0; i <= 7; i++) {
      const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
      if (candidate.getDay() === targetDay && candidate.getTime() > from) {
        return candidate.getTime();
      }
    }
    return null;
  }
  return null;
}

// ── legacy next-fire (interval_ms / daily_at) ─────────────────────────────────

/** Next firing time given a legacy trigger, computed from `from` (default: now). */
function computeNextFire(row: { interval_ms: number | null; daily_at: string | null; recurrence?: string | null }, from = Date.now()): number | null {
  // F2: recurrence grammar takes priority when present
  if (row.recurrence) {
    return nextFire(row.recurrence, from);
  }
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

/** Validate a launch_request has the minimum shape the scheduler needs (prompt + cwd).
 * Only prompt and cwd are required; model/effort/permissionMode are stored as-is so the
 * template profile (applied at fire time) can fill them in. */
function validateLaunchRequest(lr: any): { ok: true; value: LaunchRequest } | { ok: false; error: string } {
  if (!lr || typeof lr !== 'object') return { ok: false, error: 'launch_request must be an object' };
  if (typeof lr.prompt !== 'string' || !lr.prompt.trim()) return { ok: false, error: 'launch_request.prompt is required' };
  if (typeof lr.cwd !== 'string' || !lr.cwd.startsWith('/') || lr.cwd.includes('..') || lr.cwd.includes('\0')) {
    return { ok: false, error: 'launch_request.cwd must be an absolute path' };
  }
  // Store only what the operator explicitly chose — do NOT backfill model/effort here.
  // Defaults are applied at fire time (after template profile) so a blank model lets the template win.
  const value: LaunchRequest = {
    ...lr,
    prompt: lr.prompt.trim(),
    cwd: lr.cwd,
  };
  return { ok: true, value };
}

/** Validate the trigger: exactly one of interval_ms | daily_at | recurrence. */
function validateTrigger(body: any): { ok: true; intervalMs: number | null; dailyAt: string | null; recurrence: string | null } | { ok: false; error: string } {
  const hasInterval = body?.interval_ms != null;
  const hasDaily = body?.daily_at != null && body?.daily_at !== '';
  const hasRecurrence = body?.recurrence != null && body?.recurrence !== '';

  // Exactly one must be provided
  const count = [hasInterval, hasDaily, hasRecurrence].filter(Boolean).length;
  if (count !== 1) {
    return { ok: false, error: 'provide exactly one of interval_ms, daily_at, or recurrence' };
  }

  if (hasRecurrence) {
    const r = validateRecurrence(String(body.recurrence));
    if (!r.ok) return r;
    return { ok: true, intervalMs: null, dailyAt: null, recurrence: String(body.recurrence) };
  }

  if (hasInterval) {
    const n = Number(body.interval_ms);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_INTERVAL_MS) {
      return { ok: false, error: `interval_ms must be an integer >= ${MIN_INTERVAL_MS}` };
    }
    return { ok: true, intervalMs: n, dailyAt: null, recurrence: null };
  }

  if (!HHMM_RE.test(String(body.daily_at))) {
    return { ok: false, error: 'daily_at must be "HH:MM" (00:00–23:59)' };
  }
  return { ok: true, intervalMs: null, dailyAt: String(body.daily_at), recurrence: null };
}

// ── F2: template profile application ─────────────────────────────────────────
/**
 * Apply a named template's profile fields to a LaunchRequest, mirroring
 * campaigns.launchWorker's template application. Returns a new LaunchRequest
 * with template fields overlaid (appendSystemPrompt, model, effort,
 * permissionMode, allowedTools, skills, budgetUsd).
 *
 * `templateWins` controls ONLY the model field: scheduled launches carry a
 * user-supplied model so the request wins (`templateWins: false`); triggers
 * build the base request without a model, so the template wins
 * (`templateWins: true`). Effort is always template-wins in both callers.
 */
export function applyTemplateProfile(
  lr: LaunchRequest,
  templateName: string,
  opts: { templateWins: boolean },
): LaunchRequest {
  const tpl = repo.getTemplateByName(templateName);
  if (!tpl) return lr; // template not found → launch as-is
  return {
    ...lr,
    model: opts.templateWins ? tpl.model || lr.model : lr.model || tpl.model,
    effort: (tpl.effort as LaunchRequest['effort']) || lr.effort,
    permissionMode: tpl.permissionMode || lr.permissionMode,
    allowedTools: tpl.allowedTools.length ? tpl.allowedTools : (lr.allowedTools ?? []),
    skills: tpl.skills.length ? tpl.skills : (lr.skills ?? []),
    budgetUsd: tpl.budgetUsd ?? lr.budgetUsd,
    appendSystemPrompt: tpl.systemPrompt
      ? lr.appendSystemPrompt
        ? `${lr.appendSystemPrompt}\n\n${tpl.systemPrompt}`
        : tpl.systemPrompt
      : lr.appendSystemPrompt,
  };
}

// ── tick ──────────────────────────────────────────────────────────────────────
// Re-entrancy guard: tick() is async and awaits registry.launch, which genuinely suspends
// for engine-routed schedules (getEngineBin / createWorktree). Without this, a tick that
// outlasts the 30s interval would let the next interval fire a concurrent tick that
// re-selects the same due rows whose next_fire_at has not been advanced yet, double-launching
// them. triggers.ts guards the identical async-conversion hazard the same way.
let tickInFlight = false;
async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await tickOnce();
  } finally {
    tickInFlight = false;
  }
}

async function tickOnce(): Promise<void> {
  const now = Date.now();
  let due: ScheduleRow[];
  try {
    due = dueStmt.all(now) as ScheduleRow[];
  } catch {
    return;
  }
  for (const row of due) {
    let runId: string | null = null;
    let launched = false;
    let capBlocked = false;
    try {
      // Slice 04: a schedule targeting a Loop drives loops.fire(loop_id), not registry.launch.
      if (row.loop_id) {
        // Lazy import keeps scheduler.ts free of a static edge to loops.ts (→ pm/server),
        // avoiding a module cycle.
        const { loops } = await import('./loops.js');
        const hasWork = await loops.hasWork(row.loop_id);
        if (hasWork) {
          await loops.fire(row.loop_id);
        }
        // Whether or not there was work, treat this as a firing: advance the cadence so
        // an empty-work loop simply retries next cadence (no spend, no penalty, no hot-loop).
        launched = true;
      } else {
        let parsed: LaunchRequest = JSON.parse(row.launch_request);
        // F2: apply template profile first (template wins for unset fields), then fill defaults.
        if (row.template) {
          parsed = applyTemplateProfile(parsed, row.template, { templateWins: false });
        }
        // Apply defaults for any fields still unset after template merge.
        parsed = {
          ...parsed,
          model: parsed.model || 'claude-opus-4-8',
          effort: parsed.effort || 'high',
          permissionMode: parsed.permissionMode || 'default',
        };
        const run = await registry.launch(parsed);
        runId = run?.id ?? null;
        launched = true;
      }
    } catch (e: any) {
      // F2 guardrail: 429 (concurrency cap) or 409 'daily-cap' must NOT advance next_fire_at.
      // We track capBlocked and skip the updateFiredStmt call in that case.
      if (e?.statusCode === 429 || e?.code === 'daily-cap') {
        capBlocked = true;
      } else {
        // Permanent failure (bad request, etc.) — log and advance so a broken schedule
        // doesn't hot-loop every 30s.
        // eslint-disable-next-line no-console
        console.error(`[scheduler] launch failed for "${row.name}" (${row.id}):`, (e as Error)?.message ?? e);
        launched = true; // treat permanent failure as "fired" — advance past it
      }
    }

    if (capBlocked) {
      // Do NOT advance next_fire_at — will retry on the next tick.
      continue;
    }

    if (launched) {
      // F2: for recurring schedules, compute next from NOW (catch-up = SKIP).
      // For one-shot (no recurrence, no interval_ms, no daily_at — or all null),
      // next_fire_at becomes null (consumed).
      const isRecurring = !!(row.recurrence || row.interval_ms != null || row.daily_at != null);
      const next = isRecurring ? computeNextFire(row, now) : null;
      try {
        updateFiredStmt.run({ id: row.id, last_run_id: runId, last_fired_at: now, next_fire_at: next });
      } catch {
        /* row deleted mid-tick */
      }
    }
  }
}

/** Exported for tests only — calls one tick cycle. Do NOT use in production code. */
export const __tickForTests = tick;

/** Wire the recurring scheduler tick. Called once by the main loop on boot. */
export function startScheduler() {
  const t = setInterval(() => void tick(), 30_000);
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

    // F2: validate template if provided
    let templateName: string | null = null;
    if (body.template != null && body.template !== '') {
      if (typeof body.template !== 'string') {
        reply.code(400);
        return { error: 'template must be a string (template name)' };
      }
      const tpl = repo.getTemplateByName(body.template);
      if (!tpl) {
        reply.code(400);
        return { error: `template "${body.template}" not found` };
      }
      templateName = body.template;
    }

    // Slice 04: optional loop_id — a schedule may drive a Loop instead of a raw launch.
    let loopId: string | null = null;
    if (body.loop_id != null && body.loop_id !== '') {
      if (typeof body.loop_id !== 'string') {
        reply.code(400);
        return { error: 'loop_id must be a string (loop id)' };
      }
      if (!loopsRepo.get(body.loop_id)) {
        reply.code(400);
        return { error: `loop "${body.loop_id}" not found` };
      }
      loopId = body.loop_id;
    }

    const enabled = body.enabled === undefined ? true : !!body.enabled;
    const now = Date.now();
    const next = enabled ? computeNextFire({ interval_ms: trig.intervalMs, daily_at: trig.dailyAt, recurrence: trig.recurrence }, now) : null;
    const id = randomUUID();
    insertStmt.run({
      id,
      name: body.name.trim(),
      interval_ms: trig.intervalMs,
      daily_at: trig.dailyAt,
      recurrence: trig.recurrence,
      template: templateName,
      loop_id: loopId,
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

    // trigger (optional, but if any trigger field is present we re-validate)
    let intervalMs = existing.interval_ms;
    let dailyAt = existing.daily_at;
    let recurrence = existing.recurrence ?? null;
    if (body.interval_ms !== undefined || body.daily_at !== undefined || body.recurrence !== undefined) {
      const trig = validateTrigger({
        interval_ms: body.interval_ms !== undefined ? body.interval_ms : null,
        daily_at: body.daily_at !== undefined ? body.daily_at : null,
        recurrence: body.recurrence !== undefined ? body.recurrence : null,
      });
      if (!trig.ok) {
        reply.code(400);
        return { error: trig.error };
      }
      intervalMs = trig.intervalMs;
      dailyAt = trig.dailyAt;
      recurrence = trig.recurrence;
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

    // F2: template (optional)
    let templateName = existing.template ?? null;
    if (body.template !== undefined) {
      if (body.template === null || body.template === '') {
        templateName = null;
      } else {
        if (typeof body.template !== 'string') {
          reply.code(400);
          return { error: 'template must be a string (template name)' };
        }
        const tpl = repo.getTemplateByName(body.template);
        if (!tpl) {
          reply.code(400);
          return { error: `template "${body.template}" not found` };
        }
        templateName = body.template;
      }
    }

    // enabled (optional)
    const enabled = body.enabled === undefined ? !!existing.enabled : !!body.enabled;

    // Recompute next_fire_at: when enabling (from off→on) or when the trigger changed,
    // schedule fresh from now; when disabling, clear it; otherwise keep the existing slot.
    const triggerChanged = intervalMs !== existing.interval_ms || dailyAt !== existing.daily_at || recurrence !== (existing.recurrence ?? null);
    const wasEnabled = !!existing.enabled;
    let nextFire = existing.next_fire_at;
    if (!enabled) {
      nextFire = null;
    } else if (!wasEnabled || triggerChanged || existing.next_fire_at == null) {
      nextFire = computeNextFire({ interval_ms: intervalMs, daily_at: dailyAt, recurrence }, Date.now());
    }

    updateStmt.run({
      id,
      name,
      interval_ms: intervalMs,
      daily_at: dailyAt,
      recurrence,
      template: templateName,
      // Slice 04: loop_id is intentionally immutable via PUT — it is set only at POST (Task 04.1).
      // We carry the existing value through unchanged so the widened updateStmt has every bind.
      loop_id: existing.loop_id ?? null,
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

    // Slice 04: a schedule targeting a Loop drives loops.fire(loop_id), not registry.launch.
    if (existing.loop_id) {
      try {
        const { loops } = await import('./loops.js');
        const hasWork = await loops.hasWork(existing.loop_id);
        if (hasWork) {
          await loops.fire(existing.loop_id);
        }
        const now = Date.now();
        // Advance the next slot only for an enabled schedule (manual run counts as a firing).
        const next = existing.enabled ? computeNextFire(existing, now) : existing.next_fire_at;
        updateFiredStmt.run({ id, last_run_id: null, last_fired_at: now, next_fire_at: next });
        return { ok: true, runId: null };
      } catch (e: any) {
        reply.code(e?.statusCode ?? 500);
        return { error: e?.message ?? 'loop fire failed' };
      }
    }

    let parsed: LaunchRequest;
    try {
      parsed = JSON.parse(existing.launch_request);
    } catch {
      reply.code(400);
      return { error: 'stored launch_request is invalid' };
    }
    // F2: apply template profile first, then fill any still-unset defaults.
    if (existing.template) {
      parsed = applyTemplateProfile(parsed, existing.template, { templateWins: false });
    }
    parsed = {
      ...parsed,
      model: parsed.model || 'claude-opus-4-8',
      effort: parsed.effort || 'high',
      permissionMode: parsed.permissionMode || 'default',
    };
    try {
      const run = await registry.launch(parsed);
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
