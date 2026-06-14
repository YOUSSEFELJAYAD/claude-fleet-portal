/**
 * useChatStream(sessionId) — subscribes to the SESSION (not a run id) at
 * /api/chat/sessions/:id/stream and reduces the existing run-event vocabulary
 * (assistant_partial/assistant_text/tool_use/...) PLUS the chat-control `session_state`
 * envelope { state, live }. The FakeEventSource (test/setup.ts) is the transport.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../lib/live';
import { FakeEventSource } from './setup';

const ev = (type: string, nodeId: string, payload: any = {}): any => ({
  sessionId: 's', runId: 'run1', nodeId, parentNodeId: null, nodeType: 'root', seq: 0, ts: 0, type, payload,
});

describe('useChatStream — connection + session_state', () => {
  it('opens the chat-scoped SSE channel and toggles connected', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/chat/sessions/sess1/stream');
    expect(result.current.connected).toBe(false);
    act(() => es.emitOpen());
    expect(result.current.connected).toBe(true);
    act(() => es.emitError());
    expect(result.current.connected).toBe(false);
  });

  it('reduces the session_state envelope into state + live', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    expect(result.current.state).toBe('idle'); // default before any frame
    act(() => es.emit({ kind: 'session_state', state: 'running', live: true } as any));
    expect(result.current.state).toBe('running');
    expect(result.current.live).toBe(true);
    act(() => es.emit({ kind: 'session_state', state: 'killed', live: false } as any));
    expect(result.current.state).toBe('killed');
    expect(result.current.live).toBe(false);
  });

  it('closes the stream on unmount and ignores malformed frames', () => {
    const { unmount } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    act(() => es.emit('not json{'));
    unmount();
    expect(es.closed).toBe(true);
  });
});
