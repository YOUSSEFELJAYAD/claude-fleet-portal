import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../lib/live';
import { FakeEventSource } from './setup';

const ev = (type: string, nodeId: string, payload: any = {}): any =>
  ({ sessionId: 's', runId: 'run1', nodeId, parentNodeId: null, nodeType: 'root', seq: 0, ts: 0, type, payload });

describe('useChatStream', () => {
  it('subscribes to the chat-scoped stream and reduces events + partials + state', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/chat/sessions/sess1/stream');

    act(() => es.emit({ kind: 'session_state', state: 'running', live: true } as any));
    expect(result.current.state).toBe('running');

    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'Hel' }) } as any));
    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'lo' }) } as any));
    expect(result.current.partials).toEqual({ n1: 'Hello' });

    act(() => es.emit({ kind: 'event', event: ev('tool_use', 'n1', { name: 'Read' }) } as any));
    expect(result.current.events.map((e: any) => e.type)).toEqual(['tool_use']);
  });

  it('session_state to idle clears nothing but updates state', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'session_state', state: 'idle', live: false } as any));
    expect(result.current.state).toBe('idle');
  });
});
