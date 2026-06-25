/**
 * Coverage tests for useChatStream turn-scoped lifecycle (Task 2.1).
 * Tests the full frame sequence and verifies no run-status-based
 * turn-boundary inference exists.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../lib/live';
import { FakeEventSource } from './setup';

const ev = (type: string, nodeId: string, payload: any = {}): any => ({
  sessionId: 'sess1',
  runId: 'run1',
  nodeId,
  parentNodeId: null,
  nodeType: 'root',
  seq: 0,
  ts: 0,
  type,
  payload,
});

const makeTurn = (id = 't1'): any => ({
  id,
  sessionId: 'sess1',
  status: 'streaming',
  messages: [{ role: 'user', content: 'Hi', id: 'msg-1', createdAt: 0 }],
  createdAt: 0,
  settledAt: null,
});

describe('useChatStream (coverage)', () => {
  it('subscribes to the chat-scoped stream and handles session_state → events → settled lifecycle', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/chat/sessions/sess1/stream');

    act(() => es.emit({ kind: 'session_state', state: 'running' }));
    expect(result.current.state).toBe('running');

    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_partial', 'n1', { text: 'Hel' }) }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_partial', 'n1', { text: 'lo' }) }));
    expect(result.current.activeTurn!.partials).toEqual({ n1: 'Hello' });

    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('tool_use', 'n1', { name: 'Read' }) }));
    expect(result.current.activeTurn!.events.map((e: any) => e.type)).toEqual(['tool_use']);

    act(() => es.emit({ kind: 'turn:settled', turnId: 't1', assistantMessageId: 'msg-a' }));
    expect(result.current.activeTurn).toBeNull();
  });

  it('session_state to idle only updates state, does not clear activeTurn', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'session_state', state: 'idle' }));
    expect(result.current.state).toBe('idle');
    expect(result.current.activeTurn).toBeNull();
  });

  it('NO run-status-based turn-boundary inference: session_state changes leave activeTurn intact', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();

    act(() => es.emit({ kind: 'turn:start', turn: makeTurn('t1') }));
    act(() => es.emit({ kind: 'turn:event', turnId: 't1', event: ev('assistant_text', 'n1', { text: 'reply' }) }));
    expect(result.current.activeTurn!.events.length).toBe(1);

    // In the OLD implementation a `run: { status: 'awaiting-input' }` → `run: { status: 'running' }`
    // sequence would drop activeTurn.events.  The new implementation has NO run frames at all.
    act(() => es.emit({ kind: 'session_state', state: 'running' }));
    expect(result.current.activeTurn).not.toBeNull();
    expect(result.current.activeTurn!.events.length).toBe(1);
  });
});
