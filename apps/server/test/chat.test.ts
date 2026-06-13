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
