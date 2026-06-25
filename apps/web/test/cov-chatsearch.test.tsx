/**
 * cov-chatsearch — Task 3.3 chat search UI tests.
 * (a) typing a query (after debounce) renders hits from a mocked api.searchChat
 * (b) clicking a hit invokes the open-at-turn handler with { sessionId, turnId }
 * (c) stale-request abort: two fast queries → only the latest results render
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatSearchHit } from '@fleet/shared';

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      searchChat: vi.fn(async () => [] as ChatSearchHit[]),
    },
  };
});

// Import AFTER mock registration so the component picks up the mock.
const { ChatSearch } = await import('../components/ChatSearch');
const { api } = await import('@/lib/api');

function mkHit(over: Partial<ChatSearchHit> = {}): ChatSearchHit {
  return {
    sessionId: 'sess-1',
    sessionTitle: 'My Session',
    turnId: 'turn-1',
    messageId: 'msg-1',
    role: 'assistant',
    snippet: 'hello world',
    createdAt: Date.now(),
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ChatSearch', () => {
  it('(a) typing a query renders hits from api.searchChat after the 200ms debounce', async () => {
    const hit = mkHit({ snippet: 'the answer', sessionTitle: 'Alpha Session' });
    vi.mocked(api.searchChat).mockResolvedValue([hit]);

    render(<ChatSearch onOpenAtTurn={() => {}} />);
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'answer' } });
    await vi.advanceTimersByTimeAsync(300); // past the 200ms debounce

    await waitFor(() => expect(screen.getByText('the answer')).toBeTruthy());
    expect(screen.getByText('Alpha Session')).toBeTruthy();
  });

  it('(b) clicking a hit calls onOpenAtTurn with { sessionId, turnId }', async () => {
    const hit = mkHit({ sessionId: 's1', turnId: 't1', snippet: 'click me', sessionTitle: 'S1' });
    vi.mocked(api.searchChat).mockResolvedValue([hit]);
    const onOpenAtTurn = vi.fn();

    render(<ChatSearch onOpenAtTurn={onOpenAtTurn} />);
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'click' } });
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => screen.getByText('click me'));
    fireEvent.click(screen.getByText('click me'));
    expect(onOpenAtTurn).toHaveBeenCalledWith('s1', 't1');
  });

  it('(c) only the latest query results render when a stale request resolves after a fresh one', async () => {
    let resolveStale!: (hits: ChatSearchHit[]) => void;
    const staleProm = new Promise<ChatSearchHit[]>((res) => { resolveStale = res; });

    vi.mocked(api.searchChat)
      .mockReturnValueOnce(staleProm) // first call: stays pending until we resolve it
      .mockResolvedValueOnce([mkHit({ snippet: 'fresh result' })]); // second call: immediate

    render(<ChatSearch onOpenAtTurn={() => {}} />);
    const input = screen.getByRole('searchbox');

    // First query: debounce fires, stale request goes in-flight
    fireEvent.change(input, { target: { value: 'a' } });
    await vi.advanceTimersByTimeAsync(250); // past 200ms debounce

    // Second query before first resolves: debounce fires, fresh request resolves immediately
    fireEvent.change(input, { target: { value: 'b' } });
    await vi.advanceTimersByTimeAsync(250);

    await waitFor(() => screen.getByText('fresh result'));

    // Now resolve the stale promise — should NOT update the DOM
    resolveStale([mkHit({ snippet: 'stale result' })]);
    await Promise.resolve(); // flush microtasks

    expect(screen.queryByText('stale result')).toBeNull();
  });
});
