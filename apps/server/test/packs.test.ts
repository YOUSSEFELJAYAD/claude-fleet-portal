import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-packs-'));

let app: any;
let PORT: number;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H() });

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

describe('tool/skill packs CRUD (§23)', () => {
  let webDevId: string;

  it('starts empty', async () => {
    const res = await get('/api/packs');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('creates a pack — entries trimmed, deduped, blanks dropped', async () => {
    const res = await post('/api/packs', {
      name: '  web-dev  ',
      description: 'frontend work',
      tools: ['Read', ' Edit ', 'Bash(npm *)', 'Read', '  '],
      skills: ['frontend-design', 'frontend-design'],
    });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.name).toBe('web-dev');
    expect(p.tools).toEqual(['Read', 'Edit', 'Bash(npm *)']);
    expect(p.skills).toEqual(['frontend-design']);
    expect(p.id).toBeTruthy();
    webDevId = p.id;
  });

  it('refuses a duplicate name with 409', async () => {
    const res = await post('/api/packs', { name: 'web-dev' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('duplicate-name');
  });

  it.each([
    [{}, /name/],
    [{ name: '' }, /name/],
    [{ name: 'x'.repeat(61) }, /60/],
    [{ name: 'ok', tools: 'Read' }, /tools/],
    [{ name: 'ok', tools: [42] }, /tools/],
    [{ name: 'ok', skills: [{ a: 1 }] }, /skills/],
    [{ name: 'ok', tools: ['y'.repeat(121)] }, /120/],
  ])('rejects invalid input %j', async (body, msgRe) => {
    const res = await post('/api/packs', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(msgRe);
  });

  it('lists packs in case-insensitive name order', async () => {
    await post('/api/packs', { name: 'Auditor', tools: ['Read', 'Grep', 'Glob'] });
    const res = await get('/api/packs');
    expect(res.json().map((p: any) => p.name)).toEqual(['Auditor', 'web-dev']);
  });

  it('partial PUT updates only the sent fields', async () => {
    const res = await put(`/api/packs/${webDevId}`, { tools: ['Read', 'Edit', 'Write'] });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.tools).toEqual(['Read', 'Edit', 'Write']);
    expect(p.skills).toEqual(['frontend-design']); // untouched
    expect(p.name).toBe('web-dev'); // untouched
  });

  it('rename onto an existing name → 409; rename to a fresh name works', async () => {
    expect((await put(`/api/packs/${webDevId}`, { name: 'Auditor' })).statusCode).toBe(409);
    const res = await put(`/api/packs/${webDevId}`, { name: 'web-dev-2' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('web-dev-2');
  });

  it('404s on unknown ids (PUT / DELETE)', async () => {
    expect((await put('/api/packs/nope', { name: 'x' })).statusCode).toBe(404);
    expect((await del('/api/packs/nope')).statusCode).toBe(404);
  });

  it('deletes a pack', async () => {
    expect((await del(`/api/packs/${webDevId}`)).statusCode).toBe(200);
    const res = await get('/api/packs');
    expect(res.json().map((p: any) => p.name)).toEqual(['Auditor']);
  });
});
