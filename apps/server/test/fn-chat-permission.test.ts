/**
 * Fix 06 — inline permission approve/deny via the REAL chat permission route.
 *
 * REAL route: drive buildServer() + app.inject() against POST /api/chat/sessions/:id/permission.
 * We preserve the registry instance prototype via Object.create (so buildServer() boot keeps every
 * method it relies on) and stub decidePermission to assert the route maps the wire decision
 * ('allow'|'deny') to the registry verb ('approve'|'deny'). chatLive.liveRunId supplies the
 * backing run id the route resolves (chatLive.liveRunId(id) ?? session.runId).
 *
 * Asserted facts:
 *  1. decision:'allow' → registry.decidePermission(runId, requestId, 'approve').
 *  2. decision:'deny'  → registry.decidePermission(runId, requestId, 'deny').
 *  3. An unknown session → 404.
 *  4. A registry 409 (non-interactive) is forwarded to the response.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-permission-'));

const decidePermission = vi.fn();
vi.mock('../src/registry.js', async (orig) => {
  const actual = (await orig()) as any;
  const proxied = Object.create(actual.registry);
  Object.assign(proxied, {
    getRun: vi.fn(() => null),
    decidePermission,
  });
  return { ...actual, registry: proxied };
});

// chatLive: supply a backing run id so the route resolves a runId without a live process.
vi.mock('../src/chatLive.js', async (orig) => {
  const actual = (await orig()) as any;
  const proxied = Object.create(actual.chatLive);
  Object.assign(proxied, {
    liveRunId: vi.fn(() => 'run-xyz'),
    touch: vi.fn(),
    isLive: vi.fn(() => false),
    init: vi.fn(),
  });
  return { ...actual, chatLive: proxied };
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
beforeEach(() => decidePermission.mockReset());

const mkSession = async () => (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;

describe('POST /api/chat/sessions/:id/permission', () => {
  it('404s for an unknown session', async () => {
    expect((await post('/api/chat/sessions/nope/permission', { requestId: 'r1', decision: 'allow' })).statusCode).toBe(404);
  });

  it("maps decision 'allow' to the registry verb 'approve'", async () => {
    const id = await mkSession();
    const res = await post(`/api/chat/sessions/${id}/permission`, { requestId: 'r1', decision: 'allow' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(decidePermission).toHaveBeenCalledWith('run-xyz', 'r1', 'approve');
  });

  it("maps decision 'deny' to the registry verb 'deny'", async () => {
    const id = await mkSession();
    const res = await post(`/api/chat/sessions/${id}/permission`, { requestId: 'r2', decision: 'deny' });
    expect(res.statusCode).toBe(200);
    expect(decidePermission).toHaveBeenCalledWith('run-xyz', 'r2', 'deny');
  });

  it('forwards a registry 409 (non-interactive) to the response', async () => {
    const id = await mkSession();
    decidePermission.mockImplementationOnce(() => { throw Object.assign(new Error('Run is not live'), { statusCode: 409 }); });
    const res = await post(`/api/chat/sessions/${id}/permission`, { requestId: 'r3', decision: 'allow' });
    expect(res.statusCode).toBe(409);
  });
});
