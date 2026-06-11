/**
 * @fleet/shared — the FROZEN contract shared by the control-plane (apps/server)
 * and the portal UI (apps/web). Mirrors PRD §9.1 (event normalization) and §9.3
 * (data model), corrected to the verified Claude Code 2.1.168 reality (see DC.md
 * F-1..F-7). The UI renders the tree from `parentNodeId` + `nodeType` WITHOUT ever
 * parsing raw CLI JSON.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums / unions
// ─────────────────────────────────────────────────────────────────────────────

/** A node in a run's subtree. (PRD §9.1) */
export type NodeType = 'root' | 'workflow' | 'subagent' | 'teammate';

/** Run lifecycle. (PRD §7.1) */
export type RunStatus =
  | 'starting'
  | 'running'
  | 'awaiting-input'
  | 'awaiting-permission'
  | 'orchestrating'
  | 'completed'
  | 'failed'
  | 'killed';

export type NodeStatus = 'running' | 'completed' | 'failed' | 'killed';

/** Real `--effort` values verified from `claude --help` (DC.md F-4). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Real `--permission-mode` values verified from `claude --help` (DC.md F-4). */
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

/** Normalized event types (PRD §9.1, extended with verified reality). */
export type NormalizedEventType =
  | 'init'
  | 'assistant_text'
  | 'assistant_partial'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'subagent_spawned'
  | 'subagent_done'
  | 'status'
  | 'rate_limit'
  | 'api_retry' // H22 — transient retry (overload/rate-limit) so a retrying run isn't "frozen"
  | 'agent_message' // H22 — agent→user message via --brief / SendUserMessage tool
  | 'result'
  | 'error'
  | 'exit';

// ─────────────────────────────────────────────────────────────────────────────
// Normalized event (PRD §9.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizedEvent {
  sessionId: string;
  runId: string;
  /** Node within the run. root === runId; a subagent node id === the spawning Agent/Task tool_use id. */
  nodeId: string;
  parentNodeId: string | null;
  nodeType: NodeType;
  seq: number;
  /** epoch ms, server-stamped on ingest. */
  ts: number;
  type: NormalizedEventType;
  payload: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Subtree topology (PRD §9.3 run_nodes)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunNode {
  id: string;
  runId: string;
  parentId: string | null;
  nodeType: NodeType;
  label: string;
  status: NodeStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
  /** depth from root (root = 0). */
  depth: number;
  /** assembled lazily by the tree builder for UI consumption. */
  children?: RunNode[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Run (PRD §9.3 runs + derived rollups)
// ─────────────────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  sessionId: string;
  task: string;
  cwd: string;
  model: string;
  fastMode: boolean;
  effort: EffortLevel;
  workflowsEnabled: boolean;
  ultracode: boolean;
  teamId: string | null;
  /** set when this run is a campaign orchestrator/worker/synthesizer (Orchestration Mode). */
  campaignId: string | null;
  /** set when this run belongs to a Project / Kanban card (agent-PM feature). */
  projectId: string | null;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  exitCode: number | null;
  /** why a run was killed — distinguishes a user stop from a budget auto-kill (H5). */
  killReason: 'user' | 'budget' | null;
  /** captured failure cause (child stderr / guardrail note) surfaced on failed/killed runs (H5). */
  error: string | null;
  budgetUsd: number | null;
  permissionMode: PermissionMode;
  allowedTools: string | null;
  skills: string[];
  subagentProfile: string | null;
  /** the final result text from the `result` event (prose). */
  resultText: string | null;
  /** structured output from `--json-schema` runs (object on result.structured_output, F-8). */
  structuredOutput: unknown | null;
  /** OS process group id of the spawned `claude` child — lets stop/reconcile work across server restarts. */
  pid: number | null;
  // ── derived rollups (PRD §7.1) ─────────────────────────────
  subagentCount: number;
  liveSubagents: number;
  maxDepth: number;
  lastActivity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch request (PRD §7.2)
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchRequest {
  prompt: string;
  cwd: string;
  model: string;
  fastMode?: boolean;
  effort: EffortLevel;
  /** UI hint; no CLI flag exists to hard-disable orchestration (DC.md F-6/D-007). */
  workflowsEnabled?: boolean;
  /** UI preset: xhigh effort + workflow-expected + stricter budget (DC.md D-007). */
  ultracode?: boolean;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  skills?: string[];
  subagentProfile?: string | null;
  budgetUsd?: number | null;
  /** Keep the process alive after the first turn for follow-up stdin input (DC.md D-014).
   *  Default false → one-shot run that completes cleanly. */
  interactive?: boolean;
  /** internal: appended system prompt (templates use this). */
  appendSystemPrompt?: string;
  /** internal: structured-output JSON Schema → `--json-schema` (orchestrator plan, D-019). */
  jsonSchema?: unknown;
  /** internal: campaign membership for orchestrator/worker/synthesizer runs. */
  campaignId?: string | null;
  /** internal: project / kanban-card membership (agent-PM feature). */
  projectId?: string | null;
  /** H10 — `-w/--worktree <name>`: run in an isolated git worktree (safe parallel writes). */
  worktree?: string;
  /** H10 — `--disallowedTools <tools...>`: a tool deny-list (e.g. "Bash(git push *)"). */
  disallowedTools?: string[];
  /** H10 — `--agents <json>`: define ephemeral subagents inline at launch. */
  agentsJson?: unknown;
  /** H22 — `--brief`: enable the agent→user SendUserMessage tool. */
  brief?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Control actions (PRD §7.6)
// ─────────────────────────────────────────────────────────────────────────────

export interface InputRequest {
  text: string;
}

export interface PermissionDecision {
  requestId: string;
  decision: 'approve' | 'deny';
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Teams (PRD §7.4, schema verified DC.md F-3)
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: string; // pending | in_progress | completed | ...
  blocks: string[];
  blockedBy: string[];
  owner?: string | null;
}

export interface TeamMessage {
  from?: string;
  to?: string;
  ts?: number;
  text: string;
  raw?: unknown;
}

export interface TeamView {
  id: string;
  name: string;
  taskDir: string;
  tasks: TeamTask[];
  messages: TeamMessage[];
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog (PRD §7.5, §9.4 /skills /subagents /models)
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  scope: 'user' | 'project' | 'plugin' | 'builtin';
  path: string;
  description?: string;
  /** 'skill' = SKILL.md folder (Skill-tool invocable); 'command' = commands/*.md slash-command
   *  (also usable as a launch prompt: `claude -p "/<name> …"`). Absent on older payloads. */
  kind?: 'skill' | 'command';
}

export interface SubagentInfo {
  name: string;
  scope: 'user' | 'project';
  path: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** USD per million tokens, standard tier. */
  inputPerM: number;
  outputPerM: number;
  /** USD per million tokens, fast-mode tier (Opus 4.8 only per PRD §6). */
  fastInputPerM?: number;
  fastOutputPerM?: number;
  contextWindow: number;
  maxOutput: number;
  fastModeCapable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config / guardrails (PRD §7.7, §9.3 config)
// ─────────────────────────────────────────────────────────────────────────────

export interface PortalConfig {
  maxConcurrentRuns: number;
  defaultBudgetUsd: number;
  ultracodeBudgetUsd: number;
  permissionDefault: PermissionMode;
  /** the ≤16 concurrent / 1000 total subagent ceilings are platform facts, surfaced read-only. */
  subagentConcurrentCeiling: number;
  subagentTotalCeiling: number;
}

export interface SpendSummary {
  todayUsd: number;
  activeRuns: number;
  totalRunsToday: number;
}

/** Fleet-level cross-project scheduler config (v2 #7). A single-row table backs it. */
export interface FleetConfig {
  /** Concurrency slots held back from the per-project PM run-count for campaigns/non-PM work. */
  reserveSlotsForNonPm: number;
  /** Daily fleet-wide spend ceiling in USD (null = no fleet ceiling). */
  fleetSpendCeilingUsd: number | null;
}

/** Per-project allocation row in the fleet status snapshot (v2 #7). */
export interface FleetProjectStatus {
  projectId: string;
  name: string;
  priority: number;
  paused: boolean;
  weight: number; // priority + 1 (0 when not demanding)
  liveRuns: number; // live PM runs
  readyCards: number;
  quota: number; // fair-share quota under the current pool (0 when not demanding)
  demanding: boolean;
  wipLimit: number; // the project's per-project WIP cap (pm.ts gate, surfaced read-only)
  inProgress: number; // cards currently in the InProgress column
  projectSpend: number; // cumulative USD across every run scoped to this project
}

/** Live fleet allocation snapshot (GET /api/fleet/status, v2 #7). */
export interface FleetStatus {
  config: FleetConfig;
  maxConcurrentRuns: number;
  pool: number; // slots available to PM runs (maxConcurrentRuns - reserveSlotsForNonPm, floored at 0)
  pmLiveTotal: number; // total live PM runs across the fleet
  spendTodayUsd: number;
  spendCeilingUsd: number | null;
  spendExceeded: boolean;
  /** Loud H9 signal: the PM pool is 0 WHILE ≥1 project demands it → every Ready card stalls. */
  deadlocked: boolean;
  projects: FleetProjectStatus[];
}

/** git/remote readiness for PR mode (GET /api/projects/:id/git/health, v2 #2). */
export interface GitHealth {
  remoteUrl: string | null; // credential-scrubbed
  remoteResolves: boolean;
  ghInstalled: boolean;
  ghAuthOk: boolean;
  pushEnabled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE stream envelope (PRD §9.4 /stream)
// ─────────────────────────────────────────────────────────────────────────────

export type StreamMessage =
  | { kind: 'hello'; run: Run; nodes: RunNode[]; events: NormalizedEvent[]; truncatedBefore?: number }
  | { kind: 'event'; event: NormalizedEvent }
  | { kind: 'node'; node: RunNode }
  | { kind: 'run'; run: Run };

/** Fleet-wide live channel envelope (dashboard auto-refresh, PRD §7.1). */
export type FleetMessage =
  | { kind: 'fleet-hello'; runs: Run[]; spend: SpendSummary }
  | { kind: 'run'; run: Run }
  | { kind: 'run-removed'; runId: string }
  | { kind: 'spend'; spend: SpendSummary };

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Mode — Agent Templates + Campaigns (post-PRD, DC.md D-018..D-020)
// ─────────────────────────────────────────────────────────────────────────────

/** A reusable agent profile instantiated for orchestrator / worker / synthesizer roles. */
export interface AgentTemplate {
  id: string;
  name: string;
  /** role hint: orchestrator | worker | reviewer | synthesizer | … */
  role: string;
  description: string;
  /** appended via --append-system-prompt to shape the agent. */
  systemPrompt: string;
  model: string;
  fastMode: boolean;
  effort: EffortLevel;
  allowedTools: string[];
  skills: string[];
  permissionMode: PermissionMode;
  budgetUsd: number | null;
  isBuiltin: boolean;
  createdAt: number;
}

export type CreateTemplateRequest = Omit<AgentTemplate, 'id' | 'isBuiltin' | 'createdAt'>;

export type CampaignStatus =
  | 'planning' // orchestrator is decomposing
  | 'spawning' // workers being scheduled
  | 'running' // workers in flight
  | 'synthesizing' // final synthesizer agent running
  | 'completed'
  | 'failed'
  | 'killed';

export type CampaignTaskStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'skipped';

/** One subtask the orchestrator produced; the portal spawns a worker run for it. */
export interface CampaignTask {
  id: string;
  campaignId: string;
  seq: number;
  title: string;
  prompt: string;
  template: string; // template name for the worker
  dependsOn: string[]; // task ids
  runId: string | null; // the spawned worker run
  status: CampaignTaskStatus;
  createdAt: number;
}

/** A campaign = orchestrator → auto-spawned workers (DAG) → optional synthesizer. */
export interface Campaign {
  id: string;
  objective: string;
  cwd: string;
  status: CampaignStatus;
  orchestratorTemplate: string;
  workerTemplate: string;
  synthesizerTemplate: string | null;
  orchestratorRunId: string | null;
  synthesizerRunId: string | null;
  maxParallel: number;
  autoSynthesize: boolean;
  budgetPerWorkerUsd: number | null;
  model: string;
  startedAt: number;
  endedAt: number | null;
  costUsd: number;
  // ── v2 #4: campaign-per-card delegation ──
  /** Owning project (set for a campaign-per-card; null for a standalone campaign). */
  projectId: string | null;
  /** Deny-list every worker/orchestrator/synthesizer launch carries (v2 #4 — campaign workers
   *  NEVER push; the engine-side merge pushes as fleet-pm). null → engine default (no deny-list). */
  disallowedTools: string[] | null;
  /** Permission mode every launch carries so `interactive:false` workers don't stall awaiting a
   *  prompt (v2 #4). null → fall back to the per-template permission mode. */
  permissionMode: PermissionMode | null;
  // ── derived ──
  tasks?: CampaignTask[];
  taskCount?: number;
  doneCount?: number;
  liveWorkers?: number;
}

export interface CreateCampaignRequest {
  objective: string;
  cwd: string;
  orchestratorTemplate?: string;
  workerTemplate?: string;
  synthesizerTemplate?: string | null;
  maxParallel?: number;
  autoSynthesize?: boolean;
  budgetPerWorkerUsd?: number | null;
  model?: string;
  effort?: EffortLevel;
  // ── v2 #4: campaign-per-card delegation (internal — set by pm.launchBuild, not the public route) ──
  projectId?: string | null;
  disallowedTools?: string[] | null;
  permissionMode?: PermissionMode | null;
}

/** The plan the orchestrator must return — also passed to `claude --json-schema` (DC.md D-019). */
export interface OrchestratorPlan {
  tasks: Array<{
    id: string;
    title: string;
    prompt: string;
    template?: string;
    dependsOn?: string[];
  }>;
}

/** JSON Schema handed to `--json-schema` so the orchestrator's result is guaranteed-valid. */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short unique id, e.g. t1' },
          title: { type: 'string' },
          prompt: { type: 'string', description: 'the full self-contained instruction for the worker agent' },
          template: { type: 'string', description: 'optional worker template name' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'task ids that must finish first' },
        },
        required: ['id', 'title', 'prompt'],
      },
    },
  },
  required: ['tasks'],
} as const;

export type CampaignMessage =
  | { kind: 'campaign-hello'; campaign: Campaign }
  | { kind: 'campaign'; campaign: Campaign }
  | { kind: 'task'; task: CampaignTask };

// ─────────────────────────────────────────────────────────────────────────────
// Projects + Kanban + autonomous PM (spec docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-project merge strategy: local `merge --no-ff` (v1 default) or push branch + open a GitHub PR (v2 #2). */
export type MergeMode = 'local' | 'pr';

/** A first-class project = a git repo root that scopes runs/campaigns/kanban + executor policy. */
export interface Project {
  id: string;
  name: string;
  rootDir: string;
  defaultBranch: string;
  /** true = trusted full-auto merge (checks still run); false (default) = park in Review for human approve. */
  autoMerge: boolean;
  defaultValidationCommand: string | null;
  wipLimit: number;
  budgetCeilingUsd: number | null;
  paused: boolean;
  createdAt: number;
  // ── v2 #1: in-browser file CRUD + commit surface ──────────────────────────────
  /** Gate for the in-browser file edit/commit surface (default false). */
  editingEnabled: boolean;
  /** Optional per-project author override for browser commits (else the ambient git identity). */
  commitAuthorName: string | null;
  commitAuthorEmail: string | null;
  // ── v2 #2: full remote git (push / fetch / GitHub PR) ─────────────────────────
  mergeMode: MergeMode;
  remoteName: string;
  pushEnabled: boolean;
  // ── v2 #5: port-broker server validation ──────────────────────────────────────
  serverStartCommand: string | null;
  healthCheckUrl: string | null;
  healthCheckRegex: string | null;
  readinessTimeoutMs: number | null;
  portRangeStart: number | null;
  portRangeEnd: number | null;
  copyEnvFrom: string | null;
  // ── v2 #7: fleet-level cross-project scheduler ────────────────────────────────
  priority: number;
  // ── v2 #9: conflict-resolution agent ──────────────────────────────────────────
  resolveConflicts: boolean;
}

export interface CreateProjectRequest {
  name: string;
  rootDir: string;
  defaultBranch?: string;
  autoMerge?: boolean;
  defaultValidationCommand?: string | null;
  wipLimit?: number;
  budgetCeilingUsd?: number | null;
  /**
   * When `true` AND `rootDir` is an existing directory that is NOT a git work tree, the create
   * route runs `git init` (seeding `.gitignore` + an initial commit) before attaching it, instead
   * of returning the not-a-git-repo 400. The resulting project is indistinguishable from one
   * attached to a pre-existing repo (no provenance column). v2 item #10.
   */
  initGit?: boolean;
  // ── v2 optional mirrors (all default-applied server-side when omitted) ─────────
  editingEnabled?: boolean; // #1
  commitAuthorName?: string | null; // #1
  commitAuthorEmail?: string | null; // #1
  mergeMode?: MergeMode; // #2
  remoteName?: string; // #2
  pushEnabled?: boolean; // #2
  serverStartCommand?: string | null; // #5
  healthCheckUrl?: string | null; // #5
  healthCheckRegex?: string | null; // #5
  readinessTimeoutMs?: number | null; // #5
  portRangeStart?: number | null; // #5
  portRangeEnd?: number | null; // #5
  copyEnvFrom?: string | null; // #5
  priority?: number; // #7
  resolveConflicts?: boolean; // #9
}

/** Human-draggable workflow column. The PM only picks up `Ready`. */
export type KanbanColumn = 'Backlog' | 'Ready' | 'InProgress' | 'Review' | 'Done' | 'Blocked' | 'Canceled';
export const KANBAN_COLUMNS: KanbanColumn[] = ['Backlog', 'Ready', 'InProgress', 'Review', 'Done', 'Blocked', 'Canceled'];

/** Derived execution badge, orthogonal to the column. `resolving` = a conflict-resolution agent is
 *  reconciling the task branch (v2 #9, §3.6). */
export type ExecutionPhase =
  | 'idle'
  | 'building'
  | 'validating'
  | 'merging'
  | 'conflicts'
  | 'paused-budget'
  | 'failed'
  | 'resolving';

/** A kanban card = a human-curated work unit; the PARENT of execution. */
export interface KanbanTask {
  id: string;
  projectId: string;
  column: KanbanColumn;
  executionPhase: ExecutionPhase;
  title: string;
  description: string;
  acceptanceCriteria: string;
  validationCommand: string | null;
  priority: number; // 0 none .. 4 urgent
  rank: string; // lexorank in-column ordering
  dependsOn: string[];
  assignee: string; // 'pm' | 'human'
  labels: string[];
  runId: string | null;
  campaignId: string | null;
  worktreeName: string | null;
  attemptCount: number;
  maxAttempts: number;
  budgetUsd: number | null;
  validationOutput: string | null;
  lastDiffHash: string | null;
  mergeSha: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  // ── v2 #4: campaign-per-card delegation ───────────────────────────────────────
  /** `single` (one build run, default) or `campaign` (a sub-DAG of orchestrator+worker runs). */
  mode: 'single' | 'campaign';
  // ── v2 #2: full remote git (push / fetch / GitHub PR) ─────────────────────────
  prUrl: string | null;
  prState: 'open' | 'merged' | 'closed' | null;
  // ── v2 #5: port-broker server validation (per-card overrides) ──────────────────
  serverStartCommand: string | null;
  healthCheckUrl: string | null;
  healthCheckRegex: string | null;
  // ── v2 #9: conflict-resolution agent ──────────────────────────────────────────
  resolveAttemptCount: number;
  maxResolveAttempts: number;
}

export interface CreateKanbanTaskRequest {
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  validationCommand?: string | null;
  priority?: number;
  dependsOn?: string[];
  maxAttempts?: number;
  budgetUsd?: number | null;
  column?: KanbanColumn;
  // ── v2 optional mirrors (defaults applied server-side when omitted) ────────────
  mode?: 'single' | 'campaign'; // #4
  serverStartCommand?: string | null; // #5
  healthCheckUrl?: string | null; // #5
  healthCheckRegex?: string | null; // #5
  maxResolveAttempts?: number; // #9
}

export type KanbanBoardMessage =
  | { kind: 'board-hello'; tasks: KanbanTask[] }
  | { kind: 'task'; task: KanbanTask }
  | { kind: 'task-removed'; taskId: string };

// ─────────────────────────────────────────────────────────────────────────────
// Release / self-update (release page + GitHub version check)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
}

export interface ReleaseStatus {
  /** version from the repo root package.json */
  currentVersion: string;
  /** short HEAD sha of the local checkout (null outside a git repo) */
  currentSha: string | null;
  /** `owner/repo` resolved from FLEET_GITHUB_REPO or the git origin remote; null = not configured */
  repo: string | null;
  latest: ReleaseInfo | null;
  /** latest release tag is semver-newer than currentVersion */
  updateAvailable: boolean;
  /** a git origin remote exists, so POST /api/release/update can pull */
  canSelfUpdate: boolean;
  checkedAt: number | null;
  error: string | null;
}

export interface SelfUpdateStep {
  step: string;
  ok: boolean;
  output: string;
}

export interface SelfUpdateResult {
  ok: boolean;
  steps: SelfUpdateStep[];
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-ons (§22) — optional capabilities toggled from the Add-on Marketplace.
// The first (built-in) add-on is `compression`: the Headroom transparent proxy
// (headroom-docs.vercel.app) sits between spawned claude runs and the Anthropic
// API and compresses tool outputs / logs / search results before they hit the
// model. Enabling an add-on unlocks its dedicated portal page (`page`).
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle of an add-on's backing service (compression = the headroom proxy). */
export type AddonStatus =
  | 'disabled' // add-on switched off
  | 'not-installed' // enabled-able only after its dependency is installed
  | 'starting' // backing process spawned, waiting for first healthy probe
  | 'running' // healthy
  | 'stopped' // enabled but the backing process is not up
  | 'error'; // backing process failed (statusDetail says why)

export interface AddonInfo {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** `builtin` ships with the portal; `marketplace` reserved for installable add-ons. */
  kind: 'builtin' | 'marketplace';
  docsUrl: string | null;
  /** Portal route this add-on unlocks when enabled (shown in the nav rail). */
  page: string | null;
  enabled: boolean;
  /** The add-on's external dependency (headroom binary) was detected. */
  installed: boolean;
  /** Detected dependency version, when the binary reports one. */
  version: string | null;
  status: AddonStatus;
  statusDetail: string | null;
  config: Record<string, unknown>;
}

/** Config for the built-in `compression` add-on (maps to `headroom proxy` flags). */
export interface CompressionConfig {
  /** Local port the proxy listens on (127.0.0.1 only). */
  port: number;
  /** Inject ANTHROPIC_BASE_URL into newly spawned runs so they route through the proxy. */
  applyToNewRuns: boolean;
  /** Token compression itself (`--no-optimize` when false). */
  optimize: boolean;
  /** Semantic caching (`--no-cache` when false). */
  cache: boolean;
  /** Provider rate-limit smoothing (`--no-rate-limit` when false). */
  rateLimit: boolean;
  /** Daily USD ceiling enforced by the proxy (`--budget`); null = uncapped. */
  dailyBudgetUsd: number | null;
}

/** Live savings read from the proxy's /health + /stats endpoints. */
export interface CompressionStats {
  healthy: boolean;
  endpoint: string;
  totalRequests: number | null;
  tokensSaved: number | null;
  savingsPercent: number | null;
  /** Dollars not spent, as accounted by the proxy (compression + cache). */
  savedUsd: number | null;
  error: string | null;
}

/** Result of POST /api/addons/:id/install (same step shape as self-update). */
export interface AddonInstallResult {
  ok: boolean;
  steps: SelfUpdateStep[];
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool/skill packs (§23) — operator-defined presets of allowed-tools entries +
// skills, applied with one click in the launch modal / template editor.
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolPack {
  id: string;
  name: string;
  description: string;
  /** allowed-tools entries — plain names (Read) or patterns (Bash(git *)). */
  tools: string[];
  skills: string[];
  createdAt: number;
}

export interface CreateToolPackRequest {
  name: string;
  description?: string;
  tools?: string[];
  skills?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Static reference data
// ─────────────────────────────────────────────────────────────────────────────

/** Model catalog. Pricing per platform.claude.com (2026-06); cost truth still comes from
 *  `result.total_cost_usd`. Ordered most→least capable. Fast mode (2× pricing) is the
 *  Claude Code Opus-tier toggle (Opus 4.6/4.7/4.8). */
export const MODELS: ModelInfo[] = [
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    inputPerM: 10,
    outputPerM: 50,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    fastModeCapable: false,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    inputPerM: 5,
    outputPerM: 25,
    fastInputPerM: 10,
    fastOutputPerM: 50,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    fastModeCapable: true,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    inputPerM: 5,
    outputPerM: 25,
    fastInputPerM: 10,
    fastOutputPerM: 50,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    fastModeCapable: true,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    inputPerM: 5,
    outputPerM: 25,
    fastInputPerM: 10,
    fastOutputPerM: 50,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    fastModeCapable: true,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    inputPerM: 3,
    outputPerM: 15,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    fastModeCapable: false,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    inputPerM: 1,
    outputPerM: 5,
    contextWindow: 200_000,
    maxOutput: 64_000,
    fastModeCapable: false,
  },
  // ── legacy (still active on the API; pinnable for older workflows) ───────────
  {
    id: 'claude-opus-4-5',
    label: 'Claude Opus 4.5 (legacy)',
    inputPerM: 5,
    outputPerM: 25,
    contextWindow: 200_000,
    maxOutput: 64_000,
    fastModeCapable: false,
  },
  {
    id: 'claude-opus-4-1',
    label: 'Claude Opus 4.1 (legacy)',
    inputPerM: 15,
    outputPerM: 75,
    contextWindow: 200_000,
    maxOutput: 32_000,
    fastModeCapable: false,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (legacy)',
    inputPerM: 3,
    outputPerM: 15,
    contextWindow: 200_000,
    maxOutput: 64_000,
    fastModeCapable: false,
  },
];

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code's tool surface (for the allowed/disallowed-tools pickers — D-006:
 *  these become `--allowedTools` / `--disallowedTools` entries verbatim). Free-form
 *  patterns (Bash(git *), mcp__server__tool) are equally valid; this list is the
 *  discoverable baseline, not a constraint. */
export const CLAUDE_TOOLS: Array<{ name: string; hint: string }> = [
  { name: 'Bash', hint: 'shell commands · patterns work: Bash(git *)' },
  { name: 'Read', hint: 'read files' },
  { name: 'Write', hint: 'create/overwrite files' },
  { name: 'Edit', hint: 'in-place file edits' },
  { name: 'Glob', hint: 'find files by pattern' },
  { name: 'Grep', hint: 'search file contents' },
  { name: 'Task', hint: 'spawn subagents' },
  { name: 'WebFetch', hint: 'fetch a URL' },
  { name: 'WebSearch', hint: 'search the web' },
  { name: 'TodoWrite', hint: 'task list' },
  { name: 'NotebookEdit', hint: 'edit Jupyter notebooks' },
  { name: 'Skill', hint: 'invoke skills' },
  { name: 'SlashCommand', hint: 'run /commands' },
  { name: 'KillShell', hint: 'kill a background shell' },
  { name: 'BashOutput', hint: 'read background shell output' },
];

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'plan',
  'bypassPermissions',
];

export const RUN_STATUSES: RunStatus[] = [
  'starting',
  'running',
  'awaiting-input',
  'awaiting-permission',
  'orchestrating',
  'completed',
  'failed',
  'killed',
];

/** A run is "live" (controllable / consuming budget) in these states. */
export const LIVE_STATUSES: RunStatus[] = [
  'starting',
  'running',
  'awaiting-input',
  'awaiting-permission',
  'orchestrating',
];

export const isLive = (s: RunStatus): boolean => LIVE_STATUSES.includes(s);

// ─────────────────────────────────────────────────────────────────────────────
// PM Plan-board (v2 #3) — objective → orchestrator plan → Ready cards.
// A draft bridges the Campaigns planner (--json-schema + PLAN_JSON_SCHEMA) to the
// Kanban board WITHOUT touching campaigns.ts: a single orchestrator run (campaignId
// null, no card) decomposes the objective; on apply each PlanTask becomes a card with
// depends_on remapped from the DAG edges. (spec docs/superpowers/specs/2026-06-09-v2-out-of-scope-design.md §4 #3)
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle of a plan draft. `planning` → (`ready` | `error`) → `applied`. */
export type PlanDraftStatus = 'planning' | 'ready' | 'error' | 'applied';
export const PLAN_DRAFT_STATUSES: PlanDraftStatus[] = ['planning', 'ready', 'error', 'applied'];

/** One node of the proposed plan DAG (the reviewable/editable unit before apply). */
export interface PlanTask {
  id: string; // short plan-local id (e.g. t1) — the DAG edge key, NOT a card id
  title: string;
  prompt: string; // becomes the card description
  template?: string;
  dependsOn?: string[]; // plan-local ids that must finish first
}

/** A planning attempt: an objective decomposed by the orchestrator into a task DAG. */
export interface PlanDraft {
  id: string;
  projectId: string;
  objective: string;
  /** Kanban column the applied cards land in (default 'Ready'). */
  targetColumn: KanbanColumn;
  status: PlanDraftStatus;
  /** The orchestrator (planner) run whose live progress the UI streams over /api/agents/:id/stream. */
  orchestratorRunId: string | null;
  /** The decomposed plan once the planner is `ready`; null while planning / on error. */
  plan: PlanTask[] | null;
  /** Failure reason when status is `error`. */
  error: string | null;
  /** Card ids created on apply (idempotency record); empty until `applied`. */
  appliedCardIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreatePlanRequest {
  objective: string;
  targetColumn?: KanbanColumn;
}

export interface ApplyPlanRequest {
  /** Optional edited task list; defaults to the draft's stored plan. */
  tasks?: PlanTask[];
  /** Optional column override; defaults to the draft's targetColumn. */
  targetColumn?: KanbanColumn;
}
