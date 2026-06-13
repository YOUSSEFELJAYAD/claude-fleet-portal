/**
 * Real HTTP integration tests for the saved-searches CRUD routes in src/tags.ts
 * (registerTagsRoutes), targeting the previously-uncovered lines 94-144:
 *   GET    /api/saved-searches  — list shape + safeJson decode (incl. corrupt JSON fallback)
 *   POST   /api/saved-searches  — create + the two 400 validation branches
 *   DELETE /api/saved-searches/:id — delete returns {ok:true}
 *
 * Drives the REAL fastify app via buildServer().inject() against an isolated DB,
 * created in a fresh mkdtemp BEFORE any src module is imported.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-tags-'));

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

afterAll(async () => {
  await app?.close();
  try { rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: HOST() });

describe('GET /api/saved-searches — list', () => {
  it('returns an array (empty on a fresh DB)', async () => {
    const res = await get('/api/saved-searches');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json()).toEqual([]);
  });
});

describe('POST /api/saved-searches — validation 400s', () => {
  it('rejects a missing/blank name', async () => {
    const res = await post('/api/saved-searches', { filter: { status: 'done' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'name must be a non-empty string' });
  });

  it('rejects a whitespace-only name (trim → empty)', async () => {
    const res = await post('/api/saved-searches', { name: '   ', filter: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name must be a non-empty string/);
  });

  it('rejects a missing filter (not an object)', async () => {
    const res = await post('/api/saved-searches', { name: 'no-filter' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'filter must be a non-null object' });
  });

  it('rejects a null filter', async () => {
    const res = await post('/api/saved-searches', { name: 'null-filter', filter: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/filter must be a non-null object/);
  });

  it('rejects an array filter (Array.isArray branch)', async () => {
    const res = await post('/api/saved-searches', { name: 'arr-filter', filter: ['a', 'b'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/filter must be a non-null object/);
  });

  it('rejects a primitive filter (typeof !== object branch)', async () => {
    const res = await post('/api/saved-searches', { name: 'str-filter', filter: 'hello' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/filter must be a non-null object/);
  });
});

describe('POST /api/saved-searches — create (happy path)', () => {
  it('persists a search and echoes the parsed body with a uuid + createdAt', async () => {
    const before = Date.now();
    const filter = { status: 'done', model: 'opus', tags: ['x', 'y'] };
    const res = await post('/api/saved-searches', { name: 'My Preset', filter });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.name).toBe('My Preset');
    expect(body.filter).toEqual(filter); // round-trips the object, not the JSON string
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/); // randomUUID shape
    expect(typeof body.createdAt).toBe('number');
    expect(body.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('trims the name before storing it', async () => {
    const res = await post('/api/saved-searches', { name: '  Trimmed  ', filter: { a: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Trimmed');
  });
});

describe('GET /api/saved-searches — list after create + safeJson decode', () => {
  it('returns created searches newest-first with the filter decoded back to an object', async () => {
    const created = (await post('/api/saved-searches', {
      name: 'List Check',
      filter: { kind: 'list-check' },
    })).json();

    const list = (await get('/api/saved-searches')).json();
    expect(Array.isArray(list)).toBe(true);
    const found = list.find((s: any) => s.id === created.id);
    expect(found).toBeTruthy();
    expect(found.name).toBe('List Check');
    expect(found.filter).toEqual({ kind: 'list-check' }); // safeJson parsed the stored TEXT
    expect(typeof found.createdAt).toBe('number');

    // ORDER BY created_at DESC → results are non-increasing by createdAt
    const stamps = list.map((s: any) => s.createdAt);
    const sorted = [...stamps].sort((a, b) => b - a);
    expect(stamps).toEqual(sorted);
  });

  it('falls back to {} when a stored filter is not valid JSON (safeJson catch)', async () => {
    // Write a corrupt filter directly into the shared sqlite handle, bypassing the
    // route's JSON.stringify, to exercise the safeJson() catch branch on read.
    const dbMod: any = await import('../src/db.js');
    const rawDb = dbMod.default;
    const id = 'corrupt-filter-' + Date.now();
    rawDb
      .prepare('INSERT INTO saved_searches (id, name, filter, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'Corrupt', '{not valid json', Date.now());

    const list = (await get('/api/saved-searches')).json();
    const found = list.find((s: any) => s.id === id);
    expect(found).toBeTruthy();
    expect(found.filter).toEqual({}); // catch → {}
  });
});

describe('DELETE /api/saved-searches/:id', () => {
  it('removes a saved search and returns {ok:true}', async () => {
    const created = (await post('/api/saved-searches', {
      name: 'To Delete',
      filter: { tmp: true },
    })).json();

    // present before delete
    let list = (await get('/api/saved-searches')).json();
    expect(list.some((s: any) => s.id === created.id)).toBe(true);

    const res = await del('/api/saved-searches/' + created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // gone after delete
    list = (await get('/api/saved-searches')).json();
    expect(list.some((s: any) => s.id === created.id)).toBe(false);
  });

  it('is a no-op (still {ok:true}) for an unknown id', async () => {
    const res = await del('/api/saved-searches/does-not-exist-id');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
