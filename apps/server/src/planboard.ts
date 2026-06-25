/**
 * PM Plan-board (v2 #3; spec docs/superpowers/specs/2026-06-09-v2-out-of-scope-design.md §4 #3 + §3.7).
 *
 * Bridges the Campaigns planner (`--json-schema` + `PLAN_JSON_SCHEMA`) to the Kanban
 * board WITHOUT touching campaigns.ts. A human enters an objective → a SINGLE orchestrator
 * run (campaignId:null, no card) decomposes it into a task DAG → the human reviews/edits a
 * preview → on apply each task becomes a kanban card with `depends_on` mapped from the DAG
 * edges (plan-local id → created card id).
 *
 * Self-contained Lane-B module (mirrors projects.ts / kanban.ts): owns its `plan_drafts`
 * table via the shared sqlite handle (own CREATE TABLE IF NOT EXISTS on import — NOT in
 * db.ts; §3.1's ALTER-loop hazard is only about ALTERing existing tables, so a brand-new
 * CREATE-on-import table is unaffected), exposes `planboardRepo`, and `registerPlanboardRoutes(app)`.
 *
 * §3.7 PARTITION INVARIANT — a planning run carries `campaignId:null` and links to no card:
 *   • campaigns.ts handleRunTerminal acts only when `run.campaignId` is truthy → no-op.
 *   • pm.ts handleRunTerminal returns at `getTaskByRunId(run.id) === null` → no-op.
 *   • THIS engine acts only when the run is a draft's orchestratorRunId in `planning`.
 * All three share the one `registry.onRunTerminal` stream and each partitions independently,
 * so subscriber order is irrelevant. A planning run creates NO campaign_tasks row.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type {
  PlanDraft,
  PlanTask,
  PlanDraftStatus,
  KanbanColumn,
  OrchestratorPlan,
  Run,
} from '@fleet/shared';
import { PLAN_JSON_SCHEMA, KANBAN_COLUMNS } from '@fleet/shared';
import db from './db.js';
import { registry } from './registry.js';
import { planHasCycle, planHasDupIds, tpl } from './campaigns.js';
import { kanbanRepo } from './kanban.js';
import { projectsRepo, onProjectDeleted } from './projects.js';
import { pm } from './pm.js'; // circular but runtime-safe: only referenced inside apply() (mirrors kanban.ts)

const KANBAN_COLS = new Set<string>(KANBAN_COLUMNS);

// ── schema (idempotent, own CREATE TABLE on import — NOT in db.ts) ──────────────
db.exec(`
CREATE TABLE IF NOT EXISTS plan_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  target_column TEXT NOT NULL DEFAULT 'Ready',
  status TEXT NOT NULL DEFAULT 'planning',
  orchestrator_run_id TEXT,
  plan TEXT,
  error TEXT,
  applied_card_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_drafts_project ON plan_drafts(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_drafts_run ON plan_drafts(orchestrator_run_id);
`);

// ── row <-> domain mappers (snake_case ↔ camelCase, like projects.ts) ───────────
function safeJsonArray<T = unknown>(s: unknown, fallback: T[] = []): T[] {
  try {
    const v = JSON.parse(String(s ?? '[]'));
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function rowToDraft(r: any): PlanDraft {
  return {
    id: r.id,
    projectId: r.project_id,
    objective: r.objective,
    targetColumn: (KANBAN_COLS.has(r.target_column) ? r.target_column : 'Ready') as KanbanColumn,
    status: r.status as PlanDraftStatus,
    orchestratorRunId: r.orchestrator_run_id ?? null,
    plan: r.plan ? safeJsonArray<PlanTask>(r.plan, []) : null,
    error: r.error ?? null,
    appliedCardIds: safeJsonArray<string>(r.applied_card_ids, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function draftToRow(d: PlanDraft): Record<string, unknown> {
  return {
    id: d.id,
    project_id: d.projectId,
    objective: d.objective,
    target_column: d.targetColumn,
    status: d.status,
    orchestrator_run_id: d.orchestratorRunId,
    plan: d.plan ? JSON.stringify(d.plan) : null,
    error: d.error,
    applied_card_ids: JSON.stringify(d.appliedCardIds ?? []),
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

// ── prepared statements ─────────────────────────────────────────────────────────
const COLS = `id, project_id, objective, target_column, status, orchestrator_run_id, plan, error, applied_card_ids, created_at, updated_at`;
const getDraftStmt = db.prepare(`SELECT ${COLS} FROM plan_drafts WHERE id = ?`);
const getByRunStmt = db.prepare(`SELECT ${COLS} FROM plan_drafts WHERE orchestrator_run_id = ?`);
const listByProjectStmt = db.prepare(`SELECT ${COLS} FROM plan_drafts WHERE project_id = ? ORDER BY created_at DESC`);
const listPlanningStmt = db.prepare(`SELECT ${COLS} FROM plan_drafts WHERE status = 'planning'`);
const deleteByProjectStmt = db.prepare(`DELETE FROM plan_drafts WHERE project_id = ?`);
const insertStmt = db.prepare(`
  INSERT INTO plan_drafts (${COLS})
  VALUES (@id, @project_id, @objective, @target_column, @status, @orchestrator_run_id, @plan, @error, @applied_card_ids, @created_at, @updated_at)
`);
const updateStmt = db.prepare(`
  UPDATE plan_drafts SET
    objective = @objective, target_column = @target_column, status = @status,
    orchestrator_run_id = @orchestrator_run_id, plan = @plan, error = @error,
    applied_card_ids = @applied_card_ids, updated_at = @updated_at
  WHERE id = @id
`);

export const planboardRepo = {
  get(id: string): PlanDraft | null {
    const r = getDraftStmt.get(id) as any;
    return r ? rowToDraft(r) : null;
  },
  getByRunId(runId: string): PlanDraft | null {
    if (!runId) return null;
    const r = getByRunStmt.get(runId) as any;
    return r ? rowToDraft(r) : null;
  },
  list(projectId: string): PlanDraft[] {
    return (listByProjectStmt.all(projectId) as any[]).map(rowToDraft);
  },
  insert(draft: PlanDraft): PlanDraft {
    insertStmt.run(draftToRow(draft));
    return draft;
  },
  update(id: string, patch: Partial<PlanDraft>): PlanDraft | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: PlanDraft = {
      ...existing,
      ...patch,
      id: existing.id,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    updateStmt.run(draftToRow(next));
    return next;
  },
};

/**
 * Parse a planner Run's terminal output into a PlanTask[], exactly like campaigns.ts
 * `onOrchestratorDone`: structured_output first (F-8: real `--json-schema` lands an object),
 * resultText JSON fallback for the legacy/mock-as-JSON-string path.
 */
function parsePlan(run: Run): PlanTask[] | null {
  let plan: OrchestratorPlan | null = null;
  const so = run.structuredOutput as OrchestratorPlan | null;
  if (so && Array.isArray(so.tasks)) {
    plan = so;
  } else if (run.resultText) {
    try {
      plan = JSON.parse(run.resultText) as OrchestratorPlan;
    } catch {
      plan = null;
    }
  }
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) return null;
  return plan.tasks.map((t, i) => ({
    id: String(t.id ?? `t${i + 1}`),
    title: t.title ?? `Task ${i + 1}`,
    prompt: t.prompt ?? t.title ?? '',
    template: t.template,
    dependsOn: (t.dependsOn ?? []).map(String),
  }));
}

// ── engine — terminal handler (partitioned; §3.7) ───────────────────────────────
class Planboard {
  init() {
    // Boot reconciliation — registry's reconcileOrphans flips orphaned runs to 'failed' via raw
    // SQL without firing onRunTerminal (and before this subscription exists), so resolve any
    // draft still 'planning' whose planner run is gone or already terminal.
    for (const draft of (listPlanningStmt.all() as any[]).map(rowToDraft)) {
      const run = draft.orchestratorRunId ? registry.getRun(draft.orchestratorRunId) : null;
      if (!run) {
        planboardRepo.update(draft.id, { status: 'error', error: 'planner run lost across server restart' });
      } else if (run.status === 'completed' || run.status === 'failed' || run.status === 'killed') {
        this.handleRunTerminal(run);
      }
    }
    registry.onRunTerminal((run) => this.handleRunTerminal(run));
    // Deleting a project drops its drafts (stop a still-running planner first so it
    // doesn't keep spending against a project that no longer exists).
    onProjectDeleted((projectId) => {
      for (const draft of planboardRepo.list(projectId)) {
        if (draft.status === 'planning' && draft.orchestratorRunId) {
          try {
            registry.stop(draft.orchestratorRunId);
          } catch {
            /* already terminal / gone */
          }
        }
      }
      deleteByProjectStmt.run(projectId);
    });
  }

  /**
   * §3.7 — act ONLY on a planning run we own (the draft's orchestratorRunId while
   * status==='planning'). campaigns.ts already no-ops (run.campaignId is null here) and
   * pm.ts already no-ops (no card links to this run); we keep it that way by guarding on
   * the draft lookup so we never touch a PM build run or a campaign run.
   */
  private handleRunTerminal(run: Run) {
    if (run.campaignId != null) return; // campaign runs belong to campaigns.ts
    const draft = planboardRepo.getByRunId(run.id);
    if (!draft || draft.status !== 'planning') return; // not our planning run (or already resolved)

    if (run.status !== 'completed') {
      planboardRepo.update(draft.id, { status: 'error', error: run.error || `planner ${run.status}` });
      return;
    }
    const plan = parsePlan(run);
    if (!plan) {
      planboardRepo.update(draft.id, { status: 'error', error: 'planner produced no usable plan' });
      return;
    }
    // reject a malformed plan up front (same detectors campaigns/kanban use), so a draft can
    // never go `ready` with a graph that apply would only reject later.
    if (planHasDupIds(plan)) {
      planboardRepo.update(draft.id, { status: 'error', error: 'plan has duplicate task ids' });
      return;
    }
    if (planHasCycle(plan)) {
      planboardRepo.update(draft.id, { status: 'error', error: 'plan has a dependency cycle' });
      return;
    }
    planboardRepo.update(draft.id, { status: 'ready', plan, error: null });
  }

  // ── create a draft + launch the planning run ──────────────────────────────────
  /**
   * Launch the orchestrator PLANNING run via registry.launch — the SAME
   * --json-schema/PLAN_JSON_SCHEMA mechanism campaigns.ts uses, with `campaignId:null`
   * so it is owned by neither existing engine. Planning is allowed regardless of
   * pause/ceiling (gating applies to execution, not planning — spec §4 #3).
   */
  async create(projectId: string, objective: string, targetColumn?: KanbanColumn): Promise<PlanDraft> {
    const project = projectsRepo.getProject(projectId);
    if (!project) throw Object.assign(new Error('project not found'), { statusCode: 404 });
    const obj = objective.trim();
    if (!obj) throw Object.assign(new Error('objective is required'), { statusCode: 400 });
    const column: KanbanColumn = targetColumn && KANBAN_COLS.has(targetColumn) ? targetColumn : 'Ready';

    const now = Date.now();
    const draft: PlanDraft = {
      id: randomUUID(),
      projectId,
      objective: obj,
      targetColumn: column,
      status: 'planning',
      orchestratorRunId: null,
      plan: null,
      error: null,
      appliedCardIds: [],
      createdAt: now,
      updatedAt: now,
    };
    planboardRepo.insert(draft);

    const orchT = tpl(undefined, 'orchestrator');
    let run: Run;
    try {
      run = await registry.launch({
        prompt: `OBJECTIVE:\n${obj}\n\nDecompose this objective into a minimal dependency-ordered plan of subtasks suitable for kanban cards. Return ONLY the structured plan.`,
        cwd: project.rootDir,
        model: orchT.model,
        effort: orchT.effort,
        permissionMode: orchT.permissionMode,
        allowedTools: orchT.allowedTools,
        skills: orchT.skills,
        budgetUsd: orchT.budgetUsd ?? undefined,
        appendSystemPrompt: orchT.systemPrompt,
        jsonSchema: PLAN_JSON_SCHEMA,
        campaignId: null, // §3.7 — owned by neither pm.ts nor campaigns.ts
        projectId, // scopes the run to the project (shows under project runs); pm still no-ops (no card)
        interactive: false,
      });
    } catch (e: any) {
      // launch can throw synchronously (429 concurrency cap, 400 missing cwd) — resolve the
      // already-inserted draft so it never wedges in 'planning', then rethrow for the route.
      planboardRepo.update(draft.id, { status: 'error', error: e.message });
      throw e;
    }
    // The terminal fires on detached-subprocess exit (never synchronously inside launch()), and
    // the run id isn't stored until here — so the partitioned terminal handler can only match this
    // draft AFTER this update lands. Storing the run id is all that's needed.
    const updated = planboardRepo.update(draft.id, { orchestratorRunId: run.id });
    return updated ?? { ...draft, orchestratorRunId: run.id };
  }

  // ── apply — re-validate + create one card per task ────────────────────────────
  /**
   * Idempotent: a draft already `applied` returns its existing cards (skipping any since
   * deleted). 409 when the draft is neither `ready` nor `applied`. depends_on is remapped
   * from plan-local ids to the freshly-created card ids inside ONE transaction (pass 1 creates
   * cards with empty deps to build the id map; pass 2 patches deps so a forward edge can't
   * reference a not-yet-created card).
   */
  apply(draftId: string, tasksIn?: PlanTask[], targetColumnIn?: KanbanColumn): PlanDraft {
    const draft = planboardRepo.get(draftId);
    if (!draft) throw Object.assign(new Error('plan draft not found'), { statusCode: 404 });

    if (draft.status === 'applied') {
      // idempotent replay — return the still-existing cards as the result.
      return draft;
    }
    if (draft.status !== 'ready') {
      throw Object.assign(new Error(`plan is not ready to apply (status: ${draft.status})`), { statusCode: 409 });
    }

    const tasks = (tasksIn && tasksIn.length ? tasksIn : draft.plan) ?? [];
    if (tasks.length === 0) throw Object.assign(new Error('no tasks to apply'), { statusCode: 400 });

    // normalize + re-validate on the plan's OWN id-space (t1/t2/…) BEFORE creating anything.
    const normalized = tasks.map((t, i) => ({
      id: String(t.id ?? `t${i + 1}`),
      title: t.title ?? `Task ${i + 1}`,
      prompt: t.prompt ?? t.title ?? '',
      template: t.template,
      dependsOn: (t.dependsOn ?? []).map(String),
    }));
    if (planHasDupIds(normalized)) {
      throw Object.assign(new Error('plan has duplicate task ids'), { statusCode: 400 });
    }
    if (planHasCycle(normalized)) {
      throw Object.assign(new Error('plan has a dependency cycle'), { statusCode: 400 });
    }

    const column: KanbanColumn =
      targetColumnIn && KANBAN_COLS.has(targetColumnIn) ? targetColumnIn : draft.targetColumn;
    const planIds = new Set(normalized.map((t) => t.id));

    const cardIds = db.transaction(() => {
      // pass 1 — create cards with NO deps; build plan-id → cardId.
      const idMap = new Map<string, string>();
      for (const t of normalized) {
        const card = kanbanRepo.createTask({
          projectId: draft.projectId,
          title: t.title,
          description: t.prompt,
          column,
        });
        idMap.set(t.id, card.id);
      }
      // pass 2 — remap deps to real card ids (filtered to ids present in the plan, mirroring
      // campaigns' valid-set filter so an edited subset can't dangle). kanbanRepo.updateTask
      // (unlike the PUT route) does NOT re-run validateDependsOn, so this never fails on a card
      // created earlier in this same pass.
      for (const t of normalized) {
        if (!t.dependsOn.length) continue;
        const mapped = t.dependsOn
          .filter((d) => planIds.has(d))
          .map((d) => idMap.get(d)!)
          .filter(Boolean);
        if (mapped.length) kanbanRepo.updateTask(idMap.get(t.id)!, { dependsOn: mapped });
      }
      return normalized.map((t) => idMap.get(t.id)!);
    })();

    const updated = planboardRepo.update(draftId, {
      status: 'applied',
      plan: normalized,
      targetColumn: column,
      appliedCardIds: cardIds,
    });
    // Mirror the kanban create route: nudge the PM so cards landing in Ready are picked up
    // immediately (else ≤10s safety tick). Paused projects no-op, so this never spawns under pause.
    const project = projectsRepo.getProject(draft.projectId);
    if (project && !project.paused) void pm.tick(draft.projectId);
    return updated ?? draft;
  }
}

export const planboard = new Planboard();

// ── routes ────────────────────────────────────────────────────────────────────
export function registerPlanboardRoutes(app: FastifyInstance) {
  // create a draft + launch the planner
  app.post('/api/projects/:pid/plan', async (req, reply) => {
    try {
      const pid = (req.params as any).pid as string;
      const body = (req.body as any) ?? {};
      const objective = String(body.objective ?? '');
      const targetColumn = typeof body.targetColumn === 'string' ? (body.targetColumn as KanbanColumn) : undefined;
      return await planboard.create(pid, objective, targetColumn);
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  // list a project's drafts
  app.get('/api/projects/:pid/plans', async (req) => {
    const pid = (req.params as any).pid as string;
    return planboardRepo.list(pid);
  });

  // poll one draft
  app.get('/api/plans/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const draft = planboardRepo.get(id);
    if (!draft) {
      reply.code(404);
      return { error: 'plan draft not found' };
    }
    return draft;
  });

  // apply (idempotent)
  app.post('/api/plans/:id/apply', async (req, reply) => {
    try {
      const id = (req.params as any).id as string;
      const body = (req.body as any) ?? {};
      const tasks = Array.isArray(body.tasks) ? (body.tasks as PlanTask[]) : undefined;
      const targetColumn = typeof body.targetColumn === 'string' ? (body.targetColumn as KanbanColumn) : undefined;
      return planboard.apply(id, tasks, targetColumn);
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });
}
