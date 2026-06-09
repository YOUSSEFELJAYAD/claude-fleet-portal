/**
 * Autonomous "head of product" PM engine (agent-PM / Kanban feature — SPEC §5 loop + §6 gate;
 * docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md).
 *
 * A SIBLING of CampaignEngine (campaigns.ts): both subscribe the SAME registry.onRunTerminal
 * stream and coexist by partitioning on `run.campaignId` — campaigns own runs with a campaignId,
 * the PM owns runs with `campaignId === null` that link to a kanban card via the indexed
 * `kanban_tasks.run_id`. campaigns.ts / registry.ts are NOT rewritten.
 *
 * Lifecycle: pm.init() (called once by the main loop, beside campaigns.init()) subscribes the
 * terminal stream and arms an unref'd safety tick. The loop, per project:
 *   Select  → tick(projectId): top Ready card by priority then rank while InProgress < wip_limit,
 *             !paused, project spend < budget_ceiling_usd; unmet depends_on → Blocked.
 *   Build   → launchBuild(): registry.launch into an isolated worktree (campaignId:null), no git push/remote.
 *   Terminal→ handleRunTerminal(): ensure-committed → validate in the worktree → gate or rework.
 *   Gate    → auto_merge=0 → park in Review (STOP); auto_merge=1 → conflict-probe → merge under the mutex.
 *   Rework  → relaunch a fix run threading validation output; attempt_count++; no-progress diff-hash
 *             guard; at/over max_attempts → Blocked + phase failed.
 *
 * Merge-to-main serializes through a per-project async mutex (the single main worktree is never raced);
 * isolated worker worktrees stay fully parallel.
 *
 * H2 ordering (cancel/delete): mark the card terminal in the DB FIRST, then registry.stop(run_id) — the
 * synchronous onRunTerminal that stop() fires re-reads the card and short-circuits on the terminal column.
 *
 * Out-of-scope (SPEC §11): no campaign-per-card (one build run per card; campaign_id stays null), no
 * remote git / push (disallowedTools), no conflict resolution (conflicts park in Review), no port-binding
 * validation (pure checks only). The PM never auto-generates the backlog — humans create cards.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Run, Project, KanbanTask } from '@fleet/shared';
import { registry } from './registry.js';
import { projectsRepo } from './projects.js';
import { kanbanRepo } from './kanban.js';
import {
  ensureCommitted,
  conflictProbe,
  integrateAndReport,
  mergeBranch,
  cleanupWorktree,
  ensureWorktreeIgnored,
  scrubCredentials,
} from './git.js';
import { fetchAndSyncDefault, pushBranch, prCreate, prView } from './gh.js';
import { runValidation, VALIDATION_MAX_BUFFER } from './validation.js';
import { brokerValidate, type BrokerConfig } from './portbroker.js';

const execFileAsync = promisify(execFile);

// ── tunables ──────────────────────────────────────────────────────────────────
const SAFETY_TICK_MS = 10_000; // unref'd: human card moves fire no terminal event (SPEC §5.1)

/** PM run template defaults (SPEC §5.2). bypassPermissions is safe here: the build runs in an
 *  ISOLATED worktree and git push/remote are denied, so an unattended run can't escape or publish. */
const PM_MODEL = 'claude-opus-4-8';
const PM_EFFORT = 'high' as const;
const PM_PERMISSION_MODE = 'bypassPermissions' as const;
const PM_DISALLOWED_TOOLS = ['Bash(git push *)', 'Bash(git remote *)'];

/**
 * The ONE deny-list source every PM launch path reads (v2 §3.4). It returns the v1
 * PM_DISALLOWED_TOOLS list (`Bash(git push *)` + `Bash(git remote *)`) by DEFAULT, and RELAXES it
 * (drops BOTH the push and remote deny entries) ONLY when `project.pushEnabled` is true.
 *
 * CRITICAL (§3.4): the relaxation is for SINGLE-MODE build/fix launches ONLY — those are the agents
 * that may legitimately need to push their own branch. Campaign workers (#4) and the resolve agent
 * (#9) edit files only; their push is an engine-side step performed by the portal as `fleet-pm`, so
 * they must NEVER inherit the relaxed list. Those (future) call sites must therefore pass the
 * UNRELAXED list — e.g. `disallowedToolsForProject({ ...project, pushEnabled: false })` or the raw
 * `PM_DISALLOWED_TOOLS` — and must NOT call this with the live project when pushEnabled is set. Do
 * NOT change their call sites to use the relaxed form.
 *
 * A fresh array is returned each call so a consumer can never mutate the shared constant.
 */
export function disallowedToolsForProject(project: Project): string[] {
  // Relax by DROPPING only the push/remote denies (not blanket-clearing the list) so a future
  // non-push deny entry survives the relaxation.
  if (project.pushEnabled) return PM_DISALLOWED_TOOLS.filter((t) => !/git\s+(push|remote)/.test(t));
  return [...PM_DISALLOWED_TOOLS];
}

/** Columns from which the PM never re-launches / re-evaluates a card (terminal-ish). */
const PM_DONE_COLUMNS = new Set(['Done', 'Canceled']);

// ── validation runner ──────────────────────────────────────────────────────────
// runValidation / ValidationResult / capOutput + the VALIDATION_* consts moved to validation.ts
// (v2 §3.2) so #4/#5/#9 can share them without importing pm.ts. pm.ts imports them above.

// ── helpers ─────────────────────────────────────────────────────────────────
/** Deterministic worktree NAME for a card (SPEC §6: `task-<id>`). */
function worktreeNameFor(card: KanbanTask): string {
  return `task-${card.id}`;
}
/** Branch NAME git's `--worktree <name>` produces (SPEC §6: `worktree-task-<id>`). */
function branchNameFor(worktreeName: string): string {
  return `worktree-${worktreeName}`;
}
/** Absolute worktree dir (matches git.ts cleanupWorktree + processManager H10). */
function worktreeDirFor(rootDir: string, worktreeName: string): string {
  return path.join(rootDir, '.claude', 'worktrees', worktreeName);
}

/** The validation command for a card: its own, else the project default. null/empty → no checks. */
function validationCommandFor(card: KanbanTask, project: Project): string | null {
  const cmd = card.validationCommand ?? project.defaultValidationCommand ?? null;
  return cmd && cmd.trim() ? cmd : null;
}

/** Effective server-start command (card override, else project). null/empty → pure (non-server) checks. */
function serverStartCommandFor(card: KanbanTask, project: Project): string | null {
  const cmd = card.serverStartCommand ?? project.serverStartCommand ?? null;
  return cmd && cmd.trim() ? cmd : null;
}

/** Port-broker config from the merged project+card (per-card overrides = the 3 card fields; rest inherit). */
export function brokerConfigFor(card: KanbanTask, project: Project, validationCommand: string): BrokerConfig {
  return {
    serverStartCommand: (card.serverStartCommand ?? project.serverStartCommand) as string,
    validationCommand,
    healthCheckUrl: card.healthCheckUrl ?? project.healthCheckUrl ?? undefined,
    healthCheckRegex: card.healthCheckRegex ?? project.healthCheckRegex ?? undefined,
    readinessTimeoutMs: project.readinessTimeoutMs ?? undefined,
    portRangeStart: project.portRangeStart ?? undefined,
    portRangeEnd: project.portRangeEnd ?? undefined,
    copyEnvFrom: project.copyEnvFrom ?? undefined,
  };
}

/**
 * Validate a card's worktree (v2 #5). DEFAULT = v1 pure checks (runValidation, exit-code oracle).
 * If the project/card configures a server-start command, run the validation against a LIVE server
 * via the port broker instead (allocate port → start → health → check → teardown). A null validation
 * command → pass (nothing to check), preserving v1 behavior. Returns {ok, output}.
 */
export async function validateCard(
  wtDir: string,
  project: Project,
  card: KanbanTask,
): Promise<{ ok: boolean; output: string | null }> {
  const cmd = validationCommandFor(card, project);
  if (serverStartCommandFor(card, project)) {
    if (!cmd) return { ok: true, output: null }; // server configured but nothing to check → pass
    const vr = await brokerValidate(wtDir, brokerConfigFor(card, project, cmd));
    return { ok: vr.ok, output: vr.output || null };
  }
  if (!cmd) return { ok: true, output: null };
  const vr = await runValidation(wtDir, cmd);
  return { ok: vr.ok, output: vr.output || null };
}

/** Build the initial build prompt from the card (SPEC §5.2). */
function buildPrompt(card: KanbanTask): string {
  const parts = [`TASK: ${card.title}`];
  if (card.description.trim()) parts.push(`\nDESCRIPTION:\n${card.description}`);
  if (card.acceptanceCriteria.trim()) parts.push(`\nACCEPTANCE CRITERIA / DEFINITION OF DONE:\n${card.acceptanceCriteria}`);
  parts.push(
    '\nImplement this task in the current working directory. Commit nothing to a remote and do not push; ' +
      'all changes stay local. When done, ensure the code satisfies the acceptance criteria.',
  );
  return parts.join('\n');
}

/** Build a rework/fix prompt threading the failing validation output (SPEC §5.6). */
function fixPrompt(card: KanbanTask): string {
  const base = buildPrompt(card);
  const evidence = card.lastError?.startsWith('[human request-changes]')
    ? `\n\nA reviewer requested changes:\n${card.lastError}`
    : '';
  const vout = card.validationOutput
    ? `\n\nThe previous attempt FAILED validation. Fix the issues so the validation command passes. ` +
      `Validation output (tail):\n${card.validationOutput}`
    : '\n\nThe previous attempt did not pass. Address the remaining issues.';
  return base + evidence + vout;
}

/** PR body for `gh pr create` (v2 #2): the card's description + acceptance criteria, with a
 *  fleet-pm attribution footer. Empty sections are omitted. */
function prBody(card: KanbanTask): string {
  const parts: string[] = [];
  if (card.description.trim()) parts.push(card.description.trim());
  if (card.acceptanceCriteria.trim()) {
    parts.push(`## Acceptance criteria\n\n${card.acceptanceCriteria.trim()}`);
  }
  parts.push('---\n_Opened by the Fleet PM (card automerge gate). Review and merge on GitHub._');
  return parts.join('\n\n');
}

// ── engine ─────────────────────────────────────────────────────────────────
class PmEngine {
  /** Per-project merge mutex: a promise chain so merge-to-main on a project serializes (SPEC §6). */
  private mergeLocks = new Map<string, Promise<void>>();
  /** Re-entrancy guard so the safety tick and a terminal handler don't double-drive one project. */
  private ticking = new Set<string>();
  /** Cards with a merge in flight (queued on the mutex or running) — keeps the 10s safety tick from
   *  re-firing approve() for a Review+merging card whose merge is simply taking >10s. */
  private merging = new Set<string>();
  private safetyTimer: NodeJS.Timeout | null = null;

  // ── lifecycle ───────────────────────────────────────────────────────────────
  init() {
    registry.onRunTerminal((run) => this.handleRunTerminal(run));
    if (!this.safetyTimer) {
      // Human card moves (Backlog→Ready, drag) fire no terminal event → an unref'd safety tick
      // re-evaluates every project periodically. unref so it never keeps the process alive.
      this.safetyTimer = setInterval(() => this.tickAll(), SAFETY_TICK_MS);
      this.safetyTimer.unref();
    }
  }

  /** Tick every known project (safety sweep). */
  private tickAll() {
    for (const p of projectsRepo.listProjects()) {
      this.tick(p.id).catch(() => {
        /* a per-project tick failure must never crash the sweep */
      });
    }
  }

  // ── per-project merge mutex ───────────────────────────────────────────────────
  /**
   * Run `fn` while holding the project's merge lock; the promise chain serializes all merges-to-main
   * for a project (the single main worktree is never raced — SPEC §6/§10). `fn` starts only after the
   * prior holder settles (success OR failure), and the stored tail resolves only after `fn` settles.
   */
  private withMergeLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeLocks.get(projectId) ?? Promise.resolve();
    // The result of fn (started after prev settles); errors are isolated so the chain never wedges.
    const result = prev.then(fn, fn);
    // The new tail: a void promise that settles after `result` settles (success OR failure), so the
    // NEXT caller waits for this fn to finish before starting.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mergeLocks.set(projectId, tail);
    // GC the entry once this is the last holder (no one chained after us).
    void tail.finally(() => {
      if (this.mergeLocks.get(projectId) === tail) this.mergeLocks.delete(projectId);
    });
    return result;
  }

  /**
   * Public delegate to the per-project lock (v2 #1). The in-browser file edit/commit surface
   * (fileedit.ts) runs its write→stage→commit critical section through THIS so a human commit to the
   * MAIN worktree can never interleave with a PM merge's clean-check (both share the same mergeLocks).
   */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.withMergeLock(projectId, fn);
  }

  // ── SELECT (SPEC §5.1) ─────────────────────────────────────────────────────────
  /**
   * Evaluate one project: block cards with unmet deps, then launch Ready cards (top priority/rank
   * first) until the WIP cap is hit. Called from kanban routes (card create/move — wired by the main
   * loop) and the safety tick. Idempotent + re-entrancy-guarded; never throws to its caller.
   */
  async tick(projectId: string): Promise<void> {
    if (this.ticking.has(projectId)) return;
    this.ticking.add(projectId);
    try {
      const project = projectsRepo.getProject(projectId);
      if (!project) return;

      // Safety net: a human-Approved Review card (the kanban approve route set phase='merging') has no
      // run terminal to ride — drive its merge here. auto_merge cards never park in Review.
      for (const c of kanbanRepo.listTasks(projectId)) {
        if (c.column === 'Review' && c.executionPhase === 'merging') {
          // fire-and-forget under the mutex; do not block the select loop on a long merge.
          void this.approve(c.id);
        }
      }

      if (project.paused) return;

      // Re-evaluate blocked-by-deps for every Ready/Blocked card each tick.
      this.reblockReadyCards(project);

      // Budget ceiling: cumulative project spend must be under the ceiling to launch anything new.
      if (project.budgetCeilingUsd != null && this.projectSpend(projectId) >= project.budgetCeilingUsd) {
        return;
      }

      let inProgress = kanbanRepo.inProgressCount(projectId);
      if (inProgress >= project.wipLimit) return;

      // readyTasks() is already ordered priority DESC, rank ASC.
      for (const card of kanbanRepo.readyTasks(projectId)) {
        if (inProgress >= project.wipLimit) break;
        if (!this.depsSatisfied(card)) continue; // reblockReadyCards already moved it to Blocked
        const launched = await this.launchBuild(card, project);
        if (launched === 'capped') break; // 429 → leave Ready, retry on next terminal
        if (launched === 'ok') inProgress++;
        // 'skip' (card vanished / not Ready anymore) → continue to next candidate
      }
    } finally {
      this.ticking.delete(projectId);
    }
  }

  /** Sentinel stored in `lastError` so a deps-blocked card is distinguishable from a FAILED one
   *  (max_attempts / no-progress) and can be auto-returned to Ready when its deps clear. */
  private static readonly DEP_BLOCK_MSG = 'blocked: waiting on unmet dependencies';

  /**
   * Re-evaluate dependency state each tick (SPEC §5.1):
   *  - a Ready card with unmet deps → Blocked (phase idle, dep-block sentinel).
   *  - a deps-blocked card (our sentinel, phase idle) whose deps are now all Done → back to Ready.
   * A card Blocked by FAILURE (phase 'failed' — max_attempts / no-progress / launch error) is left
   * alone; only the human re-queues it.
   */
  private reblockReadyCards(project: Project) {
    for (const card of kanbanRepo.listTasks(project.id)) {
      if (card.column === 'Ready') {
        if (!this.depsSatisfied(card)) {
          kanbanRepo.updateTask(card.id, {
            column: 'Blocked',
            executionPhase: 'idle',
            lastError: PmEngine.DEP_BLOCK_MSG,
          });
        }
      } else if (
        card.column === 'Blocked' &&
        card.executionPhase === 'idle' &&
        card.lastError === PmEngine.DEP_BLOCK_MSG &&
        this.depsSatisfied(card)
      ) {
        kanbanRepo.updateTask(card.id, { column: 'Ready', executionPhase: 'idle', lastError: null });
      }
    }
  }

  /** A card's deps are satisfied iff every dependency card is Done. Unknown deps are treated unmet. */
  private depsSatisfied(card: KanbanTask): boolean {
    if (!card.dependsOn?.length) return true;
    for (const depId of card.dependsOn) {
      const dep = kanbanRepo.getTask(depId);
      if (!dep || dep.column !== 'Done') return false;
    }
    return true;
  }

  /** Cumulative spend across all runs scoped to this project (live rollups overlaid by registry). */
  private projectSpend(projectId: string): number {
    let sum = 0;
    for (const r of registry.listRuns()) {
      if (r.projectId === projectId) sum += r.costUsd || 0;
    }
    return sum;
  }

  // ── BUILD (SPEC §5.2) ──────────────────────────────────────────────────────────
  /**
   * Launch a single build run for a Ready card into an isolated worktree. Returns:
   *   'ok'     — launched; card moved to InProgress/building with run_id + worktree_name.
   *   'capped' — registry returned 429 (concurrency cap); card LEFT Ready (retry on next terminal).
   *   'skip'   — the card is no longer launchable (vanished / not Ready); caller continues.
   */
  private async launchBuild(card: KanbanTask, project: Project): Promise<'ok' | 'capped' | 'skip'> {
    // Re-read to avoid racing a concurrent move.
    const fresh = kanbanRepo.getTask(card.id);
    if (!fresh || fresh.column !== 'Ready') return 'skip';

    const wtName = worktreeNameFor(fresh);
    try {
      // Gitignore precheck (commit .gitignore as fleet-pm). MUST complete BEFORE registry.launch
      // spawns claude with --worktree: (a) so .claude/worktrees is ignored when the worktree is
      // created (else the main worktree goes dirty → mergeBranch refuses), and (b) sequentially so
      // the .gitignore commit doesn't race claude's `git worktree add` on the same index (index.lock).
      await ensureWorktreeIgnored(project.rootDir);
      const run = registry.launch({
        prompt: buildPrompt(fresh),
        cwd: project.rootDir,
        worktree: wtName,
        projectId: project.id,
        campaignId: null,
        model: PM_MODEL,
        effort: PM_EFFORT,
        permissionMode: PM_PERMISSION_MODE,
        disallowedTools: disallowedToolsForProject(project),
        budgetUsd: fresh.budgetUsd,
        interactive: false,
      });
      kanbanRepo.updateTask(fresh.id, {
        column: 'InProgress',
        executionPhase: 'building',
        runId: run.id,
        worktreeName: wtName,
        lastError: null,
      });
      return 'ok';
    } catch (e: any) {
      if (e?.statusCode === 429) return 'capped';
      // any other launch failure (bad cwd, etc.) → park the card as failed so it isn't retried forever
      kanbanRepo.updateTask(fresh.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `launch failed: ${e?.message ?? e}`,
      });
      return 'skip';
    }
  }

  /** Relaunch a fix run for a card already in InProgress, threading validation output (SPEC §5.6). */
  private launchFix(card: KanbanTask, project: Project): boolean {
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    try {
      const run = registry.launch({
        prompt: fixPrompt(card),
        cwd: project.rootDir,
        worktree: wtName,
        projectId: project.id,
        campaignId: null,
        model: PM_MODEL,
        effort: PM_EFFORT,
        permissionMode: PM_PERMISSION_MODE,
        disallowedTools: disallowedToolsForProject(project),
        budgetUsd: card.budgetUsd,
        interactive: false,
      });
      kanbanRepo.updateTask(card.id, {
        column: 'InProgress',
        executionPhase: 'building',
        runId: run.id,
        worktreeName: wtName,
      });
      return true;
    } catch (e: any) {
      if (e?.statusCode === 429) {
        // leave the card where it is; the safety tick / next terminal retries the fix
        return false;
      }
      kanbanRepo.updateTask(card.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `fix launch failed: ${e?.message ?? e}`,
      });
      return false;
    }
  }

  // ── TERMINAL (SPEC §5.3-§5.6) ─────────────────────────────────────────────────
  /**
   * React to ANY run reaching terminal. Partition: campaign runs are owned by campaigns.ts, so a
   * run with a non-null campaignId is ignored here (and vice-versa). For a PM build run, ensure the
   * worktree is committed, validate, then gate or rework. Any terminal also frees a WIP slot → re-tick
   * the affected project (anti-starvation).
   */
  private handleRunTerminal(run: Run) {
    // campaigns owns runs with a campaignId (the two engines share one onRunTerminal stream).
    if (run.campaignId != null) return;
    const card = kanbanRepo.getTaskByRunId(run.id);
    if (!card) return; // not a PM card run (e.g. a manual/standalone run that happens to have a projectId)

    // Drive the (async) terminal pipeline; failures are caught and parked, never thrown.
    void this.onCardRunDone(card.id, run).catch((e) => {
      kanbanRepo.updateTask(card.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `pm terminal error: ${e?.message ?? e}`,
      });
    });
  }

  private async onCardRunDone(cardId: string, run: Run): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    // If a human/cancel already moved the card to a terminal column, do nothing (H2 ordering).
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return;
    const project = projectsRepo.getProject(card.projectId);
    if (!project) return;

    // A killed run (user stop / budget guardrail) is not a build failure to rework — leave the card
    // wherever the canceller put it; if it's still InProgress it was a budget auto-kill → mark blocked.
    if (run.status === 'killed') {
      if (card.column === 'InProgress') {
        kanbanRepo.updateTask(cardId, {
          column: 'Blocked',
          executionPhase: run.killReason === 'budget' ? 'paused-budget' : 'failed',
          lastError: run.killReason === 'budget' ? 'run auto-killed: per-run budget reached' : 'run stopped',
        });
      }
      this.tickSoon(card.projectId);
      return;
    }

    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);

    // 1. ensure-committed (as fleet-pm) so the diff/probe/merge see real commits (SPEC §5.3 / §6.1).
    try {
      await ensureCommitted(wtDir);
    } catch (e: any) {
      kanbanRepo.updateTask(cardId, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `ensure-committed failed: ${e?.message ?? e}`,
      });
      this.tickSoon(card.projectId);
      return;
    }

    // 2. validate → gate/rework (extracted to the shared sink, v2 §3.3). ensure-committed already
    // happened above; validateAndGate validates the worktree then pass→gate / fail→rework.
    await this.validateAndGate(cardId, project);
    this.tickSoon(card.projectId);
  }

  /**
   * Shared validate→gate sink (v2 §3.3): the single funnel the single-run terminal (here), the
   * campaign terminal (#4), and the resolve terminal (#9) all route into. PRECONDITION: the
   * worktree is already ensure-committed by the caller. Validates the worktree (no command → treat
   * as pass), then pass → gate, fail → rework. Behavior is byte-for-byte the v1 onCardRunDone
   * validate→gate region; only the enclosing tickSoon stays with each caller.
   */
  private async validateAndGate(cardId: string, project: Project): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);

    // validate in the worktree (SPEC §5.4 / v2 #5). validateCard runs pure checks by default, or
    // against a live server via the port broker when the project/card configures one. No command → pass.
    kanbanRepo.updateTask(cardId, { executionPhase: 'validating' });
    const vr = await validateCard(wtDir, project, card);
    const passed = vr.ok;
    const validationOutput = vr.output;

    if (passed) {
      await this.gate(cardId, project);
    } else {
      await this.rework(cardId, project, validationOutput);
    }
  }

  // ── GATE (SPEC §5.5 / §6) ──────────────────────────────────────────────────────
  /** Validation passed: human-approve (default) parks in Review; auto_merge proceeds to merge. */
  private async gate(cardId: string, project: Project): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;

    if (!project.autoMerge) {
      // STOP for a human Approve — park in Review (phase idle so the badge isn't "merging" yet).
      kanbanRepo.updateTask(cardId, { column: 'Review', executionPhase: 'idle', lastError: null });
      return;
    }
    // auto_merge: probe + merge under the per-project mutex (re-validate happens inside doMerge).
    await this.doMerge(cardId, project, /*humanApproved*/ false);
  }

  /**
   * Approve a Review card (called by the kanban approve route via the main loop, and by the safety
   * tick for a Review+merging card). Runs the full gated merge: conflict probe → integrate+revalidate
   * → merge --no-ff, all under the per-project merge mutex (SPEC §6).
   */
  async approve(taskId: string): Promise<void> {
    const card = kanbanRepo.getTask(taskId);
    if (!card) return;
    if (card.column !== 'Review') return; // only Review cards are approvable
    // A PR is already open for this card (v2 #2 PR mode parks Review+idle with prState set). Re-approving
    // would re-run push + `gh pr create`, which fails because the PR exists. Ignore — use refresh-pr to
    // advance the card to Done when the PR merges on GitHub. prState is null in local mode (unaffected).
    if (card.prState) return;
    const project = projectsRepo.getProject(card.projectId);
    if (!project) return;
    // mark merging so the badge reflects the in-flight merge and a concurrent tick won't re-drive it
    kanbanRepo.updateTask(taskId, { executionPhase: 'merging' });
    await this.doMerge(taskId, project, /*humanApproved*/ true);
  }

  /**
   * Human "Request changes" on a Review card: the kanban route already moved it to InProgress,
   * incremented attemptCount (consumes a slot per SPEC §2), and stashed the comment in lastError.
   * Relaunch a fix run in the SAME worktree (threading the comment via fixPrompt). If the consumed
   * attempt was the last one, give up → Blocked.
   */
  requestChanges(cardId: string): void {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    const project = projectsRepo.getProject(card.projectId);
    if (!project) return;
    if (card.attemptCount >= card.maxAttempts) {
      kanbanRepo.updateTask(cardId, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `${card.lastError ?? 'request-changes'} — max attempts (${card.maxAttempts}) reached`,
      });
      return;
    }
    this.launchFix(card, project);
  }

  /**
   * The gated merge pipeline (SPEC §6.2-§6.6), serialized per project via the merge mutex:
   *   conflict probe → (integrate base + re-validate) → merge --no-ff → record merge_sha + cleanup.
   * Any conflict or re-validation failure parks the card in Review (phase conflicts/failed) WITHOUT
   * touching main. `humanApproved` is only an audit flag; the gate (auto_merge vs Approve) was decided
   * by the caller — by the time we're here a merge IS authorized.
   */
  private async doMerge(cardId: string, project: Project, _humanApproved: boolean): Promise<void> {
    // In-flight guard set SYNCHRONOUSLY (before queueing on the mutex) so a 10s safety tick can't
    // re-fire approve() for the same card while its merge is queued/running. Cleared in finally.
    if (this.merging.has(cardId)) return;
    this.merging.add(cardId);
    try {
      await this.withMergeLock(project.id, async () => {
        const card = kanbanRepo.getTask(cardId);
        if (!card) return;
        // Re-read after acquiring the lock: a prior holder (or the safety tick racing the approve route)
        // may already have merged/canceled this card. Only an InProgress (auto-merge gate) or a
        // Review (human-approved) card is still mergeable; Done/Canceled/Blocked → no-op.
        if (card.column !== 'InProgress' && card.column !== 'Review') return;
        const wtName = card.worktreeName ?? worktreeNameFor(card);
        const wtDir = worktreeDirFor(project.rootDir, wtName);
        const branch = branchNameFor(wtName);
        const base = project.defaultBranch;

        kanbanRepo.updateTask(cardId, { executionPhase: 'merging' });

        try {
          // 2. zero-side-effect conflict probe.
          const probe = await conflictProbe(project.rootDir, base, branch);
          if (!probe.clean) {
            kanbanRepo.updateTask(cardId, {
              column: 'Review',
              executionPhase: 'conflicts',
              lastError: `merge conflicts in: ${probe.conflicts.join(', ') || '(unknown files)'}`,
            });
            return;
          }

          // 4. integrate base INTO the branch (if main advanced) + re-validate the shipped tree.
          const integ = await integrateAndReport(wtDir, base);
          if (integ.conflict) {
            kanbanRepo.updateTask(cardId, {
              column: 'Review',
              executionPhase: 'conflicts',
              lastError: 'integration conflict merging the default branch into the task branch',
            });
            return;
          }
          // ensure the integration merge commit is recorded (no-op if integrate was a no-op).
          await ensureCommitted(wtDir);

          // re-validate the integrated tree (v2 #5: broker-vs-pure, same selector as validateAndGate).
          const vr = await validateCard(wtDir, project, card);
          if (!vr.ok) {
            // semantic breakage from integrating base → park in Review (do NOT merge a broken tree).
            kanbanRepo.updateTask(cardId, {
              column: 'Review',
              executionPhase: 'failed',
              validationOutput: vr.output,
              lastError: 'post-integration re-validation failed; not merging',
            });
            return;
          }

          // 5. SHIP. Branch on merge_mode (v2 #2). 'local' (default) → today's local merge --no-ff
          //    into main; 'pr' (requires push_enabled) → fetch+FF-sync the default branch, push the
          //    task branch, open a GitHub PR, and park in Review (a human merges on GitHub — locked
          //    decision §10.1; the portal NEVER calls prMerge). Everything above this point is shared.
          if (project.mergeMode === 'pr') {
            await this.doMergePr(cardId, project, card, wtName, branch, base);
            return;
          }

          // 5(local). final merge --no-ff into main (assert-clean + ORIG_HEAD rollback live in git.ts).
          const res = await mergeBranch(project.rootDir, branch);
          if (!res.ok) {
            kanbanRepo.updateTask(cardId, {
              column: 'Review',
              executionPhase: 'failed',
              lastError: `merge failed: ${res.error ?? 'unknown'}`,
            });
            return;
          }

          // 6. record + cleanup → Done.
          kanbanRepo.updateTask(cardId, {
            column: 'Done',
            executionPhase: 'idle',
            mergeSha: res.sha ?? null,
            lastError: null,
          });
          await cleanupWorktree(project.rootDir, wtName, branch);
        } catch (e: any) {
          // an "engine error" from git.ts (ambiguous probe / unexpected state): never merge; park.
          kanbanRepo.updateTask(cardId, {
            column: 'Review',
            executionPhase: 'failed',
            lastError: `merge pipeline error: ${e?.message ?? e}`,
          });
        }
      });
    } finally {
      this.merging.delete(cardId);
    }
  }

  /**
   * PR-mode SHIP step (v2 #2 keystone (b)), called from doMerge AFTER the shared conflict-probe +
   * integrate-base + re-validate steps, UNDER the per-project merge mutex (the caller already holds
   * it). Replaces the local `merge --no-ff`:
   *   1. fetchAndSyncDefault(root, remote, base) — FF-ONLY (§4 #2 keystone (d) / risk #3). On
   *      !ok OR diverged → park in Review and STOP; we NEVER force-update a diverged base.
   *   2. pushBranch(root, remote, branch) — park on failure (rejected push / auth error). Never force.
   *   3. prCreate(root, base, branch, title, body) — park on failure.
   *   4. success → record pr_url + pr_state='open' and park the card in REVIEW (NOT Done; the portal
   *      does NOT call prMerge — a human merges the PR on GitHub, locked decision §10.1). The persisted
   *      phase is 'idle' (NOT 'merging') so the safety tick's Review+merging re-drive never re-fires
   *      this push/PR flow; the pr_state badge carries the signal.
   *
   * Any gh/git stderr surfaced into lastError is already credential-scrubbed by gh.ts (ghErr →
   * scrubCredentials); we wrap with scrubCredentials again defensively (§3.5, idempotent).
   */
  private async doMergePr(
    cardId: string,
    project: Project,
    card: KanbanTask,
    _wtName: string,
    branch: string,
    base: string,
  ): Promise<void> {
    const root = project.rootDir;
    const remote = project.remoteName;

    // 1. fetch + FF-only sync the default branch (never force).
    const sync = await fetchAndSyncDefault(root, remote, base);
    if (!sync.ok || sync.diverged) {
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: 'conflicts',
        lastError: scrubCredentials(
          sync.diverged
            ? `default branch '${base}' has diverged from '${remote}/${base}'; refusing to force-update — resolve on the remote, then re-approve`
            : `failed to sync '${base}' from '${remote}': ${sync.error ?? 'unknown'}`,
        ),
      });
      return;
    }

    // 2. push the task branch (sets upstream so gh pr create resolves the head). Never force.
    const push = await pushBranch(root, remote, branch);
    if (!push.ok) {
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: 'failed',
        lastError: scrubCredentials(`push to '${remote}' failed: ${push.error ?? 'unknown'}`),
      });
      return;
    }

    // 3. open the PR (base = project.defaultBranch, head = the deterministic worktree-task-<id> branch).
    const title = card.title;
    const body = prBody(card);
    const pr = await prCreate(root, base, branch, title, body);
    if (!pr.ok) {
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: 'failed',
        lastError: scrubCredentials(`gh pr create failed: ${pr.error ?? 'unknown'}`),
      });
      return;
    }

    // 4. success → park in Review with the PR badge; a human merges on GitHub (NOT prMerge here).
    //    phase 'idle' (NOT 'merging') so the safety tick never re-drives the push/PR flow.
    kanbanRepo.updateTask(cardId, {
      column: 'Review',
      executionPhase: 'idle',
      prUrl: pr.url ?? null,
      prState: 'open',
      lastError: null,
    });
  }

  /**
   * Refresh a card's PR state from GitHub (v2 #2, wired by POST /api/tasks/:id/refresh-pr). Reads the
   * PR for the card's branch via `gh pr view` (no lock — read-only); updates pr_state/pr_url. If the
   * PR is MERGED, marks the card Done and tears down the worktree UNDER the per-project merge mutex
   * (the single main worktree must never be raced). `mergeSha` stays null in PR mode — the merge
   * happened on the remote, not locally. Never throws to its caller.
   */
  async refreshPr(taskId: string): Promise<void> {
    const card = kanbanRepo.getTask(taskId);
    if (!card) return;
    // Don't touch terminal cards or one with no branch to inspect.
    if (PM_DONE_COLUMNS.has(card.column)) return;
    const wtName = card.worktreeName;
    if (!wtName) return;
    const project = projectsRepo.getProject(card.projectId);
    if (!project) return;
    const branch = branchNameFor(wtName);

    const pv = await prView(project.rootDir, branch);
    if (!pv) return; // no PR for this branch (or gh/auth error) → leave the card as-is

    if (pv.state === 'merged') {
      await this.withMergeLock(project.id, async () => {
        const fresh = kanbanRepo.getTask(taskId);
        if (!fresh || PM_DONE_COLUMNS.has(fresh.column)) return; // already finalized
        kanbanRepo.updateTask(taskId, {
          column: 'Done',
          executionPhase: 'idle',
          prState: 'merged',
          prUrl: pv.url || fresh.prUrl,
          lastError: null,
        });
        // branch -d → -D fallback in cleanupWorktree handles the locally-unmerged branch (merged on
        // the remote, not locally). Best-effort + idempotent; never throws.
        await cleanupWorktree(project.rootDir, wtName, branch);
      });
      this.tickSoon(project.id);
      return;
    }

    // open / closed → just reflect the latest state + url.
    kanbanRepo.updateTask(taskId, { prState: pv.state, prUrl: pv.url || card.prUrl });
  }

  // ── REWORK (SPEC §5.6 + §10 guardrails) ─────────────────────────────────────────
  /**
   * Validation failed. Apply the no-progress guard, then either relaunch a fix run (under
   * max_attempts) or give up → Blocked. attempt_count increments per rework relaunch. The
   * no-progress guard: if the worktree's diff-vs-base hash equals the previously stored hash, the
   * last attempt produced an IDENTICAL tree → stop (avoids burning budget on a stuck agent).
   */
  private async rework(cardId: string, project: Project, validationOutput: string | null): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);

    // no-progress guard (SPEC §10): hash the current diff-vs-base; identical to the stored hash ⇒ stuck.
    const diffHash = await this.diffHash(wtDir, project.defaultBranch);
    if (diffHash && card.lastDiffHash && diffHash === card.lastDiffHash) {
      kanbanRepo.updateTask(cardId, {
        column: 'Blocked',
        executionPhase: 'failed',
        validationOutput,
        lastError: 'no-progress: the rework produced an identical diff twice',
      });
      return;
    }

    const nextAttempt = card.attemptCount + 1;
    if (nextAttempt >= card.maxAttempts) {
      // at/over the cap → give up, keep the worktree + last error for human inspection (SPEC §5.6).
      kanbanRepo.updateTask(cardId, {
        column: 'Blocked',
        executionPhase: 'failed',
        attemptCount: nextAttempt,
        validationOutput,
        lastDiffHash: diffHash ?? card.lastDiffHash,
        lastError: `validation failed after ${nextAttempt} attempt(s); giving up`,
      });
      return;
    }

    // record evidence + bump attempt + persist the diff hash, then relaunch a fix run.
    kanbanRepo.updateTask(cardId, {
      attemptCount: nextAttempt,
      validationOutput,
      lastDiffHash: diffHash ?? card.lastDiffHash,
      lastError: null,
    });
    const fresh = kanbanRepo.getTask(cardId);
    if (fresh) this.launchFix(fresh, project);
  }

  /** SHA-ish hash of the worktree branch's diff vs base (stable across identical trees). */
  private async diffHash(worktreeDir: string, baseBranch: string): Promise<string | null> {
    try {
      // `git diff <base>` inside the worktree → the cumulative change; hash it.
      const { stdout } = await execFileAsync('git', ['-C', worktreeDir, 'diff', baseBranch], {
        timeout: 20_000,
        maxBuffer: VALIDATION_MAX_BUFFER,
        encoding: 'utf8',
      });
      return hashString(stdout);
    } catch (e: any) {
      // a nonzero exit can still carry a diff on stdout (git diff exits 0 normally; tolerate either)
      const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
      return stdout ? hashString(stdout) : null;
    }
  }

  // ── CANCEL / DELETE (H2 ordering, SPEC §5.7) ─────────────────────────────────────
  /**
   * Cancel a card's execution. H2 ordering: mark the card terminal in the DB FIRST so the
   * synchronous onRunTerminal that registry.stop() fires re-reads a Canceled card and short-circuits
   * (handleRunTerminal → onCardRunDone returns on a Done/Canceled column). Then stop the run and
   * best-effort tear down the worktree. The main loop's kanban delete route should call this before
   * deleting the row.
   */
  cancel(cardId: string): void {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    const runId = card.runId;
    const project = projectsRepo.getProject(card.projectId);
    // 1. DB terminal FIRST (H2).
    kanbanRepo.updateTask(cardId, {
      column: 'Canceled',
      executionPhase: 'idle',
      lastError: 'canceled by user',
    });
    // 2. stop the run (fires onRunTerminal synchronously; the Canceled column makes it a no-op).
    if (runId) {
      try {
        registry.stop(runId);
      } catch {
        /* run already gone */
      }
    }
    // 3. best-effort worktree teardown (never throws).
    if (project && card.worktreeName) {
      void cleanupWorktree(project.rootDir, card.worktreeName, branchNameFor(card.worktreeName));
    }
    this.tickSoon(card.projectId);
  }

  // ── RECONCILE (SPEC §5.7 boot guardrail) ────────────────────────────────────────
  /**
   * On boot, no live run processes exist (registry's constructor killed orphan PIDs + reconciled
   * runs). Any card stuck in building/validating/merging whose run is dead/terminal is a zombie →
   * reset it. A card mid-merge whose run is gone is parked in Review (re-approve/inspect); a card mid
   * build/validate is sent back to Ready to be re-picked. Called once by the main loop on boot.
   */
  reconcile(): void {
    for (const project of projectsRepo.listProjects()) {
      for (const card of kanbanRepo.listTasks(project.id)) {
        if (card.column !== 'InProgress' && !(card.column === 'Review' && card.executionPhase === 'merging')) {
          continue;
        }
        const run = card.runId ? registry.getRun(card.runId) : null;
        const runDead = !run || run.status === 'completed' || run.status === 'failed' || run.status === 'killed';
        if (!runDead) continue; // a live run (shouldn't happen on boot) → leave it

        if (card.column === 'Review') {
          // mid-merge zombie → drop back to a plain Review for a human to re-approve.
          kanbanRepo.updateTask(card.id, {
            executionPhase: 'idle',
            lastError: 'reconciled on boot: merge interrupted; re-approve to retry',
          });
        } else {
          // mid build/validate → back to Ready so the PM re-picks it (keeps attempt history).
          kanbanRepo.updateTask(card.id, {
            column: 'Ready',
            executionPhase: 'idle',
            runId: null,
            lastError: 'reconciled on boot: build interrupted; re-queued',
          });
        }
      }
    }
    // re-evaluate every project after the reset.
    this.tickAll();
  }

  // ── internal ─────────────────────────────────────────────────────────────────
  /** Schedule a tick on the next macrotask so it runs OUTSIDE the current sync terminal handler. */
  private tickSoon(projectId: string): void {
    setTimeout(() => {
      this.tick(projectId).catch(() => {
        /* never throw out of a deferred tick */
      });
    }, 0).unref();
  }
}

// ── tiny non-crypto string hash (FNV-1a 32-bit) for the no-progress diff guard ──────
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // include length to further reduce collisions
  return `${(h >>> 0).toString(16)}-${s.length}`;
}

export const pm = new PmEngine();
