import { describe, it, expect, vi, beforeEach } from 'vitest';

const launched: any[] = [];
vi.mock('../src/registry.js', () => ({
  registry: {
    launch: vi.fn((req: any) => { const id = `run-${launched.length}`; launched.push({ id, ...req }); return { id }; }),
    stop: vi.fn(),
    getRun: vi.fn(() => ({ status: 'running' })),
  },
}));
// tiny idle window so the eviction test is fast
vi.mock('../src/config.js', async (orig) => ({ ...(await orig() as any), CHAT_LIVE_MAX: 2, CHAT_IDLE_SUSPEND_MS: 50 }));

import { chatLive } from '../src/chatLive.js';
import { registry } from '../src/registry.js';

beforeEach(() => { launched.length = 0; (registry.launch as any).mockClear(); (registry.stop as any).mockClear(); chatLive._resetForTest(); });

const session = (id: string) => ({ id, cwd: '/tmp', model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default', allowedTools: null, skills: null } as any);

describe('chatLive', () => {
  it('ensureLive launches an interactive run and tracks the handle', async () => {
    const r = await chatLive.ensureLive(session('s1'));
    expect(r.live).toBe(true);
    expect(r.runId).toBe('run-0');
    expect((registry.launch as any).mock.calls[0][0].interactive).toBe(true);
    expect(chatLive.isLive('s1')).toBe(true);
  });

  it('a second ensureLive for the same session reuses the handle (no new launch)', async () => {
    await chatLive.ensureLive(session('s1'));
    await chatLive.ensureLive(session('s1'));
    expect((registry.launch as any)).toHaveBeenCalledTimes(1);
  });

  it('falls back to resumable when CHAT_LIVE_MAX is exhausted', async () => {
    await chatLive.ensureLive(session('s1'));
    await chatLive.ensureLive(session('s2')); // fills the 2 slots
    const r = await chatLive.ensureLive(session('s3'));
    expect(r.live).toBe(false); // fallback signal
    expect(r.runId).toBeNull();
    expect((registry.launch as any)).toHaveBeenCalledTimes(2); // s3 did NOT launch
  });

  it('evict frees the slot and stops the backing run', async () => {
    const a = await chatLive.ensureLive(session('s1'));
    chatLive.evict('s1');
    expect((registry.stop as any)).toHaveBeenCalledWith(a.runId);
    expect(chatLive.isLive('s1')).toBe(false);
    // slot freed → a previously-blocked session can now go live
    await chatLive.ensureLive(session('s2'));
    await chatLive.ensureLive(session('s3'));
    const r = await chatLive.ensureLive(session('s4'));
    expect(r.live).toBe(false); // back at the cap again
  });

  it('auto-suspends an idle session after CHAT_IDLE_SUSPEND_MS', async () => {
    await chatLive.ensureLive(session('s1'));
    expect(chatLive.isLive('s1')).toBe(true);
    await new Promise((res) => setTimeout(res, 90)); // > 50ms idle window
    expect(chatLive.isLive('s1')).toBe(false);
    expect((registry.stop as any)).toHaveBeenCalled();
  });

  it('touch resets the idle timer (keeps a busy session live)', async () => {
    await chatLive.ensureLive(session('s1'));
    await new Promise((res) => setTimeout(res, 30));
    chatLive.touch('s1'); // activity → restart the 50ms window
    await new Promise((res) => setTimeout(res, 30)); // 60ms total but only 30 since touch
    expect(chatLive.isLive('s1')).toBe(true);
  });
});
