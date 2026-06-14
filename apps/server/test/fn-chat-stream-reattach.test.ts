import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as net from 'node:net';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-reattach-'));
// Point CLAUDE_BIN at the deterministic mock replayer BEFORE any src import (config.ts reads it at
// load). A real interactive launch then mints a real run id, so an evict + ensureLive really does
// produce a FRESH backing run id — exactly the evict/kill → fresh-launch path this fix repairs.
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
let chatLive: any; let chatRepo: any;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  PORT = await getFreePort();
  process.env.FLEET_SERVER_PORT = String(PORT);
  await import('../src/config.js');
  PORT = Number(process.env.FLEET_SERVER_PORT);
  const { buildServer } = await import('../src/server.js');
  ({ chatLive } = await import('../src/chatLive.js'));
  ({ chatRepo } = await import('../src/chat.js'));
  app = buildServer();
  await app.listen({ port: PORT, host: '127.0.0.1' });
});
afterAll(async () => { await app?.close(); });

/** Open an SSE stream and collect every data frame for `windowMs`, then destroy the socket.
 *  Returns the parsed `data:` JSON objects. `onOpen` (if given) fires after `openDelayMs` so the
 *  test can mutate server state WHILE the stream is open and observe what the server pushes. */
function sseCollect(
  path: string,
  windowMs: number,
  opts?: { openDelayMs?: number; onOpen?: () => void | Promise<void> },
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
        if (opts?.onOpen) setTimeout(() => { void opts.onOpen!(); }, opts.openDelayMs ?? 100);
        setTimeout(() => res.destroy(), windowMs);
      },
    );
    req.on('error', reject);
  });
}

describe('GET /api/chat/sessions/:id/stream — re-attach on backing-run change', () => {
  it('re-subscribes and emits a session_state frame carrying the NEW runId when the backing run changes', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp' } });
    const id = created.json().id;

    // Connect first (fix 04 ensures a held run → an initial backing run id), then — while the
    // stream is open — evict it and ensureLive a FRESH run. The old SSE is subscribed to the dead
    // run; without re-subscription the new run's frames never reach the client (the bug). After the
    // fix, chatLive's onBackingRunChange must drive the stream to re-subscribe and announce the new id.
    let newRunId: string | null = null;
    const { frames } = await sseCollect(`/api/chat/sessions/${id}/stream`, 1200, {
      openDelayMs: 200,
      onOpen: async () => {
        chatLive.evict(id);                               // simulate idle-suspend / kill eviction
        const session = chatRepo.getSession(id);
        const ensured = await chatLive.ensureLive(session); // fresh launch → NEW held run id
        newRunId = ensured.runId;
      },
    });

    expect(newRunId).toBeTruthy();
    const ssFrames = frames.filter((f) => f.kind === 'session_state');
    // the re-attach frame must carry the NEW backing run id so the client adopts it (fix 04 client)
    const reattach = ssFrames.find((f) => f.runId === newRunId);
    expect(reattach).toBeTruthy();
    expect(reattach.runId).toBe(newRunId);
    // the new run id must differ from the one the stream first attached to (proves a real re-sub)
    const first = ssFrames[0];
    expect(first.runId).not.toBe(newRunId);
  });
});
