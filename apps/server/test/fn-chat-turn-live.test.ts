/**
 * Fix 03 — startTurn routes live claude turns through registry.sendInput (the always-live wiring).
 *
 * REAL route: drive buildServer() + app.inject() against POST /api/chat/sessions/:id/turn.
 * We stub chatLive.ensureLive (it is the production caller wired here) and spy on
 * registry.sendInput, preserving the registry prototype via Object.create so buildServer()
 * boot still has every method it relies on.
 *
 * Asserted facts:
 *  1. When a live slot is available, the held interactive run id is reused across TWO turns
 *     (same runId returned both times) and registry.sendInput is exercised with the turn text.
 *  2. When the live budget is exhausted on a FRESH session (no backing run), the turn falls
 *     back to a one-shot launch without error.
 *  3. When the budget is exhausted on a session that already has a backing run, the turn
 *     falls back to resume without error.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-turn-live-'));

// Registry: preserve the real instance prototype (onRunTerminal/subscribeFleet/etc. are needed
// by buildServer boot) and override only launch/resume/sendInput/getRun for this test.
const sendInput = vi.fn();
vi.mock('../src/registry.js', async (orig) => {
  const actual = (await orig()) as any;
  const proxied = Object.create(actual.registry);
  Object.assign(proxied, {
    launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
    resume: vi.fn((id: string) => ({ id: 'run-resume', sessionId: 's', status: 'running' })),
    sendInput,
    getRun: vi.fn(() => null),
  });
  return { ...actual, registry: proxied };
});

// chatLive: control ensureLive (the live/budget signal) + no-op the warmth touch.
const ensureLive = vi.fn();
vi.mock('../src/chatLive.js', async (orig) => {
  const actual = (await orig()) as any;
  const proxied = Object.create(actual.chatLive);
  Object.assign(proxied, {
    ensureLive,
    touch: vi.fn(),
    isLive: vi.fn(() => false),
    liveRunId: vi.fn(() => null),
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

beforeEach(() => { sendInput.mockClear(); ensureLive.mockReset(); });

describe('startTurn — always-live wiring (fix 03)', () => {
  it('reuses the held run across two turns and delivers each via registry.sendInput', async () => {
    const { registry } = await import('../src/registry.js');
    ensureLive.mockResolvedValue({ live: true, runId: 'live-run-1' });

    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;

    const t1 = await post(`/api/chat/sessions/${id}/turn`, { message: 'first' });
    expect(t1.statusCode).toBe(200);
    expect(t1.json().runId).toBe('live-run-1');

    const t2 = await post(`/api/chat/sessions/${id}/turn`, { message: 'second' });
    expect(t2.statusCode).toBe(200);
    expect(t2.json().runId).toBe('live-run-1'); // SAME held run reused

    // sendInput exercised for both turns with their text
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput.mock.calls[0]).toEqual(['live-run-1', 'first']);
    expect(sendInput.mock.calls[1]).toEqual(['live-run-1', 'second']);

    // the live path never launches/resumes
    expect((registry.launch as any)).not.toHaveBeenCalled();
    expect((registry.resume as any)).not.toHaveBeenCalled();
  });

  it('budget-exhausted on a fresh session falls back to a one-shot launch', async () => {
    const { registry } = await import('../src/registry.js');
    (registry.launch as any).mockClear();
    ensureLive.mockResolvedValue({ live: false, runId: null });

    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    const t1 = await post(`/api/chat/sessions/${id}/turn`, { message: 'hello' });

    expect(t1.statusCode).toBe(200);
    expect(t1.json().runId).toBe('run-launch');
    expect((registry.launch as any)).toHaveBeenCalledTimes(1);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('budget-exhausted on a session with a backing run falls back to resume', async () => {
    const { registry } = await import('../src/registry.js');
    (registry.resume as any).mockClear();
    // turn 1: live, establishes a backing run id on the session
    ensureLive.mockResolvedValueOnce({ live: true, runId: 'live-run-2' });
    const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
    await post(`/api/chat/sessions/${id}/turn`, { message: 'first' });

    // turn 2: budget exhausted, but a runId is now stored → resume, no error
    ensureLive.mockResolvedValueOnce({ live: false, runId: null });
    const t2 = await post(`/api/chat/sessions/${id}/turn`, { message: 'second' });

    expect(t2.statusCode).toBe(200);
    expect(t2.json().runId).toBe('run-resume');
    expect((registry.resume as any)).toHaveBeenCalledTimes(1);
  });
});
