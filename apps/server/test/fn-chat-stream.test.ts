import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-stream-'));

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
    expect(chunk).toContain('session_state');
    expect(chunk).toContain('"state":"idle"');
  });
});
