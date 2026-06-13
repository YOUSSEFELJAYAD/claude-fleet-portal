import type {
  Run,
  RunNode,
  LaunchRequest,
  SkillInfo,
  SubagentInfo,
  ModelInfo,
  PortalConfig,
  SpendSummary,
  TeamView,
  AgentTemplate,
  CreateTemplateRequest,
  Campaign,
  CreateCampaignRequest,
  PlanDraft,
  PlanTask,
  KanbanColumn,
  FleetConfig,
  FleetStatus,
  FleetProjectStatus,
  ReleaseStatus,
  ReleaseInfo,
  SelfUpdateResult,
  AddonInfo,
  AddonInstallResult,
  CompressionStats,
  ToolPack,
  CreateToolPackRequest,
  ResearchSearchRequest,
  ResearchSearchResponse,
  ResearchSynthesizeRequest,
  ResearchSynthesizeResponse,
  ResearchStatusResponse,
} from '@fleet/shared';
// F10 — config-as-code export/import types (defined locally to avoid cross-package imports)
export interface ExportedSetup {
  version: 1;
  exportedAt: number;
  templates: unknown[];
  packs: unknown[];
  guardrails: unknown;
  fleet: unknown;
}
export interface ImportResult {
  templates: { created: number; updated: number };
  packs: { created: number; updated: number };
  guardrails: 'applied' | 'skipped';
  fleet: 'applied' | 'skipped';
  errors: string[];
}

// F8 — notification channel type (mirrors notifier.ts Channel)
export type ChannelKind = 'slack' | 'discord' | 'generic';
export type ChannelEvent =
  | 'run-failed'
  | 'run-completed'
  | 'run-killed'
  | 'awaiting-permission'
  | 'spend-threshold';
export interface NotifierChannel {
  id: string;
  kind: ChannelKind;
  url: string;
  events: ChannelEvent[];
  enabled: boolean;
  lastError: string | null;
  lastOkAt: number | null;
}

// F4 — benchmarks (mirrors benchmarks.ts wire shapes)
export interface BenchmarkVariant {
  label?: string;
  engine: 'claude' | 'codex' | 'opencode';
  model?: string;
  engineModel?: string;
  thinkingLevel?: string;
  effort?: string;
}

export interface CreateBenchmarkRequest {
  prompt: string;
  cwd: string;
  mode: 'matrix' | 'best-of-n';
  variants: BenchmarkVariant[];
  judgeTemplate?: string;
  budgetPerRunUsd?: number;
}

export interface Benchmark {
  id: string;
  prompt: string;
  cwd: string;
  mode: 'matrix' | 'best-of-n';
  variants: BenchmarkVariant[];
  runIds: string[];
  judgeTemplate: string | null;
  judgeRunId: string | null;
  winnerRunId: string | null;
  status: 'running' | 'judging' | 'completed' | 'failed' | 'killed';
  createdAt: number;
  endedAt: number | null;
}

export interface BenchmarkRunRollup {
  runId: string;
  label: string;
  engine: string;
  model: string | null;
  status: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number | null;
  resultPreview: string | null;
  isWinner: boolean;
}

export interface BenchmarkDetail extends Benchmark {
  rollups: BenchmarkRunRollup[];
}

// F1 — GitHub triggers (mirrors triggers.ts TriggerView)
export interface TriggerView {
  id: string;
  repo: string;
  kind: 'issue-label' | 'pr-opened';
  config: Record<string, unknown>;
  action: 'card' | 'run';
  projectId: string | null;
  template: string | null;
  enabled: boolean;
  state: { seen: number[] };
  lastError: string | null;
  createdAt: number;
}
export interface CreateTriggerRequest {
  repo: string;
  kind: 'issue-label' | 'pr-opened';
  config?: Record<string, unknown>;
  action: 'card' | 'run';
  project_id?: string | null;
  template?: string | null;
  enabled?: boolean;
}

// F2 — Recurring scheduled agents types (mirrors scheduler.ts ScheduleView)
export interface ScheduleView {
  id: string;
  name: string;
  intervalMs: number | null;
  dailyAt: string | null;
  /** F2: every:<min> | daily:<HH:MM> | weekly:<0-6>:<HH:MM> | null = one-shot */
  recurrence: string | null;
  /** F2: template name or null */
  template: string | null;
  launchRequest: {
    prompt: string;
    cwd: string;
    model: string;
    effort: string;
    permissionMode?: string;
  };
  enabled: boolean;
  lastRunId: string | null;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  createdAt: number;
}
export interface CreateScheduleRequest {
  name: string;
  /** Provide exactly one of recurrence | interval_ms | daily_at */
  recurrence?: string;
  interval_ms?: number;
  daily_at?: string;
  template?: string | null;
  launch_request: {
    prompt: string;
    cwd: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
  };
  enabled?: boolean;
}

// Re-export for page components that take these via the api layer.
export type { FleetStatus, FleetProjectStatus };

export const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

/** Error carrying the HTTP status + server `code` so callers can branch (e.g. 409 stale-oid). */
export type ApiError = Error & { status?: number; code?: string };

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  // Only claim a JSON body when one is actually sent — Fastify 400s an EMPTY body that
  // carries `content-type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY), which broke
  // every body-less DELETE (kill run, delete record / template / campaign).
  const r = await fetch(API + path, {
    ...(init?.body != null ? { headers: { 'content-type': 'application/json' } } : {}),
    ...init,
  });
  if (!r.ok) {
    let msg = r.statusText;
    let code: string | undefined;
    try {
      const body = await r.json();
      msg = body.error ?? msg;
      code = body.code;
    } catch {
      /* ignore */
    }
    const e = new Error(msg) as ApiError;
    e.status = r.status;
    e.code = code;
    throw e;
  }
  return r.json() as Promise<T>;
}

const qs = (q?: Record<string, string | undefined>) => {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface TeamSummary {
  id: string;
  name: string;
  taskDir: string;
  taskCount: number;
  updatedAt: number;
}

export interface MetaResponse {
  models: ModelInfo[];
  efforts: string[];
  permissionModes: string[];
  statuses: string[];
}

/** Row from GET /api/mcp (server-side `claude mcp list` parse). */
export interface McpServerInfo {
  name: string;
  status: string; // connected | needs-auth | failed | pending | best-effort token
  detail: string;
}

// ── v2 #1: in-browser file CRUD + commit ──────────────────────────────────────
/** Working-tree bytes of a single file for the editor (GET /files/edit). */
export interface FileEditResult {
  path: string;
  content: string | null; // null when binary/too-large
  oid: string | null; // working-tree blob hash → baseOid (null = file does not exist yet)
  editable: boolean; // editingEnabled && text && within cap
  binary: boolean;
  tooLarge: boolean;
  size?: number;
  exists: boolean;
}

/** Commit body for POST /files/commit. delete:true → git rm; else write `content`. */
export interface CommitFileBody {
  path: string;
  content?: string;
  delete?: boolean;
  message: string;
  baseOid?: string | null;
}

/**
 * Result of POST /files/commit. NOTE the dual failure channel (fileedit.ts): a path/validation/
 * stale rejection is a real non-2xx (so `j` throws an {@link ApiError} carrying `.status`), but a
 * git-command failure returns HTTP 200 with `{ ok:false, error }` — callers MUST check `res.ok`.
 */
export type CommitFileResult =
  | { ok: true; sha: string; author: string | { name: string; email: string } }
  | { ok: false; error: string };

// v2 #7 fleet status types now come from @fleet/shared (no local mirror — DC §10 gap closed).

export const api = {
  launch: (b: LaunchRequest) => j<Run>('/api/agents', { method: 'POST', body: JSON.stringify(b) }),
  listRuns: (q?: { status?: string; effort?: string; q?: string; archived?: 'include' | 'only' }) => j<Run[]>('/api/agents' + qs(q)),
  getRun: (id: string) => j<{ run: Run; nodes: RunNode[]; retriedBy: string | null }>(`/api/agents/${id}`),
  getTree: (id: string) => j<RunNode>(`/api/agents/${id}/tree`),
  // ── F4+F5 benchmarks ──
  benchmarks: () => j<Benchmark[]>('/api/benchmarks'),
  getBenchmark: (id: string) => j<BenchmarkDetail>(`/api/benchmarks/${id}`),
  createBenchmark: (body: CreateBenchmarkRequest) =>
    j<Benchmark>('/api/benchmarks', { method: 'POST', body: JSON.stringify(body) }),
  killBenchmark: (id: string) => j(`/api/benchmarks/${id}`, { method: 'DELETE' }),

  // ── release / self-update (§15) ──
  releaseStatus: (force?: boolean) => j<ReleaseStatus>(`/api/release/status${force ? '?force=1' : ''}`),
  releases: () => j<{ repo: string | null; releases: ReleaseInfo[]; error?: string | null }>('/api/release/list'),
  selfUpdate: () => j<SelfUpdateResult>('/api/release/update', { method: 'POST', body: JSON.stringify({}) }),

  // ── add-on marketplace (§22) ──
  addons: () => j<AddonInfo[]>('/api/addons'),
  addon: (id: string) => j<AddonInfo>(`/api/addons/${id}`),
  enableAddon: (id: string) => j<AddonInfo>(`/api/addons/${id}/enable`, { method: 'POST', body: JSON.stringify({}) }),
  disableAddon: (id: string) => j<AddonInfo>(`/api/addons/${id}/disable`, { method: 'POST', body: JSON.stringify({}) }),
  restartAddon: (id: string) => j<AddonInfo>(`/api/addons/${id}/restart`, { method: 'POST', body: JSON.stringify({}) }),
  setAddonConfig: (id: string, cfg: Record<string, unknown>) =>
    j<AddonInfo>(`/api/addons/${id}/config`, { method: 'PUT', body: JSON.stringify(cfg) }),
  installAddon: (id: string) => j<AddonInstallResult>(`/api/addons/${id}/install`, { method: 'POST', body: JSON.stringify({}) }),
  compressionStats: () => j<CompressionStats>('/api/addons/compression/stats'),

  // ── §28 web research (SearXNG) ──
  researchSearch: (body: ResearchSearchRequest) =>
    j<ResearchSearchResponse>('/api/research/search', { method: 'POST', body: JSON.stringify(body) }),
  researchSynthesize: (body: ResearchSynthesizeRequest) =>
    j<ResearchSynthesizeResponse>('/api/research/synthesize', { method: 'POST', body: JSON.stringify(body) }),
  researchStatus: () => j<ResearchStatusResponse>('/api/research/status'),
  registerSearxngMcp: () =>
    j<{ ok: boolean; output: string; note?: string }>('/api/addons/web-research/register-mcp', { method: 'POST', body: JSON.stringify({}) }),

  // ── tool/skill packs (§23) — launch presets ──
  packs: () => j<ToolPack[]>('/api/packs'),
  createPack: (p: CreateToolPackRequest) => j<ToolPack>('/api/packs', { method: 'POST', body: JSON.stringify(p) }),
  updatePack: (id: string, patch: Partial<CreateToolPackRequest>) =>
    j<ToolPack>(`/api/packs/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deletePack: (id: string) => j(`/api/packs/${id}`, { method: 'DELETE' }),

  stop: (id: string) => j(`/api/agents/${id}`, { method: 'DELETE' }),
  stopAll: () => j<{ stopped: number }>('/api/agents/stop-all', { method: 'POST', body: JSON.stringify({}) }),
  deleteRun: (id: string) => j(`/api/agents/${id}/record`, { method: 'DELETE' }),
  archiveRun: (id: string, archived: boolean) =>
    j<Run>(`/api/agents/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  input: (id: string, text: string) =>
    j(`/api/agents/${id}/input`, { method: 'POST', body: JSON.stringify({ text }) }),
  resume: (id: string, prompt?: string, interactive?: boolean) =>
    j<Run>(`/api/agents/${id}/resume`, { method: 'POST', body: JSON.stringify({ prompt, interactive }) }),
  permission: (id: string, requestId: string, decision: 'approve' | 'deny') =>
    j(`/api/agents/${id}/permission`, { method: 'POST', body: JSON.stringify({ requestId, decision }) }),
  meta: () => j<MetaResponse>('/api/meta'),
  mcp: () => j<{ servers: McpServerInfo[]; error?: string }>('/api/mcp'),
  skills: (cwd?: string) => j<SkillInfo[]>('/api/skills' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '')),
  subagents: (cwd?: string) =>
    j<SubagentInfo[]>('/api/subagents' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '')),
  // F7 — full-text transcript search
  search: (q: string, limit?: number) =>
    j<{ available: boolean; hits: Array<{ runId: string; seq: number; nodeId: string; snippet: string; run: { id: string; task: string; status: string; startedAt: number; model: string } }> }>(
      `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
    ),
  config: () => j<PortalConfig>('/api/config'),
  setConfig: (c: PortalConfig) => j<PortalConfig>('/api/config', { method: 'PUT', body: JSON.stringify(c) }),
  resetData: (confirm: 'RESET') =>
    j<{ ok: true; campaignsKilled: number; clearedRuns: number; config: PortalConfig }>('/api/config/reset-data', {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),
  // F9 — fleet memory config + stats
  memoryConfig: () => j<{ enabled: boolean; dir: string }>('/api/memory'),
  setMemoryConfig: (cfg: { enabled: boolean; dir: string }) =>
    j<{ enabled: boolean; dir: string }>('/api/memory', { method: 'PUT', body: JSON.stringify(cfg) }),
  memoryStats: () => j<{ entries: number; bytes: number; dir: string }>('/api/memory/stats'),
  spend: () => j<SpendSummary>('/api/spend'),

  // F6 — approval inbox
  inbox: () => j<{ items: Array<{ run: { id: string; task: string; cwd: string; model: string; status: string; startedAt: number; costUsd: number }; kind: 'permission' | 'input'; request?: { id: string; payload: { tool: string; input: unknown } }; lastText?: string }> }>('/api/inbox'),
  // Fleet cross-project scheduler (v2 #7).
  fleetStatus: () => j<FleetStatus>('/api/fleet/status'),
  fleetConfig: () => j<FleetConfig>('/api/fleet/config'),
  setFleetConfig: (c: FleetConfig) =>
    j<FleetConfig>('/api/fleet/config', { method: 'PUT', body: JSON.stringify(c) }),

  // F8 — notification channels + spend alerts
  notifierChannels: () => j<NotifierChannel[]>('/api/notifier/channels'),
  setNotifierChannels: (channels: NotifierChannel[]) =>
    j<NotifierChannel[]>('/api/notifier/channels', { method: 'PUT', body: JSON.stringify(channels) }),
  testNotifierChannel: (id: string) =>
    j<{ ok: boolean; error?: string }>(`/api/notifier/channels/${id}/test`, { method: 'POST', body: JSON.stringify({}) }),

  teams: () => j<TeamSummary[]>('/api/teams'),
  team: (id: string) => j<TeamView>(`/api/teams/${id}`),

  // Config as code — export / import (F10)
  exportSetup: () => j<ExportedSetup>('/api/portability/export'),
  importSetup: (setup: ExportedSetup) =>
    j<ImportResult>('/api/portability/import', { method: 'POST', body: JSON.stringify(setup) }),

  // Orchestration Mode
  templates: () => j<AgentTemplate[]>('/api/templates'),
  template: (id: string) => j<AgentTemplate>(`/api/templates/${id}`),
  createTemplate: (t: CreateTemplateRequest) => j<AgentTemplate>('/api/templates', { method: 'POST', body: JSON.stringify(t) }),
  updateTemplate: (id: string, patch: Partial<AgentTemplate>) =>
    j<AgentTemplate>(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTemplate: (id: string) => j(`/api/templates/${id}`, { method: 'DELETE' }),
  campaigns: () => j<Campaign[]>('/api/campaigns'),
  campaign: (id: string) => j<Campaign>(`/api/campaigns/${id}`),
  createCampaign: (r: CreateCampaignRequest) => j<Campaign>('/api/campaigns', { method: 'POST', body: JSON.stringify(r) }),
  killCampaign: (id: string) => j(`/api/campaigns/${id}`, { method: 'DELETE' }),

  // F2 — Recurring scheduled agents.
  schedules: () => j<ScheduleView[]>('/api/schedules'),
  createSchedule: (body: CreateScheduleRequest) =>
    j<ScheduleView>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: (id: string, patch: Partial<CreateScheduleRequest>) =>
    j<ScheduleView>(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => j(`/api/schedules/${id}`, { method: 'DELETE' }),
  runScheduleNow: (id: string) =>
    j<{ ok: boolean; runId: string | null }>(`/api/schedules/${id}/run`, { method: 'POST', body: JSON.stringify({}) }),

  // PM Plan-board (v2 #3) — objective → orchestrator plan → Ready cards.
  createPlan: (pid: string, objective: string, targetColumn?: KanbanColumn) =>
    j<PlanDraft>(`/api/projects/${pid}/plan`, { method: 'POST', body: JSON.stringify({ objective, targetColumn }) }),
  getPlan: (id: string) => j<PlanDraft>(`/api/plans/${id}`),
  listPlans: (pid: string) => j<PlanDraft[]>(`/api/projects/${pid}/plans`),
  applyPlan: (id: string, tasks?: PlanTask[], targetColumn?: KanbanColumn) =>
    j<PlanDraft>(`/api/plans/${id}/apply`, { method: 'POST', body: JSON.stringify({ tasks, targetColumn }) }),

  // F1 — GitHub triggers
  listTriggers: () =>
    j<TriggerView[]>('/api/triggers'),
  createTrigger: (body: CreateTriggerRequest) =>
    j<TriggerView>('/api/triggers', { method: 'POST', body: JSON.stringify(body) }),
  updateTrigger: (id: string, patch: Partial<CreateTriggerRequest>) =>
    j<TriggerView>(`/api/triggers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTrigger: (id: string) =>
    j(`/api/triggers/${id}`, { method: 'DELETE' }),
  pollTrigger: (id: string) =>
    j<TriggerView>(`/api/triggers/${id}/poll`, { method: 'POST', body: JSON.stringify({}) }),

  // In-browser file CRUD + commit (v2 #1) — gated server-side by project.editingEnabled.
  getFileForEdit: (pid: string, path: string) =>
    j<FileEditResult>(`/api/projects/${pid}/files/edit?path=${encodeURIComponent(path)}`),
  commitFile: (pid: string, body: CommitFileBody) =>
    j<CommitFileResult>(`/api/projects/${pid}/files/commit`, { method: 'POST', body: JSON.stringify(body) }),
};
