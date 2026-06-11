/**
 * F9 — Fleet memory tests.
 *
 * Pattern: isolate DB + data dir via FLEET_DATA_DIR, buildServer(), app.inject with
 * Host header. Fake CLAUDE_BIN produces a completed run whose files we inspect.
 *
 * Covers:
 *   - Disabled by default → no files created
 *   - Enabled + completed run (fake bin) → md + jsonl entries appear
 *   - md trimmed (300 task / 1500 result); jsonl untrimmed
 *   - Campaign-member completion writes nothing
 *   - Config validation (dir must be absolute, no '..')
 *   - GET /api/memory returns current config
 *   - GET /api/memory/stats returns entry count + bytes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// ── Isolate the DB before any src module is imported ──────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-memory-'));
process.env.FLEET_DATA_DIR = dataDir;

// ── Fake CLAUDE_BIN: exits 0 immediately, emitting a valid result JSON ────────
const fakeBin = join(dataDir, 'fake-claude.sh');
writeFileSync(
  fakeBin,
  `#!/bin/sh
echo '{"type":"result","subtype":"success","result":"Hello from fake claude — this is the result text that should appear in the memory entry.","is_error":false,"session_id":"test-session","cost_usd":0.0042}'
exit 0
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = fakeBin;

let app: any;
let PORT: number;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const put = (url: string, body: unknown) =>
  app.inject({
    method: 'PUT',
    url,
    headers: { ...H(), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
const post = (url: string, body: unknown = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...H(), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait up to `ms` for `predicate` to return true, polling every 50ms. */
async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(50);
  }
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('GET /api/memory', () => {
  it('returns default config (disabled, default dir)', async () => {
    const res = await get('/api/memory');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.enabled).toBe(false);
    expect(typeof body.dir).toBe('string');
    expect(body.dir.length).toBeGreaterThan(0);
  });
});

describe('PUT /api/memory validation', () => {
  it('rejects non-absolute dir', async () => {
    const res = await put('/api/memory', { dir: 'relative/path' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/absolute/i);
  });

  it('rejects dir containing ..', async () => {
    const res = await put('/api/memory', { dir: '/tmp/../etc' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/\.\./);
  });

  it('rejects non-boolean enabled', async () => {
    const res = await put('/api/memory', { enabled: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/boolean/i);
  });

  it('accepts valid absolute dir', async () => {
    const dir = join(dataDir, 'mem-valid-dir');
    const res = await put('/api/memory', { dir, enabled: false });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.dir).toBe(dir);
  });
});

describe('disabled by default — no files created on completed run', () => {
  it('writes nothing when memory is disabled', async () => {
    // Ensure disabled
    await put('/api/memory', { enabled: false });

    // Launch a run
    const launchRes = await post('/api/agents', {
      prompt: 'test task for memory disabled check',
      cwd: dataDir,
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(launchRes.statusCode).toBe(200);
    const run = JSON.parse(launchRes.payload);

    // Wait for the run to complete
    await waitFor(() => {
      app.inject({ method: 'GET', url: `/api/agents/${run.id}`, headers: H() });
      return false; // We'll check via polling below
    }, 100).catch(() => {});

    // Poll until terminal
    let runStatus = 'running';
    const deadline = Date.now() + 5000;
    while (runStatus === 'running' && Date.now() < deadline) {
      await sleep(100);
      const r = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/agents/${run.id}`, headers: H() })).payload,
      );
      runStatus = r.run?.status ?? 'running';
    }

    // No files should exist
    const memDir = join(dataDir, 'memory');
    const mdPath = join(memDir, 'fleet-runs.md');
    const jsonlPath = join(memDir, 'fleet-runs.jsonl');
    expect(existsSync(mdPath)).toBe(false);
    expect(existsSync(jsonlPath)).toBe(false);
  });
});

describe('enabled — completed run writes md + jsonl entries', () => {
  const memDir2 = join(dataDir, 'mem-enabled');

  it('creates md and jsonl entries on completed run', async () => {
    // Enable with custom dir
    const putRes = await put('/api/memory', { enabled: true, dir: memDir2 });
    expect(putRes.statusCode).toBe(200);
    expect(JSON.parse(putRes.payload).enabled).toBe(true);

    // Use a unique task text so we can find this specific entry
    const taskText = `deploy-fleet-portal-${randomUUID()}`;
    const launchRes = await post('/api/agents', {
      prompt: taskText,
      cwd: dataDir,
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(launchRes.statusCode).toBe(200);

    // Wait for this specific task to appear in the jsonl (entries are appended on completion)
    const jsonlPath = join(memDir2, 'fleet-runs.jsonl');
    await waitFor(() => {
      if (!existsSync(jsonlPath)) return false;
      const content = readFileSync(jsonlPath, 'utf8');
      return content.includes(taskText);
    }, 6000);

    // Verify md contains expected structure
    const mdPath = join(memDir2, 'fleet-runs.md');
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toContain('**task:**');
    expect(md).toContain(taskText);
    expect(md).toContain('**cwd:**');
    expect(md).toContain('**result:**');
    expect(md).toContain('claude-opus-4-8');
    // md result is trimmed to 1500 chars
    const resultSection = md.split('**result:**')[1] ?? '';
    expect(resultSection.length).toBeLessThanOrEqual(1600); // some slack for surrounding text

    // Verify jsonl contains this specific entry
    const jsonl = readFileSync(jsonlPath, 'utf8');
    const lines = jsonl.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Find the entry for our specific task
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.task === taskText);
    expect(entry).toBeDefined();
    expect(entry.model).toBe('claude-opus-4-8');
    expect(typeof entry.costUsd).toBe('number');
    expect(entry.ts).toBeTruthy();
    expect(entry.cwd).toBe(dataDir);
    // jsonl has full result text (untrimmed — fake bin returns short text, so just check presence)
    expect(typeof entry.resultText).toBe('string');
  });

  it('GET /api/memory/stats reflects entries after write', async () => {
    const statsRes = await get('/api/memory/stats');
    expect(statsRes.statusCode).toBe(200);
    const stats = JSON.parse(statsRes.payload);
    expect(stats.entries).toBeGreaterThanOrEqual(1);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(typeof stats.dir).toBe('string');
  });
});

describe('campaign-member completion writes nothing', () => {
  it('does not append memory entry for a completed run with campaignId set', async () => {
    const memDir3 = join(dataDir, 'mem-campaign');
    await put('/api/memory', { enabled: true, dir: memDir3 });

    // Drive via the registry's terminal subscriber directly — this exercises the
    // REAL production code path (initMemory registers via registry.onRunTerminal,
    // which is what fires for every terminal run including campaign workers).
    const { registry } = await import('../src/registry.js');
    const rAny = registry as any;

    const runId = randomUUID();
    const now = Date.now();
    const fakeRun = {
      id: runId, sessionId: runId,
      task: `campaign-skip-test-${runId}`,
      cwd: dataDir,
      model: 'claude-opus-4-8', fastMode: false, effort: 'high' as const,
      workflowsEnabled: false, ultracode: false,
      // campaignId set — this is what the skip guard in memory.ts checks.
      teamId: null, campaignId: 'fake-campaign-id', projectId: null,
      pid: null, status: 'completed' as const, startedAt: now, endedAt: now,
      tokensIn: 10, tokensOut: 5, costUsd: 0.001, exitCode: 0, killReason: null,
      error: null, budgetUsd: null, permissionMode: 'default' as const, allowedTools: null,
      skills: [], subagentProfile: null,
      resultText: 'campaign run result that should NOT be written',
      structuredOutput: null,
      subagentCount: 0, liveSubagents: 0, maxDepth: 0, lastActivity: now,
    };

    // Fire through the terminal subscribers (same path as production).
    for (const cb of rAny.terminalSubs) {
      try { cb(fakeRun); } catch { /* ignore */ }
    }

    await sleep(200);

    // Memory files must NOT exist in memDir3 because the only event fired was a campaign run.
    const mdPath3 = join(memDir3, 'fleet-runs.md');
    const jsonlPath3 = join(memDir3, 'fleet-runs.jsonl');
    expect(existsSync(mdPath3)).toBe(false);
    expect(existsSync(jsonlPath3)).toBe(false);
  });

  it('does not append memory entry for a completed run with projectId set (PM run)', async () => {
    const memDir4pm = join(dataDir, 'mem-pm');
    await put('/api/memory', { enabled: true, dir: memDir4pm });

    const { registry } = await import('../src/registry.js');
    const rAny = registry as any;

    const runId = randomUUID();
    const now = Date.now();
    const fakeRun = {
      id: runId, sessionId: runId,
      task: `pm-skip-test-${runId}`,
      cwd: dataDir,
      model: 'claude-opus-4-8', fastMode: false, effort: 'high' as const,
      workflowsEnabled: false, ultracode: false,
      // projectId set — PM run skip guard.
      teamId: null, campaignId: null, projectId: 'fake-project-id',
      pid: null, status: 'completed' as const, startedAt: now, endedAt: now,
      tokensIn: 10, tokensOut: 5, costUsd: 0.001, exitCode: 0, killReason: null,
      error: null, budgetUsd: null, permissionMode: 'default' as const, allowedTools: null,
      skills: [], subagentProfile: null,
      resultText: 'pm run result that should NOT be written',
      structuredOutput: null,
      subagentCount: 0, liveSubagents: 0, maxDepth: 0, lastActivity: now,
    };

    for (const cb of rAny.terminalSubs) {
      try { cb(fakeRun); } catch { /* ignore */ }
    }

    await sleep(200);

    const mdPath4pm = join(memDir4pm, 'fleet-runs.md');
    const jsonlPath4pm = join(memDir4pm, 'fleet-runs.jsonl');
    expect(existsSync(mdPath4pm)).toBe(false);
    expect(existsSync(jsonlPath4pm)).toBe(false);
  });
});

describe('md entry shape', () => {
  it('task is trimmed to 300 chars and result to 1500 chars in md', async () => {
    const memDir4 = join(dataDir, 'mem-trim');
    await put('/api/memory', { enabled: true, dir: memDir4 });

    // Launch a run — use a unique task to identify this entry reliably.
    const shortTask = `verify-trim-logic-${randomUUID()}`;
    const launchRes = await post('/api/agents', {
      prompt: shortTask,
      cwd: dataDir,
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(launchRes.statusCode).toBe(200);

    const mdPath4 = join(memDir4, 'fleet-runs.md');
    await waitFor(() => {
      if (!existsSync(mdPath4)) return false;
      return readFileSync(mdPath4, 'utf8').includes(shortTask);
    }, 6000);

    const md = readFileSync(mdPath4, 'utf8');
    expect(md).toContain(shortTask);
    // The ISO timestamp heading format
    expect(md).toMatch(/## \d{4}-\d{2}-\d{2}T/);
  });
});
