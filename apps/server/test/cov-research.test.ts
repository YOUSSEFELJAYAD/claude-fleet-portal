/**
 * Coverage test for src/research.ts targeting the previously-uncovered branches:
 *   31-32   isHttpUrl catch — a URL that throws in `new URL()` returns false (drop the row)
 *   71-72   searchWeb — SearXNG returns a 200 with a NON-JSON body → 502 hint
 *   146-160 POST /api/research/search — query validation (400), success, and upstream error (502)
 *   185     POST /api/research/synthesize — registry.launch rejects → propagated error code
 *   190-205 GET /api/research/status — ok / json-403 / non-ok / unreachable branches
 *
 * Pattern mirrors test/research.test.ts: a fake SearXNG over node:http, registry+addons
 * vi.mock'd, and the routes driven through a plain Fastify().inject() (no DB needed).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { searchWeb, buildResearchPrompt } from '../src/research.js';

// ── a fake SearXNG whose behaviour is switched per-test via `mode` ──
type Mode = 'ok' | 'json-403' | 'non-json' | 'err500' | 'empty';
let server: Server;
let baseUrl = '';
let mode: Mode = 'ok';

beforeEach(async () => {
  mode = 'ok';
  server = createServer((req, res) => {
    if (mode === 'json-403') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html>json disabled</html>');
      return;
    }
    if (mode === 'err500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    if (mode === 'non-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>this is not json</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'empty') {
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    res.end(JSON.stringify({
      results: [
        { title: 'A', url: 'https://a.example', content: 'snippet a', score: 1.5, engine: 'google' },
        // a result whose URL THROWS in `new URL()` (no scheme/host) → isHttpUrl catch (31-32)
        { title: 'Bad', url: 'http://[::bad::]', content: 'malformed', engine: 'x' },
      ],
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

// ── line 31-32: isHttpUrl catch, reached through searchWeb's filter ──
describe('searchWeb — isHttpUrl catch (31-32)', () => {
  it('drops a row whose URL throws in new URL() (not just wrong protocol)', async () => {
    const out = await searchWeb({ searxngUrl: baseUrl, query: 'q', maxResults: 10 });
    // only the valid https row survives; the malformed-URL row is filtered out
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://a.example');
    expect(out.some((r) => r.url === 'http://[::bad::]')).toBe(false);
  });

  it('buildResearchPrompt also drops a row whose URL throws (defense in depth)', () => {
    const p = buildResearchPrompt('t', [
      { title: 'bad', url: 'http://[::bad::]', snippet: 's', score: 0, engine: 'g' },
      { title: 'ok', url: 'https://ok.example', snippet: 's', score: 0, engine: 'g' },
    ]);
    expect(p).not.toContain('[::bad::]');
    expect(p).toContain('https://ok.example');
  });
});

// ── line 71-72: a 200 response that is not parseable JSON ──
describe('searchWeb — non-JSON body (71-72)', () => {
  it('throws a 502 with the "non-JSON body" hint when r.json() throws', async () => {
    mode = 'non-json';
    await expect(searchWeb({ searxngUrl: baseUrl, query: 'q' }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('non-JSON') });
  });

  it('throws a 502 with the json-disabled hint on a 403 (63-64)', async () => {
    mode = 'json-403';
    await expect(searchWeb({ searxngUrl: baseUrl, query: 'q' }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('403') });
  });

  it('throws a 502 "unreachable" when fetch itself rejects (58)', async () => {
    // port 1 refuses → fetch throws → the catch wraps it as an unreachable 502
    await expect(searchWeb({ searxngUrl: 'http://127.0.0.1:1', query: 'q' }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('unreachable') });
  });
});

// ── the HTTP routes (146-160, 185, 190-205) ──
// researchConfig is mocked to point at the live fake SearXNG; registry.launch is a spy
// we can make resolve or reject per-test via mockResolvedValueOnce / mockRejectedValueOnce.
const launch = vi.fn(async () => ({ id: 'run-xyz' }));
vi.mock('../src/registry.js', () => ({ registry: { get launch() { return launch; } } }));
vi.mock('../src/addons.js', () => ({
  researchConfig: () => ({ searxngUrl: baseUrl, engines: 'google', maxResults: 4, safeSearch: 1, language: 'en' }),
}));

async function makeApp() {
  const { registerResearchRoutes } = await import('../src/research.js');
  const app = Fastify();
  registerResearchRoutes(app);
  await app.ready();
  return app;
}

describe('POST /api/research/search (146-160)', () => {
  it('400s when query is missing/blank', async () => {
    const app = await makeApp();
    const res1 = await app.inject({ method: 'POST', url: '/api/research/search', payload: {} });
    expect(res1.statusCode).toBe(400);
    expect(res1.json()).toEqual({ error: 'query is required' });
    const res2 = await app.inject({ method: 'POST', url: '/api/research/search', payload: { query: '   ' } });
    expect(res2.statusCode).toBe(400);
    await app.close();
  });

  it('returns normalized results from the configured SearXNG on success', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/research/search', payload: { query: '  widgets  ' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.query).toBe('widgets'); // trimmed
    // the malformed-URL row is filtered; only the https row remains
    expect(body.results).toHaveLength(1);
    expect(body.results[0].url).toBe('https://a.example');
    await app.close();
  });

  it('surfaces an upstream SearXNG failure as the thrown statusCode (502)', async () => {
    mode = 'err500';
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/research/search', payload: { query: 'q' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('SearXNG error 500');
    await app.close();
  });
});

describe('POST /api/research/synthesize — launch error path (185)', () => {
  it('returns the error statusCode/message when registry.launch rejects', async () => {
    launch.mockRejectedValueOnce(Object.assign(new Error('over capacity'), { statusCode: 503 }));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/research/synthesize',
      payload: { topic: 'widgets', results: [{ title: 'A', url: 'https://a.example', snippet: 's', score: 1, engine: 'g' }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'over capacity' });
    await app.close();
  });

  it('falls back to 500 when the rejection carries no statusCode', async () => {
    launch.mockRejectedValueOnce(new Error('kaboom'));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/research/synthesize',
      payload: { topic: 'x', results: [] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'kaboom' });
    await app.close();
  });

  it('400s on a blank topic and returns the launched runId on success (167-168, 183)', async () => {
    const app = await makeApp();
    const bad = await app.inject({ method: 'POST', url: '/api/research/synthesize', payload: { topic: '   ', results: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'topic is required' });

    launch.mockResolvedValueOnce({ id: 'run-ok' });
    const ok = await app.inject({
      method: 'POST', url: '/api/research/synthesize',
      payload: { topic: 'widgets', results: [{ title: 'A', url: 'https://a.example', snippet: 's', score: 1, engine: 'g' }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ runId: 'run-ok' });
    await app.close();
  });
});

describe('GET /api/research/status (190-205)', () => {
  it('reports ok when SearXNG answers 200 with JSON', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/research/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, searxngUrl: baseUrl, state: 'ok', detail: null });
    await app.close();
  });

  it('reports json-disabled on a 403', async () => {
    mode = 'json-403';
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/research/status' });
    const b = res.json();
    expect(b.ok).toBe(false);
    expect(b.state).toBe('json-disabled');
    expect(b.detail).toContain('json');
    await app.close();
  });

  it('reports unreachable on a non-ok status', async () => {
    mode = 'err500';
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/research/status' });
    const b = res.json();
    expect(b.ok).toBe(false);
    expect(b.state).toBe('unreachable');
    expect(b.detail).toContain('500');
    await app.close();
  });

  it('reports unreachable when the fetch throws (server down)', async () => {
    // close the fake server so the status probe's fetch rejects → catch branch (203-205)
    await new Promise<void>((r) => server.close(() => r()));
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/research/status' });
    const b = res.json();
    expect(b.ok).toBe(false);
    expect(b.state).toBe('unreachable');
    expect(b.detail).toContain('not reachable');
    await app.close();
    // re-open so afterEach's close() resolves cleanly
    server = createServer((_q, s) => { s.writeHead(200); s.end('{}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
});
