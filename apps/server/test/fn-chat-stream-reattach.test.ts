/**
 * Task 1.4 — turn-scoped SSE: session_state frame carries no runId or live field.
 *
 * The old backing-run-change reattach logic (onBackingRunChange / evict → new runId in session_state)
 * was removed when the stream route switched to chatTurns.subscribe. This file now covers the
 * straightforward property that the stream emits a valid session_state on connect and that the
 * frame has no runId leak — a lightweight complement to the comprehensive chatstream.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as net from 'node:net';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-reattach-'));
const here = dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_BIN = resolve(here, '..', '..', '..', 'tools', 'mock-claude.mjs');
process.env.MOCK_DELAY_MS = '0';

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
  PORT = await getFreePort();
  process.env.FLEET_SERVER_PORT = String(PORT);
  await import('../src/config.js');
  PORT = Number(process.env.FLEET_SERVER_PORT);
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.listen({ port: PORT, host: '127.0.0.1' });
});
afterAll(async () => { await app?.close(); });

function sseCollect(path: string, windowMs: number): Promise<{ statusCode: number; frames: any[] }> {
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
        setTimeout(() => res.destroy(), windowMs);
      },
    );
    req.on('error', reject);
  });
}

describe('GET /api/chat/sessions/:id/stream — session_state frame (Task 1.4)', () => {
  it('emits session_state with no runId or live field on connect', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp' } });
    const id = created.json().id;

    const { frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 500);
    const ss = frames.find((f) => f.kind === 'session_state');
    expect(ss).toBeTruthy();
    expect(ss.state).toBeTruthy();
    // Task 1.4 — Phase 2 ChatStreamFrame contract: no runId, no live
    expect('runId' in ss).toBe(false);
    expect('live' in ss).toBe(false);
  });
});
