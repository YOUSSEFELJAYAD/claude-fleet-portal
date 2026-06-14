import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../lib/live';
import { FakeEventSource } from './setup';

describe('useChatStream', () => {
  it('subscribes to the chat-scoped stream by session id', () => {
    renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/chat/sessions/sess-1/stream');
  });

  it('reduces hello → state/live/runId/subagents and toggles connected', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    expect(result.current.connected).toBe(false);
    act(() => es.emitOpen());
    expect(result.current.connected).toBe(true);
    act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [{ runId: 'sub-1', name: 'reviewer' }] }));
    expect(result.current.state).toBe('live');
    expect(result.current.live).toBe(true);
    expect(result.current.runId).toBe('run-a');
    expect(result.current.subagents).toEqual([{ runId: 'sub-1', name: 'reviewer' }]);
  });

  it('budget exhaustion: a session_state idle envelope flips a live session to resumable (no error)', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [] }));
    expect(result.current.state).toBe('live');
    // CHAT_LIVE_MAX exhausted / idle-suspend → server pushes a state transition, never an error frame
    act(() => es.emit({ kind: 'session_state', state: 'idle', live: false }));
    expect(result.current.state).toBe('idle');
    expect(result.current.live).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('appends subagents from subagent_spawned events and follows the run id across kill→resume', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [] }));
    act(() => es.emit({ kind: 'event', event: { type: 'subagent_spawned', runId: 'run-a', nodeId: 'n1', payload: { name: 'tester' } } }));
    expect(result.current.subagents).toEqual([{ runId: 'n1', name: 'tester' }]);
    // kill→resume: the backing run id changes; the stream follows it (spec §4)
    act(() => es.emit({ kind: 'event', event: { type: 'result', runId: 'run-b', nodeId: 'run-b', payload: {} } }));
    expect(result.current.runId).toBe('run-b');
  });

  it('ignores malformed frames and closes on unmount', () => {
    const { result, unmount } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit('not json{'));
    expect(result.current.subagents).toEqual([]);
    unmount();
    expect(es.closed).toBe(true);
  });
});
