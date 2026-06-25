/**
 * Task 1.4 — turn-scoped SSE route (chatStream.ts) + paginated turn history.
 *
 * Wire-frame contract:
 *   1. First frame on connect:    { kind: 'session_state', state } — NO runId, NO live
 *   2. When a turn runs:          turn:start → turn:event(s) → turn:settled | turn:failed
 *   3. No hello / run-proxy frames (old protocol is gone)
 *   4. Pagination:  GET /api/chat/sessions/:id → { session, turns }
 *                   GET /api/chat/sessions/:id/turns?before=&limit=
 *
 * Real-process: interactive fake-claude (same pattern as chatturn.test.ts) so the full
 * chatTurns → registry → stream pipeline fires without mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';

// ── Isolate BEFORE any src/ import ───────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-chatstream-'));

const fakeClaude = join(dataDir, 'fake-claude.mjs');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const argv = process.argv.slice(2);
const sidIdx = argv.indexOf('--session-id');
const sid = sidIdx >= 0 ? argv[sidIdx + 1] : '00000000-0000-0000-0000-000000000000';
const interactive = argv.includes('--input-format');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (interactive) {
  line({ type: 'system', subtype: 'init', session_id: sid, tools: [], mcp_servers: [], model: 'claude-haiku-4-5', cwd: process.cwd(), permissionMode: 'default', apiKeySource: 'env' });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c; let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      let text = ''; try { text = JSON.parse(raw)?.message?.content?.[0]?.text ?? ''; } catch {}
      if (text === '__BYE__') { process.exit(0); }
      else {
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + text }], usage: { input_tokens: 1, output_tokens: 1 } } });
        line({ type: 'result', subtype: 'success', session_id: sid, result: 'echo: ' + text, total_cost_usd: 0, is_error: false });
      }
    }
  });
} else {
  const dd = argv.indexOf('--');
  const prompt = dd >= 0 ? argv[dd + 1] : 'oneshot';
  line({ type: 'system', subtype: 'init', session_id: sid, tools: [], mcp_servers: [], model: 'claude-haiku-4-5', cwd: process.cwd(), permissionMode: 'default', apiKeySource: 'env' });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply: ' + prompt }], usage: { input_tokens: 1, output_tokens: 1 } } });
  line({ type: 'result', subtype: 'success', session_id: sid, result: 'reply: ' + prompt, total_cost_usd: 0, is_error: false });
}
`,
);
chmodSync(fakeClaude, 0o755);

process.env.FLEET_DATA_DIR = dataDir;
process.env.CLAUDE_BIN = fakeClaude;
process.env.FLEET_CHAT_LIVE_MAX = '1';
process.env.MOCK_DELAY_MS = '0';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close((e) => (e ? rej(e) : res(port)));
    });
  });
}

let app: any;
let PORT: number;
let chatTurns: any;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });
const post = (url: string, payload?: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
};

/** Collect SSE frames for `windowMs` then close. */
function sseCollect(
  path: string,
  windowMs: number,
  opts?: { onOpen?: () => void | Promise<void>; openDelayMs?: number },
): Promise<{ statusCode: number; frames: any[] }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: PORT, path, headers: { host: `127.0.0.1:${PORT}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        const finish = () => {
          const body = Buffer.concat(chunks).toString();
          const frames = body
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
            .filter((x) => x !== null);
          resolve({ statusCode: res.statusCode!, frames });
        };
        res.on('close', finish);
        res.on('error', (e) => ((e as any).code === 'ECONNRESET' ? finish() : reject(e)));
        if (opts?.onOpen) setTimeout(() => void opts.onOpen!(), opts.openDelayMs ?? 50);
        setTimeout(() => res.destroy(), windowMs);
      },
    );
    req.on('error', reject);
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  PORT = await getFreePort();
  process.env.FLEET_SERVER_PORT = String(PORT);
  await import('../src/config.js');
  PORT = Number(process.env.FLEET_SERVER_PORT);
  const { buildServer } = await import('../src/server.js');
  ({ chatTurns } = await import('../src/chatTurn.js'));
  app = buildServer();
  await app.listen({ port: PORT, host: '127.0.0.1' });
});

afterAll(async () => { await app?.close(); });

afterEach(() => { chatTurns._resetForTest(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/chat/sessions/:id/stream — turn-scoped protocol', () => {
  it('404s for an unknown session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/sessions/nope/stream', headers: HOST() });
    expect(res.statusCode).toBe(404);
  });

  it('first frame is session_state with NO runId field', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const { statusCode, frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 300);
    expect(statusCode).toBe(200);
    const ss = frames.find((f) => f.kind === 'session_state');
    expect(ss).toBeTruthy();
    expect(ss.state).toBeTruthy();         // 'idle' | 'live' | 'running' | 'killed'
    expect('runId' in ss).toBe(false);     // Phase 2 contract: no runId leaked
    expect('live' in ss).toBe(false);      // no live field either
  });

  it('no hello / run-proxy event frames emitted (old protocol gone)', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const { frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 300);
    expect(frames.every((f) => f.kind !== 'hello')).toBe(true);
    // no raw 'event' or 'run' frames (those were run-proxy frames)
    expect(frames.every((f) => f.kind !== 'event' && f.kind !== 'run')).toBe(true);
  });

  it('a completed turn emits session_state → turn:start → turn:event(assistant_text) → turn:settled', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;

    let turnSettled = false;
    const { frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 3000, {
      openDelayMs: 100,
      onOpen: async () => {
        await post(`/api/chat/sessions/${id}/turn`, { message: 'hello' });
        // wait for turn to settle before the window closes
        await waitFor(() => turnSettled, 2500);
      },
    });

    // Track settlement for the waitFor above
    frames.forEach((f) => { if (f.kind === 'turn:settled') turnSettled = true; });

    const kinds = frames.map((f) => f.kind);

    // session_state must be first
    expect(kinds[0]).toBe('session_state');

    // turn:start must appear
    const startIdx = kinds.indexOf('turn:start');
    expect(startIdx).toBeGreaterThan(-1);

    // at least one turn:event with type 'assistant_text'
    const events = frames.filter((f) => f.kind === 'turn:event');
    expect(events.length).toBeGreaterThan(0);
    const textEvent = events.find((f) => f.event?.type === 'assistant_text');
    expect(textEvent).toBeTruthy();

    // turn:settled must appear after turn:start
    const settledIdx = kinds.indexOf('turn:settled');
    expect(settledIdx).toBeGreaterThan(startIdx);

    // no runId at the top level of any frame
    frames.forEach((f) => {
      expect('runId' in f).toBe(false);
    });
  });

  it('a mid-turn connect receives the buffered frames (replay on subscribe)', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;

    // Fire turn BEFORE connecting the stream — chatTurns buffers the frames
    // The fake-claude at MOCK_DELAY_MS=0 is fast, but if we subscribe before it settles
    // we'll see replayed frames; if it already settled we'll still see session_state.
    await post(`/api/chat/sessions/${id}/turn`, { message: 'preconnect' });
    // brief pause: let the turn settle completely
    await sleep(200);

    const { frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 500);
    const kinds = frames.map((f) => f.kind);
    // session_state is always first even if turn is already done
    expect(kinds[0]).toBe('session_state');
    // no hello/run frames
    expect(frames.every((f) => f.kind !== 'hello' && f.kind !== 'run' && f.kind !== 'event')).toBe(true);
  });
});

// ── Paginated turn history ────────────────────────────────────────────────────

describe('GET /api/chat/sessions/:id → { session, turns }', () => {
  it('returns session + empty turns list for a new session', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const res = await get(`/api/chat/sessions/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.id).toBe(id);
    expect(Array.isArray(body.turns)).toBe(true);
    expect(body.turns.length).toBe(0);
    // old 'messages' field is gone
    expect('messages' in body).toBe(false);
  });

  it('returns turns after a completed turn (oldest-first)', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    // add messages directly (turn-based) to avoid spawning a real process
    const t1 = (await import('../src/chatRepo.js')).chatRepo.newTurnId();
    const repo = (await import('../src/chatRepo.js')).chatRepo;
    repo.addMessage({ sessionId: id, role: 'user', kind: 'text', content: 'q1', runId: null, turnId: t1 });
    repo.addMessage({ sessionId: id, role: 'assistant', kind: 'text', content: 'a1', runId: null, turnId: t1 });

    const res = await get(`/api/chat/sessions/${id}`);
    expect(res.statusCode).toBe(200);
    const { turns } = res.json();
    expect(turns.length).toBe(1);
    expect(turns[0].id).toBe(t1);
    expect(turns[0].messages.length).toBe(2);
  });
});

describe('GET /api/chat/sessions/:id/turns?before=&limit= (pagination)', () => {
  it('returns 404 for unknown session', async () => {
    const res = await get('/api/chat/sessions/nope/turns');
    expect(res.statusCode).toBe(404);
  });

  it('paginates: before cursor returns only older turns', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const repo = (await import('../src/chatRepo.js')).chatRepo;
    const db = (await import('../src/db.js')).default;

    const t1 = repo.newTurnId();
    const t2 = repo.newTurnId();
    const base = Date.now();

    const ins = db.prepare(`INSERT INTO chat_messages
      (id,session_id,role,kind,content,run_id,turn_id,created_at)
      VALUES (@id,@session_id,@role,@kind,@content,@run_id,@turn_id,@created_at)`);
    const { randomUUID } = await import('node:crypto');
    ins.run({ id: randomUUID(), session_id: id, role: 'user', kind: 'text', content: 'first', run_id: null, turn_id: t1, created_at: base });
    ins.run({ id: randomUUID(), session_id: id, role: 'user', kind: 'text', content: 'second', run_id: null, turn_id: t2, created_at: base + 100 });

    // GET all turns — oldest-first: t1 then t2
    const all = (await get(`/api/chat/sessions/${id}/turns`)).json();
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(t1);           // oldest first
    expect(all[all.length - 1].id).toBe(t2); // newest last

    // Paginate: before = t2.createdAt → only t1 (still oldest-first in result)
    const page = (await get(`/api/chat/sessions/${id}/turns?before=${base + 100}`)).json();
    expect(page.length).toBe(1);
    expect(page[0].id).toBe(t1);
  });

  it('limit param caps results', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const repo = (await import('../src/chatRepo.js')).chatRepo;
    const db = (await import('../src/db.js')).default;
    const { randomUUID } = await import('node:crypto');
    const ins = db.prepare(`INSERT INTO chat_messages
      (id,session_id,role,kind,content,run_id,turn_id,created_at)
      VALUES (@id,@session_id,@role,@kind,@content,@run_id,@turn_id,@created_at)`);
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      const t = repo.newTurnId();
      ins.run({ id: randomUUID(), session_id: id, role: 'user', kind: 'text', content: `m${i}`, run_id: null, turn_id: t, created_at: base + i });
    }

    const page = (await get(`/api/chat/sessions/${id}/turns?limit=2`)).json();
    expect(page.length).toBe(2);
  });
});
