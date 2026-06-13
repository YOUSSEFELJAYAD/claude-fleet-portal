// Local mirror of the loops wire shapes. The web app cannot import from apps/server, and the
// Slice-1 shared Loop/contract types may not be published to @fleet/shared when this page ships,
// so we mirror them here exactly like apps/web/app/schedules/page.tsx mirrors Schedule.
const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

export type RiskLevel = 'low' | 'medium' | 'high';
export type LoopKind = 'manager' | 'worker';
export type LoopMode = 'dry-run' | 'apply';
export type ControlPlaneKind = 'board' | 'github';
export type MergePosture = 'human-gate' | 'auto-low-risk';

export interface LoopContract {
  job: string;
  inputs: string;
  allowed: string[];
  forbidden: string[];
  output: string;
  evaluation: string;
}
export interface RiskRule {
  glob: string;
  forceRisk: RiskLevel;
}
export interface LoopEvalResult {
  clean: boolean;
  score: number;
  notes: string;
}
export interface Loop {
  id: string;
  name: string;
  projectId: string;
  kind: LoopKind;
  controlPlane: ControlPlaneKind;
  scheduleId: string | null;
  contract: LoopContract;
  mode: LoopMode;
  consecutiveGoodRuns: number;
  escalationThreshold: number;
  mergePosture: MergePosture;
  reviewPolicy: string; // 'always' | 'off' | 'threshold:<N>'
  riskRubric: RiskRule[];
  routableCeiling: RiskLevel;
  enabled: boolean;
  lastRunId: string | null;
  lastEval: LoopEvalResult | null;
  lastError: string | null;
  createdAt: number;
}
export interface CreateLoopRequest {
  name: string;
  projectId: string;
  kind: LoopKind;
  controlPlane?: ControlPlaneKind;
  scheduleId?: string | null;
  contract: LoopContract;
  escalationThreshold?: number;
  mergePosture?: MergePosture;
  reviewPolicy?: string;
  riskRubric?: RiskRule[];
  routableCeiling?: RiskLevel;
}

/** card assessment thread (board adapter) — GET /api/tasks/:id/comments */
export interface TaskComment {
  id: string;
  taskId: string;
  author: 'manager' | 'reviewer' | 'worker' | 'human';
  body: string;
  createdAt: number;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  // json content-type only when a body is sent — Fastify 400s an empty JSON-typed body
  // (mirrors apps/web/lib/api.ts and the schedules page helper).
  const r = await fetch(API + path, {
    ...(init?.body != null ? { headers: { 'content-type': 'application/json' } } : {}),
    ...init,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const body = await r.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (r.status === 204) return undefined as unknown as T;
  return r.json() as Promise<T>;
}

export const loopsApi = {
  list: () => j<Loop[]>('/api/loops'),
  get: (id: string) => j<Loop>(`/api/loops/${id}`),
  create: (body: CreateLoopRequest) => j<Loop>('/api/loops', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, patch: Partial<CreateLoopRequest> & { enabled?: boolean }) =>
    j<Loop>(`/api/loops/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  remove: (id: string) => j<void>(`/api/loops/${id}`, { method: 'DELETE' }),
  // Slice 02's POST /api/loops/:id/fire returns { ok, loop } (the refreshed Loop); runId stays
  // optional/legacy. The detail page only awaits this (then calls load()), so the wider shape is
  // backward-compatible — nothing here reads .runId.
  fire: (id: string) => j<{ ok: boolean; runId: string | null; loop?: Loop }>(`/api/loops/${id}/fire`, { method: 'POST', body: JSON.stringify({}) }),
  promote: (id: string) => j<Loop>(`/api/loops/${id}/promote`, { method: 'POST', body: JSON.stringify({}) }),
  demote: (id: string) => j<Loop>(`/api/loops/${id}/demote`, { method: 'POST', body: JSON.stringify({}) }),
  comments: (taskId: string) => j<TaskComment[]>(`/api/tasks/${taskId}/comments`),
};
