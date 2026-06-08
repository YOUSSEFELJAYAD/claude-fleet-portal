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
} from '@fleet/shared';

export const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
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
};
