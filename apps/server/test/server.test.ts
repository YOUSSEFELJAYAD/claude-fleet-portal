import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-srv-'));

let app: any;
let PORT: number;
let WEB_PORT: number;

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  WEB_PORT = cfg.WEB_PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('control-plane hardening (H3) — DNS-rebinding + CORS scoping', () => {
  it('rejects a non-allowlisted Host header with 403 (rebinding guard)', async () => {
    const evil = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'attacker.com' } });
    expect(evil.statusCode).toBe(403);
  });

  it('accepts the localhost Host', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { host: `127.0.0.1:${PORT}` } });
    expect(ok.statusCode).toBe(200);
  });

  it('does not reflect a foreign Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('reflects the local web-app Origin', async () => {
    const origin = `http://127.0.0.1:${WEB_PORT}`;
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: `127.0.0.1:${PORT}`, origin },
    });
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });
});

describe('config + body validation (H9)', () => {
  const H = () => ({ host: `127.0.0.1:${PORT}` });

  it('rejects maxConcurrentRuns < 1 (would deadlock all launches)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 0 } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-positive / non-numeric budgets (would disable the ceiling)', async () => {
    for (const payload of [{ defaultBudgetUsd: 0 }, { defaultBudgetUsd: -1 }, { ultracodeBudgetUsd: 'x' as any }, { defaultBudgetUsd: NaN }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('accepts a partial valid config and merges defaults (no undefined ceilings)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 4 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxConcurrentRuns).toBe(4);
    expect(body.subagentTotalCeiling).toBe(1000); // default merged, not undefined
    expect(body.defaultBudgetUsd).toBeGreaterThan(0); // default merged
  });

  it('rejects empty /input text and a bad /permission decision before reaching the run', async () => {
    const badInput = await app.inject({ method: 'POST', url: '/api/agents/nope/input', headers: H(), payload: { text: '' } });
    expect(badInput.statusCode).toBe(400);
    const badPerm = await app.inject({ method: 'POST', url: '/api/agents/nope/permission', headers: H(), payload: { requestId: 'r', decision: 'maybe' } });
    expect(badPerm.statusCode).toBe(400);
  });
});

describe('path-traversal guards (H21)', () => {
  const H = () => ({ host: `127.0.0.1:${PORT}` });

  it('rejects a team id containing ".." with 400 (no arbitrary file read)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/teams/a..b', headers: H() });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-absolute / traversing cwd on /api/skills with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills?cwd=' + encodeURIComponent('../../etc'), headers: H() });
    expect(res.statusCode).toBe(400);
  });

  it('still serves a normal absolute cwd on /api/skills', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills?cwd=' + encodeURIComponent('/tmp'), headers: H() });
    expect(res.statusCode).toBe(200);
  });
});

describe('config ↔ fleet deadlock guard (residual H9 path — DC §10)', () => {
  const H = () => ({ host: `127.0.0.1:${PORT}` });

  beforeAll(async () => {
    // Normalize cap first (an earlier H9 test leaves it at 4), THEN raise the fleet reserve —
    // the /api/fleet/config guard itself requires reserve < cap at PUT time.
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 8 } });
    const res = await app.inject({ method: 'PUT', url: '/api/fleet/config', headers: H(), payload: { reserveSlotsForNonPm: 4 } });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.inject({ method: 'PUT', url: '/api/fleet/config', headers: H(), payload: { reserveSlotsForNonPm: 0 } });
    await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 8 } });
  });

  it('rejects lowering maxConcurrentRuns TO the fleet reserve (PM pool would be 0) and leaves config unchanged', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 4 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('reserveSlotsForNonPm'); // names the remedy, not a generic 400
    const cfg = await app.inject({ method: 'GET', url: '/api/config', headers: H() });
    expect(cfg.json().maxConcurrentRuns).toBe(8); // rejected PUT must not have applied
  });

  it('rejects lowering maxConcurrentRuns BELOW the fleet reserve', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 3 } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a cap strictly above the reserve', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: H(), payload: { maxConcurrentRuns: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxConcurrentRuns).toBe(5);
  });
});
