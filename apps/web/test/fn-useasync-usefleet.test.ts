/**
 * Real tests for two web hooks (canary for the harness):
 *   useAsync  — promise-backed one-shot fetch helper (loading/data/error/reload)
 *   useFleet  — fleet-wide SSE channel (hello/run/run-removed/spend reducers)
 * The fake EventSource (test/setup.ts) is the transport; the hook's reducer logic is real.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsync, useFleet } from '../lib/live';
import { FakeEventSource } from './setup';

describe('useAsync', () => {
  it('starts loading, then resolves to data', async () => {
    const { result } = renderHook(() => useAsync(() => Promise.resolve(42), []));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeNull();
  });

  it('captures a rejection as an error string', async () => {
    const { result } = renderHook(() => useAsync(() => Promise.reject(new Error('boom')), []));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });

  it('reload re-runs the async fn', async () => {
    let calls = 0;
    const { result } = renderHook(() => useAsync(async () => ++calls, []));
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe(2));
  });
});

describe('useFleet', () => {
  it('opens an SSE connection and reduces hello/run/run-removed/spend frames', async () => {
    const { result } = renderHook(() => useFleet());
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/fleet/stream');
    expect(result.current.connected).toBe(false);

    act(() => es.emitOpen());
    expect(result.current.connected).toBe(true);

    act(() => es.emit({
      kind: 'fleet-hello',
      runs: [{ id: 'r1', startedAt: 10 }, { id: 'r2', startedAt: 20 }],
      spend: { totalUsd: 1 },
    }));
    // sorted by startedAt DESC
    expect(result.current.runs.map((r: any) => r.id)).toEqual(['r2', 'r1']);
    expect(result.current.spend).toEqual({ totalUsd: 1 });

    act(() => es.emit({ kind: 'run', run: { id: 'r3', startedAt: 30 } }));
    expect(result.current.runs.map((r: any) => r.id)).toEqual(['r3', 'r2', 'r1']);

    act(() => es.emit({ kind: 'run-removed', runId: 'r2' }));
    expect(result.current.runs.map((r: any) => r.id)).toEqual(['r3', 'r1']);

    act(() => es.emit({ kind: 'spend', spend: { totalUsd: 5 } }));
    expect(result.current.spend).toEqual({ totalUsd: 5 });

    act(() => es.emitError());
    expect(result.current.connected).toBe(false);
  });

  it('ignores malformed frames and closes the stream on unmount', () => {
    const { result, unmount } = renderHook(() => useFleet());
    const es = FakeEventSource.last();
    act(() => es.emit('not json{')); // must not throw / must be ignored
    expect(result.current.runs).toEqual([]);
    unmount();
    expect(es.closed).toBe(true);
  });
});
