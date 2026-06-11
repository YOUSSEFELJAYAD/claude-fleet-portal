/**
 * §24 — Guardrails: daily-spend cap, per-run wall-clock timeout, stop-all panic button.
 * Standard test layout: tmp FLEET_DATA_DIR, buildServer + inject pattern with Host header.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate the DB before any src module is imported.
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-guardrails-'));
process.env.FLEET_DATA_DIR = dataDir;

// A tiny sleeping stub for tests that need live processes (timeout + stop-all).
// It just sleeps indefinitely so the registry sees it as a live run.
const sleepBin = join(dataDir, 'sleep-claude.mjs');
writeFileSync(
  sleepBin,
  '#!/usr/bin/env node\n// endless mock — stays alive until killed\nsetInterval(() => {}, 60_000);\n',
);
chmodSync(sleepBin, 0o755);

// processManager.ts reads CLAUDE_BIN once via config.ts at module import time.
// Pin the test binary before any src module is imported.
const originalClaudeBin = process.env.CLAUDE_BIN;
process.env.CLAUDE_BIN = sleepBin;

let app: any;
let PORT: number;
let registry: any;
let repo: any;

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
});

afterAll(async () => {
  await app?.close();
  if (originalClaudeBin == null) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = originalClaudeBin;
});

const H = () => ({ host: `127.0.0.1:${PORT}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── PUT /api/config: nullable ceiling validation ──────────────────────────────
describe('PUT /api/config — dailySpendCeilingUsd + maxRunMinutes validation', () => {
  it('rejects dailySpendCeilingUsd -1 (below minimum 0.01)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: -1 } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects dailySpendCeilingUsd 0.005 (below minimum 0.01)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: 0.005 } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts dailySpendCeilingUsd 25 and reflects it', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: 25 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().dailySpendCeilingUsd).toBe(25);
  });

  it('accepts dailySpendCeilingUsd null (no cap)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().dailySpendCeilingUsd).toBeNull();
  });

  it('rejects maxRunMinutes 0 (below minimum 1)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxRunMinutes: 0 } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects maxRunMinutes 1.5 (must be integer)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxRunMinutes: 1.5 } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts maxRunMinutes 30', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxRunMinutes: 30 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxRunMinutes).toBe(30);
  });

  it('accepts maxRunMinutes null (unlimited)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxRunMinutes: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxRunMinutes).toBeNull();
  });
});

// ── daily-cap launch rejection ────────────────────────────────────────────────
describe('daily-cap launch rejection', () => {
  // Reset ceiling to null so config tests above don't leak into this suite.
  beforeAll(async () => {
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: null } });
  });

  it('rejects a new launch with 409 daily-cap when today spend >= ceiling', async () => {
    // Seed a completed run for today with costUsd 10.
    const id = randomUUID();
    const now = Date.now();
    const seedRun = {
      id,
      sessionId: id,
      task: 'seed-for-cap-test',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      engine: undefined,
      fastMode: false,
      effort: 'low' as const,
      workflowsEnabled: false,
      ultracode: false,
      teamId: null,
      campaignId: null,
      projectId: null,
      pid: null,
      status: 'completed' as const,
      startedAt: now,
      endedAt: now,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 10,
      exitCode: 0,
      killReason: null,
      error: null,
      budgetUsd: null,
      permissionMode: 'default' as const,
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
    repo.upsertRun(seedRun);

    // Set ceiling to 5 (below the seeded 10).
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: 5 } });

    // Launch must be rejected with 409 daily-cap BEFORE spawn.
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: { prompt: 'test cap', cwd: dataDir, model: 'claude-haiku-4-5', effort: 'low', permissionMode: 'default' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('daily-cap');
  });

  it('allows launch when ceiling is raised above today spend', async () => {
    // Ceiling 1000 — well above the seeded 10.
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: 1000 } });

    // registry.config is live; also set it via PUT so registry re-reads from DB.
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: 1000 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: { prompt: 'test cap pass', cwd: dataDir, model: 'claude-haiku-4-5', effort: 'low', permissionMode: 'default' },
    });

    // Should NOT be a 409 daily-cap regardless of other errors (bad cwd, etc.).
    expect(res.statusCode).not.toBe(409);
    const body = res.json();
    expect(body.code).not.toBe('daily-cap');

    // Clean up: stop the run if it was created.
    if (body.id) {
      registry.stop(body.id);
    }
    // Reset ceiling.
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: null } });
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });
  });

  it('resume is ALSO blocked by the daily cap (review: resume was an open side gate)', async () => {
    // a terminal run to resume — its own seeded cost trips the ceiling
    const id = randomUUID();
    const now = Date.now();
    repo.upsertRun({
      id, sessionId: id, task: 'seed-for-resume-cap', cwd: dataDir, model: 'claude-haiku-4-5',
      fastMode: false, effort: 'low', workflowsEnabled: false, ultracode: false, teamId: null,
      campaignId: null, projectId: null, pid: null, status: 'completed', startedAt: now, endedAt: now,
      tokensIn: 0, tokensOut: 0, costUsd: 10, exitCode: 0, killReason: null, error: null,
      budgetUsd: null, permissionMode: 'default', allowedTools: null, skills: [],
      subagentProfile: null, resultText: null, structuredOutput: null,
      subagentCount: 0, liveSubagents: 0, maxDepth: 0, lastActivity: now,
    } as any);
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: 5 } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${id}/resume`,
      headers: H(),
      payload: { prompt: 'continue' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Daily spend ceiling/);

    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { dailySpendCeilingUsd: null } });
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });
  });
});

// ── sweepTimeouts ─────────────────────────────────────────────────────────────
describe('registry.sweepTimeouts — per-run wall-clock timeout', () => {
  beforeAll(async () => {
    // Set maxRunMinutes to 1 for these tests.
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxRunMinutes: 1 } });
    registry.setConfig({ ...registry.getConfig(), maxRunMinutes: 1 });
  });

  afterAll(async () => {
    // Clear the timeout so it doesn't interfere with other tests.
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxRunMinutes: null } });
    registry.setConfig({ ...registry.getConfig(), maxRunMinutes: null });
  });

  it('kills an overdue run with killReason "timeout" when sweepTimeouts is called', async () => {
    registry.setConfig({ ...registry.getConfig(), maxRunMinutes: 1 });

    const run = registry.launch({
      prompt: 'timeout test',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
    });

    // Wait for the process to start (status != 'starting').
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      const r = registry.getRun(run.id);
      if (r && r.status !== 'starting') break;
    }

    // Backdate the run's startedAt so it looks overdue (2 minutes ago).
    const twoMinsAgo = Date.now() - 2 * 60 * 1000;
    registry.__backdateRunForTests(run.id, twoMinsAgo);

    // Call the sweep directly (no timer dependency).
    registry.sweepTimeouts();

    // Allow stop() path + DB flush to complete.
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      const r = registry.getRun(run.id);
      if (r?.status === 'killed') break;
    }

    const final = registry.getRun(run.id);
    expect(final?.status).toBe('killed');
    expect(final?.killReason).toBe('timeout');
  });
});

// ── POST /api/agents/stop-all ─────────────────────────────────────────────────
describe('POST /api/agents/stop-all — panic button', () => {
  it('stops all live runs and returns { stopped: N }', async () => {
    // Ensure no config guardrails interfere (null ceiling + unlimited duration).
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null, maxRunMinutes: null });

    // Launch 2 runs.
    const r1 = registry.launch({
      prompt: 'stop-all test 1',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
    });
    const r2 = registry.launch({
      prompt: 'stop-all test 2',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
    });

    // Wait briefly so processes start (avoids the 'starting' → immediate-terminal edge case).
    await sleep(150);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/stop-all',
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // stopped count should be at least 2 (may include other live runs from other tests).
    expect(body.stopped).toBeGreaterThanOrEqual(2);

    // Both runs should reach killed status.
    for (let i = 0; i < 80; i++) {
      await sleep(50);
      const s1 = registry.getRun(r1.id)?.status;
      const s2 = registry.getRun(r2.id)?.status;
      if (s1 === 'killed' && s2 === 'killed') break;
    }
    expect(registry.getRun(r1.id)?.status).toBe('killed');
    expect(registry.getRun(r2.id)?.status).toBe('killed');
    // killReason is 'user' (stopAll uses default reason)
    expect(registry.getRun(r1.id)?.killReason).toBe('user');
    expect(registry.getRun(r2.id)?.killReason).toBe('user');
  });
});
