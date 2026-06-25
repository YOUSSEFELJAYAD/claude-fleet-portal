/**
 * Chat concurrency UX (spec §3.2/§12) — Task 2.1 update.
 * The new useChatStream only handles turn-scoped frames; state transitions come
 * from session_state frames. `hello` and `live` are gone.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../lib/live';
import { chatStateMeta } from '../lib/chatState';
import { FakeEventSource } from './setup';

describe('chat concurrency UX (spec §3.2/§12)', () => {
  it('budget exhausted: a brand-new session opens in resumable mode, never an error', () => {
    const { result } = renderHook(() => useChatStream('sess-new'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    // CHAT_LIVE_MAX is full → the server sends session_state idle (resumable), NOT an error
    act(() => es.emit({ kind: 'session_state', state: 'idle' }));
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    // the badge the page renders for this state is the subtle "RESUMABLE" pill
    expect(chatStateMeta(result.current.state!).label).toBe('RESUMABLE');
  });

  it('idle-suspend: a live session transitions to idle after CHAT_IDLE_SUSPEND_MS (server push)', () => {
    const { result } = renderHook(() => useChatStream('sess-live'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    act(() => es.emit({ kind: 'session_state', state: 'live' }));
    expect(result.current.state).toBe('live');
    // idle-suspend eviction reclaims the chat slot → server pushes a session_state envelope
    act(() => es.emit({ kind: 'session_state', state: 'idle' }));
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('kill→resume: state goes live → killed → live without losing the subscription', () => {
    const { result } = renderHook(() => useChatStream('sess-kr'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    act(() => es.emit({ kind: 'session_state', state: 'live' }));
    act(() => es.emit({ kind: 'session_state', state: 'killed' }));
    expect(result.current.state).toBe('killed');
    act(() => es.emit({ kind: 'session_state', state: 'live' }));
    expect(result.current.state).toBe('live');
    expect(es.closed).toBe(false); // one durable subscription across the whole flow
  });
});
