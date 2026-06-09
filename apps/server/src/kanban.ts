/**
 * Kanban board (agent-PM feature, spec docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md §4/§5/§8).
 *
 * Self-contained Lane-B module: owns the `kanban_tasks` table + its indexes via the
 * shared sqlite handle, exposes a `kanbanRepo` (the PM engine — pm.ts — consumes it),
 * a per-project board pub/sub (mirrors CampaignEngine's subs Map + broadcast), and
 * `registerKanbanRoutes(app)` for CRUD / reorder / Review actions.
 *
 * Frozen contract: KanbanTask / CreateKanbanTaskRequest / KanbanColumn / KANBAN_COLUMNS /
 * ExecutionPhase / KanbanBoardMessage are defined in @fleet/shared — this module persists
 * EXACTLY those fields (no extra columns; Review-action markers reuse existing fields).
 *
 * Board SSE: the stream route lives in server.ts (it needs the module-private `sse()`
 * helper for the connection cap + H3 origin echo); it calls `subscribeBoard(pid, send)`
 * here — exactly like the campaigns stream route calls `campaigns.subscribe`.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type {
  KanbanTask,
  CreateKanbanTaskRequest,
  KanbanColumn,
  ExecutionPhase,
  KanbanBoardMessage,
} from '@fleet/shared';
import { KANBAN_COLUMNS } from '@fleet/shared';
import db from './db.js';
import { planHasCycle, planHasDupIds } from './campaigns.js';
import { pm } from './pm.js'; // circular but runtime-safe: pm uses kanbanRepo only inside methods

// ── schema (idempotent) ───────────────────────────────────────────────────────
// NOTE: `column` and `rank` are SQLite keywords → always double-quoted in DDL/DML.
// CREATE-body carries every column (so a fresh DB never relies on the ALTER loop), and the ALTER
// loop below upgrades pre-existing DBs. (§3.1: kanban_tasks ALTERs live HERE, not in db.ts.)
db.exec(`
CREATE TABLE IF NOT EXISTS kanban_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  "column" TEXT NOT NULL DEFAULT 'Backlog',
  execution_phase TEXT NOT NULL DEFAULT 'idle',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  validation_command TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  "rank" TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  assignee TEXT NOT NULL DEFAULT 'human',
  labels TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  campaign_id TEXT,
  worktree_name TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  budget_usd REAL,
  validation_output TEXT,
  last_diff_hash TEXT,
  merge_sha TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'single',
  pr_url TEXT,
  pr_state TEXT,
  server_start_command TEXT,
  health_check_url TEXT,
  health_check_regex TEXT,
  resolve_attempt_count INTEGER NOT NULL DEFAULT 0,
  max_resolve_attempts INTEGER NOT NULL DEFAULT 2
);
CREATE INDEX IF NOT EXISTS idx_kanban_project ON kanban_tasks(project_id, "column", "rank");
CREATE INDEX IF NOT EXISTS idx_kanban_run ON kanban_tasks(run_id);
`);

// idempotent migrations for v2 columns + the campaign index (§3.1). `campaign_id` ALREADY exists
// in the base table, so only an index is added for it (NOT re-added as a column). Mirrors db.ts:
// swallow ONLY "duplicate column name"; rethrow any real DDL failure. SAFE on a fresh DB (runs
// after the CREATE TABLE above). `CREATE INDEX IF NOT EXISTS` is naturally idempotent.
for (const ddl of [
  "ALTER TABLE kanban_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'",
  'ALTER TABLE kanban_tasks ADD COLUMN pr_url TEXT',
  'ALTER TABLE kanban_tasks ADD COLUMN pr_state TEXT',
  'ALTER TABLE kanban_tasks ADD COLUMN server_start_command TEXT',
  'ALTER TABLE kanban_tasks ADD COLUMN health_check_url TEXT',
  'ALTER TABLE kanban_tasks ADD COLUMN health_check_regex TEXT',
  'ALTER TABLE kanban_tasks ADD COLUMN resolve_attempt_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE kanban_tasks ADD COLUMN max_resolve_attempts INTEGER NOT NULL DEFAULT 2',
  'CREATE INDEX IF NOT EXISTS idx_kanban_campaign ON kanban_tasks(campaign_id)',
]) {
  try {
    db.exec(ddl);
  } catch (e: any) {
    if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
  }
}

const KANBAN_COLS = new Set<string>(KANBAN_COLUMNS);
const PHASES = new Set<ExecutionPhase>([
  'idle',
  'building',
  'validating',
  'merging',
  'conflicts',
  'paused-budget',
  'failed',
  'resolving',
]);

// ── lexorank ──────────────────────────────────────────────────────────────────
// Sparse string keys ordered by JS string comparison (== SQLite BINARY collation on
// TEXT, so the DB ORDER BY and any in-memory sort agree). Each char is in the printable
// ASCII window [MIN_CODE, MAX_CODE]. `rankBetween(a, b)` returns a key strictly between
// `a` and `b` (lexicographically); null = open end. When two neighbours are adjacent
// with no character between them (e.g. 'a'/'b'), the key is LENGTHENED rather than
// colliding — so reorder is always safe.
const MIN_CODE = 0x30; // '0'
const MAX_CODE = 0x7a; // 'z'
const FIRST = 'U'; // a midpoint of the window, used for the first card in an empty column

export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b ?? '';
  // defensive: if bounds are out of order, fall back to "just below hi".
  if (hi && lo >= hi) return rankBetween(null, hi);

  let prefix = '';
  let i = 0;
  for (;;) {
    const lc = i < lo.length ? lo.charCodeAt(i) : MIN_CODE;
    const hc = i < hi.length ? hi.charCodeAt(i) : MAX_CODE + 1; // hi is exclusive
    if (hc - lc > 1) {
      // there's at least one code strictly between → done.
      return prefix + String.fromCharCode(Math.floor((lc + hc) / 2));
    }
    // no gap at this position: keep lo's char and descend; the upper bound for the
    // remaining suffix is open (MAX_CODE), which guarantees a gap eventually, so the
    // key only grows in length.
    prefix += String.fromCharCode(lc);
    i++;
  }
}

/** rank appended at the END of a column (after `last`), or FIRST for an empty column. */
function rankAfter(last: string | null): string {
  if (!last) return FIRST;
  return rankBetween(last, null);
}

// ── prepared statements ───────────────────────────────────────────────────────
const COLS = `
  id, project_id, "column", execution_phase, title, description, acceptance_criteria,
  validation_command, priority, "rank", depends_on, assignee, labels, run_id, campaign_id,
  worktree_name, attempt_count, max_attempts, budget_usd, validation_output, last_diff_hash,
  merge_sha, last_error, created_at, updated_at,
  mode, pr_url, pr_state, server_start_command, health_check_url, health_check_regex,
  resolve_attempt_count, max_resolve_attempts
`;

const getTaskStmt = db.prepare(`SELECT ${COLS} FROM kanban_tasks WHERE id = ?`);
const getByRunStmt = db.prepare(`SELECT ${COLS} FROM kanban_tasks WHERE run_id = ?`);
const listByProjectStmt = db.prepare(
  `SELECT ${COLS} FROM kanban_tasks WHERE project_id = ? ORDER BY "column", "rank", created_at`,
);
const lastRankInColumnStmt = db.prepare(
  `SELECT "rank" FROM kanban_tasks WHERE project_id = ? AND "column" = ? ORDER BY "rank" DESC LIMIT 1`,
);
const readyTasksStmt = db.prepare(
  `SELECT ${COLS} FROM kanban_tasks WHERE project_id = ? AND "column" = 'Ready' ORDER BY priority DESC, "rank" ASC`,
);
const inProgressCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM kanban_tasks WHERE project_id = ? AND "column" = 'InProgress'`,
);
const deleteTaskStmt = db.prepare('DELETE FROM kanban_tasks WHERE id = ?');

const insertStmt = db.prepare(`
  INSERT INTO kanban_tasks (
    id, project_id, "column", execution_phase, title, description, acceptance_criteria,
    validation_command, priority, "rank", depends_on, assignee, labels, run_id, campaign_id,
    worktree_name, attempt_count, max_attempts, budget_usd, validation_output, last_diff_hash,
    merge_sha, last_error, created_at, updated_at,
    mode, pr_url, pr_state, server_start_command, health_check_url, health_check_regex,
    resolve_attempt_count, max_resolve_attempts
  ) VALUES (
    @id, @project_id, @column, @execution_phase, @title, @description, @acceptance_criteria,
    @validation_command, @priority, @rank, @depends_on, @assignee, @labels, @run_id, @campaign_id,
    @worktree_name, @attempt_count, @max_attempts, @budget_usd, @validation_output, @last_diff_hash,
    @merge_sha, @last_error, @created_at, @updated_at,
    @mode, @pr_url, @pr_state, @server_start_command, @health_check_url, @health_check_regex,
    @resolve_attempt_count, @max_resolve_attempts
  )
`);

const updateStmt = db.prepare(`
  UPDATE kanban_tasks SET
    "column" = @column, execution_phase = @execution_phase, title = @title,
    description = @description, acceptance_criteria = @acceptance_criteria,
    validation_command = @validation_command, priority = @priority, "rank" = @rank,
    depends_on = @depends_on, assignee = @assignee, labels = @labels, run_id = @run_id,
    campaign_id = @campaign_id, worktree_name = @worktree_name, attempt_count = @attempt_count,
    max_attempts = @max_attempts, budget_usd = @budget_usd, validation_output = @validation_output,
    last_diff_hash = @last_diff_hash, merge_sha = @merge_sha, last_error = @last_error,
    updated_at = @updated_at,
    mode = @mode, pr_url = @pr_url, pr_state = @pr_state,
    server_start_command = @server_start_command, health_check_url = @health_check_url,
    health_check_regex = @health_check_regex, resolve_attempt_count = @resolve_attempt_count,
    max_resolve_attempts = @max_resolve_attempts
  WHERE id = @id
`);

// ── row <-> domain mappers ─────────────────────────────────────────────────────
function safeJsonArray(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToTask(r: any): KanbanTask {
  return {
    id: r.id,
    projectId: r.project_id,
    column: r.column as KanbanColumn,
    executionPhase: r.execution_phase as ExecutionPhase,
    title: r.title,
    description: r.description ?? '',
    acceptanceCriteria: r.acceptance_criteria ?? '',
    validationCommand: r.validation_command ?? null,
    priority: r.priority ?? 0,
    rank: r.rank ?? '',
    dependsOn: safeJsonArray(r.depends_on),
    assignee: r.assignee ?? 'human',
    labels: safeJsonArray(r.labels),
    runId: r.run_id ?? null,
    campaignId: r.campaign_id ?? null,
    worktreeName: r.worktree_name ?? null,
    attemptCount: r.attempt_count ?? 0,
    maxAttempts: r.max_attempts ?? 3,
    budgetUsd: r.budget_usd ?? null,
    validationOutput: r.validation_output ?? null,
    lastDiffHash: r.last_diff_hash ?? null,
    mergeSha: r.merge_sha ?? null,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // ── v2 columns ──
    mode: (r.mode ?? 'single') as 'single' | 'campaign',
    prUrl: r.pr_url ?? null,
    prState: (r.pr_state ?? null) as KanbanTask['prState'],
    serverStartCommand: r.server_start_command ?? null,
    healthCheckUrl: r.health_check_url ?? null,
    healthCheckRegex: r.health_check_regex ?? null,
    resolveAttemptCount: r.resolve_attempt_count ?? 0,
    maxResolveAttempts: r.max_resolve_attempts ?? 2,
  };
}

function taskToRow(t: KanbanTask): Record<string, unknown> {
  return {
    id: t.id,
    project_id: t.projectId,
    column: t.column,
    execution_phase: t.executionPhase,
    title: t.title,
    description: t.description,
    acceptance_criteria: t.acceptanceCriteria,
    validation_command: t.validationCommand,
    priority: t.priority,
    rank: t.rank,
    depends_on: JSON.stringify(t.dependsOn ?? []),
    assignee: t.assignee,
    labels: JSON.stringify(t.labels ?? []),
    run_id: t.runId,
    campaign_id: t.campaignId,
    worktree_name: t.worktreeName,
    attempt_count: t.attemptCount,
    max_attempts: t.maxAttempts,
    budget_usd: t.budgetUsd,
    validation_output: t.validationOutput,
    last_diff_hash: t.lastDiffHash,
    merge_sha: t.mergeSha,
    last_error: t.lastError,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    // ── v2 columns ──
    mode: t.mode,
    pr_url: t.prUrl,
    pr_state: t.prState,
    server_start_command: t.serverStartCommand,
    health_check_url: t.healthCheckUrl,
    health_check_regex: t.healthCheckRegex,
    resolve_attempt_count: t.resolveAttemptCount,
    max_resolve_attempts: t.maxResolveAttempts,
  };
}

// ── board pub/sub (mirror CampaignEngine.subs) ─────────────────────────────────
const boardSubs = new Map<string, Set<(m: KanbanBoardMessage) => void>>();

/** Fan a board message out to every subscriber of a project. */
export function broadcastBoard(projectId: string, m: KanbanBoardMessage): void {
  for (const cb of boardSubs.get(projectId) ?? []) {
    try {
      cb(m);
    } catch {
      /* dead subscriber */
    }
  }
}

/** Broadcast a single card upsert to its project's board subscribers. */
export function broadcastTask(task: KanbanTask): void {
  broadcastBoard(task.projectId, { kind: 'task', task });
}

/**
 * Subscribe to a project's board. Sends a `board-hello` snapshot immediately, then
 * live `task` / `task-removed` frames. Unlike CampaignEngine.subscribe this NEVER
 * returns null — an empty board (zero cards, or a project with no rows yet) is valid
 * and still gets a `board-hello` with `tasks: []`. Returns an unsubscribe fn.
 */
export function subscribeBoard(projectId: string, cb: (m: KanbanBoardMessage) => void): () => void {
  cb({ kind: 'board-hello', tasks: kanbanRepo.listTasks(projectId) });
  let set = boardSubs.get(projectId);
  if (!set) {
    set = new Set();
    boardSubs.set(projectId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) boardSubs.delete(projectId);
  };
}

// ── repo (PM engine + routes consume this) ─────────────────────────────────────
export const kanbanRepo = {
  getTask(id: string): KanbanTask | null {
    const r = getTaskStmt.get(id) as any;
    return r ? rowToTask(r) : null;
  },

  listTasks(projectId: string): KanbanTask[] {
    return (listByProjectStmt.all(projectId) as any[]).map(rowToTask);
  },

  getTaskByRunId(runId: string): KanbanTask | null {
    if (!runId) return null;
    const r = getByRunStmt.get(runId) as any;
    return r ? rowToTask(r) : null;
  },

  /** Insert a card. Defaults: column Backlog, phase idle, end-of-column lexorank. Broadcasts. */
  createTask(req: CreateKanbanTaskRequest): KanbanTask {
    const now = Date.now();
    const column: KanbanColumn = req.column && KANBAN_COLS.has(req.column) ? req.column : 'Backlog';
    const lastRow = lastRankInColumnStmt.get(req.projectId, column) as any;
    const task: KanbanTask = {
      id: randomUUID(),
      projectId: req.projectId,
      column,
      executionPhase: 'idle',
      title: req.title,
      description: req.description ?? '',
      acceptanceCriteria: req.acceptanceCriteria ?? '',
      validationCommand: req.validationCommand ?? null,
      priority: req.priority ?? 0,
      rank: rankAfter(lastRow?.rank ?? null),
      dependsOn: (req.dependsOn ?? []).map(String),
      assignee: 'human',
      labels: [],
      runId: null,
      campaignId: null,
      worktreeName: null,
      attemptCount: 0,
      maxAttempts: req.maxAttempts ?? 3,
      budgetUsd: req.budgetUsd ?? null,
      validationOutput: null,
      lastDiffHash: null,
      mergeSha: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      // ── v2 fields: optional in the request, defaulted to the v1-equivalent behavior ──
      mode: req.mode ?? 'single',
      prUrl: null,
      prState: null,
      serverStartCommand: req.serverStartCommand ?? null,
      healthCheckUrl: req.healthCheckUrl ?? null,
      healthCheckRegex: req.healthCheckRegex ?? null,
      resolveAttemptCount: 0,
      maxResolveAttempts: req.maxResolveAttempts ?? 2,
    };
    insertStmt.run(taskToRow(task));
    broadcastTask(task);
    return task;
  },

  /**
   * Patch a card (any subset of KanbanTask fields). ALWAYS bumps updated_at and
   * broadcasts the result. `id`/`projectId`/`createdAt` are immutable here.
   * Returns the fresh task, or null if it doesn't exist.
   */
  updateTask(id: string, patch: Partial<KanbanTask>): KanbanTask | null {
    const existing = this.getTask(id);
    if (!existing) return null;
    const next: KanbanTask = {
      ...existing,
      ...patch,
      id: existing.id,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    updateStmt.run(taskToRow(next));
    broadcastTask(next);
    return next;
  },

  /** Delete a card; broadcasts a `task-removed`. Returns true if a row was removed. */
  deleteTask(id: string): boolean {
    const existing = this.getTask(id);
    if (!existing) return false;
    deleteTaskStmt.run(id);
    broadcastBoard(existing.projectId, { kind: 'task-removed', taskId: id });
    return true;
  },

  /** Ready cards for the PM, top-priority first (priority DESC, then rank ASC). */
  readyTasks(projectId: string): KanbanTask[] {
    return (readyTasksStmt.all(projectId) as any[]).map(rowToTask);
  },

  /** Count of cards currently in the InProgress column (WIP-cap input for the PM). */
  inProgressCount(projectId: string): number {
    return ((inProgressCountStmt.get(projectId) as any)?.n as number) ?? 0;
  },
};

// ── depends_on validation ──────────────────────────────────────────────────────
/**
 * Validate a candidate card's depends_on against the project's existing cards.
 * Rejects: deps that don't reference an existing project card, duplicate ids, and any
 * dependency cycle (incl. self-dep). Throws a 400-tagged Error on failure.
 */
function validateDependsOn(projectId: string, candidateId: string, dependsOn: string[]) {
  const deps = dependsOn.map(String);
  if (deps.length === 0) return;
  const existing = kanbanRepo.listTasks(projectId).filter((t) => t.id !== candidateId);
  const known = new Set(existing.map((t) => t.id));
  for (const d of deps) {
    if (d === candidateId) {
      throw Object.assign(new Error('a card cannot depend on itself'), { statusCode: 400 });
    }
    if (!known.has(d)) {
      throw Object.assign(new Error(`unknown dependency: ${d}`), { statusCode: 400 });
    }
  }
  // Build the full graph (all project cards + this candidate's proposed deps) and reuse
  // the campaign engine's cycle/dup detectors.
  const nodes = existing.map((t) => ({ id: t.id, dependsOn: t.dependsOn }));
  nodes.push({ id: candidateId, dependsOn: deps });
  if (planHasDupIds(nodes)) {
    throw Object.assign(new Error('duplicate task ids in dependency graph'), { statusCode: 400 });
  }
  if (planHasCycle(nodes)) {
    throw Object.assign(new Error('depends_on introduces a dependency cycle'), { statusCode: 400 });
  }
}

// ── routes ──────────────────────────────────────────────────────────────────
const PATCHABLE_COLUMN = (v: unknown): v is KanbanColumn => typeof v === 'string' && KANBAN_COLS.has(v);
const PATCHABLE_PHASE = (v: unknown): v is ExecutionPhase => typeof v === 'string' && PHASES.has(v as ExecutionPhase);

export function registerKanbanRoutes(app: FastifyInstance) {
  // ── list a project's cards ──────────────────────────────────────────────────
  app.get('/api/projects/:pid/tasks', async (req) => {
    const pid = (req.params as any).pid as string;
    return kanbanRepo.listTasks(pid);
  });

  // ── create a card ────────────────────────────────────────────────────────────
  app.post('/api/projects/:pid/tasks', async (req, reply) => {
    try {
      const pid = (req.params as any).pid as string;
      const body = (req.body as any) ?? {};
      const title = String(body.title ?? '').trim();
      if (!title) {
        reply.code(400);
        return { error: 'title is required' };
      }
      const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.map(String) : [];
      // validate deps against the project graph (id generated inside createTask, but the
      // candidate id is brand-new so self-dep is impossible here; cycle/unknown still checked).
      validateDependsOn(pid, '__new__', dependsOn);
      const createReq: CreateKanbanTaskRequest = {
        projectId: pid, // from the URL, never body.projectId
        title,
        description: body.description != null ? String(body.description) : undefined,
        acceptanceCriteria: body.acceptanceCriteria != null ? String(body.acceptanceCriteria) : undefined,
        validationCommand:
          body.validationCommand === null ? null : body.validationCommand != null ? String(body.validationCommand) : undefined,
        priority: body.priority != null ? Number(body.priority) : undefined,
        dependsOn,
        maxAttempts: body.maxAttempts != null ? Number(body.maxAttempts) : undefined,
        budgetUsd: body.budgetUsd === null ? null : body.budgetUsd != null ? Number(body.budgetUsd) : undefined,
        column: PATCHABLE_COLUMN(body.column) ? body.column : undefined,
        // ── v2 optional mirrors ──
        mode: body.mode === 'campaign' || body.mode === 'single' ? body.mode : undefined,
        serverStartCommand:
          body.serverStartCommand === null ? null : body.serverStartCommand != null ? String(body.serverStartCommand) : undefined,
        healthCheckUrl:
          body.healthCheckUrl === null ? null : body.healthCheckUrl != null ? String(body.healthCheckUrl) : undefined,
        healthCheckRegex:
          body.healthCheckRegex === null ? null : body.healthCheckRegex != null ? String(body.healthCheckRegex) : undefined,
        maxResolveAttempts: body.maxResolveAttempts != null ? Number(body.maxResolveAttempts) : undefined,
      };
      const created = kanbanRepo.createTask(createReq);
      void pm.tick(pid); // pick up immediately if the card landed in Ready (else ≤10s safety tick)
      return created;
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  // ── edit / move / reorder a card ──────────────────────────────────────────────
  // Reorder is expressed via { beforeId, afterId } (the cards a moved card lands
  // between, in the target column) → a fresh lexorank is computed between them. A bare
  // `column` change without before/after appends to the end of the target column.
  app.put('/api/tasks/:id', async (req, reply) => {
    try {
      const id = (req.params as any).id as string;
      const body = (req.body as any) ?? {};
      const result = db.transaction(() => {
        const existing = kanbanRepo.getTask(id);
        if (!existing) return { code: 404 as const, error: 'not found' };

        const patch: Partial<KanbanTask> = {};

        // ── editable content fields ──────────────────────────────────────────
        if (typeof body.title === 'string') {
          const t = body.title.trim();
          if (!t) return { code: 400 as const, error: 'title cannot be empty' };
          patch.title = t;
        }
        if (typeof body.description === 'string') patch.description = body.description;
        if (typeof body.acceptanceCriteria === 'string') patch.acceptanceCriteria = body.acceptanceCriteria;
        if ('validationCommand' in body) {
          patch.validationCommand = body.validationCommand == null ? null : String(body.validationCommand);
        }
        if (body.priority != null) patch.priority = Number(body.priority);
        if (body.maxAttempts != null) patch.maxAttempts = Number(body.maxAttempts);
        if ('budgetUsd' in body) patch.budgetUsd = body.budgetUsd == null ? null : Number(body.budgetUsd);
        if (Array.isArray(body.labels)) patch.labels = body.labels.map(String);
        if (PATCHABLE_PHASE(body.executionPhase)) patch.executionPhase = body.executionPhase;

        // ── v2 editable fields ───────────────────────────────────────────────
        // mode (#4): immutable once executing — only a Backlog card may switch single<->campaign.
        if (body.mode === 'campaign' || body.mode === 'single') {
          if (existing.column !== 'Backlog') {
            return { code: 409 as const, error: 'mode can only be changed while the card is in Backlog' };
          }
          patch.mode = body.mode;
        }
        // per-card server-validation overrides (#5).
        if ('serverStartCommand' in body) {
          patch.serverStartCommand = body.serverStartCommand == null ? null : String(body.serverStartCommand);
        }
        if ('healthCheckUrl' in body) {
          patch.healthCheckUrl = body.healthCheckUrl == null ? null : String(body.healthCheckUrl);
        }
        if ('healthCheckRegex' in body) {
          patch.healthCheckRegex = body.healthCheckRegex == null ? null : String(body.healthCheckRegex);
        }
        // resolve attempt cap (#9).
        if (body.maxResolveAttempts != null) patch.maxResolveAttempts = Number(body.maxResolveAttempts);

        // ── depends_on (re-validated against the project graph) ───────────────
        if (Array.isArray(body.dependsOn)) {
          const deps = body.dependsOn.map(String);
          validateDependsOn(existing.projectId, existing.id, deps);
          patch.dependsOn = deps;
        }

        // ── column move ───────────────────────────────────────────────────────
        const targetColumn: KanbanColumn = PATCHABLE_COLUMN(body.column) ? body.column : existing.column;
        if (PATCHABLE_COLUMN(body.column)) patch.column = body.column;

        // ── reorder (lexorank) ────────────────────────────────────────────────
        const hasBefore = typeof body.beforeId === 'string';
        const hasAfter = typeof body.afterId === 'string';
        if (hasBefore || hasAfter || PATCHABLE_COLUMN(body.column)) {
          const beforeRank = hasBefore ? kanbanRepo.getTask(body.beforeId)?.rank ?? null : null;
          const afterRank = hasAfter ? kanbanRepo.getTask(body.afterId)?.rank ?? null : null;
          if (hasBefore || hasAfter) {
            // place strictly between the two neighbour ranks
            patch.rank = rankBetween(beforeRank, afterRank);
          } else {
            // pure column move with no neighbours given → append to end of target column
            const lastRow = lastRankInColumnStmt.get(existing.projectId, targetColumn) as any;
            patch.rank = rankAfter(lastRow?.rank ?? null);
          }
        }

        const next = kanbanRepo.updateTask(id, patch);
        return { code: 200 as const, task: next! };
      })();

      if (result.code !== 200) {
        reply.code(result.code);
        return { error: result.error };
      }
      void pm.tick(result.task.projectId); // a move into Ready should be picked up now
      return result.task;
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  // ── delete a card ──────────────────────────────────────────────────────────
  app.delete('/api/tasks/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!kanbanRepo.getTask(id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    pm.cancel(id); // H2 ordering: mark terminal + stop the live run + cleanup BEFORE deleting the row
    kanbanRepo.deleteTask(id);
    return { ok: true };
  });

  // ── Review-card actions ──────────────────────────────────────────────────────
  // No new shared field exists, so these mark EXISTING fields; the PM engine (pm.ts)
  // reacts on its next tick / terminal:
  //   approve         → executionPhase='merging' (Review + 'merging' = human-approved
  //                     gate; auto-merge cards never park in Review).
  //   request-changes → attemptCount++, comment stashed in lastError, column→InProgress
  //                     (re-enters rework; consumes an attempt per spec §2/§5.6).
  app.post('/api/tasks/:id/approve', async (req, reply) => {
    const id = (req.params as any).id as string;
    const existing = kanbanRepo.getTask(id);
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (existing.column !== 'Review') {
      reply.code(409);
      return { error: 'card is not in Review' };
    }
    const next = kanbanRepo.updateTask(id, { executionPhase: 'merging' });
    void pm.approve(id); // run the gated merge under the per-project mutex
    return next!;
  });

  app.post('/api/tasks/:id/request-changes', async (req, reply) => {
    const id = (req.params as any).id as string;
    const existing = kanbanRepo.getTask(id);
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (existing.column !== 'Review') {
      reply.code(409);
      return { error: 'card is not in Review' };
    }
    const comment = String((req.body as any)?.comment ?? '').trim();
    const next = kanbanRepo.updateTask(id, {
      column: 'InProgress',
      executionPhase: 'idle',
      attemptCount: existing.attemptCount + 1,
      lastError: comment ? `[human request-changes] ${comment}` : '[human request-changes]',
    });
    void pm.requestChanges(id); // relaunch a fix run in the same worktree (threads the comment)
    return next!;
  });

  // ── refresh a card's PR state from GitHub (v2 #2) ──────────────────────────────
  // PR-mode cards park in Review with a pr_state badge; this route re-reads `gh pr view` for the
  // card's branch and updates pr_state/pr_url (and flips the card to Done if the PR merged, under
  // the PM merge mutex). Fire-and-forget like approve/request-changes; SSE delivers the result.
  app.post('/api/tasks/:id/refresh-pr', async (req, reply) => {
    const id = (req.params as any).id as string;
    const existing = kanbanRepo.getTask(id);
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    void pm.refreshPr(id);
    return existing;
  });
}
