/**
 * Loops (loop-engineering, spec docs/superpowers/specs/2026-06-13-loop-engineering-design.md §4.1).
 *
 * A Loop is a first-class, persisted, contract-bearing entity: it wakes on a SCHEDULE, reads STATE
 * via a control-plane adapter, does ONE JOB within fixed PERMISSIONS, writes results back, sleeps.
 * Self-contained module (mirrors scheduler.ts / projects.ts): owns the `loops` table via the shared
 * sqlite handle, exposes `loopsRepo`, `validateContract`, `compileContract`, the `loops` singleton
 * (init/fire) and `registerLoopRoutes(app)`.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import db from './db.js';
import type {
  Loop,
  LoopContract,
  CreateLoopRequest,
  LoopKind,
  LoopMode,
  ControlPlaneKind,
  MergePosture,
  RiskLevel,
  RiskRule,
  LoopEvalResult,
  Project,
  PermissionMode,
} from '@fleet/shared';
import { disallowedToolsForProject } from './pm.js';

// ── schema (idempotent — CREATE-body carries every column; the ALTER loop upgrades old DBs) ──
db.exec(`
CREATE TABLE IF NOT EXISTS loops (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  project_id             TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  control_plane          TEXT NOT NULL DEFAULT 'board',
  schedule_id            TEXT,
  contract               TEXT NOT NULL,
  mode                   TEXT NOT NULL DEFAULT 'dry-run',
  consecutive_good_runs  INTEGER NOT NULL DEFAULT 0,
  escalation_threshold   INTEGER NOT NULL DEFAULT 3,
  merge_posture          TEXT NOT NULL DEFAULT 'human-gate',
  review_policy          TEXT NOT NULL DEFAULT 'always',
  risk_rubric            TEXT NOT NULL DEFAULT '[]',
  routable_ceiling       TEXT NOT NULL DEFAULT 'low',
  enabled                INTEGER NOT NULL DEFAULT 1,
  last_run_id            TEXT,
  last_eval              TEXT,
  last_error             TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loops_project ON loops(project_id, enabled);
`);

// Swallow ONLY the idempotent "duplicate column name" (mirrors db.ts / projects.ts / scheduler.ts).
for (const ddl of [
  // future columns land here; CREATE body above is the source of truth for a fresh DB.
] as string[]) {
  try {
    db.exec(ddl);
  } catch (e: any) {
    if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
  }
}

// ── row mappers (snake_case ↔ camelCase, like db.ts / projects.ts) ──────────────
function parseContract(s: string): LoopContract {
  try {
    const c = JSON.parse(s);
    return {
      job: String(c.job ?? ''),
      inputs: String(c.inputs ?? ''),
      allowed: Array.isArray(c.allowed) ? c.allowed.map(String) : [],
      forbidden: Array.isArray(c.forbidden) ? c.forbidden.map(String) : [],
      output: String(c.output ?? ''),
      evaluation: String(c.evaluation ?? ''),
    };
  } catch {
    return { job: '', inputs: '', allowed: [], forbidden: [], output: '', evaluation: '' };
  }
}
function parseRubric(s: string): RiskRule[] {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v
      .filter((r) => r && typeof r.glob === 'string')
      .map((r) => ({ glob: String(r.glob), forceRisk: (r.forceRisk ?? 'high') as RiskLevel }));
  } catch {
    return [];
  }
}
function parseEval(s: string | null): LoopEvalResult | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return { clean: !!v.clean, score: Number(v.score ?? 0), notes: String(v.notes ?? '') };
  } catch {
    return null;
  }
}

function rowToLoop(row: any): Loop {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    kind: row.kind as LoopKind,
    controlPlane: (row.control_plane ?? 'board') as ControlPlaneKind,
    scheduleId: row.schedule_id ?? null,
    contract: parseContract(row.contract),
    mode: row.mode as LoopMode,
    consecutiveGoodRuns: row.consecutive_good_runs,
    escalationThreshold: row.escalation_threshold,
    mergePosture: (row.merge_posture ?? 'human-gate') as MergePosture,
    reviewPolicy: row.review_policy ?? 'always',
    riskRubric: parseRubric(row.risk_rubric ?? '[]'),
    routableCeiling: (row.routable_ceiling ?? 'low') as RiskLevel,
    enabled: !!row.enabled,
    lastRunId: row.last_run_id ?? null,
    lastEval: parseEval(row.last_eval ?? null),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
  };
}

// ── prepared statements ─────────────────────────────────────────────────────────
const insertStmt = db.prepare(`
INSERT INTO loops (id, name, project_id, kind, control_plane, schedule_id, contract, mode,
  consecutive_good_runs, escalation_threshold, merge_posture, review_policy, risk_rubric,
  routable_ceiling, enabled, last_run_id, last_eval, last_error, created_at)
VALUES (@id, @name, @project_id, @kind, @control_plane, @schedule_id, @contract, @mode,
  @consecutive_good_runs, @escalation_threshold, @merge_posture, @review_policy, @risk_rubric,
  @routable_ceiling, @enabled, @last_run_id, @last_eval, @last_error, @created_at)
`);
const getStmt = db.prepare('SELECT * FROM loops WHERE id = ?');
const listAllStmt = db.prepare('SELECT * FROM loops ORDER BY created_at DESC');
const listByProjectStmt = db.prepare('SELECT * FROM loops WHERE project_id = ? ORDER BY created_at DESC');
const enabledByKindStmt = db.prepare('SELECT * FROM loops WHERE project_id = ? AND kind = ? AND enabled = 1 ORDER BY created_at DESC');
const deleteStmt = db.prepare('DELETE FROM loops WHERE id = ?');
const updateStmt = db.prepare(`
UPDATE loops SET name=@name, kind=@kind, control_plane=@control_plane, schedule_id=@schedule_id,
  contract=@contract, escalation_threshold=@escalation_threshold, merge_posture=@merge_posture,
  review_policy=@review_policy, risk_rubric=@risk_rubric, routable_ceiling=@routable_ceiling,
  enabled=@enabled WHERE id=@id
`);
const setModeStmt = db.prepare('UPDATE loops SET mode=@mode WHERE id=@id');
const recordRunStmt = db.prepare('UPDATE loops SET last_run_id=@last_run_id, last_eval=@last_eval, last_error=@last_error WHERE id=@id');
const setGoodRunsStmt = db.prepare('UPDATE loops SET consecutive_good_runs=@n WHERE id=@id');

// ── repo ─────────────────────────────────────────────────────────────────────────
export const loopsRepo = {
  create(req: CreateLoopRequest): Loop {
    const id = randomUUID();
    const now = Date.now();
    insertStmt.run({
      id,
      name: req.name,
      project_id: req.projectId,
      kind: req.kind,
      control_plane: req.controlPlane ?? 'board',
      schedule_id: req.scheduleId ?? null,
      contract: JSON.stringify(req.contract),
      mode: 'dry-run', // forced start (spec §6.2 / §20)
      consecutive_good_runs: 0,
      // Defensive clamp: a threshold <= 0 makes the dry-run ramp inert (1 >= 0 is true on the first
      // clean run → instant apply, bypassing the safety ramp). Floor at 1 (Fix: threshold bypass).
      escalation_threshold: Math.max(1, Math.trunc(req.escalationThreshold ?? 3)),
      merge_posture: req.mergePosture ?? 'human-gate',
      review_policy: req.reviewPolicy ?? 'always',
      risk_rubric: JSON.stringify(req.riskRubric ?? []),
      routable_ceiling: req.routableCeiling ?? 'low',
      enabled: 1,
      last_run_id: null,
      last_eval: null,
      last_error: null,
      created_at: now,
    });
    return rowToLoop(getStmt.get(id));
  },

  list(projectId?: string): Loop[] {
    const rows = projectId ? listByProjectStmt.all(projectId) : listAllStmt.all();
    return (rows as any[]).map(rowToLoop);
  },

  get(id: string): Loop | null {
    const row = getStmt.get(id);
    return row ? rowToLoop(row) : null;
  },

  update(id: string, patch: Partial<CreateLoopRequest> & { enabled?: boolean }): Loop | null {
    const current = this.get(id);
    if (!current) return null;
    updateStmt.run({
      id,
      name: patch.name ?? current.name,
      kind: patch.kind ?? current.kind,
      control_plane: patch.controlPlane ?? current.controlPlane,
      schedule_id: patch.scheduleId !== undefined ? patch.scheduleId : current.scheduleId,
      contract: JSON.stringify(patch.contract ?? current.contract),
      // Defensive clamp (mirrors create): never persist a threshold < 1 that would defeat the ramp.
      escalation_threshold: Math.max(1, Math.trunc(patch.escalationThreshold ?? current.escalationThreshold)),
      merge_posture: patch.mergePosture ?? current.mergePosture,
      review_policy: patch.reviewPolicy ?? current.reviewPolicy,
      risk_rubric: JSON.stringify(patch.riskRubric ?? current.riskRubric),
      routable_ceiling: patch.routableCeiling ?? current.routableCeiling,
      enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    });
    return this.get(id);
  },

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    deleteStmt.run(id);
    return true;
  },

  enabledByKind(projectId: string, kind: LoopKind): Loop[] {
    return (enabledByKindStmt.all(projectId, kind) as any[]).map(rowToLoop);
  },

  setMode(id: string, mode: LoopMode): void {
    setModeStmt.run({ id, mode });
  },

  recordRun(id: string, info: { runId?: string | null; eval?: LoopEvalResult | null; error?: string | null }): void {
    const current = this.get(id);
    if (!current) return;
    recordRunStmt.run({
      id,
      last_run_id: info.runId !== undefined ? info.runId : current.lastRunId,
      last_eval: info.eval !== undefined ? (info.eval ? JSON.stringify(info.eval) : null) : (current.lastEval ? JSON.stringify(current.lastEval) : null),
      last_error: info.error !== undefined ? info.error : current.lastError,
    });
  },

  bumpGoodRuns(id: string): number {
    const current = this.get(id);
    if (!current) return 0;
    const n = current.consecutiveGoodRuns + 1;
    setGoodRunsStmt.run({ id, n });
    return n;
  },

  /**
   * Atomic bump-and-escalate (Fix: the un-transactioned bumpGoodRuns→setMode pair could crash between
   * the two writes, leaving counter==threshold with mode still 'dry-run' → a duplicate escalation on
   * the next clean run). Increment consecutive_good_runs and, IN THE SAME TRANSACTION, flip mode to
   * 'apply' iff the post-bump counter reaches the threshold. Returns { n, escalated }. The escalation
   * NOTIFICATION is intentionally NOT emitted here — callers fire it best-effort OUTSIDE the txn so a
   * notifier failure can never roll back the (committed) counter+mode change.
   */
  bumpAndEscalate(id: string, threshold: number): { n: number; escalated: boolean } {
    return bumpAndEscalateTxn(id, threshold) as { n: number; escalated: boolean };
  },

  resetGoodRuns(id: string): void {
    setGoodRunsStmt.run({ id, n: 0 });
  },
};

// The bump+flip must be a single SQLite transaction so a crash can never interleave the two writes.
// better-sqlite3 transactions are synchronous — the whole fn body runs atomically (BEGIN…COMMIT, or a
// full ROLLBACK on throw). We re-read inside the txn so the increment is computed from the committed row.
const bumpAndEscalateTxn = db.transaction((id: string, threshold: number) => {
  const row = getStmt.get(id) as any;
  if (!row) return { n: 0, escalated: false };
  const n = row.consecutive_good_runs + 1;
  setGoodRunsStmt.run({ id, n });
  let escalated = false;
  if (n >= threshold && row.mode === 'dry-run') {
    setModeStmt.run({ id, mode: 'apply' });
    escalated = true;
  }
  return { n, escalated };
});

// ── validateContract ─────────────────────────────────────────────────────────────

/**
 * Validate a six-part contract (spec §3). Returns an error MESSAGE (string) or null if valid.
 * The hard rule: an empty `evaluation` is rejected — "if you can't grade it, you're not ready to
 * run it autonomously." job/inputs/output are required free-text fields too.
 *
 * `opts` carries the loop-level merge/review posture so the cross-field SPEC §11 invariant can be
 * enforced at create/edit time: `mergePosture='auto-low-risk'` with `reviewPolicy='off'` is rejected —
 * auto-merge requires a maker/checker pass, but review 'off' skips the reviewing phase entirely, so
 * such a loop could auto-merge with no review (Fix 2).
 */
export function validateContract(
  c: LoopContract,
  opts?: { mergePosture?: MergePosture; reviewPolicy?: string },
): string | null {
  if (!c || typeof c !== 'object') return 'contract is required';
  if (!c.job || !c.job.trim()) return 'contract.job is required';
  if (!c.inputs || !c.inputs.trim()) return 'contract.inputs is required';
  if (!c.output || !c.output.trim()) return 'contract.output is required';
  if (!c.evaluation || !c.evaluation.trim()) {
    return 'contract.evaluation is required — if you cannot grade it, you cannot run it autonomously';
  }
  if (!Array.isArray(c.allowed)) return 'contract.allowed must be a string[]';
  if (!Array.isArray(c.forbidden)) return 'contract.forbidden must be a string[]';
  if (opts?.mergePosture === 'auto-low-risk' && opts?.reviewPolicy === 'off') {
    return "mergePosture 'auto-low-risk' requires a review — set reviewPolicy to 'always' or 'threshold:<N>' (an auto-merge with no maker/checker pass is forbidden)";
  }
  return null;
}

// ── compileContract ──────────────────────────────────────────────────────────────

/**
 * Compile a loop's contract into the launch envelope every run the loop spawns inherits (spec §10).
 * - `contract.allowed`  → allowedTools.
 * - `contract.forbidden` is MERGED ON TOP of pm.disallowedToolsForProject(project) — the baseline
 *   `Bash(git push *)`/`Bash(git remote *)` deny is never relaxed. Compilation may only ADD denies.
 * - permissionMode per kind: manager = read-only / non-interactive ('default'); worker = the existing
 *   PM isolated-worktree 'bypassPermissions' posture.
 */
export function compileContract(
  loop: Loop,
  project: Project,
): { allowedTools: string[]; disallowedTools: string[]; permissionMode: PermissionMode } {
  const baseline = disallowedToolsForProject(project); // already a fresh array
  // Union (baseline ∪ forbidden) — only ADD; preserve baseline order, then append new forbids.
  const disallowed = [...baseline];
  for (const f of loop.contract.forbidden) {
    if (!disallowed.includes(f)) disallowed.push(f);
  }
  const permissionMode: PermissionMode = loop.kind === 'manager' ? 'default' : 'bypassPermissions';
  return {
    allowedTools: [...loop.contract.allowed],
    disallowedTools: disallowed,
    permissionMode,
  };
}

// ── applyEvalResult ──────────────────────────────────────────────────────────────

// The notifications table is owned by notifier.ts (columns id, run_id, kind, message, ts, read) and
// created idempotently before loops.init() runs. notifier.ts exports no public emit helper, so we
// own a prepared statement here (db.ts:resetAllData already treats notifications as cross-module).
// The statement is prepared LAZILY inside notifyEscalation — at module load time the notifications
// table may not exist yet (notifier.ts loads via server.ts, AFTER loops.ts in the test beforeAll).

/**
 * Apply a dry-run's grade to the escalation counter (spec §6.2 — the lifecycle's heart).
 * - apply-mode loop → no-op (a graded run only drives the dry-run→apply ramp; never re-grants).
 * - clean dry run   → consecutive_good_runs++; at >= escalation_threshold, AUTO-flip to apply
 *                     (no human gate) and emit a 'loop-escalation' notification.
 * - non-clean run   → reset the counter to 0; stay dry-run.
 * Returns the post-update consecutive_good_runs (for tests / callers).
 */
export function applyEvalResult(loop: Loop, evalResult: LoopEvalResult): number {
  if (loop.mode === 'apply') return loop.consecutiveGoodRuns; // already escalated — counter is frozen
  if (!evalResult.clean) {
    loopsRepo.resetGoodRuns(loop.id);
    return 0;
  }
  // Atomic bump+flip (Fix: a crash between the old un-transactioned bumpGoodRuns and setMode left
  // counter==threshold while mode stayed 'dry-run', causing a DUPLICATE escalation on re-entry). The
  // notification is best-effort and lives OUTSIDE the transaction so a notifier failure can't roll back.
  const { n, escalated } = loopsRepo.bumpAndEscalate(loop.id, loop.escalationThreshold);
  if (escalated) {
    notifyEscalation(loop, n);
  }
  return n;
}

/** Emit a notification when a loop auto-escalates to apply-mode (spec §6.2 — notify, no human gate). */
function notifyEscalation(loop: Loop, goodRuns: number): void {
  try {
    db.prepare(
      'INSERT INTO notifications (id, run_id, kind, message, ts, read) VALUES (@id, @run_id, @kind, @message, @ts, @read)',
    ).run({
      id: randomUUID(),
      run_id: loop.lastRunId ?? null,
      kind: 'loop-escalation',
      message: `Loop "${loop.name}" auto-escalated to apply-mode after ${goodRuns} clean dry-run${goodRuns === 1 ? '' : 's'}.`,
      ts: Date.now(),
      read: 0,
    });
  } catch {
    /* best-effort — an escalation notification must never destabilize the fire path */
  }
}

// ── loops singleton ──────────────────────────────────────────────────────────────

/**
 * The loops driver singleton (spec §6).
 * - init(): boot reconcile — a loop has no live process across a restart, so nothing here re-grants
 *   apply-mode; mode/counter persist in SQLite. We only clear a stale last_error left mid-fire so the
 *   UI never shows a permanent error from an interrupted dry run (mirrors pm.reconcile resetting
 *   mid-flight cards). Called once by the main loop on boot.
 * - hasWork(loopId): cheap "is there anything to do?" probe the scheduler consults before firing — a
 *   loop with no work is skipped but its cadence still advances (spec §13). Never throws.
 * - fire(loopId): manager path. Worker loops are driven by pm.ts (Slice 08); fire() for a worker just
 *   records the tick. A fire is a safe no-op for a missing or disabled loop (defers, no spend).
 */
class LoopEngine {
  init(): void {
    // Boot reconcile: clear any last_error from a fire interrupted by a crash. mode + counter are
    // intentionally LEFT AS-IS (persisted in SQLite) so a restart never silently re-grants apply-mode
    // and never silently loses escalation progress (spec §18 boot-reconcile).
    try {
      db.prepare("UPDATE loops SET last_error = NULL WHERE last_error LIKE 'mid-fire:%'").run();
    } catch {
      /* best-effort — a reconcile failure must never block boot */
    }
  }

  /**
   * Does this loop have anything to do right now? The scheduler (Slice 04) calls this before fire():
   * no work → skip the fire but still advance the cadence (spec §13). A manager has work when its
   * control plane has untriaged backlog; a worker when there are agent:ready cards to pick up. Any
   * missing/disabled loop, missing project, or thrown adapter error resolves to `false` (never throws).
   */
  async hasWork(loopId: string): Promise<boolean> {
    try {
      const loop = loopsRepo.get(loopId);
      if (!loop || !loop.enabled) return false;
      const { projectsRepo } = await import('./projects.js');
      const project = projectsRepo.getProject(loop.projectId);
      if (!project) return false;
      const { controlPlaneFor } = await import('./controlplane.js'); // Slice 03
      const { cp } = controlPlaneFor(loop, project);
      if (loop.kind === 'manager') return (await cp.listBacklog()).length > 0;
      return (await cp.listReady()).length > 0; // worker
    } catch {
      return false; // a probe must never throw — defer the fire, advance the cadence
    }
  }

  async fire(loopId: string): Promise<void> {
    const loop = loopsRepo.get(loopId);
    if (!loop || !loop.enabled) return; // missing/disabled → defer, no spend

    // Worker loops execute through pm.ts (Slice 08). fire() for a worker just records the tick so the
    // scheduler's last_run bookkeeping has something to point at; the selection/review/gate logic lives
    // in pm.tick.
    if (loop.kind === 'worker') {
      loopsRepo.recordRun(loop.id, { error: null });
      return;
    }

    const { projectsRepo } = await import('./projects.js');
    const project = projectsRepo.getProject(loop.projectId);
    if (!project) {
      loopsRepo.recordRun(loop.id, { error: 'project not found' });
      return;
    }

    try {
      // Dynamic imports so loops.ts compiles before Slices 03/05/06 land (see note above).
      const { controlPlaneFor } = await import('./controlplane.js'); // Slice 03
      const { runManagerLoop } = await import('./manager.js'); // Slice 06
      const { gradeLoopRun } = await import('./loopEval.js'); // Slice 05
      // controlPlaneFor wraps the adapter: in dry-run, cp writes are intercepted into the tuple's
      // `intended` array and NOT performed; in apply, writes are real and `intended` stays empty
      // (Slice 03). runManagerLoop drives the cp; the dry-run wrapper RECORDS the intended actions
      // INTO this same `intended` array — so we grade the TUPLE's `intended`, NOT runManagerLoop's
      // return value (it must not be relied on for the intended set).
      const { cp, intended } = controlPlaneFor(loop, project);
      await runManagerLoop(loop, project, cp); // Slice 06 — drives cp; fills `intended` via the wrapper
      const evalResult = await gradeLoopRun(loop, intended, project); // Slice 05 — grades the tuple's intended
      loopsRepo.recordRun(loop.id, { eval: evalResult, error: null });
      // Escalation only ramps in dry-run; applyEvalResult is a no-op once mode==='apply'.
      if (loop.mode === 'dry-run') applyEvalResult(loopsRepo.get(loop.id)!, evalResult);
    } catch (e: any) {
      // A cap rejection must propagate so the scheduler's capBlocked path defers the cadence and
      // retries next tick (spec §13) — exactly the 429 / 'daily-cap' contract scheduler.ts already
      // honors. RETHROW those; all OTHER errors are swallowed into a non-clean run (never auto-escalate
      // on uncertainty): the error lands in last_error and the dry-run counter resets.
      if (e?.statusCode === 429 || e?.code === 'daily-cap') throw e;
      // Prefix the error so init()'s boot-reconcile (UPDATE ... WHERE last_error LIKE 'mid-fire:%')
      // can clear it on the next boot — without the prefix the predicate never matches and a crashed
      // fire's error persists forever (Fix: boot-reconcile was inert).
      loopsRepo.recordRun(loop.id, { error: `mid-fire: ${e?.message ?? 'fire failed'}` });
      // Re-fetch the LIVE loop: a concurrent promote during the awaits above may have flipped mode to
      // 'apply' in the DB, but the `loop` snapshot (captured before the awaits) still says 'dry-run'.
      // Gate the reset on the FRESH mode so we never wrongly reset an already-escalated loop's counter.
      const live = loopsRepo.get(loop.id);
      if (live?.mode === 'dry-run') loopsRepo.resetGoodRuns(loop.id);
    }
  }
}

export const loops = new LoopEngine();

// ── registerLoopRoutes ────────────────────────────────────────────────────────────

/** REST routes mirroring scheduler.ts / triggers.ts (spec §16). */
export function registerLoopRoutes(app: FastifyInstance): void {
  // List (newest first; optional ?projectId= filter).
  app.get('/api/loops', async (req) => {
    const projectId = (req.query as any)?.projectId as string | undefined;
    return loopsRepo.list(projectId);
  });

  // Detail.
  app.get('/api/loops/:id', async (req, reply) => {
    const loop = loopsRepo.get((req.params as any).id);
    if (!loop) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    return loop;
  });

  // Create (rejects an empty contract.evaluation per spec §3).
  app.post('/api/loops', async (req, reply) => {
    const body = (req.body as any) ?? {};
    if (typeof body.name !== 'string' || !body.name.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const { projectsRepo } = await import('./projects.js');
    if (typeof body.projectId !== 'string' || !projectsRepo.getProject(body.projectId)) {
      reply.code(400);
      return { error: 'projectId must reference an existing project' };
    }
    if (body.kind !== 'manager' && body.kind !== 'worker') {
      reply.code(400);
      return { error: "kind must be 'manager' or 'worker'" };
    }
    // Validate the contract AND the SPEC §11 cross-field invariant against the EFFECTIVE posture/policy
    // (apply the repo's create-time defaults so an omitted field is graded as what will be stored).
    const cErr = validateContract(body.contract, {
      mergePosture: body.mergePosture ?? 'human-gate',
      reviewPolicy: body.reviewPolicy ?? 'always',
    });
    if (cErr) {
      reply.code(400);
      return { error: cErr };
    }
    // escalationThreshold, when provided, must be an integer >= 1. A 0 (or negative) would defeat the
    // dry-run ramp entirely — the FIRST clean run satisfies `1 >= 0`, instant-applying with no safety
    // window (Fix: threshold bypass).
    if (body.escalationThreshold !== undefined) {
      if (!Number.isInteger(body.escalationThreshold) || body.escalationThreshold < 1) {
        reply.code(400);
        return { error: 'escalationThreshold must be an integer >= 1' };
      }
    }
    const created = loopsRepo.create({
      name: body.name.trim(),
      projectId: body.projectId,
      kind: body.kind,
      controlPlane: body.controlPlane,
      scheduleId: body.scheduleId ?? null,
      contract: body.contract,
      escalationThreshold: body.escalationThreshold,
      mergePosture: body.mergePosture,
      reviewPolicy: body.reviewPolicy,
      riskRubric: body.riskRubric,
      routableCeiling: body.routableCeiling,
    });
    reply.code(201);
    return created;
  });

  // Edit (re-validates the contract when one is provided; enable/disable/posture/schedule).
  app.put('/api/loops/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const current = loopsRepo.get(id);
    if (!current) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    const body = (req.body as any) ?? {};
    // Re-validate the contract (when provided) AND the SPEC §11 cross-field invariant against the
    // EFFECTIVE post-edit posture/policy (an edit that flips only mergePosture or reviewPolicy must
    // still be rejected if the resulting pair is auto-low-risk + review off).
    const effective = {
      mergePosture: (body.mergePosture ?? current.mergePosture) as MergePosture,
      reviewPolicy: (body.reviewPolicy ?? current.reviewPolicy) as string,
    };
    if (body.contract !== undefined) {
      const cErr = validateContract(body.contract, effective);
      if (cErr) {
        reply.code(400);
        return { error: cErr };
      }
    } else if (effective.mergePosture === 'auto-low-risk' && effective.reviewPolicy === 'off') {
      reply.code(400);
      return {
        error:
          "mergePosture 'auto-low-risk' requires a review — set reviewPolicy to 'always' or 'threshold:<N>' (an auto-merge with no maker/checker pass is forbidden)",
      };
    }
    // Same threshold guard as POST: a provided escalationThreshold must be an integer >= 1 (Fix).
    if (body.escalationThreshold !== undefined) {
      if (!Number.isInteger(body.escalationThreshold) || body.escalationThreshold < 1) {
        reply.code(400);
        return { error: 'escalationThreshold must be an integer >= 1' };
      }
    }
    return loopsRepo.update(id, {
      name: body.name,
      kind: body.kind,
      controlPlane: body.controlPlane,
      scheduleId: body.scheduleId,
      contract: body.contract,
      escalationThreshold: body.escalationThreshold,
      mergePosture: body.mergePosture,
      reviewPolicy: body.reviewPolicy,
      riskRubric: body.riskRubric,
      routableCeiling: body.routableCeiling,
      enabled: body.enabled,
    });
  });

  // Delete.
  app.delete('/api/loops/:id', async (req, reply) => {
    if (!loopsRepo.remove((req.params as any).id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });

  // Run-now: one fire, respecting the loop's current mode. The response surfaces `runId` (the loop's
  // post-fire lastRunId) — Slice 09's web client reads it to open the run's comments. `loop` is the
  // refreshed row.
  app.post('/api/loops/:id/fire', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    await loops.fire(id);
    const loop = loopsRepo.get(id);
    return { ok: true, runId: loop?.lastRunId ?? null, loop };
  });

  // Manual escape hatches: flip dry-run → apply / apply → dry-run.
  app.post('/api/loops/:id/promote', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    loopsRepo.setMode(id, 'apply');
    return loopsRepo.get(id);
  });
  app.post('/api/loops/:id/demote', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    loopsRepo.setMode(id, 'dry-run');
    loopsRepo.resetGoodRuns(id); // demoting restarts the dry-run ramp
    return loopsRepo.get(id);
  });
}
