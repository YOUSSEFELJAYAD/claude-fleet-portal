/**
 * Real tests for the per-run SSE hook:
 *   useRunStream(id) — opens `/api/agents/${id}/stream` and reduces the server's
 *   StreamMessage frames (hello/run/node/event + the {error} terminator) into
 *   {run, nodes, tree, events, partials, connected, error, truncatedBefore}.
 * The fake EventSource (test/setup.ts) is the transport; the hook's reducer logic
 * (partial accumulation, node upsert, tree derivation, error→close) runs for real.
 * Frames are cast `as any` — vitest does not typecheck, and the contract is what we assert.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRunStream } from '../lib/live';
import { FakeEventSource } from './setup';

// Minimal RunNode-shaped node (cast away the rest of the interface at the call site).
const node = (id: string, parentId: string | null, startedAt = 0): any => ({
  id,
  parentId,
  startedAt,
  nodeType: 'root',
  status: 'running',
});

// Minimal NormalizedEvent-shaped frame.
const ev = (type: string, nodeId: string, payload: any = {}): any => ({
  sessionId: 's',
  runId: 'run1',
  nodeId,
  parentNodeId: null,
  nodeType: 'root',
  seq: 0,
  ts: 0,
  type,
  payload,
});

describe('useRunStream', () => {
  it('opens the per-run SSE channel and toggles connected on open/error', () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/agents/run1/stream');
    expect(result.current.connected).toBe(false);

    act(() => es.emitOpen());
    expect(result.current.connected).toBe(true);

    act(() => es.emitError());
    expect(result.current.connected).toBe(false);
  });

  it('hello populates run, nodeMap and events, sets truncatedBefore, clears partials', () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    // seed a partial first so we can prove hello clears it
    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'hi' }) } as any));
    expect(result.current.partials).toEqual({ n1: 'hi' });

    act(() =>
      es.emit({
        kind: 'hello',
        run: { id: 'run1', startedAt: 1 },
        nodes: [node('n1', null, 0), node('n2', 'n1', 5)],
        events: [ev('init', 'n1')],
        truncatedBefore: 42,
      } as any),
    );

    expect(result.current.run).toEqual({ id: 'run1', startedAt: 1 });
    // nodeMap → derived nodes array, both nodes present
    expect(result.current.nodes.map((n: any) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(result.current.events.map((e: any) => e.type)).toEqual(['init']);
    expect(result.current.partials).toEqual({}); // cleared by hello
    expect(result.current.truncatedBefore).toBe(42);
  });

  it("kind:'run' replaces run; kind:'node' upserts into the node map", () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    act(() =>
      es.emit({
        kind: 'hello',
        run: { id: 'run1', startedAt: 1, status: 'running' },
        nodes: [node('n1', null, 0)],
        events: [],
      } as any),
    );
    expect((result.current.run as any).status).toBe('running');

    // run frame swaps the whole run object
    act(() => es.emit({ kind: 'run', run: { id: 'run1', startedAt: 1, status: 'done' } } as any));
    expect((result.current.run as any).status).toBe('done');

    // node frame for a NEW id → inserted
    act(() => es.emit({ kind: 'node', node: node('n2', 'n1', 5) } as any));
    expect(result.current.nodes.map((n: any) => n.id).sort()).toEqual(['n1', 'n2']);

    // node frame for an EXISTING id → updated in place (upsert, not duplicate)
    act(() => es.emit({ kind: 'node', node: { ...node('n1', null, 0), status: 'done' } } as any));
    expect(result.current.nodes.length).toBe(2);
    expect((result.current.nodes.find((n: any) => n.id === 'n1') as any).status).toBe('done');
  });

  it('assistant_partial frames accumulate per node into partials (not events)', () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'Hel' }) } as any));
    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'lo' }) } as any));
    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n2', { text: 'X' }) } as any));

    expect(result.current.partials).toEqual({ n1: 'Hello', n2: 'X' });
    expect(result.current.events).toEqual([]); // partials never land in the events log
  });

  it('assistant_text clears that node\'s partial AND appends the event', () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'streaming...' }) } as any));
    expect(result.current.partials.n1).toBe('streaming...');

    act(() => es.emit({ kind: 'event', event: ev('assistant_text', 'n1', { text: 'final' }) } as any));
    expect(result.current.partials.n1).toBe(''); // buffer cleared for that node
    expect(result.current.events.map((e: any) => e.type)).toEqual(['assistant_text']);
  });

  it('non-partial events append to the events log and leave partials untouched', () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'buf' }) } as any));
    act(() => es.emit({ kind: 'event', event: ev('tool_use', 'n1', { name: 'Read' }) } as any));
    act(() => es.emit({ kind: 'event', event: ev('tool_result', 'n1') } as any));

    expect(result.current.events.map((e: any) => e.type)).toEqual(['tool_use', 'tool_result']);
    expect(result.current.partials).toEqual({ n1: 'buf' }); // untouched by non-text events
  });

  it('derives a tree from the node map rooted at id', async () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    act(() =>
      es.emit({
        kind: 'hello',
        run: { id: 'run1', startedAt: 0 },
        // root id must equal the run id ('run1') for buildTree to root correctly
        nodes: [node('run1', null, 0), node('child-b', 'run1', 20), node('child-a', 'run1', 10)],
        events: [],
      } as any),
    );

    await waitFor(() => expect(result.current.tree).not.toBeNull());
    const tree: any = result.current.tree;
    expect(tree.id).toBe('run1');
    // children sorted by startedAt ASC (buildTree contract)
    expect(tree.children.map((c: any) => c.id)).toEqual(['child-a', 'child-b']);
  });

  it("{error:'not found'} sets error AND closes the EventSource (no reconnect loop)", () => {
    const { result } = renderHook(() => useRunStream('gone'));
    const es = FakeEventSource.last();

    act(() => es.emit({ error: 'not found' } as any));
    expect(result.current.error).toBe('not found');
    expect(FakeEventSource.last().closed).toBe(true);
  });

  it('ignores malformed (non-JSON) frames without throwing', () => {
    const { result } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();

    act(() => es.emit('this is not json{')); // must be swallowed
    expect(result.current.run).toBeNull();
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useRunStream('run1'));
    const es = FakeEventSource.last();
    unmount();
    expect(es.closed).toBe(true);
  });
});
