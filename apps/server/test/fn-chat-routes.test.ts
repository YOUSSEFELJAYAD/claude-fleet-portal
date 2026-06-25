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

  it('creates → lists → gets → renames → deletes a session', async () => {
    const created = await post('/api/chat/sessions', { cwd: '/tmp', title: 'first' });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(id).toBeTruthy();

    // list contains it
    expect((await get('/api/chat/sessions')).json().some((s: any) => s.id === id)).toBe(true);

    // get returns session + empty turns list (Task 1.4: messages field replaced by turns)
    const got = await get('/api/chat/sessions/' + id);
    expect(got.statusCode).toBe(200);
    expect(got.json().session.id).toBe(id);
    expect(got.json().turns).toEqual([]);

    // rename (valid + invalid)
    expect((await patch('/api/chat/sessions/' + id, { title: '  renamed  ' })).json().title).toBe('renamed');
    expect((await patch('/api/chat/sessions/' + id, { title: '' })).statusCode).toBe(400);

    // delete → subsequent get 404s
    expect((await del('/api/chat/sessions/' + id)).json()).toEqual({ ok: true });
    expect((await get('/api/chat/sessions/' + id)).statusCode).toBe(404);
  });

  it('C1 cross-seam: GET /api/chat/sessions/:id returns turns oldest-first', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp', title: 'order-check' })).json().id;
    const { chatRepo } = await import('../src/chatRepo.js');
    const db = (await import('../src/db.js')).default;
    const { randomUUID } = await import('node:crypto');
    const base = Date.now();
    const t1 = chatRepo.newTurnId();
    const t2 = chatRepo.newTurnId();
    const t3 = chatRepo.newTurnId();
    const ins = db.prepare(`INSERT INTO chat_messages (id,session_id,role,kind,content,run_id,turn_id,created_at)
      VALUES (@id,@session_id,@role,@kind,@content,@run_id,@turn_id,@created_at)`);
    ins.run({ id: randomUUID(), session_id: id, role: 'user', kind: 'text', content: 'first',  run_id: null, turn_id: t1, created_at: base });
    ins.run({ id: randomUUID(), session_id: id, role: 'user', kind: 'text', content: 'second', run_id: null, turn_id: t2, created_at: base + 10 });
    ins.run({ id: randomUUID(), session_id: id, role: 'user', kind: 'text', content: 'third',  run_id: null, turn_id: t3, created_at: base + 20 });

    const { turns } = (await get('/api/chat/sessions/' + id)).json();
    expect(turns.length).toBe(3);
    // oldest-first: t1, t2, t3
    expect(turns[0].id).toBe(t1);
    expect(turns[1].id).toBe(t2);
    expect(turns[2].id).toBe(t3);
    expect(turns[0].createdAt).toBeLessThan(turns[1].createdAt);
    expect(turns[1].createdAt).toBeLessThan(turns[2].createdAt);
  });

  it('404s get/patch on an unknown session id', async () => {
    expect((await get('/api/chat/sessions/nope')).statusCode).toBe(404);
    expect((await patch('/api/chat/sessions/nope', { title: 'x' })).statusCode).toBe(404);
  });
});
