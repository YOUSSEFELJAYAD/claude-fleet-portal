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
} from '@fleet/shared';

export const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

/** Error carrying the HTTP status + server `code` so callers can branch (e.g. 409 stale-oid). */
export type ApiError = Error & { status?: number; code?: string };

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
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

export const api = {
  launch: (b: LaunchRequest) => j<Run>('/api/agents', { method: 'POST', body: JSON.stringify(b) }),
  listRuns: (q?: { status?: string; effort?: string; q?: string }) => j<Run[]>('/api/agents' + qs(q)),
  getRun: (id: string) => j<{ run: Run; nodes: RunNode[] }>(`/api/agents/${id}`),
  getTree: (id: string) => j<RunNode>(`/api/agents/${id}/tree`),
  stop: (id: string) => j(`/api/agents/${id}`, { method: 'DELETE' }),
  deleteRun: (id: string) => j(`/api/agents/${id}/record`, { method: 'DELETE' }),
  input: (id: string, text: string) =>
    j(`/api/agents/${id}/input`, { method: 'POST', body: JSON.stringify({ text }) }),
  resume: (id: string, prompt?: string, interactive?: boolean) =>
    j<Run>(`/api/agents/${id}/resume`, { method: 'POST', body: JSON.stringify({ prompt, interactive }) }),
  permission: (id: string, requestId: string, decision: 'approve' | 'deny') =>
    j(`/api/agents/${id}/permission`, { method: 'POST', body: JSON.stringify({ requestId, decision }) }),
  meta: () => j<MetaResponse>('/api/meta'),
  skills: (cwd?: string) => j<SkillInfo[]>('/api/skills' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '')),
  subagents: (cwd?: string) =>
    j<SubagentInfo[]>('/api/subagents' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '')),
  config: () => j<PortalConfig>('/api/config'),
  setConfig: (c: PortalConfig) => j<PortalConfig>('/api/config', { method: 'PUT', body: JSON.stringify(c) }),
  spend: () => j<SpendSummary>('/api/spend'),
  teams: () => j<TeamSummary[]>('/api/teams'),
  team: (id: string) => j<TeamView>(`/api/teams/${id}`),

  // Orchestration Mode
  templates: () => j<AgentTemplate[]>('/api/templates'),
  createTemplate: (t: CreateTemplateRequest) => j<AgentTemplate>('/api/templates', { method: 'POST', body: JSON.stringify(t) }),
  deleteTemplate: (id: string) => j(`/api/templates/${id}`, { method: 'DELETE' }),
  campaigns: () => j<Campaign[]>('/api/campaigns'),
  campaign: (id: string) => j<Campaign>(`/api/campaigns/${id}`),
  createCampaign: (r: CreateCampaignRequest) => j<Campaign>('/api/campaigns', { method: 'POST', body: JSON.stringify(r) }),
  killCampaign: (id: string) => j(`/api/campaigns/${id}`, { method: 'DELETE' }),

  // PM Plan-board (v2 #3) — objective → orchestrator plan → Ready cards.
  createPlan: (pid: string, objective: string, targetColumn?: KanbanColumn) =>
    j<PlanDraft>(`/api/projects/${pid}/plan`, { method: 'POST', body: JSON.stringify({ objective, targetColumn }) }),
  getPlan: (id: string) => j<PlanDraft>(`/api/plans/${id}`),
  listPlans: (pid: string) => j<PlanDraft[]>(`/api/projects/${pid}/plans`),
  applyPlan: (id: string, tasks?: PlanTask[], targetColumn?: KanbanColumn) =>
    j<PlanDraft>(`/api/plans/${id}/apply`, { method: 'POST', body: JSON.stringify({ tasks, targetColumn }) }),

  // In-browser file CRUD + commit (v2 #1) — gated server-side by project.editingEnabled.
  getFileForEdit: (pid: string, path: string) =>
    j<FileEditResult>(`/api/projects/${pid}/files/edit?path=${encodeURIComponent(path)}`),
  commitFile: (pid: string, body: CommitFileBody) =>
    j<CommitFileResult>(`/api/projects/${pid}/files/commit`, { method: 'POST', body: JSON.stringify(body) }),
};
