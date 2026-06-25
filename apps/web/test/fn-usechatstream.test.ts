/**
 * Real tests for the chat-session SSE hook (turn-scoped frames, Task 2.1).
 * useChatStream(sessionId) consumes ChatStreamFrame from
 * GET /api/chat/sessions/:id/stream and returns
 * { state, activeTurn, error }.
 *
 * FakeEventSource is the transport; reducer logic runs for real.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../lib/live';
import { FakeEventSource } from './setup';

const makeTurn = (id = 'turn-1'): any => ({
  id,
  sessionId: 'sess-1',
  status: 'streaming',
  messages: [{ role: 'user', content: 'Hello', id: 'msg-u1', createdAt: 0 }],
  createdAt: 0,
  settledAt: null,
});

const ev = (type: string, nodeId: string, payload: any = {}): any => ({
  sessionId: 'sess-1',
  runId: 'run-1',
  nodeId,
  parentNodeId: null,
  nodeType: 'root',
  seq: 0,
  ts: 0,
  type,
  payload,
});

describe('useChatStream (turn-scoped SSE)', () => {
  it('subscribes to the chat-scoped stream by session id', () => {
    renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/chat/sessions/sess-1/stream');
  });

  it('returns idle state and null activeTurn initially', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    expect(result.current.state).toBe('idle');
    expect(result.current.activeTurn).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('null sessionId does not open a stream', () => {
    renderHook(() => useChatStream(null));
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it('session_state frame sets state', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'session_state', state: 'running' }));
    expect(result.current.state).toBe('running');
    act(() => es.emit({ kind: 'session_state', state: 'idle' }));
    expect(result.current.state).toBe('idle');
  });

  it('turn:start sets activeTurn with empty events/partials', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    expect(result.current.activeTurn).not.toBeNull();
    expect(result.current.activeTurn!.turnId).toBe('t1');
    expect(result.current.activeTurn!.events).toEqual([]);
    expect(result.current.activeTurn!.partials).toEqual({});
  });

  it('turn:event assistant_partial accumulates into partials (not events)', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_partial', 'n1', { text: 'Hel' }) }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_partial', 'n1', { text: 'lo' }) }));
    expect(result.current.activeTurn!.partials).toEqual({ n1: 'Hello' });
    expect(result.current.activeTurn!.events).toEqual([]);
  });

  it('turn:event assistant_text clears partial and appends to events', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_partial', 'n1', { text: 'streaming' }) }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_text', 'n1', { text: 'done' }) }));
    expect(result.current.activeTurn!.partials.n1).toBe('');
    expect(result.current.activeTurn!.events.map((e: any) => e.type)).toEqual(['assistant_text']);
  });

  it('turn:settled clears activeTurn (turn is now in persisted history)', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('tool_use', 'n1') }));
    act(() => es.emit({ kind: 'turn:settled', turnId: 't1', assistantMessageId: 'msg-a' }));
    expect(result.current.activeTurn).toBeNull();
  });

  it('turn:failed sets status=failed and retains events for retry UI', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('tool_use', 'n1') }));
    act(() => es.emit({ kind: 'turn:failed', turnId: 't1', error: 'timeout' }));
    expect(result.current.activeTurn).not.toBeNull();
    expect(result.current.activeTurn!.status).toBe('failed');
    expect(result.current.activeTurn!.events.length).toBe(1);
  });

  it('error frame sets error and closes the EventSource (no reconnect loop)', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'error', error: 'session not found' }));
    expect(result.current.error).toBe('session not found');
    expect(es.closed).toBe(true);
  });

  it('turn:event with wrong turnId is ignored (guard against out-of-order frames)', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 'stale-turn', event: ev('tool_use', 'n1') }));
    expect(result.current.activeTurn!.events).toEqual([]);
  });

  it('ignores malformed frames and closes on unmount', () => {
    const { result, unmount } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit('not json{'));
    expect(result.current.activeTurn).toBeNull();
    unmount();
    expect(es.closed).toBe(true);
  });

  it('return value has NO runId, live, subagents, run fields (old machinery deleted)', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    expect('runId' in result.current).toBe(false);
    expect('live' in result.current).toBe(false);
    expect('subagents' in result.current).toBe(false);
    expect('run' in result.current).toBe(false);
  });

  it('second turn:start after settled sets fresh activeTurn', () => {
    const { result } = renderHook(() => useChatStream('sess-1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_partial', 'n1', { text: 'hi' }) }));
    act(() => es.emit({ kind: 'turn:settled', turnId: 't1', assistantMessageId: 'msg-a' }));
    expect(result.current.activeTurn).toBeNull();

    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t2') }));
    expect(result.current.activeTurn!.turnId).toBe('t2');
    expect(result.current.activeTurn!.partials).toEqual({});
    expect(result.current.activeTurn!.events).toEqual([]);
  });
});
