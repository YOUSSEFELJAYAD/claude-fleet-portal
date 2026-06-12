import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '@fleet/shared';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-reset-'));

let app: any;
let PORT: number;
let repo: typeof import('../src/db.js').repo;

const H = () => ({ host: `127.0.0.1:${PORT}` });

function run(overrides: Partial<Run> = {}): Run {
  const now = Date.now();
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    task: 'archive me',
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    workflowsEnabled: true,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'completed',
    startedAt: now - 1000,
    endedAt: now,
    tokensIn: 1,
    tokensOut: 2,
    costUsd: 0.01,
    exitCode: 0,
    killReason: null,
    error: null,
    budgetUsd: 5,
    permissionMode: 'default',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: 'done',
    structuredOutput: null,
    pid: null,
    retryOf: null,
    archivedAt: null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: now,
    ...overrides,
  };
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const db = await import('../src/db.js');
  repo = db.repo;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('run archive and delete controls', () => {
  it('archives terminal runs out of the default fleet list and can restore them', async () => {
    const r = run();
    repo.upsertRun(r);

    const before = await app.inject({ method: 'GET', url: '/api/agents', headers: H() });
    expect(before.statusCode).toBe(200);
    expect(before.json().map((x: Run) => x.id)).toContain(r.id);

    const archived = await app.inject({ method: 'POST', url: `/api/agents/${r.id}/archive`, headers: H(), payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toEqual(expect.any(Number));

    const hidden = await app.inject({ method: 'GET', url: '/api/agents', headers: H() });
    expect(hidden.json().map((x: Run) => x.id)).not.toContain(r.id);

    const only = await app.inject({ method: 'GET', url: '/api/agents?archived=only', headers: H() });
    expect(only.statusCode).toBe(200);
    expect(only.json().map((x: Run) => x.id)).toContain(r.id);

    const restored = await app.inject({ method: 'POST', url: `/api/agents/${r.id}/archive`, headers: H(), payload: { archived: false } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().archivedAt).toBeNull();

    const visible = await app.inject({ method: 'GET', url: '/api/agents', headers: H() });
    expect(visible.json().map((x: Run) => x.id)).toContain(r.id);
  });

  it('rejects archiving a live run until it is stopped', async () => {
    const r = run({ status: 'running', endedAt: null });
    repo.upsertRun(r);

    const res = await app.inject({ method: 'POST', url: `/api/agents/${r.id}/archive`, headers: H(), payload: { archived: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Stop the run');
  });
});

describe('destructive local database reset', () => {
  it('requires typed confirmation and resets persisted data/default config', async () => {
    const r = run({ task: 'reset me' });
    repo.upsertRun(r);
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 4 } });

    const rejected = await app.inject({ method: 'POST', url: '/api/config/reset-data', headers: H(), payload: { confirm: 'reset' } });
    expect(rejected.statusCode).toBe(400);

    const reset = await app.inject({ method: 'POST', url: '/api/config/reset-data', headers: H(), payload: { confirm: 'RESET' } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().clearedRuns).toBeGreaterThanOrEqual(1);

    const runs = await app.inject({ method: 'GET', url: '/api/agents?archived=include', headers: H() });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toHaveLength(0);

    const cfg = await app.inject({ method: 'GET', url: '/api/config', headers: H() });
    expect(cfg.json().maxConcurrentRuns).toBe(8);

    const templates = await app.inject({ method: 'GET', url: '/api/templates', headers: H() });
    expect(templates.statusCode).toBe(200);
    expect(templates.json().some((t: any) => t.isBuiltin)).toBe(true);
  });
});
