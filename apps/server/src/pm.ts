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
 * v2 #4 (campaign-per-card): a card with mode==='campaign' runs as a CAMPAIGN (orchestrator+worker
 * sub-DAG) instead of one build run. launchBuild branches on card.mode; the campaign is scoped to the
 * card's worktree and the card stores campaign_id (NOT run_id). A separate onCampaignTerminal handler
 * routes the card into the SAME validateAndGate sink when the WHOLE campaign completes. Partition holds:
 * campaign runs (campaignId!=null) are owned by campaigns.ts; PM single-mode owns campaignId==null+run_id.
 * No double-gate: a single-mode card gates on its run terminal; a campaign-mode card gates on the
 * campaign terminal; an individual worker run terminal never triggers the card gate.
 *
 * Still out-of-scope here: no conflict resolution beyond #9 (conflicts park in Review).
 * The PM never auto-generates the backlog — humans create cards.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Run, Project, KanbanTask, Campaign, ExecutionPhase, Loop, RiskLevel } from '@fleet/shared';
import { RISK_LABELS, ROUTING } from '@fleet/shared';
import { registry } from './registry.js';
import { projectsRepo, onProjectDeleted } from './projects.js';
import { kanbanRepo } from './kanban.js';
import { loopsRepo, compileContract } from './loops.js';
import { launchReview } from './review.js';
import {
  ensureCommitted,
  conflictProbe,
  integrateAndReport,
  mergeBranch,
  cleanupWorktree,
  ensureWorktreeIgnored,
  createWorktree,
  scrubCredentials,
  startResolveMerge,
  mergeAbort,
  isMergeInProgress,
  conflictedFiles,
  hasConflictMarkers,
  gitExec,
} from './git.js';
import { campaigns } from './campaigns.js';
import { tryAdmit } from './fleet.js';
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

/**
 * SPEC §10 — the deny-list for a worker BUILD / FIX launch. When an enabled kind='worker' Loop
 * governs the project, the loop's compiled contract deny-list (project baseline ∪ contract.forbidden;
 * compilation only ADDS denies) is used so the contract's `forbidden` is enforced on every run the
 * loop spawns. BACKWARD-COMPATIBLE: with NO worker Loop this is byte-for-byte `disallowedToolsForProject`,
 * preserving today's exact PM behavior for projects that don't use Loops. `compileContract` rides the
 * SAME static `./loops.js` import pm.ts already uses for `loopsRepo` (the pm.ts ↔ loops.ts edge already
 * exists and resolves via ESM live bindings at call time), so no microtask deferral is introduced —
 * the worker build/fix launch stays synchronous.
 */
function disallowedToolsForWorkerBuild(project: Project): string[] {
  const workerLoop = loopsRepo.enabledByKind(project.id, 'worker')[0];
  if (!workerLoop) return disallowedToolsForProject(project);
  return compileContract(workerLoop, project).disallowedTools;
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

/** Risk ordering for the `routableCeiling` comparison (low < medium < high). */
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** The card's inferred risk from its `risk:*` label (default 'low' when unlabeled). */
function cardRisk(card: KanbanTask): RiskLevel {
  if (card.labels.includes(RISK_LABELS.high)) return 'high';
  if (card.labels.includes(RISK_LABELS.medium)) return 'medium';
  return 'low';
}

/**
 * SPEC §9 worker-loop selection filter (BACKWARD COMPATIBLE). When an enabled kind='worker' Loop owns
 * the project, only `agent:ready` cards within the loop's `routableCeiling` are routable — a human-
 * dragged-but-untriaged card is left alone for the Manager to triage. With NO worker Loop the filter
 * is OFF and every Ready card is routable, preserving today's bare `column='Ready'` behavior exactly.
 */
function routableReadyCards(projectId: string): KanbanTask[] {
  const ready = kanbanRepo.readyTasks(projectId); // priority DESC, rank ASC
  const workerLoops = loopsRepo.enabledByKind(projectId, 'worker');
  if (workerLoops.length === 0) return ready; // no worker Loop → unchanged
  const ceiling = workerLoops[0].routableCeiling;
  return ready.filter(
    (c) => c.labels.includes(ROUTING.ready) && RISK_RANK[cardRisk(c)] <= RISK_RANK[ceiling],
  );
}

/** Parse a Loop.reviewPolicy ('always' | 'off' | 'threshold:<N>') into a decision. For 'threshold:N'
 *  the review fires only when the diff changed MORE than N files; a malformed value → treat as 'always'. */
function reviewDecision(policy: string): { review: boolean; thresholdFiles: number | null } {
  if (policy === 'off') return { review: false, thresholdFiles: null };
  const m = /^threshold:(\d+)$/.exec(policy);
  if (m) return { review: true, thresholdFiles: Number(m[1]) };
  return { review: true, thresholdFiles: null }; // 'always' (or unknown) → always review
}

/** Count files changed in the worktree branch's diff vs base (for the threshold:N review gate). */
async function changedFilesVsBase(worktreeDir: string, baseBranch: string): Promise<number> {
  const r = await gitExec(worktreeDir, ['diff', '--name-only', '-z', baseBranch]);
  if (!r.ok) return 0;
  return r.stdout.split('\0').filter((p) => p !== '').length;
}

/**
 * SPEC §11 — is a card eligible for auto-low-risk merge? ALL must hold: the loop opted into
 * 'auto-low-risk', a maker/checker review ACTUALLY ran and passed on this attempt (reviewWasRun),
 * the project is in LOCAL merge mode (the PR path NEVER auto-merges), the card is labeled risk:low,
 * and the GLOBAL loopAutoMergeCeiling permits risk:low (null = off → never).
 *
 * `reviewWasRun` closes the threshold-skip hole: under reviewPolicy='threshold:N' a sub-threshold
 * diff SKIPS the reviewing phase (no maker/checker runs), yet the card is otherwise low-risk — without
 * this conjunct it would auto-merge UNREVIEWED. We require the review to have actually executed and
 * passed (not merely "not been rejected"), so an unreviewed card always parks for a human.
 */
function autoLowRiskEligible(
  card: KanbanTask,
  project: Project,
  loop: Loop,
  ceiling: RiskLevel | null,
  reviewWasRun: boolean,
): boolean {
  if (loop.mergePosture !== 'auto-low-risk') return false;
  // SPEC §11 (Fix 2): "maker/checker passed" is a hard conjunct. When reviewPolicy is 'off' the
  // reviewing phase is SKIPPED entirely, so no review ever ran — there is no maker/checker to pass.
  // Never auto-merge without a review, defensively (the create/edit gate also rejects this combo).
  if (loop.reviewPolicy === 'off') return false;
  // SPEC §11 — the threshold-skip hole: a 'threshold:N' policy with a sub-threshold diff never launches
  // a Reviewer, so there is no maker/checker verdict to authorize an auto-merge. Require a review that
  // actually ran (and passed — we only reach the gate on pass/skip, never on reject) before auto-merging.
  if (!reviewWasRun) return false;
  if (project.mergeMode === 'pr') return false; // PR path never auto-merges
  if (cardRisk(card) !== 'low') return false;
  if (ceiling == null) return false; // global ceiling off
  return RISK_RANK[cardRisk(card)] <= RISK_RANK[ceiling];
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

/** Build a rework/fix prompt threading the failing validation output (SPEC §5.6). When a reviewer
 *  rejected the diff, `reviewFindings` carries the maker/checker verdict (SPEC §9) injected directly
 *  — it does NOT depend on lastError (rework clears that before relaunch). */
function fixPrompt(card: KanbanTask, reviewFindings?: string): string {
  const base = buildPrompt(card);
  // On the review-REJECT path the reviewer findings ARE the evidence. Validation PASSED on this
  // attempt (the reviewer rejected an otherwise-passing diff), so a stale prior validationOutput must
  // never be emitted — it would contradict the findings ("validation FAILED" vs a passing diff the
  // reviewer flagged). Prefer reviewFindings and suppress the validation-failure block on this path.
  const onReviewRejectPath = !!reviewFindings || !!card.lastError?.startsWith('[human request-changes]');
  const evidence = reviewFindings
    ? `\n\nA reviewer requested changes:\n${reviewFindings}`
    : card.lastError?.startsWith('[human request-changes]')
      ? `\n\nA reviewer requested changes:\n${card.lastError}`
      : '';
  const vout = onReviewRejectPath
    ? '\n\nAddress the reviewer feedback above; the previous diff passed validation but was rejected on review.'
    : card.validationOutput
      ? `\n\nThe previous attempt FAILED validation. Fix the issues so the validation command passes. ` +
        `Validation output (tail):\n${card.validationOutput}`
      : '\n\nThe previous attempt did not pass. Address the remaining issues.';
  return base + evidence + vout;
}

/**
 * v2 #9 — prompt for the conflict-resolution agent. The agent is dropped into a worktree with an
 * in-progress merge (conflict markers + MERGE_HEAD). It must resolve EVERY marker to satisfy the
 * acceptance criteria; it may edit files ONLY (the UNRELAXED deny-list blocks push/remote) and must
 * NOT run git itself (the engine commits / aborts on its terminal). The result must pass validation.
 */
function resolvePrompt(card: KanbanTask, project: Project, conflicts: string[]): string {
  const ac = card.acceptanceCriteria.trim()
    ? card.acceptanceCriteria.trim()
    : '(no explicit acceptance criteria — preserve the intent of BOTH sides of each conflict)';
  const vcmd = validationCommandFor(card, project);
  const files = conflicts.length ? `\n\nConflicted files:\n${conflicts.map((f) => `  - ${f}`).join('\n')}` : '';
  return [
    `You are in a git worktree with an IN-PROGRESS MERGE (the default branch was merged into this ` +
      `task branch and left conflict markers).`,
    `Resolve EVERY conflict marker (<<<<<<<, =======, >>>>>>>) in the working tree so the code ` +
      `satisfies the acceptance criteria below.`,
    `\nACCEPTANCE CRITERIA / DEFINITION OF DONE:\n${ac}` + files,
    `\nRules:\n- Edit files ONLY. Do NOT run git (no add/commit/merge/push) — the system commits the ` +
      `resolution for you.\n- Leave NO conflict markers behind.` +
      (vcmd ? `\n- The result must pass the validation command: ${vcmd}` : ''),
  ].join('\n');
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
    // v2 #4 — a campaign-mode card gates on WHOLE-campaign completion (not its workers' run
    // terminals, which carry campaignId!=null and are skipped by handleRunTerminal's partition guard).
    campaigns.onCampaignTerminal((c) => this.handleCampaignTerminal(c));
    // Deleting a project cascades its board: cancel (stops live run/campaign, tears down the
    // worktree) then drop the row — same H2 ordering the kanban DELETE route uses.
    onProjectDeleted((projectId) => {
      for (const card of kanbanRepo.listTasks(projectId)) {
        try {
          this.cancel(card.id);
        } catch {
          /* card cleanup is best-effort; still drop the row below */
        }
        kanbanRepo.deleteTask(card.id);
      }
    });
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

      // routableReadyCards() applies the worker-loop selection filter (agent:ready + risk<=ceiling)
      // ONLY when an enabled worker Loop owns the project; otherwise it returns kanbanRepo.readyTasks
      // unchanged (priority DESC, rank ASC) — today's exact bare column='Ready' behavior (SPEC §9).
      for (const card of routableReadyCards(projectId)) {
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

    // v2 #7 — fleet admission gate: when total demand exceeds the global pool, fair-share by project
    // priority. Denied → leave the card Ready ('capped', like a 429) and retry on the next tick. Covers
    // BOTH single and campaign launches (a campaign card consumes fleet capacity too).
    if (!tryAdmit(project.id)) return 'capped';

    // v2 #4 — a campaign-mode card delegates to a campaign sub-DAG instead of one build run.
    if (fresh.mode === 'campaign') return this.launchCampaignBuild(fresh, project);

    const wtName = worktreeNameFor(fresh);
    try {
      // Gitignore precheck (commit .gitignore as fleet-pm). MUST complete BEFORE registry.launch
      // spawns claude with --worktree: (a) so .claude/worktrees is ignored when the worktree is
      // created (else the main worktree goes dirty → mergeBranch refuses), and (b) sequentially so
      // the .gitignore commit doesn't race claude's `git worktree add` on the same index (index.lock).
      await ensureWorktreeIgnored(project.rootDir);
      // SPEC §10 — when a worker Loop governs this project, its compiled contract deny-list is enforced
      // on the build run; with no worker Loop this is byte-for-byte disallowedToolsForProject (compat).
      const disallowedTools = disallowedToolsForWorkerBuild(project);
      const run = await registry.launch({
        prompt: buildPrompt(fresh),
        cwd: project.rootDir,
        worktree: wtName,
        projectId: project.id,
        campaignId: null,
        model: fresh.model ?? PM_MODEL,
        effort: PM_EFFORT,
        permissionMode: PM_PERMISSION_MODE,
        disallowedTools,
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
      // §24 — the daily ceiling is transient like the concurrency cap: card stays Ready
      // and the PM retries once the cap clears (Blocked would need a human forever).
      if (e?.statusCode === 429 || e?.code === 'daily-cap') return 'capped';
      // any other launch failure (bad cwd, etc.) → park the card as failed so it isn't retried forever
      kanbanRepo.updateTask(fresh.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `launch failed: ${e?.message ?? e}`,
      });
      return 'skip';
    }
  }

  /**
   * v2 #4 — launch a CAMPAIGN scoped to a campaign-mode card (in place of one build run). Creates +
   * starts a campaign whose objective is built from the card, whose cwd is the card's OWN isolated
   * worktree (same worktreeNameFor / branchNameFor as a single build, so validateAndGate + the merge
   * pipeline find it unchanged), and persists `kanban_tasks.campaign_id` (NOT run_id) on the card.
   * Returns the same 'ok' | 'capped' | 'skip' contract as launchBuild.
   *
   * Deny-list: the campaign's workers/orchestrator/synthesizer carry the UNRELAXED deny-list
   * (`disallowedToolsForProject` with pushEnabled forced false — workers never push; the engine-side
   * merge pushes as fleet-pm) and a non-interactive permission mode (else interactive:false workers
   * stall awaiting a prompt). Both ride the campaigns.disallowed_tools / permission_mode columns.
   */
  private async launchCampaignBuild(fresh: KanbanTask, project: Project): Promise<'ok' | 'capped' | 'skip'> {
    const wtName = worktreeNameFor(fresh);
    const branch = branchNameFor(wtName);
    try {
      // Same gitignore precheck as a single build (must precede the worktree create so the main
      // worktree stays clean and mergeBranch doesn't later refuse on a dirty tree).
      await ensureWorktreeIgnored(project.rootDir);
      // The campaign engine spawns its runs via `cwd` (NOT `claude --worktree`), so the PM must create
      // the worktree itself and point the campaign at it.
      const wt = await createWorktree(project.rootDir, wtName, branch);
      if (!wt.ok) {
        kanbanRepo.updateTask(fresh.id, {
          column: 'Blocked',
          executionPhase: 'failed',
          lastError: `campaign worktree create failed: ${wt.error ?? 'unknown'}`,
        });
        return 'skip';
      }

      // campaigns.create persists the campaign row BEFORE launching the orchestrator, so a 429 from
      // the concurrency cap there would strand a dead 'planning' row on every capped retry — pre-check
      // the cap and stay 'capped' (card left Ready; the tick retries). Synchronous from here through
      // the orchestrator launch, so the slot can't be claimed in between.
      if (registry.spend().activeRuns >= registry.getConfig().maxConcurrentRuns) return 'capped';

      // UNRELAXED deny-list (§3.4): campaign workers NEVER push — force pushEnabled false regardless of
      // the project's single-mode relaxation. permissionMode: the same unattended bypass the PM build
      // uses (isolated worktree + push denied → safe), so interactive:false workers don't stall.
      const campaign = await campaigns.create({
        objective: buildPrompt(fresh),
        cwd: wt.dir,
        budgetPerWorkerUsd: fresh.budgetUsd,
        projectId: project.id,
        // Honor the card's per-card model override (engine-tagged ids delegate to that engine),
        // matching the single/fix/resolve launches; omit → campaigns.create falls back to the
        // orchestrator template's model. (CreateCampaignRequest.model is string|undefined.)
        model: fresh.model ?? undefined,
        disallowedTools: disallowedToolsForProject({ ...project, pushEnabled: false }),
        permissionMode: PM_PERMISSION_MODE,
      });

      kanbanRepo.updateTask(fresh.id, {
        column: 'InProgress',
        executionPhase: 'building',
        campaignId: campaign.id, // NOT run_id — a campaign-mode card links by campaign_id (§3.7)
        runId: null,
        worktreeName: wtName,
        lastError: null,
      });
      return 'ok';
    } catch (e: any) {
      // concurrency cap or §24 daily ceiling — both transient, card stays Ready
      if (e?.statusCode === 429 || e?.code === 'daily-cap') return 'capped';
      kanbanRepo.updateTask(fresh.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `campaign launch failed: ${e?.message ?? e}`,
      });
      return 'skip';
    }
  }

  /**
   * v2 #4 — react to a WHOLE campaign reaching terminal (completed/failed/killed). Look up the card
   * that owns the campaign (by campaign_id) and route it into the SHARED validateAndGate (§3.3) so the
   * card's validate→gate→merge fires on CAMPAIGN completion. The partition keeps this from double-gating:
   *   - a #3 planning run / standalone campaign has no owning card → getTaskByCampaignId returns null.
   *   - an individual worker run terminal carries campaignId!=null → handleRunTerminal skips it; only
   *     this whole-campaign signal reaches here.
   * Failed/killed campaigns don't merge — they go through validateAndGate exactly like a single build
   * whose work didn't satisfy the acceptance criteria (validation is the incompleteness catch); a card
   * with no commits / failing validation reworks or parks, never silently merging an incomplete tree.
   */
  private handleCampaignTerminal(c: Campaign): void {
    if (!c.projectId) return; // standalone campaign (not a campaign-per-card) → not ours
    const card = kanbanRepo.getTaskByCampaignId(c.id);
    if (!card) return; // no card owns this campaign
    // H2 ordering: if a human/cancel already moved the card terminal, do nothing.
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return;
    const project = projectsRepo.getProject(card.projectId);
    if (!project) return;

    // A KILLED campaign (user stop via DELETE /api/campaigns/:id, or pm.cancel below) is not a build
    // to gate — mirror onCardRunDone's killed branch: leave a terminal card alone, mark a still-running
    // one Blocked. Completed/failed both route into validateAndGate (single-mode parity: a failed/empty
    // campaign with no validation command parks in Review exactly like a failed single run does).
    if (c.status === 'killed') {
      if (card.column === 'InProgress') {
        kanbanRepo.updateTask(card.id, {
          column: 'Blocked',
          executionPhase: 'failed',
          lastError: 'campaign stopped',
        });
      }
      this.tickSoon(card.projectId);
      return;
    }

    void this.onCardCampaignDone(card.id, project).catch((e) => {
      kanbanRepo.updateTask(card.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `pm campaign terminal error: ${e?.message ?? e}`,
      });
    });
  }

  /**
   * v2 #4 — the campaign-terminal counterpart of onCardRunDone: ensure-committed the campaign's
   * worktree (the engine-side fleet-pm commit, so the diff/probe/merge see real commits), then route
   * into the SHARED validateAndGate. Mirrors onCardRunDone's structure minus the run-status branches
   * (a campaign has no single run.status / killReason).
   */
  private async onCardCampaignDone(cardId: string, project: Project): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);

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

    await this.validateAndGate(cardId, project);
    this.tickSoon(card.projectId);
  }

  /** Relaunch a fix run for a card already in InProgress, threading validation output (SPEC §5.6)
   *  and, when a reviewer rejected the diff (SPEC §9), the reviewer findings. */
  private launchFix(card: KanbanTask, project: Project, reviewFindings?: string): boolean | Promise<boolean> {
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const onRun = (run: Run): boolean => {
      kanbanRepo.updateTask(card.id, {
        column: 'InProgress',
        executionPhase: 'building',
        runId: run.id,
        worktreeName: wtName,
      });
      return true;
    };
    const onError = (e: any): boolean => {
      if (e?.statusCode === 429 || e?.code === 'daily-cap') {
        // capped (concurrency or §24 daily ceiling): the safety tick never retries an
        // InProgress card (and the old run's terminal won't re-fire), so return the card
        // to Ready — the tick re-picks Ready cards. Fix context survives in lastError.
        kanbanRepo.updateTask(card.id, { column: 'Ready', executionPhase: 'idle' });
        return false;
      }
      kanbanRepo.updateTask(card.id, {
        column: 'Blocked',
        executionPhase: 'failed',
        lastError: `fix launch failed: ${e?.message ?? e}`,
      });
      return false;
    };
    try {
      // SPEC §10 — when a worker Loop governs this project, enforce its compiled contract deny-list on
      // the fix/rework run too; with no worker Loop this is byte-for-byte disallowedToolsForProject.
      const disallowedTools = disallowedToolsForWorkerBuild(project);
      const run = registry.launch({
        prompt: fixPrompt(card, reviewFindings),
        cwd: project.rootDir,
        worktree: wtName,
        projectId: project.id,
        campaignId: null,
        model: card.model ?? PM_MODEL,
        effort: PM_EFFORT,
        permissionMode: PM_PERMISSION_MODE,
        disallowedTools,
        budgetUsd: card.budgetUsd,
        interactive: false,
      });
      return run instanceof Promise ? run.then(onRun).catch(onError) : onRun(run);
    } catch (e: any) {
      return onError(e);
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

    // v2 #9 — a resolve run links by the SAME run_id but the card sits in phase 'resolving'; route it
    // to the resolve terminal (commit → re-validate → merge/abort) instead of the build pipeline.
    if (card.executionPhase === 'resolving') {
      void this.onResolveRunDone(card.id, run).catch((e) => {
        kanbanRepo.updateTask(card.id, {
          column: 'Review',
          executionPhase: 'failed',
          lastError: `pm resolve terminal error: ${e?.message ?? e}`,
        });
      });
      return;
    }

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
      // SPEC §9 maker/checker: a separate Reviewer judges the worker's diff before the gate. Engages
      // ONLY for a project that has an enabled worker Loop with reviewPolicy != 'off' (and, for
      // 'threshold:N', only when the diff changed MORE than N files). reject → rework with the findings
      // threaded as the fix prompt; pass → gate. No worker Loop → straight to the gate (v1 behavior).
      const workerLoops = loopsRepo.enabledByKind(project.id, 'worker');
      const loop = workerLoops[0];
      // reviewWasRun: true ONLY when a Reviewer actually executed AND passed on this attempt. A
      // skipped review (policy 'off', no worker loop, or a sub-threshold 'threshold:N' diff) leaves
      // it false so gate()→autoLowRiskEligible refuses to auto-merge an UNREVIEWED card (SPEC §11).
      let reviewWasRun = false;
      if (loop) {
        const dec = reviewDecision(loop.reviewPolicy);
        let doReview = dec.review;
        if (doReview && dec.thresholdFiles !== null) {
          doReview = (await changedFilesVsBase(wtDir, project.defaultBranch)) > dec.thresholdFiles;
        }
        if (doReview) {
          if (await this.reviewGate(cardId, project)) return; // rejected → reworked, do not gate
          reviewWasRun = true; // reviewGate returned false → the Reviewer ran and PASSED
        }
      }
      await this.gate(cardId, project, reviewWasRun);
    } else {
      await this.rework(cardId, project, validationOutput);
    }
  }

  /**
   * SPEC §9 maker/checker step: mark the card 'reviewing', compute its diff vs base, launch a separate
   * Reviewer (review.ts) on it, then route the verdict. Returns true when the review REJECTED and the
   * card was reworked (so the caller must NOT proceed to the gate); false when the review PASSED (the
   * caller proceeds to the gate). On a rejected verdict, the reviewer findings are threaded through
   * `rework`'s new `reviewFindings` parameter (→ launchFix → fixPrompt) so they reach the fix prompt
   * WITHOUT relying on `lastError` — which `rework` clears to null before re-reading the card. Reworks
   * under the existing attempt_count cap + last_diff_hash no-progress guard.
   */
  private async reviewGate(cardId: string, project: Project): Promise<boolean> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return false;
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return false;
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);

    kanbanRepo.updateTask(cardId, { executionPhase: 'reviewing' });
    const diff = await this.diffText(wtDir, project.defaultBranch);
    const verdict = await launchReview(card, project, diff);

    if (verdict.pass) return false; // proceed to gate

    // REJECT → rework with the findings as the fix prompt. Re-read after the (long) review await.
    const fresh = kanbanRepo.getTask(cardId);
    if (!fresh) return true;
    if (PM_DONE_COLUMNS.has(fresh.column) || fresh.column === 'Backlog' || fresh.column === 'Ready') return true;
    // Thread the findings EXPLICITLY (not via lastError — rework clears that before re-reading the card)
    // through the SAME no-progress + attempt_count machinery the validation-fail path uses. fixPrompt
    // injects them into the fix prompt under its '[human request-changes]' branch. Pass null for the
    // validationOutput: validation just PASSED on this attempt (we're here only because the reviewer
    // rejected), so a stale prior validationOutput must not leak into the fix prompt.
    await this.rework(cardId, project, null, verdict.findings);
    return true;
  }

  /** The raw diff text of the worktree branch vs base (threaded into the Reviewer prompt). */
  private async diffText(worktreeDir: string, baseBranch: string): Promise<string> {
    const r = await gitExec(worktreeDir, ['diff', baseBranch], { maxBuffer: VALIDATION_MAX_BUFFER });
    return r.ok ? r.stdout : '';
  }

  // ── GATE (SPEC §5.5 / §6) ──────────────────────────────────────────────────────
  /** Validation passed: human-approve (default) parks in Review; auto_merge proceeds to merge.
   *  `reviewWasRun` (from validateAndGate) is true only when a maker/checker review actually ran and
   *  passed — required for auto-low-risk auto-merge so an unreviewed (e.g. sub-threshold) card parks. */
  private async gate(cardId: string, project: Project, reviewWasRun = false): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    // Re-check after the (long) validate await: a human/cancel may have moved the card terminal
    // or re-queued it meanwhile (H2 ordering) — do not resurrect it.
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return;

    // SPEC §11 — a worker Loop's mergePosture can authorize a bounded auto-merge even when the
    // project's own autoMerge flag is off: 'auto-low-risk' merges only for LOCAL mode + risk:low +
    // (review already passed) + the global loopAutoMergeCeiling permitting risk:low. 'human-gate'
    // (default) preserves today's behavior exactly. The PR path never auto-merges (guarded in the
    // eligibility helper). When neither path authorizes a merge, park in Review for a human.
    const loop = loopsRepo.enabledByKind(project.id, 'worker')[0];
    const ceiling = registry.getConfig().loopAutoMergeCeiling;
    const postureAuto = !!loop && autoLowRiskEligible(card, project, loop, ceiling, reviewWasRun);

    if (!project.autoMerge && !postureAuto) {
      // STOP for a human Approve — park in Review (phase idle so the badge isn't "merging" yet).
      kanbanRepo.updateTask(cardId, { column: 'Review', executionPhase: 'idle', lastError: null });
      return;
    }
    // auto_merge OR posture-authorized auto-low-risk: probe + merge under the per-project mutex
    // (re-validate happens inside doMerge).
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
    // A live resolve agent owns this card's worktree (MERGE_HEAD is set) — driving a merge
    // now would clobber the 'resolving' partition marker and could ship conflict markers.
    // ('merging' is NOT blocked here: the safety tick deliberately re-drives Review+merging
    // after a restart, and the in-flight set dedupes live merges.)
    if (card.executionPhase === 'resolving') return;
    // A PR is LIVE for this card (v2 #2 PR mode parks Review+idle with prState set). Re-approving
    // would re-run push + `gh pr create`, which fails because the PR exists. Ignore — use refresh-pr
    // to advance the card to Done when the PR merges on GitHub. A CLOSED (rejected) PR stays
    // approvable: doMergePr pushes and opens a fresh PR. prState is null in local mode (unaffected).
    // Reset any 'merging' phase a caller already wrote, else the badge (and the tick's Review+merging
    // sweep) sticks until the PR merges remotely.
    if (card.prState === 'open' || card.prState === 'merged') {
      if (card.executionPhase === 'merging') kanbanRepo.updateTask(taskId, { executionPhase: 'idle' });
      return;
    }
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
    void this.launchFix(card, project);
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
            // v2 #9 — RESOLVE if enabled + under the cap, else park in Review exactly as v1.
            await this.resolveOrParkConflict(cardId, project, card, wtDir, base, probe.conflicts, {
              phase: 'conflicts',
              lastError: `merge conflicts in: ${probe.conflicts.join(', ') || '(unknown files)'}`,
            });
            return;
          }

          // 4. integrate base INTO the branch (if main advanced) + re-validate the shipped tree.
          const integ = await integrateAndReport(wtDir, base);
          if (integ.conflict) {
            // v2 #9 — the integrate-base merge conflicted; RESOLVE if enabled + under the cap, else
            // park exactly as v1. integrateAndReport already aborted the merge, so the worktree is
            // clean; the resolve path re-starts the merge itself (startResolveMerge) to leave markers.
            await this.resolveOrParkConflict(cardId, project, card, wtDir, base, [], {
              phase: 'conflicts',
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
          const res = await mergeBranch(project.rootDir, branch, base);
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

  // ── RESOLVE (v2 #9 — conflict-resolution agent) ─────────────────────────────────
  /**
   * v2 #9 — a conflict was detected in doMerge (probe-unclean OR integrate-base conflict). If the
   * project has resolveConflicts ON and the card is UNDER its resolve cap, launch a conflict-
   * resolution agent into the half-merged worktree (phase 'resolving'); otherwise park in Review
   * EXACTLY as v1 (the `park` message/phase the caller would have used). Runs UNDER the merge mutex
   * (the caller holds it) but only does worktree-local + synchronous-launch work — it returns
   * immediately, RELEASING the mutex so the long-running resolve agent never blocks other merges.
   * The resolve run terminal (onResolveRunDone) re-acquires the mutex to finish the merge.
   */
  private async resolveOrParkConflict(
    cardId: string,
    project: Project,
    card: KanbanTask,
    wtDir: string,
    base: string,
    conflicts: string[],
    park: { phase: ExecutionPhase; lastError: string },
  ): Promise<void> {
    const canResolve = project.resolveConflicts && card.resolveAttemptCount < card.maxResolveAttempts;
    if (!canResolve) {
      // resolveConflicts OFF (or absent) OR at/over the cap → park in Review EXACTLY as v1.
      kanbanRepo.updateTask(cardId, { column: 'Review', executionPhase: park.phase, lastError: park.lastError });
      return;
    }

    // START the integration merge leaving conflict markers + MERGE_HEAD for the agent to edit.
    let resolveMerge;
    try {
      resolveMerge = await startResolveMerge(wtDir, base);
    } catch (e: any) {
      // could not even start the merge → clean up + park (do NOT leave a half-merged tree).
      await mergeAbort(wtDir);
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: park.phase,
        lastError: `${park.lastError} (resolve setup failed: ${e?.message ?? e})`,
      });
      return;
    }

    // Rare: the merge applied cleanly (no markers) — the probe was stale / the integrate path's
    // earlier abort means base wasn't yet merged. The tree is now integrated + committed; re-validate
    // and ship directly (counts as no resolve attempt — no agent was needed).
    if (!resolveMerge.conflict) {
      await ensureCommitted(wtDir);
      const vr = await validateCard(wtDir, project, card);
      if (!vr.ok) {
        kanbanRepo.updateTask(cardId, {
          column: 'Review',
          executionPhase: 'failed',
          validationOutput: vr.output,
          lastError: 'post-integration re-validation failed; not merging',
        });
        return;
      }
      await this.shipMerge(cardId, project, card);
      return;
    }

    // count the attempt + mark resolving, THEN launch the resolve agent into the half-merged worktree.
    const markerFiles = resolveMerge.conflicts.length ? resolveMerge.conflicts : conflicts;
    kanbanRepo.updateTask(cardId, {
      executionPhase: 'resolving',
      resolveAttemptCount: card.resolveAttemptCount + 1,
      lastError: markerFiles.length ? `resolving conflicts in: ${markerFiles.join(', ')}` : 'resolving conflicts',
    });

    const fresh = kanbanRepo.getTask(cardId);
    if (!fresh) {
      await mergeAbort(wtDir); // card vanished mid-flight → don't leave a half-merged tree
      return;
    }
    const launched = await this.launchResolve(fresh, project, markerFiles);
    if (!launched) {
      // launch failed (429 / error) → abort the merge (no half-merged tree) and park in Review for a
      // human; the attempt is counted (consumed) so retries stay bounded.
      await mergeAbort(wtDir);
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: park.phase,
        lastError: `${park.lastError} (resolve agent launch failed)`,
      });
    }
  }

  /**
   * v2 #9 — launch the conflict-resolution agent into the card's (half-merged) worktree. Mirrors
   * launchFix/launchBuild, but carries the UNRELAXED deny-list (§3.4): the resolve agent edits files
   * only and must NEVER push — the engine performs the merge/push as fleet-pm. Links the run to the
   * card (run_id) so its terminal routes back here. Returns true on success.
   */
  private async launchResolve(card: KanbanTask, project: Project, conflicts: string[]): Promise<boolean> {
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    try {
      const run = await registry.launch({
        prompt: resolvePrompt(card, project, conflicts),
        cwd: project.rootDir,
        worktree: wtName,
        projectId: project.id,
        campaignId: null,
        model: card.model ?? PM_MODEL,
        effort: PM_EFFORT,
        permissionMode: PM_PERMISSION_MODE,
        // UNRELAXED (§3.4): the resolve agent edits files only; its push is an engine-side step, so it
        // must NEVER inherit the relaxed (push-enabled) deny-list — force pushEnabled false.
        disallowedTools: disallowedToolsForProject({ ...project, pushEnabled: false }),
        budgetUsd: card.budgetUsd,
        interactive: false,
      });
      kanbanRepo.updateTask(card.id, { runId: run.id, worktreeName: wtName });
      return true;
    } catch {
      // 429 or any launch error → caller aborts the merge + parks (attempt already counted).
      return false;
    }
  }

  /**
   * v2 #9 — the resolve agent reached terminal. ALWAYS re-validate (commit the worktree first so the
   * resolution is real), under guards:
   *   - the worktree must have NO conflict markers left (MERGE_HEAD must be gone OR no unmerged files)
   *     AND the run must not have been killed/failed AND re-validation must pass → SHIP under the mutex.
   *   - otherwise → `git merge --abort` (clean the half-merged tree — never leave one) + park in
   *     Review (phase conflicts/failed) with the conflicting file list in lastError.
   * The attempt was already counted in resolveOrParkConflict; at/over the cap a future conflict won't
   * re-resolve (the cap check in resolveOrParkConflict parks instead).
   */
  private async onResolveRunDone(cardId: string, run: Run): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return;
    const project = projectsRepo.getProject(card.projectId);
    if (!project) return;
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);
    const base = project.defaultBranch;

    const fail = async (msg: string, phase: ExecutionPhase = 'conflicts') => {
      const remaining = await conflictedFiles(wtDir);
      await mergeAbort(wtDir); // NEVER leave a half-merged tree
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: phase,
        lastError: remaining.length ? `${msg}; unresolved: ${remaining.join(', ')}` : msg,
      });
      this.tickSoon(card.projectId);
    };

    // a killed resolve run (user stop / budget) → abort the merge + park.
    if (run.status === 'killed') {
      await fail(run.killReason === 'budget' ? 'resolve run auto-killed: per-run budget reached' : 'resolve run stopped');
      return;
    }

    // Leftover conflict markers in the WORKING TREE? → resolution incomplete → abort + park. Uses
    // `git diff --check` (working-tree markers) — authoritative even though the agent never `git add`ed
    // (the index stays "unmerged" until the engine stages on commit, so the index probe would lie).
    if (await hasConflictMarkers(wtDir)) {
      await fail('conflict resolution incomplete (markers remain)');
      return;
    }

    // commit the resolution (`git add -A` stages the agent's edits → completes the in-progress merge
    // as fleet-pm), then re-validate. ensureCommitted is a no-op only if the tree is already clean.
    try {
      await ensureCommitted(wtDir);
    } catch (e: any) {
      await fail(`resolve commit failed: ${e?.message ?? e}`, 'failed');
      return;
    }
    // Belt-and-braces: MERGE_HEAD still set after commit means the merge never completed → incomplete.
    if (await isMergeInProgress(wtDir)) {
      await fail('conflict resolution did not complete the merge');
      return;
    }

    const vr = await validateCard(wtDir, project, card);
    if (!vr.ok) {
      // re-validation failed after resolution → abort any residual merge + park (do NOT merge a
      // broken tree). The merge is already committed at this point, so merge --abort is a no-op; the
      // parked card keeps the worktree for human inspection.
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: 'failed',
        validationOutput: vr.output,
        lastError: 'post-resolution re-validation failed; not merging',
      });
      this.tickSoon(card.projectId);
      return;
    }

    // GREEN (pre-lock fast-check passed) → finish the merge under the per-project mutex. CRITICAL: the
    // resolve agent ran with the lock RELEASED (it can take minutes), so `main` may have ADVANCED since
    // startResolveMerge integrated the base. Re-integrate the CURRENT base and RE-VALIDATE inside the
    // lock before shipping — exactly doMerge's inside-lock invariant — so the SHIPPED tree is always the
    // VALIDATED tree and a concurrent merge can never sneak an unchecked change into the resolved card.
    await this.withMergeLock(project.id, async () => {
      const f = kanbanRepo.getTask(cardId);
      if (!f) return;
      if (f.column !== 'InProgress' && f.column !== 'Review') return; // canceled/merged meanwhile
      kanbanRepo.updateTask(cardId, { executionPhase: 'merging' });

      // re-integrate the base as it is NOW (no-op if unchanged; brings any new commits otherwise).
      const integ = await integrateAndReport(wtDir, base);
      if (integ.conflict) {
        kanbanRepo.updateTask(cardId, {
          column: 'Review',
          executionPhase: 'conflicts',
          lastError: 'base advanced during resolution and re-integration conflicts; resolve again or merge manually',
        });
        return;
      }
      await ensureCommitted(wtDir); // record the integration merge commit (no-op if integrate was a no-op)
      const vr2 = await validateCard(wtDir, project, f);
      if (!vr2.ok) {
        kanbanRepo.updateTask(cardId, {
          column: 'Review',
          executionPhase: 'failed',
          validationOutput: vr2.output,
          lastError: 'post-integration re-validation failed after resolution; not merging',
        });
        return;
      }
      await this.shipMerge(cardId, project, f);
    });
    this.tickSoon(card.projectId);
  }

  /**
   * v2 #9 — the final SHIP step shared by the normal doMerge tail and the resolve terminal: branch on
   * merge_mode (PR push or local merge --no-ff), record the result, and tear down the worktree on a
   * local merge. PRECONDITION: caller holds the merge mutex and the integrated tree has re-validated
   * green. Mirrors doMerge's step-5/6 exactly so resolved cards ship identically to clean ones.
   */
  private async shipMerge(cardId: string, project: Project, card: KanbanTask): Promise<void> {
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const branch = branchNameFor(wtName);
    const base = project.defaultBranch;

    if (project.mergeMode === 'pr') {
      await this.doMergePr(cardId, project, card, wtName, branch, base);
      return;
    }
    const res = await mergeBranch(project.rootDir, branch, base);
    if (!res.ok) {
      kanbanRepo.updateTask(cardId, {
        column: 'Review',
        executionPhase: 'failed',
        lastError: `merge failed: ${res.error ?? 'unknown'}`,
      });
      return;
    }
    kanbanRepo.updateTask(cardId, {
      column: 'Done',
      executionPhase: 'idle',
      mergeSha: res.sha ?? null,
      lastError: null,
    });
    await cleanupWorktree(project.rootDir, wtName, branch);
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

    const pvr = await prView(project.rootDir, branch);
    if (pvr.error) {
      // gh/auth/network failure ≠ "no PR" — surface it on the card so the user knows the
      // badge is stale instead of silently never updating (route is fire-and-forget).
      kanbanRepo.updateTask(taskId, { lastError: `refresh-pr failed: ${pvr.error}` });
      return;
    }
    const pv = pvr.pr;
    if (!pv) return; // genuinely no PR for this branch → leave the card as-is

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
  private async rework(cardId: string, project: Project, validationOutput: string | null, reviewFindings?: string): Promise<void> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return;
    // Re-check after the (long) validate await: a human/cancel may have moved the card terminal
    // or re-queued it meanwhile (H2 ordering) — never relaunch a run for it.
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return;
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
    if (fresh) await this.launchFix(fresh, project, reviewFindings);
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
    const campaignId = card.campaignId; // v2 #4 — a campaign-mode card delegates to a campaign
    const project = projectsRepo.getProject(card.projectId);
    // 1. DB terminal FIRST (H2). The Canceled column makes every downstream terminal a no-op:
    //    registry.stop()'s synchronous onRunTerminal AND campaigns.kill()'s onCampaignTerminal both
    //    re-read the card and short-circuit on the terminal column.
    kanbanRepo.updateTask(cardId, {
      column: 'Canceled',
      executionPhase: 'idle',
      lastError: 'canceled by user',
    });
    // 2. stop the campaign (campaign card) or the single build run (single card).
    if (campaignId) {
      // a campaign card carries campaign_id, not run_id; kill the whole campaign so its orchestrator
      // + in-flight workers stop spending (campaigns.kill is itself H2-ordered internally).
      try {
        campaigns.kill(campaignId);
      } catch {
        /* campaign already gone / terminal */
      }
    }
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
   * runs). Any card stuck in building/validating/merging/resolving whose run is dead/terminal is a
   * zombie → reset it. A card mid-merge whose run is gone is parked in Review (re-approve/inspect); a
   * card mid build/validate is sent back to Ready to be re-picked; a card mid-RESOLVE (v2 #9) left a
   * worktree with MERGE_HEAD set → `git merge --abort` it (never leave a half-merged tree) and park
   * it in Review/conflicts; a card mid-REVIEW (SPEC §9) had an in-flight Reviewer run whose process is
   * dead → re-drive it through validateAndGate (re-validate + re-review the intact worktree) rather
   * than leave it stuck in 'reviewing'. Called once by the main loop on boot. Async because the resolve
   * sweep must abort a real in-progress merge before the worktree is clean (callers may fire-and-forget).
   */
  async reconcile(): Promise<void> {
    const aborts: Promise<void>[] = [];
    for (const project of projectsRepo.listProjects()) {
      for (const card of kanbanRepo.listTasks(project.id)) {
        // v2 #9 — a mid-resolve zombie (phase 'resolving', in InProgress OR Review) needs its
        // half-merged worktree aborted regardless of run state (the resolve agent process is dead).
        if (card.executionPhase === 'resolving') {
          aborts.push(this.reconcileResolving(card, project));
          continue;
        }
        // SPEC §9 — a mid-review zombie (phase 'reviewing'): the Reviewer run is launched independently
        // of card.runId (review.ts), so the generic build/validate sweep below would wrongly treat it as
        // a build interruption (back to Ready, losing the validated worktree). The committed worktree is
        // intact, so re-drive it through validateAndGate, which re-validates and re-reviews from scratch.
        if (card.executionPhase === 'reviewing' && card.column === 'InProgress') {
          aborts.push(this.reconcileReviewing(card, project));
          continue;
        }
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
    // wait for the mid-resolve worktrees to be aborted (clean) before re-evaluating.
    await Promise.all(aborts);
    // re-evaluate every project after the reset.
    this.tickAll();
  }

  /**
   * v2 #9 — reconcile a single mid-resolve zombie: `git merge --abort` its worktree (so no half-
   * merged tree survives the crash) and park it in Review/conflicts for a human to inspect/re-approve.
   * Never throws (best-effort, like cleanupWorktree).
   */
  private async reconcileResolving(card: KanbanTask, project: Project): Promise<void> {
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);
    try {
      await mergeAbort(wtDir);
    } catch {
      /* best-effort: a missing worktree / no merge in progress is harmless */
    }
    kanbanRepo.updateTask(card.id, {
      column: 'Review',
      executionPhase: 'conflicts',
      lastError: 'reconciled on boot: conflict resolution interrupted; re-approve to retry',
    });
  }

  /**
   * SPEC §9 — reconcile a single mid-review zombie: its Reviewer run died with the process at boot,
   * but the worker's worktree is committed and intact. Re-drive it through validateAndGate (re-validate
   * + re-review from scratch), which routes it sanely (review pass → gate, reject → rework). On any
   * failure park it in Review for a human so it is never left stuck in 'reviewing'. Never throws.
   */
  private async reconcileReviewing(card: KanbanTask, project: Project): Promise<void> {
    try {
      await this.validateAndGate(card.id, project);
    } catch {
      // validateAndGate should not throw, but never leave a card wedged in 'reviewing' on boot.
      kanbanRepo.updateTask(card.id, {
        column: 'Review',
        executionPhase: 'idle',
        lastError: 'reconciled on boot: review interrupted; re-approve to retry',
      });
    }
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
