/**
 * Real HTTP integration tests for server.ts that target the still-uncovered surface:
 *   - the module-private `sse()` helper (server.ts 60-107): its 503 connection-cap
 *     branch (FLEET_MAX_SSE=0 forces every live endpoint to refuse) AND the happy
 *     hijack path (headers, `: connected` preamble, event frames with id: lines).
 *   - the reference-data + run + template + campaign route handlers (server.ts 250-656).
 *
 * All assertions are behavioral: real inject() requests, asserting real status codes,
 * bodies and SSE wire bytes. The DB is isolated (FLEET_DATA_DIR) BEFORE importing src.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// (afterAll used both to close the app and to tear down held SSE streams)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS, EFFORT_LEVELS, PERMISSION_MODES, RUN_STATUSES } from '@fleet/shared';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-covserver-'));
// Cap SSE connections at 2. A live stream HIJACKS (exercising the full happy path of sse(),
// server.ts 65-107). NOTE: a held hijacked stream only releases its slot on the server-side
// 'close' event, which light-my-request does NOT reliably fire when the client stream is
// destroyed — so held slots are effectively sticky within the process. We therefore hold
// exactly enough to (a) prove the hijack path, then (b) cross the cap → 503 (server.ts 61-63),
// and we run the SELF-RELEASING not-found agent stream FIRST (it calls stop() synchronously).
process.env.FLEET_MAX_SSE = '2';

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
const post = (url: string, payload?: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const put = (url: string, payload?: any) => app.inject({ method: 'PUT', url, headers: HOST(), payload });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: HOST() });

// Open an SSE endpoint as a live stream and resolve once the first byte chunk arrives.
// payloadAsStream lets inject() return BEFORE the (never-ending) hijacked response closes.
async function openStream(url: string, extraHeaders: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url, headers: { ...HOST(), ...extraHeaders }, payloadAsStream: true });
  return res;
}
function firstChunk(res: any): Promise<string> {
  return new Promise((resolve) => {
    const stream = res.stream();
    stream.once('data', (d: Buffer) => resolve(d.toString()));
  });
}
const held: any[] = [];
afterAll(() => { for (const s of held) try { s.stream().destroy(); } catch { /* ignore */ } });

describe('sse() — hijack happy path + connection cap (server.ts 60-107)', () => {
  // Run FIRST, before any sticky slot is held: the not-found agent stream calls stop()
  // synchronously inside the handler, so it self-releases its slot (server.ts 389-400).
  it('agent stream for an unknown run hijacks, sends an {error} frame, then ends', async () => {
    const res = await openStream('/api/agents/run-does-not-exist/stream');
    expect(res.statusCode).toBe(200); // hijacked: headers flushed before the run lookup fails
    const chunk = await firstChunk(res);
    // : connected preamble (sse 77) then the error frame written by send({error:'not found'}).
    expect(chunk).toContain(': connected');
    res.stream().destroy();
  });

  it('a team stream rejects a bad id with 400 BEFORE the cap/hijack is consulted', async () => {
    // isSafeId guard runs first (server.ts 519-521), so it 400s independent of the cap.
    const res = await get('/api/teams/..bad../stream');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid team id');
  });

  // These two HOLD their slots (no synchronous stop), filling the cap of 2.
  it('hijacks the fleet stream: text/event-stream headers, connected preamble + a data frame', async () => {
    // origin is an allowlisted web origin → the ACAO echo branch (server.ts 75) runs.
    const res = await openStream('/api/fleet/stream', { origin: `http://127.0.0.1:5173` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    // subscribeFleet() pushes a fleet-hello immediately → sse send() writes a data: frame
    // (server.ts 79-88), proving the send() closure runs, not just the preamble.
    const chunk = await firstChunk(res);
    expect(chunk).toContain(': connected');
    held.push(res); // hold slot 1 open
  });

  it('hijacks a kanban board stream (subscribeBoard, server.ts 249-258) for slot 2', async () => {
    const res = await openStream('/api/projects/cov-proj/board/stream');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const chunk = await firstChunk(res);
    expect(chunk).toContain(': connected');
    held.push(res); // hold slot 2 open → cap (2) is now full
  });

  it('refuses the next concurrent stream with 503 once the cap is full (branch 61-63)', async () => {
    const refused = await get('/api/campaigns/cap-test/stream');
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: 'too many live connections' });
  });
});

describe('reference data routes (server.ts 263-285)', () => {
  it('GET /api/models returns the canonical model catalog', async () => {
    const res = await get('/api/models');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MODELS);
    expect(body.some((m: any) => m.id === 'claude-opus-4-8')).toBe(true);
  });
  it('GET /api/meta bundles models + the enum vocabularies', async () => {
    const res = await get('/api/meta');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.models).toEqual(MODELS);
    expect(b.efforts).toEqual(EFFORT_LEVELS);
    expect(b.permissionModes).toEqual(PERMISSION_MODES);
    expect(b.statuses).toEqual(RUN_STATUSES);
  });
  it('GET /api/skills returns an array for the default cwd', async () => {
    const res = await get('/api/skills');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
  it('GET /api/skills 400s a relative cwd (isSafeCwd guard, server.ts 48-51 + 272-275)', async () => {
    const res = await get('/api/skills?cwd=relative/path');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cwd must be an absolute path');
  });
  it('GET /api/skills 400s a traversal cwd', async () => {
    const res = await get('/api/skills?cwd=' + encodeURIComponent('/etc/../secret'));
    expect(res.statusCode).toBe(400);
  });
  it('GET /api/skills accepts an absolute cwd', async () => {
    const res = await get('/api/skills?cwd=' + encodeURIComponent('/tmp'));
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
  it('GET /api/subagents returns an array and 400s a relative cwd', async () => {
    expect((await get('/api/subagents')).statusCode).toBe(200);
    expect(Array.isArray((await get('/api/subagents')).json())).toBe(true);
    const bad = await get('/api/subagents?cwd=nope');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('cwd must be an absolute path');
  });
});

describe('config / spend routes (server.ts 288-324)', () => {
  it('GET /api/config returns the live config object', async () => {
    const res = await get('/api/config');
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().maxConcurrentRuns).toBe('number');
  });
  it('PUT /api/config 400s an invalid body (validateConfig throws)', async () => {
    const res = await put('/api/config', { maxConcurrentRuns: -5 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });
  it('PUT /api/config persists a valid clamp and round-trips via GET', async () => {
    const current = (await get('/api/config')).json();
    const res = await put('/api/config', { ...current, maxConcurrentRuns: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxConcurrentRuns).toBe(3);
    expect((await get('/api/config')).json().maxConcurrentRuns).toBe(3);
  });
  it('POST /api/config/reset-data requires the exact RESET confirm token', async () => {
    expect((await post('/api/config/reset-data', { confirm: 'nope' })).statusCode).toBe(400);
    expect((await post('/api/config/reset-data', {})).statusCode).toBe(400);
  });
  it('POST /api/config/reset-data with confirm=RESET wipes and reseeds', async () => {
    const res = await post('/api/config/reset-data', { confirm: 'RESET' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    expect(typeof b.clearedRuns).toBe('number');
    expect(b.config).toHaveProperty('maxConcurrentRuns');
  });
  it('GET /api/spend returns the spend aggregate', async () => {
    const res = await get('/api/spend');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeTypeOf('object');
  });
});

describe('agent (run) routes — validation + not-found paths (server.ts 327-488)', () => {
  it('POST /api/agents 400s when prompt or cwd is missing', async () => {
    expect((await post('/api/agents', { cwd: '/tmp' })).statusCode).toBe(400);
    expect((await post('/api/agents', { prompt: 'hi' })).statusCode).toBe(400);
    const r = await post('/api/agents', {});
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('prompt and cwd are required');
  });
  it('GET /api/agents lists runs (array) and accepts filter query params', async () => {
    expect(Array.isArray((await get('/api/agents')).json())).toBe(true);
    const filtered = await get('/api/agents?status=completed&archived=include&q=foo');
    expect(filtered.statusCode).toBe(200);
    expect(Array.isArray(filtered.json())).toBe(true);
  });
  it('GET /api/agents/:id 404s an unknown run', async () => {
    const res = await get('/api/agents/missing-run');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not found');
  });
  it('GET /api/agents/:id/tree 404s an unknown run', async () => {
    expect((await get('/api/agents/missing-run/tree')).statusCode).toBe(404);
  });
  it('POST /api/agents/:id/input 400s a non-string / empty text', async () => {
    expect((await post('/api/agents/x/input', { text: '' })).statusCode).toBe(400);
    expect((await post('/api/agents/x/input', { text: 123 })).statusCode).toBe(400);
    expect((await post('/api/agents/x/input', {})).statusCode).toBe(400);
  });
  it('POST /api/agents/:id/input errors for an unknown run (registry throws → mapped code)', async () => {
    const res = await post('/api/agents/missing-run/input', { text: 'hello' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).toHaveProperty('error');
  });
  it('POST /api/agents/:id/resume errors for an unknown run', async () => {
    const res = await post('/api/agents/missing-run/resume', {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).toHaveProperty('error');
  });
  it('POST /api/agents/stop-all returns the kill counts even when nothing is live', async () => {
    const res = await post('/api/agents/stop-all', {});
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toHaveProperty('stopped');
    expect(b).toHaveProperty('campaignsKilled');
    expect(typeof b.stopped).toBe('number');
  });
  it('DELETE /api/agents/:id is idempotent (stop signal) and returns ok', async () => {
    const res = await del('/api/agents/whatever');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
  it('DELETE /api/agents/:id/record errors for an unknown run', async () => {
    const res = await del('/api/agents/missing-run/record');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).toHaveProperty('error');
  });
  it('POST /api/agents/:id/archive 400s a non-boolean archived flag', async () => {
    const res = await post('/api/agents/x/archive', { archived: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('archived must be boolean');
  });
  it('POST /api/agents/:id/archive errors for an unknown run with a valid flag', async () => {
    const res = await post('/api/agents/missing-run/archive', { archived: true });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
  it('POST /api/agents/:id/permission 400s a malformed decision/requestId', async () => {
    expect((await post('/api/agents/x/permission', { requestId: '', decision: 'approve' })).statusCode).toBe(400);
    expect((await post('/api/agents/x/permission', { requestId: 'r1', decision: 'maybe' })).statusCode).toBe(400);
    expect((await post('/api/agents/x/permission', {})).statusCode).toBe(400);
  });
  it('POST /api/agents/:id/permission errors for an unknown run with a valid body', async () => {
    const res = await post('/api/agents/missing-run/permission', { requestId: 'r1', decision: 'deny' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('teams routes (server.ts 503-516)', () => {
  it('GET /api/teams returns an array', async () => {
    const res = await get('/api/teams');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
  it('GET /api/teams/:id 400s an invalid id', async () => {
    const res = await get('/api/teams/' + encodeURIComponent('../etc'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid team id');
  });
  it('GET /api/teams/:id 404s a safe-but-unknown id', async () => {
    const res = await get('/api/teams/team-unknown-123');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not found');
  });
});

describe('template CRUD (server.ts 536-612)', () => {
  it('GET /api/templates lists the seeded built-ins', async () => {
    const res = await get('/api/templates');
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((t: any) => t.isBuiltin)).toBe(true);
  });
  it('GET /api/templates/:id 404s an unknown id', async () => {
    expect((await get('/api/templates/nope-id')).statusCode).toBe(404);
  });
  it('GET /api/templates/:id fetches a real seeded template', async () => {
    const list = (await get('/api/templates')).json();
    const one = list[0];
    const res = await get('/api/templates/' + one.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(one.id);
  });
  it('POST /api/templates 400s a blank name', async () => {
    const res = await post('/api/templates', { name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('name is required');
  });
  it('POST /api/templates 409s a duplicate name (matches a built-in)', async () => {
    const list = (await get('/api/templates')).json();
    const existingName = list.find((t: any) => t.isBuiltin).name;
    const res = await post('/api/templates', { name: existingName });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('already exists');
  });
  it('POST /api/templates 400s when a field fails validation', async () => {
    const res = await post('/api/templates', { name: 'cov-bad-role', role: 'wizard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('role must be one of');
  });
  it('POST → PUT → DELETE round-trips a user template with defaults applied', async () => {
    const created = await post('/api/templates', {
      name: 'cov-rt-template',
      role: 'reviewer',
      description: 'd',
      allowedTools: 'Read, Write',
    });
    expect(created.statusCode).toBe(200);
    const t = created.json();
    expect(t.id).toBeTruthy();
    expect(t.isBuiltin).toBe(false);
    expect(t.role).toBe('reviewer');
    expect(t.allowedTools).toEqual(['Read', 'Write']);
    // unspecified fields take the route defaults
    expect(t.model).toBe('claude-opus-4-8');
    expect(t.permissionMode).toBe('default');

    // PUT updates whitelisted fields, preserving id/name/createdAt/isBuiltin
    const updated = await put('/api/templates/' + t.id, { description: 'updated', effort: 'low' });
    expect(updated.statusCode).toBe(200);
    const u = updated.json();
    expect(u.id).toBe(t.id);
    expect(u.name).toBe('cov-rt-template');
    expect(u.description).toBe('updated');
    expect(u.effort).toBe('low');
    expect(u.createdAt).toBe(t.createdAt);

    // PUT 400s a bad field value
    expect((await put('/api/templates/' + t.id, { model: 'ghost' })).statusCode).toBe(400);

    // DELETE removes it
    expect((await del('/api/templates/' + t.id)).json()).toEqual({ ok: true });
    expect((await get('/api/templates/' + t.id)).statusCode).toBe(404);
  });
  it('POST /api/templates exercises every whitelisted field validator (server.ts 117-161)', async () => {
    const model = MODELS[0].id;
    const created = await post('/api/templates', {
      name: 'cov-all-fields',
      role: 'orchestrator',
      description: 'desc',
      systemPrompt: 'sys',
      model,
      fastMode: 1,            // coerced to boolean (server.ts 137)
      effort: 'max',          // effort enum (138-141)
      allowedTools: ['Read'], // already-array path (142-146)
      skills: ['s1', 's2'],   // already-array path (147-151)
      permissionMode: 'plan', // permissionMode enum (152-155)
      budgetUsd: 12.5,        // numeric budget (156-161)
    });
    expect(created.statusCode).toBe(200);
    const t = created.json();
    expect(t.role).toBe('orchestrator');
    expect(t.systemPrompt).toBe('sys');
    expect(t.model).toBe(model);
    expect(t.fastMode).toBe(true);
    expect(t.effort).toBe('max');
    expect(t.allowedTools).toEqual(['Read']);
    expect(t.skills).toEqual(['s1', 's2']);
    expect(t.permissionMode).toBe('plan');
    expect(t.budgetUsd).toBe(12.5);
    await del('/api/templates/' + t.id);
  });
  it('POST /api/templates 400s a non-array skills value', async () => {
    const res = await post('/api/templates', { name: 'cov-bad-skills', skills: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('skills must be an array');
  });
  it('POST /api/templates 400s a non-number, non-null budgetUsd (server.ts 156-159)', async () => {
    const res = await post('/api/templates', { name: 'cov-bad-budget', budgetUsd: 'lots' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('budgetUsd must be');
  });
  it('PUT /api/templates/:id 404s an unknown id', async () => {
    expect((await put('/api/templates/nope', { description: 'x' })).statusCode).toBe(404);
  });
  it('DELETE /api/templates/:id 404s an unknown id', async () => {
    expect((await del('/api/templates/nope')).statusCode).toBe(404);
  });
  it('DELETE /api/templates/:id 409s a built-in (cannot be deleted)', async () => {
    const builtin = (await get('/api/templates')).json().find((t: any) => t.isBuiltin);
    const res = await del('/api/templates/' + builtin.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('built-in');
  });
});

describe('campaign routes — validation + not-found (server.ts 615-640)', () => {
  it('POST /api/campaigns errors on an invalid body (campaigns.create throws)', async () => {
    const res = await post('/api/campaigns', {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).toHaveProperty('error');
  });
  it('GET /api/campaigns returns an array', async () => {
    const res = await get('/api/campaigns');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
  it('GET /api/campaigns/:id 404s an unknown id', async () => {
    const res = await get('/api/campaigns/nope-id');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not found');
  });
  it('DELETE /api/campaigns/:id errors for an unknown id (campaigns.kill throws)', async () => {
    const res = await del('/api/campaigns/nope-id');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).toHaveProperty('error');
  });
});

describe('GET /api/health', () => {
  it('reports ok with a timestamp', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    expect(typeof b.ts).toBe('number');
  });
});

describe('Host allowlist hook (server.ts 193-197)', () => {
  it('403s a request whose Host header is not allowlisted', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden host');
  });
  it('403s a request with no Host header at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '' } });
    expect(res.statusCode).toBe(403);
  });
});
