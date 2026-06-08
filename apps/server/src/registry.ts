/**
 * Registry & guardrails (PRD §8.1) — the control-plane core. Owns run lifecycle,
 * wires process → parser → tree → persistence, derives run status, enforces
 * concurrency + budget guardrails (§7.7), and fans out live updates to SSE
 * subscribers (per-run and fleet-wide).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type {
  Run,
  RunNode,
  NormalizedEvent,
  LaunchRequest,
  StreamMessage,
  FleetMessage,
  SpendSummary,
  PortalConfig,
  RunStatus,
  EffortLevel,
} from '@fleet/shared';
import { MODELS } from '@fleet/shared';
import { repo } from './db.js';
import { RunTree } from './tree.js';
import { normalize } from './parser.js';
import { spawnClaude, buildArgs, buildResumeArgs, killProcessGroup, type ManagedProcess } from './processManager.js';

const TERMINAL: RunStatus[] = ['completed', 'failed', 'killed'];
const isTerminal = (s: RunStatus) => TERMINAL.includes(s);

interface LiveRun {
  run: Run;
  req: LaunchRequest;
  tree: RunTree;
  proc: ManagedProcess | null;
  interactive: boolean;
  killed: boolean;
  resultSeen: boolean;
  resultError: boolean;
  awaitingPermission: boolean;
  lastStderr: string;
}

function modelRates(modelId: string, fast: boolean) {
  const m = MODELS.find((x) => x.id === modelId) ?? MODELS[0];
  if (fast && m.fastModeCapable && m.fastInputPerM) {
    return { inputPerM: m.fastInputPerM, outputPerM: m.fastOutputPerM! };
  }
  return { inputPerM: m.inputPerM, outputPerM: m.outputPerM };
}

const startOfToday = (): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

class Registry {
  private live = new Map<string, LiveRun>();
  /** per-run SSE subscribers, keyed by runId — decoupled from LiveRun so updates reach an open
   *  run page even when the run isn't in the live map (e.g. after a server restart). */
  private runSubs = new Map<string, Set<(m: StreamMessage) => void>>();
  private evictTimers = new Map<string, NodeJS.Timeout>();
  private fleetSubs = new Set<(m: FleetMessage) => void>();
  private terminalSubs = new Set<(run: Run) => void>();
  private notified = new Set<string>();
  config: PortalConfig;

  /** Fire once when any run reaches a terminal state (used by the campaign engine). */
  onRunTerminal(cb: (run: Run) => void): () => void {
    this.terminalSubs.add(cb);
    return () => this.terminalSubs.delete(cb);
  }
  private notifyTerminal(lr: LiveRun) {
    if (this.notified.has(lr.run.id)) return; // stop()+onExit can both fire — dedupe
    this.notified.add(lr.run.id);
    const snap = { ...lr.run };
    for (const cb of this.terminalSubs) {
      try {
        cb(snap);
      } catch {
        /* ignore */
      }
    }
  }

  /** Evict a terminal run from memory after a grace window (review #6). Reads fall back to DB. */
  private scheduleEvict(runId: string) {
    const prev = this.evictTimers.get(runId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      const lr = this.live.get(runId);
      const subs = this.runSubs.get(runId)?.size ?? 0;
      if (lr && isTerminal(lr.run.status) && subs === 0) this.live.delete(runId);
      this.evictTimers.delete(runId);
    }, 60_000);
    t.unref();
    this.evictTimers.set(runId, t);
  }
  private cancelEvict(runId: string) {
    const t = this.evictTimers.get(runId);
    if (t) {
      clearTimeout(t);
      this.evictTimers.delete(runId);
    }
  }

  constructor() {
    this.config = repo.getConfig();
    // A fresh process owns no live runs → kill orphaned process groups, then clear stale rows (PRD §10).
    for (const pid of repo.nonTerminalPids()) killProcessGroup(pid, true);
    repo.reconcileOrphans();
  }

  // ── config ────────────────────────────────────────────────────────────────
  getConfig(): PortalConfig {
    return this.config;
  }
  setConfig(cfg: PortalConfig) {
    this.config = cfg;
    repo.setConfig(cfg);
  }

  // ── fleet pub/sub ───────────────────────────────────────────────────────────
  subscribeFleet(cb: (m: FleetMessage) => void): () => void {
    this.fleetSubs.add(cb);
    cb({ kind: 'fleet-hello', runs: this.listRuns(), spend: this.spend() });
    return () => this.fleetSubs.delete(cb);
  }
  private broadcastFleet(m: FleetMessage) {
    for (const cb of this.fleetSubs) {
      try {
        cb(m);
      } catch {
        /* dead subscriber */
      }
    }
  }

  spend(): SpendSummary {
    const today = startOfToday();
    const activeRuns = [...this.live.values()].filter((lr) => !isTerminal(lr.run.status)).length;
    return {
      todayUsd: repo.spendSince(today),
      activeRuns,
      totalRunsToday: repo.countRunsSince(today),
    };
  }

  // ── per-run pub/sub ─────────────────────────────────────────────────────────
  subscribeRun(runId: string, cb: (m: StreamMessage) => void): (() => void) | null {
    const snapshot = this.snapshot(runId);
    if (!snapshot) return null;
    cb({ kind: 'hello', run: snapshot.run, nodes: snapshot.nodes, events: snapshot.events });
    let set = this.runSubs.get(runId);
    if (!set) {
      set = new Set();
      this.runSubs.set(runId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.runSubs.delete(runId);
    };
  }
  private broadcastRun(runId: string, m: StreamMessage) {
    for (const cb of this.runSubs.get(runId) ?? []) {
      try {
        cb(m);
      } catch {
        /* dead subscriber */
      }
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  launch(reqIn: LaunchRequest): Run {
    const activeCount = [...this.live.values()].filter((lr) => !isTerminal(lr.run.status)).length;
    if (activeCount >= this.config.maxConcurrentRuns) {
      throw Object.assign(new Error(`Max concurrent runs reached (${this.config.maxConcurrentRuns})`), {
        statusCode: 429,
      });
    }
    // Validate the working directory up front → a clear 400 instead of a silent failed spawn.
    if (!reqIn.cwd || !existsSync(reqIn.cwd) || !statSync(reqIn.cwd).isDirectory()) {
      throw Object.assign(new Error(`Working directory does not exist: ${reqIn.cwd}`), { statusCode: 400 });
    }

    // ultracode preset (DC.md D-007/D-008): force xhigh effort + tighter budget default.
    const ultracode = !!reqIn.ultracode;
    const effort: EffortLevel = ultracode ? 'xhigh' : reqIn.effort;
    const defaultBudget = ultracode ? this.config.ultracodeBudgetUsd : this.config.defaultBudgetUsd;
    const budgetUsd = reqIn.budgetUsd != null ? reqIn.budgetUsd : defaultBudget;
    const req: LaunchRequest = { ...reqIn, effort, budgetUsd };

    const sessionId = randomUUID();
    const now = Date.now();
    const run: Run = {
      id: sessionId,
      sessionId,
      task: req.prompt,
      cwd: req.cwd,
      model: req.model,
      fastMode: !!req.fastMode,
      effort,
      workflowsEnabled: req.workflowsEnabled ?? (effort === 'xhigh' || effort === 'max'),
      ultracode,
      teamId: null,
      campaignId: req.campaignId ?? null,
      pid: null,
      status: 'starting',
      startedAt: now,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      exitCode: null,
      budgetUsd,
      permissionMode: req.permissionMode,
      allowedTools: req.allowedTools?.length ? req.allowedTools.join(',') : null,
      skills: req.skills ?? [],
      subagentProfile: req.subagentProfile ?? null,
      resultText: null,
      structuredOutput: null,
      subagentCount: 0,
      liveSubagents: 0,
      maxDepth: 0,
      lastActivity: now,
    };
    repo.upsertRun(run);
    repo.saveSkills(sessionId, run.skills);

    const interactive = !!req.interactive;
    const tree = new RunTree(sessionId, sessionId, modelRates(req.model, run.fastMode), now);
    const lr: LiveRun = {
      run,
      req,
      tree,
      proc: null,
      interactive,
      killed: false,
      resultSeen: false,
      resultError: false,
      awaitingPermission: false,
      lastStderr: '',
    };
    this.live.set(sessionId, lr);

    const args = buildArgs(req, sessionId, interactive);
    this.startProcess(lr, args);
    this.emitRun(lr);
    return run;
  }

  private startProcess(lr: LiveRun, args: string[]) {
    lr.proc = spawnClaude(
      args,
      lr.run.cwd,
      {
        onLine: (raw) => this.handleLine(lr, raw),
        onStderr: (c) => {
          lr.lastStderr = (lr.lastStderr + c).slice(-2000);
        },
        onExit: (code, signal) => this.onExit(lr, code, signal),
      },
      lr.interactive,
    );
    // Persist the OS pid so stop/reconcile can reach the process group across server restarts.
    lr.run.pid = lr.proc.pid ?? null;
    repo.upsertRun(lr.run);
    // Interactive runs use stream-json INPUT: the prompt is NOT a positional, it must be sent on
    // stdin as the first user message — otherwise claude blocks forever (run stuck at "starting").
    if (lr.interactive) lr.proc.writeUserMessage(lr.req.prompt);
  }

  private handleLine(lr: LiveRun, raw: any) {
    const parsedList = normalize(raw);
    if (parsedList.length === 0) return;

    for (const parsed of parsedList) {
      const ts = Date.now();
      const r = lr.tree.ingest(parsed, ts);
      if (r.events.length === 0) continue;

      // persist nodes + non-ephemeral events
      const changedNodes = [...r.changedNodeIds]
        .map((id) => lr.tree.nodes.get(id))
        .filter((n): n is RunNode => !!n);
      if (changedNodes.length) repo.upsertNodes(changedNodes);
      const persistable = r.events.filter((e) => e.type !== 'assistant_partial' && e.type !== 'thinking');
      if (persistable.length) repo.insertEvents(persistable);

      // fan out events + node updates
      for (const e of r.events) this.broadcastRun(lr.run.id, { kind: 'event', event: e });
      for (const n of changedNodes) this.broadcastRun(lr.run.id, { kind: 'node', node: n });

      // status signals
      if (r.init) this.setLiveStatus(lr);
      if (r.permission) {
        lr.awaitingPermission = true;
      }
      if (r.result) {
        lr.resultSeen = true;
        lr.resultError = r.result.isError;
        lr.run.resultText = r.result.text;
        if (r.result.structuredOutput != null) lr.run.structuredOutput = r.result.structuredOutput;
      }
    }

    // roll up totals + derive status + guardrail
    const roll = lr.tree.rollups();
    lr.run.tokensIn = roll.tokensIn;
    lr.run.tokensOut = roll.tokensOut;
    lr.run.costUsd = roll.costUsd;
    lr.run.subagentCount = roll.subagentCount;
    lr.run.liveSubagents = roll.liveSubagents;
    lr.run.maxDepth = roll.maxDepth;
    lr.run.lastActivity = roll.lastActivity;

    if (!isTerminal(lr.run.status)) this.setLiveStatus(lr);

    // budget guardrail (§7.7): auto-kill a LIVE run whose running cost estimate breaches the
    // ceiling. `> 0` so budget 0 ≠ instant kill (review #8); compares this-invocation cost so a
    // resumed run gets a fresh allowance (review #2); `!resultSeen` so a run that already finished
    // is never retroactively "killed" — the spend already happened (advisor catch).
    if (
      lr.run.budgetUsd != null &&
      lr.run.budgetUsd > 0 &&
      !lr.resultSeen &&
      roll.portionCostUsd >= lr.run.budgetUsd &&
      !lr.killed &&
      !isTerminal(lr.run.status)
    ) {
      lr.lastStderr += `\n[guardrail] budget $${lr.run.budgetUsd} breached at $${roll.portionCostUsd.toFixed(4)} — auto-killing.`;
      this.stop(lr.run.id, 'budget');
      return;
    }

    repo.upsertRun(lr.run);
    this.emitRun(lr);
  }

  /** Derive the non-terminal live status from current signals. */
  private setLiveStatus(lr: LiveRun) {
    if (isTerminal(lr.run.status)) return;
    let status: RunStatus = 'running';
    if (lr.awaitingPermission) status = 'awaiting-permission';
    else if (lr.resultSeen && lr.interactive) status = 'awaiting-input';
    else if (lr.run.liveSubagents > 0) status = 'orchestrating';
    lr.run.status = status;
  }

  private onExit(lr: LiveRun, code: number | null, _signal: NodeJS.Signals | null) {
    let status: RunStatus;
    if (lr.killed) status = 'killed';
    else if (code === 0 || (lr.resultSeen && !lr.resultError)) status = 'completed';
    else status = 'failed';

    const now = Date.now();
    lr.run.status = status;
    lr.run.endedAt = now;
    lr.run.exitCode = code;
    if (status === 'killed') lr.tree.killAll(now);
    const roll = lr.tree.rollups();
    lr.run.costUsd = roll.costUsd;
    lr.run.tokensIn = roll.tokensIn;
    lr.run.tokensOut = roll.tokensOut;
    lr.run.liveSubagents = 0;
    lr.proc = null;

    repo.upsertNodes(lr.tree.flatNodes());
    repo.upsertRun(lr.run);
    this.emitRun(lr);
    this.notifyTerminal(lr);
    this.scheduleEvict(lr.run.id);
  }

  private emitRun(lr: LiveRun) {
    const snap = { ...lr.run };
    this.broadcastRun(lr.run.id, { kind: 'run', run: snap });
    this.broadcastFleet({ kind: 'run', run: snap });
    this.broadcastFleet({ kind: 'spend', spend: this.spend() });
  }

  // ── control actions (PRD §7.6) ──────────────────────────────────────────────
  sendInput(runId: string, text: string) {
    const lr = this.live.get(runId);
    if (!lr || !lr.proc) throw Object.assign(new Error('Run is not live; use Resume instead.'), { statusCode: 409 });
    if (!lr.interactive) throw Object.assign(new Error('Run was launched one-shot (not interactive).'), { statusCode: 409 });
    lr.proc.writeUserMessage(text);
    lr.resultSeen = false;
    if (!isTerminal(lr.run.status)) {
      lr.run.status = 'running';
      this.emitRun(lr);
    }
  }

  stop(runId: string, reason: 'user' | 'budget' = 'user') {
    const lr = this.live.get(runId);
    if (!lr) {
      // Run isn't in this process's live map (e.g. after a server restart). Kill its process
      // group by persisted pid, mark it killed, and broadcast so the UI reflects it (PRD §10).
      const run = repo.getRun(runId);
      if (!run) return;
      killProcessGroup(run.pid);
      if (!isTerminal(run.status)) {
        run.status = 'killed';
        run.endedAt = Date.now();
        repo.upsertRun(run);
      }
      this.broadcastRun(run.id, { kind: 'run', run }); // update an open run page
      this.broadcastFleet({ kind: 'run', run });
      this.broadcastFleet({ kind: 'spend', spend: this.spend() });
      return;
    }
    lr.killed = true;
    const now = Date.now();
    lr.tree.killAll(now);
    lr.run.status = 'killed';
    lr.run.endedAt = now;
    lr.run.liveSubagents = 0;
    repo.upsertNodes(lr.tree.flatNodes());
    repo.upsertRun(lr.run);
    this.emitRun(lr);
    this.notifyTerminal(lr);
    lr.proc?.kill(); // cascades to the process group (§7.6)
    this.scheduleEvict(runId);
    void reason;
  }

  /** Permanently delete a finished run from history (PRD §7.8). Live runs must be stopped first. */
  deleteRun(runId: string) {
    const lr = this.live.get(runId);
    const run = lr?.run ?? repo.getRun(runId);
    if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    if (!isTerminal(run.status)) {
      throw Object.assign(new Error('Stop the run before deleting it.'), { statusCode: 409 });
    }
    repo.deleteRun(runId);
    this.cancelEvict(runId);
    this.notified.delete(runId);
    this.live.delete(runId);
    this.broadcastFleet({ kind: 'run-removed', runId });
    this.broadcastFleet({ kind: 'spend', spend: this.spend() });
  }

  resume(runId: string, prompt?: string, interactive?: boolean): Run {
    const existing = repo.getRun(runId);
    if (!existing) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    if (!isTerminal(existing.status)) {
      throw Object.assign(new Error('Run is still live; cannot resume.'), { statusCode: 409 });
    }
    // concurrency guardrail also applies to resume (review #3)
    const activeCount = [...this.live.values()].filter((lr) => !isTerminal(lr.run.status)).length;
    if (activeCount >= this.config.maxConcurrentRuns) {
      throw Object.assign(new Error(`Max concurrent runs reached (${this.config.maxConcurrentRuns})`), { statusCode: 429 });
    }
    this.cancelEvict(runId);
    this.notified.delete(runId); // allow a fresh terminal notification after resume
    const req: LaunchRequest = {
      prompt: prompt ?? 'Continue.',
      cwd: existing.cwd,
      model: existing.model,
      fastMode: existing.fastMode,
      effort: existing.effort,
      permissionMode: existing.permissionMode,
      allowedTools: existing.allowedTools ? existing.allowedTools.split(',') : undefined,
      skills: existing.skills,
      subagentProfile: existing.subagentProfile,
      budgetUsd: existing.budgetUsd,
      ultracode: existing.ultracode,
      interactive: interactive ?? false,
    };
    // ALWAYS a fresh tree (review #2): never reuse a prior tree whose authoritativeCost/seq
    // are frozen from the previous invocation. Carry prior totals as a baseline so display
    // stays cumulative while the budget guardrail measures only this invocation.
    const tree = new RunTree(runId, existing.sessionId, modelRates(existing.model, existing.fastMode), Date.now(), {
      cost: existing.costUsd,
      tokensIn: existing.tokensIn,
      tokensOut: existing.tokensOut,
    });
    // seed seq past persisted events so INSERT OR IGNORE doesn't drop new events (review #4)
    tree.seq = repo.maxEventSeq(runId) + 1;
    // revive run
    existing.status = 'starting';
    existing.endedAt = null;
    existing.exitCode = null;
    const lr: LiveRun = {
      run: existing,
      req,
      tree,
      proc: null,
      interactive: !!req.interactive,
      killed: false,
      resultSeen: false,
      resultError: false,
      awaitingPermission: false,
      lastStderr: '',
    };
    this.live.set(runId, lr);
    repo.upsertRun(existing);
    const args = buildResumeArgs(req, runId, lr.interactive);
    this.startProcess(lr, args);
    this.emitRun(lr);
    return existing;
  }

  /**
   * Approve/deny a pending permission request (PRD §7.6). Best-effort: writes a
   * control message to stdin and clears the awaiting state. The headless permission
   * control protocol is not fully verified on this CC version (DC.md open items) —
   * most fleet runs use a non-prompting permission-mode to avoid this path.
   */
  decidePermission(runId: string, requestId: string, decision: 'approve' | 'deny') {
    const lr = this.live.get(runId);
    if (!lr || !lr.proc) throw Object.assign(new Error('Run is not live'), { statusCode: 409 });
    const msg = JSON.stringify({
      type: 'control_response',
      response: { request_id: requestId, decision },
    });
    try {
      (lr.proc.child.stdin as any)?.write(msg + '\n');
    } catch {
      /* ignore */
    }
    lr.awaitingPermission = false;
    if (!isTerminal(lr.run.status)) this.setLiveStatus(lr);
    this.emitRun(lr);
  }

  // ── reads ────────────────────────────────────────────────────────────────────
  getRun(runId: string): Run | null {
    const lr = this.live.get(runId);
    if (lr) return { ...lr.run };
    const run = repo.getRun(runId);
    if (!run) return null;
    const nodes = repo.getNodes(runId);
    run.subagentCount = nodes.filter((n) => n.nodeType === 'subagent' || n.nodeType === 'teammate').length;
    run.maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    run.liveSubagents = 0;
    return run;
  }

  listRuns(filter?: { status?: string; effort?: string; q?: string }): Run[] {
    // DB is the source of truth; overlay live rollups for in-memory runs.
    const rows = repo.listRuns(filter);
    return rows.map((r) => {
      const lr = this.live.get(r.id);
      return lr ? { ...lr.run } : r;
    });
  }

  getNodes(runId: string): RunNode[] {
    const lr = this.live.get(runId);
    return lr ? lr.tree.flatNodes() : repo.getNodes(runId);
  }

  getTree(runId: string): RunNode | null {
    const lr = this.live.get(runId);
    if (lr) return lr.tree.assembleTree();
    const nodes = repo.getNodes(runId);
    if (nodes.length === 0) return null;
    return assembleFromFlat(nodes, runId);
  }

  private snapshot(runId: string): { run: Run; nodes: RunNode[]; events: NormalizedEvent[] } | null {
    const lr = this.live.get(runId);
    if (lr) {
      return {
        run: { ...lr.run },
        nodes: lr.tree.flatNodes(),
        events: repo.getEventsTail(runId), // most-recent events → continuity to live (review #9)
      };
    }
    const run = repo.getRun(runId);
    if (!run) return null;
    return { run, nodes: repo.getNodes(runId), events: repo.getEventsTail(runId) };
  }
}

/** Assemble a nested tree from a flat node list (DB replay path). */
function assembleFromFlat(nodes: RunNode[], rootId: string): RunNode | null {
  const byParent = new Map<string | null, RunNode[]>();
  const byId = new Map<string, RunNode>();
  for (const n of nodes) {
    const copy = { ...n, children: [] as RunNode[] };
    byId.set(n.id, copy);
    const list = byParent.get(n.parentId) ?? [];
    list.push(copy);
    byParent.set(n.parentId, list);
  }
  const root = byId.get(rootId) ?? nodes.find((n) => n.parentId === null);
  if (!root) return null;
  const attach = (node: RunNode): RunNode => {
    node.children = (byParent.get(node.id) ?? []).map(attach).sort((a, b) => a.startedAt - b.startedAt);
    return node;
  };
  return attach(byId.get(root.id)!);
}

export const registry = new Registry();
