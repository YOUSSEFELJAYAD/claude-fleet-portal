import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-state-'));

// No backing run yet → runId is null on a fresh session; chatLive is not live → state must be 'idle'.
// No registry mock needed: deriveSessionState short-circuits when session.runId is null.

let app: any; let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe('derived session state/live', () => {
  it('a fresh session (no backing run, not live) reads state:idle live:false', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const got = await get('/api/chat/sessions/' + id);
    expect(got.statusCode).toBe(200);
    expect(got.json().session.state).toBe('idle');
    expect(got.json().session.live).toBe(false);
  });
});
