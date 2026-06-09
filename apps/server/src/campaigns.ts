/**
 * Campaign engine (DC.md D-018..D-020) — the portal's own orchestration runtime.
 *
 * One ORCHESTRATOR run decomposes an objective into a plan (via `--json-schema`,
 * D-019); the engine then auto-spawns a real WORKER run per subtask (reusing
 * registry.launch — each fully tracked/controllable), respecting `dependsOn` and
 * a `maxParallel` cap; on completion an optional SYNTHESIZER merges the results.
 * Reacts to run completions via registry.onRunTerminal — no polling.
 */
import { randomUUID } from 'node:crypto';
import type {
  Campaign,
  CampaignTask,
  CreateCampaignRequest,
  CampaignMessage,
  AgentTemplate,
  OrchestratorPlan,
  Run,
} from '@fleet/shared';
import { PLAN_JSON_SCHEMA } from '@fleet/shared';
import { repo } from './db.js';
import { registry } from './registry.js';

const TERMINAL_TASK = new Set(['completed', 'failed', 'skipped']);
const TERMINAL_CAMPAIGN = new Set(['completed', 'failed', 'killed']);

/**
 * H20 — a dependency cycle (or self-dep) in an LLM-emitted plan would wedge the
 * campaign in 'running' forever (no task's deps ever resolve). DFS for a back-edge.
 */
export function planHasCycle(tasks: { id: string; dependsOn?: string[] }[]): boolean {
  const ids = new Set(tasks.map((t) => String(t.id)));
  const deps = new Map(tasks.map((t) => [String(t.id), (t.dependsOn ?? []).map(String).filter((d) => ids.has(d))]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited · 1 on-stack · 2 done
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true; // back-edge → cycle
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) if (visit(d)) return true;
    state.set(n, 2);
    return false;
  };
  for (const id of ids) if (visit(id)) return true;
  return false;
}

/** H20 — duplicate task ids silently drop tasks (Set-dedupe + ON CONFLICT overwrite). */
export function planHasDupIds(tasks: { id: string }[]): boolean {
  const ids = tasks.map((t) => String(t.id));
  return new Set(ids).size !== ids.length;
}

function tpl(name: string | null | undefined, fallbackRole: string): AgentTemplate {
  if (name) {
    const t = repo.getTemplateByName(name);
    if (t) return t;
  }
  const all = repo.listTemplates();
  return (
    all.find((t) => t.role === fallbackRole) ??
    all[0] ?? {
      // last-resort default if the table is somehow empty
      id: 'x',
      name: 'default',
      role: fallbackRole,
      description: '',
      systemPrompt: '',
      model: 'claude-opus-4-8',
      fastMode: false,
      effort: 'high',
      allowedTools: [],
      skills: [],
      permissionMode: 'default',
      budgetUsd: 3,
      isBuiltin: true,
      createdAt: 0,
    }
  );
}

class CampaignEngine {
  private subs = new Map<string, Set<(m: CampaignMessage) => void>>();
  private listSubs = new Set<(c: Campaign) => void>();

  init() {
    registry.onRunTerminal((run) => this.handleRunTerminal(run));
  }

  // ── pub/sub ─────────────────────────────────────────────────────────────────
  subscribe(id: string, cb: (m: CampaignMessage) => void): (() => void) | null {
    const view = this.view(id);
    if (!view) return null;
    cb({ kind: 'campaign-hello', campaign: view });
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }
  subscribeList(cb: (c: Campaign) => void): () => void {
    this.listSubs.add(cb);
    return () => this.listSubs.delete(cb);
  }
  private broadcast(id: string, m: CampaignMessage) {
    for (const cb of this.subs.get(id) ?? []) {
      try {
        cb(m);
      } catch {
        /* ignore */
      }
    }
  }
  private emitCampaign(c: Campaign) {
    this.broadcast(c.id, { kind: 'campaign', campaign: c });
    for (const cb of this.listSubs) {
      try {
        cb(c);
      } catch {
        /* ignore */
      }
    }
  }
  private emitTask(t: CampaignTask) {
    this.broadcast(t.campaignId, { kind: 'task', task: t });
  }

  // ── create ──────────────────────────────────────────────────────────────────
  create(req: CreateCampaignRequest): Campaign {
    if (!req.objective?.trim() || !req.cwd?.trim()) {
      throw Object.assign(new Error('objective and cwd are required'), { statusCode: 400 });
    }
    const orchT = tpl(req.orchestratorTemplate, 'orchestrator');
    const workerName = req.workerTemplate ?? 'Implementer';
    const synthName = req.autoSynthesize ? (req.synthesizerTemplate ?? 'Synthesizer') : null;
    const now = Date.now();
    const campaign: Campaign = {
      id: randomUUID(),
      objective: req.objective,
      cwd: req.cwd,
      status: 'planning',
      orchestratorTemplate: orchT.name,
      workerTemplate: workerName,
      synthesizerTemplate: synthName,
      orchestratorRunId: null,
      synthesizerRunId: null,
      maxParallel: Math.max(1, Math.min(req.maxParallel ?? 3, 16)),
      autoSynthesize: !!req.autoSynthesize,
      budgetPerWorkerUsd: req.budgetPerWorkerUsd ?? null,
      model: req.model || orchT.model,
      startedAt: now,
      endedAt: null,
      costUsd: 0,
    };
    repo.upsertCampaign(campaign);

    // launch the orchestrator → it returns a structured plan (D-019)
    const run = registry.launch({
      prompt: `OBJECTIVE:\n${req.objective}\n\nDecompose this objective into a minimal dependency-ordered plan of worker subtasks. Return ONLY the structured plan.`,
      cwd: req.cwd,
      model: campaign.model,
      effort: req.effort ?? orchT.effort,
      permissionMode: orchT.permissionMode,
      allowedTools: orchT.allowedTools,
      skills: orchT.skills,
      budgetUsd: orchT.budgetUsd,
      appendSystemPrompt: orchT.systemPrompt,
      jsonSchema: PLAN_JSON_SCHEMA,
      campaignId: campaign.id,
      interactive: false,
    });
    campaign.orchestratorRunId = run.id;
    repo.upsertCampaign(campaign);
    this.emitCampaign(campaign);
    return campaign;
  }

  // ── react to run completions ─────────────────────────────────────────────────
  private handleRunTerminal(run: Run) {
    if (run.campaignId) {
      const campaign = repo.getCampaign(run.campaignId);
      if (campaign && !TERMINAL_CAMPAIGN.has(campaign.status)) {
        if (run.id === campaign.orchestratorRunId && campaign.status === 'planning') {
          this.onOrchestratorDone(campaign, run);
        } else if (run.id === campaign.synthesizerRunId) {
          this.finalize(campaign);
        } else {
          this.onWorkerDone(campaign, run);
        }
      }
    }
    // any terminal frees a concurrency slot → tick active campaigns (anti-starvation)
    this.tickActive();
  }

  /** H20 — terminate a campaign as failed with a logged reason (no schema change). */
  private failCampaign(campaign: Campaign, reason: string) {
    // eslint-disable-next-line no-console
    console.warn(`[campaign ${campaign.id}] failed: ${reason}`);
    campaign.status = 'failed';
    campaign.endedAt = Date.now();
    campaign.costUsd = this.rollupCost(campaign);
    repo.upsertCampaign(campaign);
    this.emitCampaign(campaign);
  }

  private onOrchestratorDone(campaign: Campaign, run: Run) {
    // F-8: real `--json-schema` output lands on run.structuredOutput (an object).
    // Fall back to parsing resultText (legacy/mock-as-JSON-string) only if needed.
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
    if (run.status !== 'completed' || !plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      return this.failCampaign(campaign, 'orchestrator produced no usable plan');
    }
    // H20 — reject malformed plans up front instead of wedging/silently dropping tasks.
    const normalized = plan.tasks.map((t, i) => ({ id: String(t.id ?? `t${i + 1}`), dependsOn: (t.dependsOn ?? []).map(String) }));
    if (planHasDupIds(normalized)) return this.failCampaign(campaign, 'plan has duplicate task ids');
    if (planHasCycle(normalized)) return this.failCampaign(campaign, 'plan has a dependency cycle');
    const now = Date.now();
    const valid = new Set(plan.tasks.map((t) => String(t.id)));
    plan.tasks.forEach((t, i) => {
      const task: CampaignTask = {
        id: String(t.id ?? `t${i + 1}`),
        campaignId: campaign.id,
        seq: i,
        title: t.title ?? `Task ${i + 1}`,
        prompt: t.prompt ?? t.title ?? '',
        template: t.template && repo.getTemplateByName(t.template) ? t.template : campaign.workerTemplate,
        dependsOn: (t.dependsOn ?? []).map(String).filter((d) => valid.has(d)),
        runId: null,
        status: 'pending',
        createdAt: now,
      };
      repo.upsertTask(task);
      this.emitTask(task);
    });
    campaign.status = 'spawning';
    repo.upsertCampaign(campaign);
    this.emitCampaign(campaign);
    this.schedule(campaign);
  }

  private onWorkerDone(campaign: Campaign, run: Run) {
    const tasks = repo.getTasks(campaign.id);
    const task = tasks.find((t) => t.runId === run.id);
    if (!task || TERMINAL_TASK.has(task.status)) return;
    task.status = run.status === 'completed' ? 'completed' : 'failed';
    repo.upsertTask(task);
    this.emitTask(task);
    this.schedule(campaign);
  }

  // ── scheduler ─────────────────────────────────────────────────────────────────
  private schedule(campaign: Campaign) {
    if (TERMINAL_CAMPAIGN.has(campaign.status) || campaign.status === 'synthesizing') return;
    const tasks = repo.getTasks(campaign.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    // cascade: a pending task whose dependency failed/was skipped can never run → skip it
    for (const t of tasks) {
      if (t.status !== 'pending') continue;
      if (t.dependsOn.some((d) => ['failed', 'skipped'].includes(byId.get(d)?.status ?? 'completed'))) {
        t.status = 'skipped';
        repo.upsertTask(t);
        this.emitTask(t);
      }
    }

    let running = tasks.filter((t) => t.status === 'running').length;
    for (const t of tasks) {
      if (running >= campaign.maxParallel) break;
      if (t.status !== 'pending') continue;
      const depsDone = t.dependsOn.every((d) => byId.get(d)?.status === 'completed');
      if (!depsDone) continue;
      try {
        const run = this.launchWorker(campaign, t, byId);
        t.runId = run.id;
        t.status = 'running';
        repo.upsertTask(t);
        this.emitTask(t);
        running++;
      } catch (e: any) {
        // concurrency cap (429) or transient → leave pending; retried on next terminal
        if (e?.statusCode !== 429) {
          t.status = 'failed';
          repo.upsertTask(t);
          this.emitTask(t);
        }
        break;
      }
    }

    // recompute campaign status
    const fresh = repo.getTasks(campaign.id);
    const allTerminal = fresh.every((t) => TERMINAL_TASK.has(t.status));
    const anyCompleted = fresh.some((t) => t.status === 'completed');
    if (allTerminal) {
      if (campaign.autoSynthesize && campaign.synthesizerTemplate && !campaign.synthesizerRunId && anyCompleted) {
        this.launchSynthesizer(campaign, fresh);
      } else {
        this.finalize(campaign);
      }
    } else {
      campaign.status = 'running';
      campaign.costUsd = this.rollupCost(campaign);
      repo.upsertCampaign(campaign);
      this.emitCampaign(campaign);
    }
  }

  private launchWorker(campaign: Campaign, task: CampaignTask, byId: Map<string, CampaignTask>): Run {
    const t = tpl(task.template, 'worker');
    // thread completed-dependency results into the worker prompt for context
    const depContext = task.dependsOn
      .map((d) => byId.get(d))
      .filter((d): d is CampaignTask => !!d && d.status === 'completed' && !!d.runId)
      .map((d) => {
        const r = registry.getRun(d.runId!);
        return r?.resultText ? `\n\n[Result of "${d.title}"]:\n${r.resultText}` : '';
      })
      .join('');
    return registry.launch({
      prompt: task.prompt + depContext,
      cwd: campaign.cwd,
      model: campaign.model || t.model,
      effort: t.effort,
      permissionMode: t.permissionMode,
      allowedTools: t.allowedTools,
      skills: t.skills,
      budgetUsd: campaign.budgetPerWorkerUsd ?? t.budgetUsd,
      appendSystemPrompt: t.systemPrompt,
      campaignId: campaign.id,
      interactive: false,
    });
  }

  private launchSynthesizer(campaign: Campaign, tasks: CampaignTask[]) {
    const t = tpl(campaign.synthesizerTemplate, 'synthesizer');
    const results = tasks
      .filter((x) => x.status === 'completed' && x.runId)
      .map((x) => {
        const r = registry.getRun(x.runId!);
        return `### ${x.title}\n${r?.resultText ?? '(no result)'}`;
      })
      .join('\n\n');
    const run = registry.launch({
      prompt: `OBJECTIVE:\n${campaign.objective}\n\nThe worker agents produced these results:\n\n${results}\n\nSynthesize them into one coherent final deliverable.`,
      cwd: campaign.cwd,
      model: campaign.model || t.model,
      effort: t.effort,
      permissionMode: t.permissionMode,
      allowedTools: t.allowedTools,
      skills: t.skills,
      budgetUsd: t.budgetUsd,
      appendSystemPrompt: t.systemPrompt,
      campaignId: campaign.id,
      interactive: false,
    });
    campaign.synthesizerRunId = run.id;
    campaign.status = 'synthesizing';
    campaign.costUsd = this.rollupCost(campaign);
    repo.upsertCampaign(campaign);
    this.emitCampaign(campaign);
  }

  private finalize(campaign: Campaign) {
    const tasks = repo.getTasks(campaign.id);
    const anyCompleted = tasks.some((t) => t.status === 'completed');
    campaign.status = anyCompleted ? 'completed' : 'failed';
    campaign.endedAt = Date.now();
    campaign.costUsd = this.rollupCost(campaign);
    repo.upsertCampaign(campaign);
    this.emitCampaign(campaign);
  }

  private rollupCost(campaign: Campaign): number {
    let cost = 0;
    const add = (id: string | null) => {
      if (!id) return;
      const r = registry.getRun(id);
      if (r) cost += r.costUsd;
    };
    add(campaign.orchestratorRunId);
    add(campaign.synthesizerRunId);
    for (const t of repo.getTasks(campaign.id)) add(t.runId);
    return cost;
  }

  private tickActive() {
    for (const c of repo.listCampaigns()) {
      if (c.status === 'spawning' || c.status === 'running') this.schedule(c);
    }
  }

  // ── control ──────────────────────────────────────────────────────────────────
  kill(id: string) {
    const campaign = repo.getCampaign(id);
    if (!campaign) throw Object.assign(new Error('campaign not found'), { statusCode: 404 });
    // Mark the campaign terminal in the DB FIRST (H2). Each registry.stop() below
    // synchronously fires onRunTerminal → handleRunTerminal, which re-reads the
    // campaign and only short-circuits when it is terminal. If we flipped the status
    // afterwards, a dependency-freed worker could be scheduled mid-kill and would
    // never be stopped (kill()'s task snapshot predates it) → a cost-spending orphan.
    campaign.status = 'killed';
    campaign.endedAt = Date.now();
    repo.upsertCampaign(campaign);

    registry.stop(campaign.orchestratorRunId ?? '');
    registry.stop(campaign.synthesizerRunId ?? '');
    for (const t of repo.getTasks(id)) {
      if (t.runId) registry.stop(t.runId);
      if (!TERMINAL_TASK.has(t.status)) {
        t.status = 'skipped';
        repo.upsertTask(t);
      }
    }
    // all child runs are terminal now → roll up the final cost and re-emit.
    campaign.costUsd = this.rollupCost(campaign);
    repo.upsertCampaign(campaign);
    this.emitCampaign(campaign);
  }

  // ── reads ────────────────────────────────────────────────────────────────────
  view(id: string): Campaign | null {
    const c = repo.getCampaign(id);
    if (!c) return null;
    const tasks = repo.getTasks(id);
    c.tasks = tasks;
    c.taskCount = tasks.length;
    c.doneCount = tasks.filter((t) => TERMINAL_TASK.has(t.status)).length;
    c.liveWorkers = tasks.filter((t) => t.status === 'running').length;
    if (!TERMINAL_CAMPAIGN.has(c.status)) c.costUsd = this.rollupCost(c);
    return c;
  }
  list(): Campaign[] {
    return repo.listCampaigns().map((c) => {
      const tasks = repo.getTasks(c.id);
      c.taskCount = tasks.length;
      c.doneCount = tasks.filter((t) => TERMINAL_TASK.has(t.status)).length;
      c.liveWorkers = tasks.filter((t) => t.status === 'running').length;
      return c;
    });
  }
}

export const campaigns = new CampaignEngine();
