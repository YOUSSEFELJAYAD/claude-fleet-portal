import { describe, it, expect } from 'vitest';
import { chatRepo, buildEnginePrompt } from '../src/chat.js';

describe('chatRepo', () => {
  it('creates, lists, gets, renames, and deletes a session', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/x', title: 'first' });
    expect(s.id).toBeTruthy();
    expect(s.title).toBe('first');
    expect(s.engine).toBe('claude');
    expect(s.runId).toBeNull();

    expect(chatRepo.getSession(s.id)?.id).toBe(s.id);
    expect(chatRepo.listSessions().some((x) => x.id === s.id)).toBe(true);

    chatRepo.renameSession(s.id, 'renamed');
    expect(chatRepo.getSession(s.id)?.title).toBe('renamed');

    chatRepo.setSessionRun(s.id, 'run-1');
    expect(chatRepo.getSession(s.id)?.runId).toBe('run-1');

    chatRepo.deleteSession(s.id);
    expect(chatRepo.getSession(s.id)).toBeNull();
  });

  it('appends and lists messages in order', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/y' });
    chatRepo.addMessage({ sessionId: s.id, role: 'user', kind: 'text', content: 'hi', runId: null });
    chatRepo.addMessage({ sessionId: s.id, role: 'assistant', kind: 'text', content: 'hello', runId: 'r1' });
    const msgs = chatRepo.listMessages(s.id);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(msgs[1].runId).toBe('r1');
  });
});

describe('buildEnginePrompt', () => {
  it('reconstructs prior turns + the new message', () => {
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as any[];
    const p = buildEnginePrompt(history, 'next question');
    expect(p).toContain('hi');
    expect(p).toContain('hello');
    expect(p).toContain('next question');
    expect(p.indexOf('next question')).toBeGreaterThan(p.indexOf('hello'));
  });

  it('caps total length, keeping the most recent turns', () => {
    const history = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `OLD${i}` })) as any[];
    const p = buildEnginePrompt(history, 'fresh');
    expect(p.length).toBeLessThanOrEqual(12_200);
    expect(p).toContain('fresh');
    expect(p).not.toContain('OLD0'); // oldest dropped
  });
});

import { vi } from 'vitest';
vi.mock('../src/registry.js', () => ({
  registry: {
    launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
    resume: vi.fn(async (id: string) => ({ id: 'run-resume', sessionId: 's', status: 'running' })),
    launchEngine: vi.fn(async (req: any) => ({ id: 'run-engine', sessionId: 's', status: 'running', ...req })),
    sendInput: vi.fn(),
  },
}));

// Fix 03 — claude turns now route through chatLive.ensureLive first. The launch(turn-1)/resume(turn-2)
// assertions below pin the resumable fallback, so force the budget-exhausted signal (live:false) to
// keep that path live (the held-process/sendInput path is covered by fn-chat-turn-live.test.ts).
vi.mock('../src/chatLive.js', () => ({
  chatLive: {
    ensureLive: vi.fn(async () => ({ live: false, runId: null })),
    touch: vi.fn(),
    isLive: vi.fn(() => false),
    liveRunId: vi.fn(() => null),
    init: vi.fn(),
  },
}));

describe('startTurn', () => {
  it('turn 1 launches; turn 2 resumes the stored run id', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: '/tmp/t' });

    const t1 = await startTurn(s.id, 'first');
    expect((registry.launch as any)).toHaveBeenCalledTimes(1);
    expect(t1.runId).toBe('run-launch');
    expect(chatRepo.getSession(s.id)?.runId).toBe('run-launch');
    expect(t1.userMessage.content).toBe('first');

    const t2 = await startTurn(s.id, 'second');
    expect((registry.resume as any)).toHaveBeenCalledWith('run-launch', 'second', undefined, undefined);
    expect(t2.runId).toBe('run-resume');
    expect(chatRepo.getSession(s.id)?.runId).toBe('run-resume');
  });

  it('engine session launches an engine run with a reconstructed prompt each turn', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: '/tmp/e', engine: 'codex', model: 'gpt-5-codex' });
    await startTurn(s.id, 'hello engine');
    expect((registry.launchEngine as any)).toHaveBeenCalled();
    const arg = (registry.launchEngine as any).mock.calls.at(-1)[0];
    expect(arg.engine).toBe('codex');
    expect(arg.prompt).toContain('hello engine');
  });
});
