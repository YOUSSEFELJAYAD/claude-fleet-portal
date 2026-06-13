/**
 * Real HTTP integration test for registerChatRoutes — the chat-session CRUD surface
 * (create / list / get / rename / add-message / delete) driven through the REAL fastify
 * app via buildServer().inject(). The claude-spawning /turn + /command routes are out of
 * scope here (covered by chat.test.ts at the function level).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-routes-'));

let app: any;
let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

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
const patch = (url: string, payload: any) => app.inject({ method: 'PATCH', url, headers: HOST(), payload });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: HOST() });

describe('registerChatRoutes — session CRUD', () => {
  it('rejects session creation without a cwd', async () => {
    expect((await post('/api/chat/sessions', {})).statusCode).toBe(400);
  });

  it('creates → lists → gets → renames → adds a message → deletes a session', async () => {
    const created = await post('/api/chat/sessions', { cwd: '/tmp', title: 'first' });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(id).toBeTruthy();

    // list contains it
    expect((await get('/api/chat/sessions')).json().some((s: any) => s.id === id)).toBe(true);

    // get returns session + empty message list
    const got = await get('/api/chat/sessions/' + id);
    expect(got.statusCode).toBe(200);
    expect(got.json().session.id).toBe(id);
    expect(got.json().messages).toEqual([]);

    // rename (valid + invalid)
    expect((await patch('/api/chat/sessions/' + id, { title: '  renamed  ' })).json().title).toBe('renamed');
    expect((await patch('/api/chat/sessions/' + id, { title: '' })).statusCode).toBe(400);

    // add a message, then it shows up
    const msg = await post('/api/chat/sessions/' + id + '/messages', { role: 'user', kind: 'text', content: 'hello' });
    expect(msg.statusCode).toBe(200);
    expect((await get('/api/chat/sessions/' + id)).json().messages.map((m: any) => m.content)).toContain('hello');

    // delete → subsequent get 404s
    expect((await del('/api/chat/sessions/' + id)).json()).toEqual({ ok: true });
    expect((await get('/api/chat/sessions/' + id)).statusCode).toBe(404);
  });

  it('404s get/patch on an unknown session id', async () => {
    expect((await get('/api/chat/sessions/nope')).statusCode).toBe(404);
    expect((await patch('/api/chat/sessions/nope', { title: 'x' })).statusCode).toBe(404);
  });
});
