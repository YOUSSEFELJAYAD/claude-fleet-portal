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
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  exitCode: number | null;
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
  scope: 'user' | 'project' | 'plugin';
  path: string;
  description?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// SSE stream envelope (PRD §9.4 /stream)
// ─────────────────────────────────────────────────────────────────────────────

export type StreamMessage =
  | { kind: 'hello'; run: Run; nodes: RunNode[]; events: NormalizedEvent[] }
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
// Static reference data
// ─────────────────────────────────────────────────────────────────────────────

/** Model catalog. Pricing per PRD §6; cost truth still comes from `result.total_cost_usd`. */
export const MODELS: ModelInfo[] = [
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
];

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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
