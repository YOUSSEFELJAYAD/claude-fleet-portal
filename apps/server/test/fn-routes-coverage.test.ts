/**
 * Real HTTP integration tests for the route registrars that no other test exercised:
 *   registerMetricsRoutes  — GET /api/metrics
 *   registerScoreRoutes    — /api/agents/:id/scores (+ summary, delete)
 *   registerTagsRoutes     — /api/agents/:id/tags, /api/tags, /api/saved-searches
 *   registerExportRoutes   — /api/agents/export.csv, /api/agents/:id/export
 *   registerMcpRoutes      — GET /api/mcp (always 200; failure surfaced in body)
 * Drives the REAL fastify app via buildServer().inject() against an isolated DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-routes-'));
// Point the MCP route at a binary that does not exist, so `claude mcp list` fails
// FAST with ENOENT (deterministic) instead of shelling out to a real, possibly-slow claude.
process.env.CLAUDE_REAL_BIN = '/nonexistent/fleet-fake-claude-xyz';

let app: any;
let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` }); // satisfy the H3 host allowlist

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: HOST() });

describe('registerMetricsRoutes — GET /api/metrics', () => {
  it('returns the full aggregate shape, zeroed on an empty DB', async () => {
    const res = await get('/api/metrics');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toHaveProperty('totals');
    expect(b).toHaveProperty('byModel');
    expect(b).toHaveProperty('byEffort');
    expect(b).toHaveProperty('statusCounts');
    expect(b).toHaveProperty('durations');
    expect(b).toHaveProperty('dailySpend');
    expect(b.totals.runs).toBe(0);
    expect(b.totals.costUsd).toBe(0);
  });
  it('accepts a since= window without error', async () => {
    const res = await get('/api/metrics?since=' + (Date.now() - 86_400_000));
    expect(res.statusCode).toBe(200);
  });
});

describe('registerScoreRoutes — /api/agents/:id/scores', () => {
  it('lists empty for an unknown run and validates the POST body', async () => {
    expect((await get('/api/agents/run-x/scores')).json()).toEqual([]);
    expect((await post('/api/agents/run-x/scores', { name: 'q' })).statusCode).toBe(400); // missing value
    expect((await post('/api/agents/run-x/scores', { value: 5 })).statusCode).toBe(400);  // missing name
  });
  it('round-trips a human score: create → list → delete', async () => {
    const created = await post('/api/agents/run-y/scores', { name: 'quality', value: 4, comment: 'ok' });
    expect(created.statusCode).toBe(200);
    const score = created.json();
    expect(score.value).toBe(4);
    expect(score.source).toBe('human');

    const listed = (await get('/api/agents/run-y/scores')).json();
    expect(listed.map((s: any) => s.id)).toContain(score.id);

    expect((await del('/api/scores/' + score.id)).json()).toEqual({ ok: true });
    expect((await get('/api/agents/run-y/scores')).json()).toEqual([]);
  });
  it('exposes a summary endpoint', async () => {
    const res = await get('/api/scores/summary');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('registerTagsRoutes — tags + saved searches', () => {
  it('round-trips a per-run tag (normalized lowercase) and rejects an empty tag', async () => {
    expect((await post('/api/agents/run-t/tags', { tag: '   ' })).statusCode).toBe(400);
    const added = await post('/api/agents/run-t/tags', { tag: '  Flaky  ' });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toContain('flaky'); // normalized lower-case

    // per-run listing reflects it immediately…
    expect((await get('/api/agents/run-t/tags')).json()).toContain('flaky');
    // …and the global /api/tags aggregate is a well-formed array (it JOINs real runs,
    // so a tag on a non-persisted run id legitimately does not surface there).
    const all = (await get('/api/tags')).json();
    expect(Array.isArray(all)).toBe(true);

    await del('/api/agents/run-t/tags/flaky');
    expect((await get('/api/agents/run-t/tags')).json()).toEqual([]);
  });
  it('lists saved searches (array)', async () => {
    const res = await get('/api/saved-searches');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('registerExportRoutes — CSV + per-run export', () => {
  it('serves a CSV attachment for the history export', async () => {
    const res = await get('/api/agents/export.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('fleet-history.csv');
    expect(typeof res.body).toBe('string');
  });
  it('404s exporting an unknown run', async () => {
    const res = await get('/api/agents/does-not-exist/export?format=json');
    expect(res.statusCode).toBe(404);
  });
});

describe('registerMcpRoutes — GET /api/mcp', () => {
  it('always returns 200 with a servers array; a missing binary surfaces as an error string', async () => {
    const res = await get('/api/mcp');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(Array.isArray(b.servers)).toBe(true);
    expect(b.servers).toEqual([]);
    expect(typeof b.error).toBe('string'); // CLAUDE_REAL_BIN points at a nonexistent path
    expect(b.error).toContain('not found');
  });
  it('400s an over-long server name via the handler guard (maxParamLength raised to 256)', async () => {
    // 201 chars now reaches the handler (maxParamLength: 256) → its own >200 guard returns 400
    expect((await get('/api/mcp/' + 'x'.repeat(201))).statusCode).toBe(400);
    // beyond maxParamLength fastify still 404s the route before the handler
    expect((await get('/api/mcp/' + 'x'.repeat(300))).statusCode).toBe(404);
  });
});
