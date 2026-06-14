import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-input-'));

// Not-live by default: sendInput throws 409 (mirrors registry.sendInput's contract).
vi.mock('../src/registry.js', async (orig) => {
  const actual = await orig() as any;
  // Preserve the actual registry instance's prototype so that all prototype methods
  // (onRunTerminal, subscribeFleet, etc.) remain available for buildServer() initialization.
  // Then override only the specific methods we need for this test.
  const proxied = Object.create(actual.registry);
  Object.assign(proxied, {
    getRun: vi.fn(() => null),
    sendInput: vi.fn(() => { throw Object.assign(new Error('Run is not live; use Resume instead.'), { statusCode: 409 }); }),
    stop: vi.fn(),
  });
  return { ...actual, registry: proxied };
});

let app: any; let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe('chat input / interrupt', () => {
  it('POST /input 404s for an unknown session', async () => {
    expect((await post('/api/chat/sessions/nope/input', { text: 'hi' })).statusCode).toBe(404);
  });
  it('POST /input 400s without text', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    expect((await post(`/api/chat/sessions/${id}/input`, {})).statusCode).toBe(400);
  });
  it('POST /input 409s when the session is not live', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    expect((await post(`/api/chat/sessions/${id}/input`, { text: 'hi' })).statusCode).toBe(409);
  });
  it('POST /interrupt 404s for an unknown session', async () => {
    expect((await post('/api/chat/sessions/nope/interrupt', {})).statusCode).toBe(404);
  });
  it('POST /interrupt with no backing run is a 200 no-op ack', async () => {
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const res = await post(`/api/chat/sessions/${id}/interrupt`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
