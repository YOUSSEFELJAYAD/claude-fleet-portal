import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as net from 'node:net';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-stream-'));
// Point CLAUDE_BIN at the deterministic mock replayer BEFORE any src import (config.ts reads it at
// load). A real interactive launch then replays the fixture, so a connected stream actually carries
// run/event frames — letting us assert the FIRST turn DOES stream (fix 04), not just the envelope.
const here = dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_BIN = resolve(here, '..', '..', '..', 'tools', 'mock-claude.mjs');
process.env.MOCK_DELAY_MS = '0';

/** Find a free port on loopback. */
function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close((e) => (e ? rej(e) : res(port)));
    });
  });
}

let app: any; let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  // Pick a free port BEFORE importing config so ALLOWED_HOSTS is built with the right value.
  PORT = await getFreePort();
  process.env.FLEET_SERVER_PORT = String(PORT);
  const cfg = await import('../src/config.js');
  // cfg.PORT may already be set (module cached) in other test workers, so fall back to our env-set value.
  PORT = Number(process.env.FLEET_SERVER_PORT);
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.listen({ port: PORT, host: '127.0.0.1' });
});
afterAll(async () => { await app?.close(); });

/** Read the first data chunk from an SSE endpoint then destroy the socket. */
function sseFirstChunk(path: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; chunk: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: PORT, path, headers: { host: `127.0.0.1:${PORT}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => {
          chunks.push(d);
          // Once we have data, destroy the socket (SSE stays open indefinitely)
          res.destroy();
        });
        res.on('close', () =>
          resolve({ statusCode: res.statusCode!, headers: res.headers, chunk: Buffer.concat(chunks).toString() }),
        );
        res.on('error', (e) => {
          // ECONNRESET is expected — we destroyed the socket intentionally
          if ((e as any).code === 'ECONNRESET') {
            resolve({ statusCode: res.statusCode!, headers: res.headers, chunk: Buffer.concat(chunks).toString() });
          } else {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
  });
}

/** Open an SSE stream and collect every data frame for `windowMs`, then destroy the socket.
 *  Returns the concatenated body plus the parsed `data:` JSON objects. Used to observe live
 *  run/event frames pushed while a turn is in flight. */
function sseCollect(path: string, windowMs: number): Promise<{ statusCode: number; body: string; frames: any[] }> {
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
          resolve({ statusCode: res.statusCode!, body, frames });
        };
        res.on('close', finish);
        res.on('error', (e) => ((e as any).code === 'ECONNRESET' ? finish() : reject(e)));
        setTimeout(() => res.destroy(), windowMs);
      },
    );
    req.on('error', reject);
  });
}

describe('GET /api/chat/sessions/:id/stream', () => {
  it('404s for an unknown session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/sessions/nope/stream', headers: HOST() });
    expect(res.statusCode).toBe(404);
  });

  it('opens an SSE stream and emits an initial session_state envelope', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp' } });
    const id = created.json().id;

    // Use raw http.get to read the first chunk without blocking on the long-lived SSE socket
    const { statusCode, headers, chunk } = await sseFirstChunk(`/api/chat/sessions/${id}/stream`);
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('text/event-stream');
    // Task 1.4: first frame is session_state with NO runId or live fields (new turn-scoped protocol).
    expect(chunk).toContain('session_state');
    const frame = JSON.parse(chunk.split('\n').find((l: string) => l.startsWith('data: '))!.slice(6));
    expect(frame.kind).toBe('session_state');
    expect('runId' in frame).toBe(false);
    expect('live' in frame).toBe(false);
  });

  it('an ENGINE session stays idle on connect (never holds a live process)', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp', engine: 'codex' } });
    const id = created.json().id;

    const { chunk } = await sseFirstChunk(`/api/chat/sessions/${id}/stream`);
    expect(chunk).toContain('session_state');
    expect(chunk).toContain('"state":"idle"');
  });

  it('the initial session_state frame has NO runId field (Task 1.4 turn-scoped protocol)', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp' } });
    const id = created.json().id;

    const { frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 500);
    const ss = frames.find((f) => f.kind === 'session_state');
    expect(ss).toBeTruthy();
    // Task 1.4: session_state carries ONLY state — no runId, no live (ChatStreamFrame contract).
    expect('runId' in ss).toBe(false);
    expect('live' in ss).toBe(false);
  });

  it('a turn emits turn:start / turn:event / turn:settled frames (Task 1.4 turn-scoped protocol)', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp' } });
    const id = created.json().id;

    // Connect first, then fire the turn while the stream is open.
    const collected = sseCollect(`/api/chat/sessions/${id}/stream`, 2000);
    await new Promise((r) => setTimeout(r, 100));
    const turn = await app.inject({ method: 'POST', url: `/api/chat/sessions/${id}/turn`, headers: HOST(), payload: { message: 'hello' } });
    expect(turn.statusCode).toBe(200);

    const { frames } = await collected;
    // Task 1.4: turn-scoped frames replace the old run-proxy frames
    const turnFrames = frames.filter((f) => ['turn:start', 'turn:event', 'turn:settled', 'turn:failed'].includes(f.kind));
    expect(turnFrames.length).toBeGreaterThan(0);
    // no old-protocol run-proxy frames
    expect(frames.filter((f) => f.kind === 'run' || f.kind === 'hello').length).toBe(0);
  });
});
