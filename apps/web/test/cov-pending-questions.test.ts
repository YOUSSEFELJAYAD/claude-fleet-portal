import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({ api: { inbox: vi.fn() } }));
import { api } from '../lib/api';
import { usePendingQuestions } from '../lib/live';

const item = (sessionId: string) => ({
  kind: 'question',
  question: {
    id: 'g-' + sessionId,
    sessionId,
    question: 'Q?',
    options: ['a', 'b'],
    multiSelect: false,
    allowFreeText: false,
    createdAt: 0,
  },
});

describe('usePendingQuestions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns only questions for the given session', async () => {
    (api.inbox as any).mockResolvedValue({ items: [item('s1'), item('s2')] });
    const { result } = renderHook(() => usePendingQuestions('s1'));
    // let the initial fetch microtasks complete
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    expect(result.current.questions[0].sessionId).toBe('s1');
  });

  it('returns empty for a null session and does not poll', () => {
    const { result } = renderHook(() => usePendingQuestions(null));
    expect(result.current.questions).toEqual([]);
    expect(api.inbox).not.toHaveBeenCalled();
  });

  it('refresh triggers an immediate re-fetch', async () => {
    (api.inbox as any).mockResolvedValue({ items: [item('s1')] });
    const { result } = renderHook(() => usePendingQuestions('s1'));
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));

    // now update the mock to return empty and call refresh
    (api.inbox as any).mockResolvedValue({ items: [] });
    act(() => { result.current.refresh(); });
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(result.current.questions).toHaveLength(0));
  });
});
