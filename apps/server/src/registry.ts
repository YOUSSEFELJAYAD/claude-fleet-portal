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
import { validateConfig } from './config.js';
import { repo } from './db.js';
import { RunTree } from './tree.js';
import { normalize } from './parser.js';
import { spawnClaude, buildArgs, buildResumeArgs, killProcessGroup, type ManagedProcess } from './processManager.js';
import { getEngineBin, engineLaunchConfig, isEngineEnabled } from './addons.js';
import { buildEngineArgs, parseEngineLine, spawnEngine, type ManagedEngineProcess } from './engines.js';

const TERMINAL: RunStatus[] = ['completed', 'failed', 'killed'];
const isTerminal = (s: RunStatus) => TERMINAL.includes(s);

/** H18 — getEventsTail caps at the most-recent 5000 events; if it returned a full page and the
 *  earliest returned seq is past 0, earlier events were omitted from this snapshot. */
export function tailTruncatedBefore(events: NormalizedEvent[]): number | undefined {
  return events.length >= 5000 && (events[0]?.seq ?? 0) > 0 ? events[0].seq : undefined;
}

/** H14 — the verified SDK control-protocol response shape for a permission decision. */
export function buildPermissionControlResponse(requestId: string, decision: 'approve' | 'deny') {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: decision === 'approve' ? 'allow' : 'deny' },
    },
  };
}

interface LiveRun {
  run: Run;
  req: LaunchRequest;
  tree: RunTree;
  proc: ManagedProcess | null;
  /** Engine add-on runs use a ManagedEngineProcess instead of a ManagedProcess. */
  engineProc: ManagedEngineProcess | null;
  interactive: boolean;
  killed: boolean;
  resultSeen: boolean;
  resultError: boolean;
  awaitingPermission: boolean;
  /** H14 — a decision was written to stdin; awaitingPermission clears only when the child
   *  actually advances (next non-permission event), not optimistically on send. */
  permissionSent: boolean;
  lastStderr: string;
  /** H16 — coalesced DB writes: pending changed nodes (by id) + new events + a dirty run row,
   *  flushed in one transaction on a short timer / on terminal / before a snapshot read. */
  pendingNodes: Map<string, RunNode>;
  pendingEvents: NormalizedEvent[];
  runDirty: boolean;
  flushTimer: NodeJS.Timeout | null;
  /** Set by deleteRun() — the detached child can outlive the record by up to ~3s
   *  (SIGTERM→SIGKILL window); its late onExit must not resurrect deleted rows. */
  deleted?: boolean;
}

function modelRates(modelId: string, fast: boolean) {
  // Unknown ids price as the DEFAULT model (opus), not whatever happens to be first
  // in the catalog — Fable 5 sits at MODELS[0] and costs 2× opus.
  const m =
    MODELS.find((x) => x.id === modelId) ?? MODELS.find((x) => x.id === 'claude-opus-4-8') ?? MODELS[0];
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
      this.evictTimers.delete(runId);
      const lr = this.live.get(runId);
      if (!lr || !isTerminal(lr.run.status)) return;
      const subs = this.runSubs.get(runId)?.size ?? 0;
      if (subs === 0) this.live.delete(runId);
      else this.scheduleEvict(runId);
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

    // §24 — per-run wall-clock timeout sweep: unref'd so it doesn't keep the process alive.
    const sweepInterval = setInterval(() => this.sweepTimeouts(), 30_000);
    sweepInterval.unref();
  }

  // ── §24 guardrail helpers ────────────────────────────────────────────────────

  /** Check today's spend against the daily ceiling. Throws 409 'daily-cap' if breached. */
  private checkDailyCap() {
    if (this.config.dailySpendCeilingUsd == null) return;
    const today = startOfToday();
    const spent = repo.spendSince(today);
    const cap = this.config.dailySpendCeilingUsd;
    if (spent >= cap) {
      throw Object.assign(
        new Error(`Daily spend ceiling reached ($${spent.toFixed(2)} of $${cap.toFixed(2)}) — raise it in Guardrails or wait for tomorrow`),
        { statusCode: 409, code: 'daily-cap' },
      );
    }
  }

  /**
   * §24 — sweep live runs for wall-clock timeout. Exported so tests can call it directly
   * without relying on the 30s interval timer. Optionally accepts a timestamp to treat as
   * 'now' (for deterministic tests that backdate a run's startedAt).
   */
  sweepTimeouts(now: number = Date.now()) {
    const maxMs = this.config.maxRunMinutes == null ? null : this.config.maxRunMinutes * 60_000;
    if (maxMs == null) return;
    for (const lr of this.live.values()) {
      if (isTerminal(lr.run.status)) continue;
      if (lr.killed) continue;
      const elapsed = now - lr.run.startedAt;
      if (elapsed > maxMs) {
        lr.run.error = `[guardrail] exceeded maxRunMinutes (${this.config.maxRunMinutes} min) — auto-killed.`;
        lr.lastStderr += `\n${lr.run.error}`;
        this.stop(lr.run.id, 'timeout');
      }
    }
  }

  /** §24 — stop every live non-terminal run. Returns the count of runs stopped. */
  stopAll(): number {
    let count = 0;
    for (const lr of this.live.values()) {
      if (isTerminal(lr.run.status)) continue;
      if (lr.killed) continue;
      this.stop(lr.run.id, 'user');
      count++;
    }
    return count;
  }

  /** §24 — expose the live map count for tests (backdate helper). */
  __backdateRunForTests(runId: string, startedAt: number) {
    const lr = this.live.get(runId);
    if (lr) {
      lr.run.startedAt = startedAt;
      repo.upsertRun(lr.run);
    }
  }

  // ── config ────────────────────────────────────────────────────────────────
  getConfig(): PortalConfig {
    return this.config;
  }
  setConfig(cfg: unknown) {
    // H9 — validate/clamp + merge DEFAULT_CONFIG so a partial/invalid PUT can't disable
    // the guardrails or leave a ceiling undefined. Throws a 400 on invalid input.
    const valid = validateConfig(cfg);
    this.config = valid;
    repo.setConfig(valid);
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
    cb({ kind: 'hello', run: snapshot.run, nodes: snapshot.nodes, events: snapshot.events, truncatedBefore: snapshot.truncatedBefore });
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
    // §24 — daily spend hard cap: checked after concurrency so the 429 fires first when both hit.
    this.checkDailyCap();
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
      projectId: req.projectId ?? null,
      pid: null,
      status: 'starting',
      startedAt: now,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      exitCode: null,
      killReason: null,
      error: null,
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
      engineProc: null,
      interactive,
      killed: false,
      resultSeen: false,
      resultError: false,
      awaitingPermission: false,
      permissionSent: false,
      pendingNodes: new Map(),
      pendingEvents: [],
      runDirty: false,
      flushTimer: null,
      lastStderr: '',
    };
    this.live.set(sessionId, lr);

    const args = buildArgs(req, sessionId, interactive);
    this.startProcess(lr, args);
    this.emitRun(lr);
    return run;
  }

  /**
   * Async engine launch — validates the engine add-on state (requires awaiting getEngineBin),
   * creates the run record, spawns the engine CLI.  Called from server.ts for engine runs.
   */
  async launchEngine(reqIn: LaunchRequest): Promise<Run> {
    const engine = reqIn.engine!;
    if (!isEngineEnabled(engine)) {
      throw Object.assign(new Error(`Engine add-on '${engine}' is not enabled — enable it in the Add-on Marketplace first`), {
        statusCode: 409,
        code: 'engine-disabled',
      });
    }
    const bin = await getEngineBin(engine);
    if (!bin) {
      throw Object.assign(new Error(`Engine '${engine}' binary is not installed — install it from the Add-on Marketplace`), {
        statusCode: 409,
        code: 'engine-not-installed',
      });
    }

    const activeCount = [...this.live.values()].filter((lr) => !isTerminal(lr.run.status)).length;
    if (activeCount >= this.config.maxConcurrentRuns) {
      throw Object.assign(new Error(`Max concurrent runs reached (${this.config.maxConcurrentRuns})`), {
        statusCode: 429,
      });
    }
    // §24 — daily spend hard cap (same check as launch).
    this.checkDailyCap();
    if (!reqIn.cwd || !existsSync(reqIn.cwd) || !statSync(reqIn.cwd).isDirectory()) {
      throw Object.assign(new Error(`Working directory does not exist: ${reqIn.cwd}`), { statusCode: 400 });
    }

    const cfg = engineLaunchConfig(engine);
    const resolvedModel = reqIn.engineModel ?? (cfg as any).defaultModel ?? engine;

    const sessionId = randomUUID();
    const now = Date.now();
    const run: Run = {
      id: sessionId,
      sessionId,
      task: reqIn.prompt,
      cwd: reqIn.cwd,
      model: resolvedModel,
      engine,
      fastMode: false,
      effort: reqIn.effort || 'high',
      workflowsEnabled: false,
      ultracode: false,
      teamId: null,
      campaignId: reqIn.campaignId ?? null,
      projectId: reqIn.projectId ?? null,
      pid: null,
      status: 'starting',
      startedAt: now,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      exitCode: null,
      killReason: null,
      error: null,
      budgetUsd: reqIn.budgetUsd ?? null,
      permissionMode: reqIn.permissionMode || 'default',
      allowedTools: null,
      skills: [],
      subagentProfile: null,
      resultText: null,
      structuredOutput: null,
      subagentCount: 0,
      liveSubagents: 0,
      maxDepth: 0,
      lastActivity: now,
    };
    repo.upsertRun(run);

    // Engine runs don't use a cost-aware tree (no model rates known); use a dummy rate.
    const tree = new RunTree(sessionId, sessionId, { inputPerM: 0, outputPerM: 0 }, now);
    const lr: LiveRun = {
      run,
      req: reqIn,
      tree,
      proc: null,
      engineProc: null,
      interactive: false,
      killed: false,
      resultSeen: false,
      resultError: false,
      awaitingPermission: false,
      permissionSent: false,
      pendingNodes: new Map(),
      pendingEvents: [],
      runDirty: false,
      flushTimer: null,
      lastStderr: '',
    };
    this.live.set(sessionId, lr);

    const args = buildEngineArgs(engine, reqIn, cfg);
    this.startEngineProcess(lr, engine, bin, args);
    this.emitRun(lr);
    return run;
  }

  private startEngineProcess(lr: LiveRun, engine: import('@fleet/shared').RunEngine, bin: string, args: string[]) {
    // The root node is already seeded by RunTree constructor — mark it running.
    const rootNode = lr.tree.nodes.get(lr.run.id);
    if (rootNode) {
      rootNode.status = 'running';
      lr.pendingNodes.set(rootNode.id, rootNode);
    }
    lr.run.status = 'running';

    let lastResultText: string | undefined;
    let totalTokIn = 0;
    let totalTokOut = 0;

    lr.engineProc = spawnEngine(engine, bin, args, lr.run.cwd, {
      onLine: (obj) => {
        if (lr.killed) return;
        const line = parseEngineLine(engine, obj);

        // Accumulate usage
        if (line.usage) {
          totalTokIn += line.usage.tokensIn;
          totalTokOut += line.usage.tokensOut;
          lr.run.tokensIn = totalTokIn;
          lr.run.tokensOut = totalTokOut;
        }
        if (line.resultText) {
          lastResultText = line.resultText;
          lr.resultSeen = true;
        }
        if (line.isError) {
          lr.resultError = true;
        }

        if (line.type && line.type !== null) {
          const seq = lr.tree.seq++;
          const ts = Date.now();
          const event: NormalizedEvent = {
            sessionId: lr.run.sessionId,
            runId: lr.run.id,
            nodeId: lr.run.id,
            parentNodeId: null,
            nodeType: 'root',
            seq,
            ts,
            type: line.type,
            payload: line.payload ?? {},
          };
          lr.pendingEvents.push(event);
          this.broadcastRun(lr.run.id, { kind: 'event', event });
        }

        lr.run.lastActivity = Date.now();
        lr.runDirty = true;
        this.scheduleFlush(lr);
        this.emitRun(lr);
      },
      onStderr: (c) => {
        lr.lastStderr = (lr.lastStderr + c).slice(-2000);
      },
      onExit: (code) => {
        if (lr.deleted || this.live.get(lr.run.id) !== lr) {
          lr.engineProc = null;
          return;
        }
        this.flush(lr);

        // Final token write
        lr.run.tokensIn = totalTokIn;
        lr.run.tokensOut = totalTokOut;
        lr.run.costUsd = 0; // engine CLIs provide no cost stream
        lr.run.resultText = lastResultText ?? null;

        let status: RunStatus;
        if (lr.killed) status = 'killed';
        else if (code === 0 || (lr.resultSeen && !lr.resultError)) status = 'completed';
        else status = 'failed';

        lr.run.status = status;
        lr.run.endedAt = Date.now();
        lr.run.exitCode = code;

        if (status !== 'completed') {
          const err = lr.lastStderr.trim();
          if (err) lr.run.error = err.slice(-2000);
        }

        // Mark root node done
        const rootNode = lr.tree.nodes.get(lr.run.id);
        if (rootNode) {
          rootNode.status = status === 'completed' ? 'completed' : 'failed';
          rootNode.endedAt = lr.run.endedAt;
          rootNode.tokensIn = totalTokIn;
          rootNode.tokensOut = totalTokOut;
        }
        lr.engineProc = null;

        repo.upsertNodes(lr.tree.flatNodes());
        repo.upsertRun(lr.run);
        this.emitRun(lr);
        this.notifyTerminal(lr);
        this.scheduleEvict(lr.run.id);
      },
    });

    lr.run.pid = lr.engineProc.pid ?? null;
    repo.upsertRun(lr.run);
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
    // H12 — once a run is killed, the detached child can keep emitting for up to the
    // SIGTERM→SIGKILL window; ignore those lines instead of running the full ingest →
    // persist → broadcast body for an already-terminal run (wasted DB writes + SSE noise).
    if (lr.killed) return;
    const parsedList = normalize(raw);
    if (parsedList.length === 0) return;

    for (const parsed of parsedList) {
      const ts = Date.now();
      const r = lr.tree.ingest(parsed, ts);
      if (r.events.length === 0) continue;

      // H16 — buffer nodes + non-ephemeral events for a coalesced flush (instead of a
      // commit per line). Live SSE still fans out immediately below; only the DB write is batched.
      const changedNodes = [...r.changedNodeIds]
        .map((id) => lr.tree.nodes.get(id))
        .filter((n): n is RunNode => !!n);
      for (const n of changedNodes) lr.pendingNodes.set(n.id, n);
      for (const e of r.events) if (e.type !== 'assistant_partial' && e.type !== 'thinking') lr.pendingEvents.push(e);

      // fan out events + node updates
      for (const e of r.events) this.broadcastRun(lr.run.id, { kind: 'event', event: e });
      for (const n of changedNodes) this.broadcastRun(lr.run.id, { kind: 'node', node: n });

      // status signals
      if (r.init) this.setLiveStatus(lr);
      if (r.permission) {
        lr.awaitingPermission = true;
        lr.permissionSent = false;
      } else if (lr.permissionSent && parsed.type !== 'noise') {
        // H14 — the child advanced past the prompt after our decision → clear the await state.
        lr.awaitingPermission = false;
        lr.permissionSent = false;
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

    lr.runDirty = true; // H16 — coalesced flush instead of a per-line upsertRun
    this.scheduleFlush(lr);
    this.emitRun(lr);
  }

  /** H16 — flush the coalesced node/event/run buffer to SQLite in one transaction. */
  private flush(lr: LiveRun) {
    if (lr.flushTimer) {
      clearTimeout(lr.flushTimer);
      lr.flushTimer = null;
    }
    const nodes = lr.pendingNodes.size ? [...lr.pendingNodes.values()] : [];
    const events = lr.pendingEvents;
    if (!nodes.length && !events.length && !lr.runDirty) return;
    lr.pendingNodes = new Map();
    lr.pendingEvents = [];
    lr.runDirty = false;
    repo.batchPersist(nodes, events, lr.run);
  }
  private scheduleFlush(lr: LiveRun) {
    if (lr.flushTimer) return;
    lr.flushTimer = setTimeout(() => {
      lr.flushTimer = null;
      this.flush(lr);
    }, 75);
    lr.flushTimer.unref();
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
    // The run was deleted (or replaced by a resume) while the child was still dying —
    // upserting now would re-INSERT the deleted rows, re-broadcast a ghost run, and
    // fire a second terminal notification. Drop everything from this stale closure.
    if (lr.deleted || this.live.get(lr.run.id) !== lr) {
      lr.proc = null;
      return;
    }
    this.flush(lr); // H16 — drain buffered events before writing the terminal state
    let status: RunStatus;
    if (lr.killed) status = 'killed';
    else if (code === 0 || (lr.resultSeen && !lr.resultError)) status = 'completed';
    else status = 'failed';

    const now = Date.now();
    lr.run.status = status;
    lr.run.endedAt = now;
    lr.run.exitCode = code;
    // H5 — surface the captured stderr / guardrail note instead of discarding it, so a
    // failed/killed run shows WHY (the F-8/F-9/F-11 history is all flags that fail only
    // against real claude — a bare status='failed' hid the actual cause).
    if (status !== 'completed') {
      const err = lr.lastStderr.trim();
      if (err) lr.run.error = err.slice(-2000);
    }
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
    if (!lr || (!lr.proc && !lr.engineProc)) throw Object.assign(new Error('Run is not live; use Resume instead.'), { statusCode: 409 });
    if (lr.engineProc) throw Object.assign(new Error('Input is not supported on engine add-on runs.'), { statusCode: 409, code: 'engine-unsupported' });
    if (!lr.interactive) throw Object.assign(new Error('Run was launched one-shot (not interactive).'), { statusCode: 409 });
    if (!lr.proc) throw Object.assign(new Error('Run process is not live.'), { statusCode: 409 });
    lr.proc.writeUserMessage(text);
    lr.resultSeen = false;
    if (lr.tree.authoritativeCost != null) lr.tree.liveCostEstimate = lr.tree.authoritativeCost;
    lr.tree.authoritativeCost = null;
    lr.tree.authoritativeTokensIn = null;
    lr.tree.authoritativeTokensOut = null;
    if (!isTerminal(lr.run.status)) {
      lr.run.status = 'running';
      this.emitRun(lr);
    }
  }

  /**
   * H4 — on server shutdown, terminate every live claude child process group. They are
   * spawned detached, so without this they survive the parent and keep spending budget
   * (the boot-time reconcileOrphans is only a reactive band-aid that leaves an orphan window).
   */
  shutdown() {
    for (const lr of this.live.values()) {
      try {
        lr.proc?.kill();
        lr.engineProc?.kill();
        killProcessGroup(lr.run.pid, true);
      } catch {
        /* best-effort during shutdown */
      }
    }
  }

  stop(runId: string, reason: 'user' | 'budget' | 'timeout' = 'user') {
    const lr = this.live.get(runId);
    if (!lr) {
      // Also handles engine runs via persisted pid — though engine CLIs don't track
      // the pid as a process group, the generic killProcessGroup is still safe here.
      // Run isn't in this process's live map (e.g. after a server restart). Kill its process
      // group by persisted pid, mark it killed, and broadcast so the UI reflects it (PRD §10).
      const run = repo.getRun(runId);
      if (!run) return;
      if (!isTerminal(run.status)) {
        // Signal the pid ONLY while the record says the run is live — a terminal row's
        // persisted pid may have been recycled by the OS onto an unrelated process
        // (another fleet run passes the looksLikeClaudePid guard).
        killProcessGroup(run.pid);
        run.status = 'killed';
        run.killReason = reason; // H5
        run.endedAt = Date.now();
        repo.upsertRun(run);
      }
      this.broadcastRun(run.id, { kind: 'run', run }); // update an open run page
      this.broadcastFleet({ kind: 'run', run });
      this.broadcastFleet({ kind: 'spend', spend: this.spend() });
      return;
    }
    if (isTerminal(lr.run.status)) return;
    this.flush(lr); // H16 — drain buffered events before the terminal write
    lr.killed = true;
    const now = Date.now();
    lr.tree.killAll(now);
    lr.run.status = 'killed';
    lr.run.killReason = reason; // H5 — distinguish user stop vs budget auto-kill
    lr.run.endedAt = now;
    lr.run.liveSubagents = 0;
    repo.upsertNodes(lr.tree.flatNodes());
    repo.upsertRun(lr.run);
    this.emitRun(lr);
    this.notifyTerminal(lr);
    // kill either the claude process or the engine process
    lr.proc?.kill();
    lr.engineProc?.kill();
    this.scheduleEvict(runId);
  }

  /** Permanently delete a finished run from history (PRD §7.8). Live runs must be stopped first. */
  deleteRun(runId: string) {
    const lr = this.live.get(runId);
    const run = lr?.run ?? repo.getRun(runId);
    if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    if (!isTerminal(run.status)) {
      throw Object.assign(new Error('Stop the run before deleting it.'), { statusCode: 409 });
    }
    if (lr) lr.deleted = true; // the dying child's late onExit must not resurrect the rows
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
    // Engine add-on runs are one-shot; resume is not supported.
    if (existing.engine && existing.engine !== 'claude') {
      throw Object.assign(new Error('Resume is not supported on engine add-on runs.'), { statusCode: 409, code: 'engine-unsupported' });
    }
    // concurrency guardrail also applies to resume (review #3)
    const activeCount = [...this.live.values()].filter((lr) => !isTerminal(lr.run.status)).length;
    if (activeCount >= this.config.maxConcurrentRuns) {
      throw Object.assign(new Error(`Max concurrent runs reached (${this.config.maxConcurrentRuns})`), { statusCode: 429 });
    }
    // Mirror launch()'s cwd guard — a PM worktree may have been pruned since this run
    // finished; without this the spawn fails async into a bare 'failed' with no error.
    if (!existsSync(existing.cwd) || !statSync(existing.cwd).isDirectory()) {
      throw Object.assign(new Error(`Working directory no longer exists: ${existing.cwd}`), { statusCode: 400 });
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
    existing.killReason = null;
    existing.error = null;
    const lr: LiveRun = {
      run: existing,
      req,
      tree,
      proc: null,
      engineProc: null,
      interactive: !!req.interactive,
      killed: false,
      resultSeen: false,
      resultError: false,
      awaitingPermission: false,
      permissionSent: false,
      pendingNodes: new Map(),
      pendingEvents: [],
      runDirty: false,
      flushTimer: null,
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
    if (!lr || (!lr.proc && !lr.engineProc)) throw Object.assign(new Error('Run is not live'), { statusCode: 409 });
    if (lr.engineProc) throw Object.assign(new Error('Permission decisions are not supported on engine add-on runs.'), { statusCode: 409, code: 'engine-unsupported' });
    if (!lr.interactive) {
      // One-shot runs had stdin closed at spawn — a write would be silently dropped
      // (ERR_STREAM_WRITE_AFTER_END is swallowed) and the child would wait forever.
      throw Object.assign(
        new Error('This run was launched one-shot; its stdin is closed so a permission decision cannot be delivered. Stop the run, or relaunch interactive / with a non-prompting permission mode.'),
        { statusCode: 409 },
      );
    }
    // H14 — use the verified SDK control-protocol shape: subtype:'success' wrapper, and the
    // inner response keyed by `behavior: allow|deny` (NOT `decision`), nested one level deeper.
    // (best-effort: this CC version has no --permission-prompt-tool flag and CLI #469/#34046
    // report can_use_tool may not fire under -p at all, so this path is largely dormant.)
    const msg = JSON.stringify(buildPermissionControlResponse(requestId, decision));
    try {
      (lr.proc?.child.stdin as any)?.write(msg + '\n');
    } catch {
      /* ignore */
    }
    // H14 — do NOT optimistically clear/flip to running; the child may reject or never proceed
    // (masking a silent failure). awaitingPermission clears in handleLine when the child advances.
    lr.permissionSent = true;
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

  private snapshot(runId: string): { run: Run; nodes: RunNode[]; events: NormalizedEvent[]; truncatedBefore?: number } | null {
    const lr = this.live.get(runId);
    if (lr) {
      this.flush(lr); // H16 — ensure buffered events are in the DB before a snapshot read
      const events = repo.getEventsTail(runId); // most-recent events → continuity to live (review #9)
      return { run: { ...lr.run }, nodes: lr.tree.flatNodes(), events, truncatedBefore: tailTruncatedBefore(events) };
    }
    const run = repo.getRun(runId);
    if (!run) return null;
    const events = repo.getEventsTail(runId);
    return { run, nodes: repo.getNodes(runId), events, truncatedBefore: tailTruncatedBefore(events) };
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
