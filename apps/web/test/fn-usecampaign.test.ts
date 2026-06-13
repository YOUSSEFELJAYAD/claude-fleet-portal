/**
 * Real tests for the useCampaign(id) hook — the per-campaign SSE channel (Orchestration Mode)
 * in apps/web/lib/live.ts. The fake EventSource (test/setup.ts) is the transport; the hook's
 * reducer logic (campaign-hello / campaign merge / task upsert+sort) runs for real.
 *
 * We feed server-shaped JSON frames and assert the hook's actual state transitions:
 *   - opens at /api/campaigns/${id}/stream; onopen→connected, onerror→disconnected
 *   - campaign-hello sets the campaign
 *   - task frames upsert-by-id and re-sort the tasks array by .seq ascending
 *   - a `campaign` frame merges campaign-level fields but PRESERVES the accumulated tasks
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCampaign } from '../lib/live';
import { FakeEventSource } from './setup';

describe('useCampaign', () => {
  it('opens the per-campaign SSE stream and tracks connected state', () => {
    const { result } = renderHook(() => useCampaign('c1'));
    const es = FakeEventSource.last();

    // URL is per-campaign and carries the id
    expect(es.url).toContain('/api/campaigns/c1/stream');
    // not connected until onopen fires
    expect(result.current.connected).toBe(false);
    expect(result.current.campaign).toBeNull();

    act(() => es.emitOpen());
    expect(result.current.connected).toBe(true);

    // a transport error flips connected back to false (stream still alive / reconnecting)
    act(() => es.emitError());
    expect(result.current.connected).toBe(false);
  });

  it('reduces hello → task upsert/sort → campaign merge, preserving tasks', () => {
    const { result } = renderHook(() => useCampaign('c1'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());

    // campaign-hello seeds the campaign (empty tasks)
    act(() => es.emit({ kind: 'campaign-hello', campaign: { id: 'c1', status: 'running', tasks: [] } } as any));
    expect(result.current.campaign).toEqual({ id: 'c1', status: 'running', tasks: [] });

    // tasks arrive out of order — they must be re-sorted ascending by .seq
    act(() => es.emit({ kind: 'task', task: { id: 't2', seq: 2, status: 'pending' } } as any));
    act(() => es.emit({ kind: 'task', task: { id: 't1', seq: 1, status: 'pending' } } as any));
    expect((result.current.campaign as any).tasks.map((t: any) => t.id)).toEqual(['t1', 't2']);
    expect((result.current.campaign as any).tasks.map((t: any) => t.seq)).toEqual([1, 2]);

    // an update for an existing id REPLACES the task in place (no duplicate row)
    act(() => es.emit({ kind: 'task', task: { id: 't1', seq: 1, status: 'done' } } as any));
    expect((result.current.campaign as any).tasks).toHaveLength(2);
    const t1 = (result.current.campaign as any).tasks.find((t: any) => t.id === 't1') as any;
    expect(t1.status).toBe('done');
    // still sorted ascending after the replace
    expect((result.current.campaign as any).tasks.map((t: any) => t.id)).toEqual(['t1', 't2']);

    // a campaign-level frame merges new fields (status) but PRESERVES the accumulated tasks,
    // even though the incoming campaign carries no tasks of its own.
    act(() => es.emit({ kind: 'campaign', campaign: { id: 'c1', status: 'completed' } } as any));
    expect((result.current.campaign as any).status).toBe('completed');
    expect((result.current.campaign as any).tasks.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });

  it('ignores task frames that arrive before any campaign exists', () => {
    const { result } = renderHook(() => useCampaign('c1'));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());

    // no campaign-hello yet → a stray task must be dropped (campaign stays null, no throw)
    act(() => es.emit({ kind: 'task', task: { id: 't9', seq: 9, status: 'pending' } } as any));
    expect(result.current.campaign).toBeNull();
  });

  it('ignores malformed frames and closes the stream on unmount', () => {
    const { result, unmount } = renderHook(() => useCampaign('c1'));
    const es = FakeEventSource.last();
    act(() => es.emit('not json{')); // must not throw / must be ignored
    expect(result.current.campaign).toBeNull();
    unmount();
    expect(es.closed).toBe(true);
  });
});
