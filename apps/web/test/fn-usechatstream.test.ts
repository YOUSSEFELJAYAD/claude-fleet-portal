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

describe('useChatStream — event reduction', () => {
  it('accumulates assistant_partial deltas per node and clears on assistant_text', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'Hel' }) }));
    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'lo' }) }));
    expect(result.current.partials).toEqual({ n1: 'Hello' });
    // full message arrives → partial buffer for that node clears, event lands in events
    act(() => es.emit({ kind: 'event', event: ev('assistant_text', 'n1', { text: 'Hello' }) }));
    expect(result.current.partials).toEqual({ n1: '' });
    expect(result.current.events.map((e) => e.type)).toEqual(['assistant_text']);
  });

  it('appends non-partial run events (tool_use, tool_result, permission_request, result)', () => {
    const { result } = renderHook(() => useChatStream('sess1'));
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: 'event', event: ev('tool_use', 'n1', { name: 'Bash' }) }));
    act(() => es.emit({ kind: 'event', event: ev('tool_result', 'n1', { ok: true }) }));
    act(() => es.emit({ kind: 'event', event: ev('permission_request', 'n1', { id: 'p1' }) }));
    act(() => es.emit({ kind: 'event', event: ev('result', 'n1', {}) }));
    expect(result.current.events.map((e) => e.type)).toEqual([
      'tool_use', 'tool_result', 'permission_request', 'result',
    ]);
  });
});
