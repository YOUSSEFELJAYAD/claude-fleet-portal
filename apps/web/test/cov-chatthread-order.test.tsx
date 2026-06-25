/**
 * cov-chatthread-order — Task 2.3 rewrite.
 * Old tests verified the run-based stitching / result-seq dedup in ChatThread;
 * that logic has moved server-side (turns are persisted entities, not manually
 * written by the client). These tests now verify the new-API rendering contract:
 * history turns + activeTurn render without duplication, and a turn that joins
 * history (activeTurn → null, turn in history) is shown exactly once.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatTurn, ChatMessage } from '@fleet/shared';
import type { ChatActiveTurn } from '../lib/live';

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...real,
    api: { ...real.api, chatTurns: vi.fn(async () => []), chatInterrupt: vi.fn(async () => {}) },
  };
});

const { ChatThread } = await import('../components/ChatThread');

const m = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: Math.random().toString(36).slice(2), sessionId: 's', role: 'user', kind: 'text',
  content: '', runId: null, turnId: 't0', createdAt: 0, ...over,
});
const t = (over: Partial<ChatTurn> & { msgs?: Partial<ChatMessage>[] } = {}): ChatTurn => {
  const { msgs = [], ...rest } = over;
  return {
    id: `turn-${Math.random().toString(36).slice(2)}`, sessionId: 's1', status: 'settled',
    messages: msgs.map(m), createdAt: Date.now(), settledAt: null, ...rest,
  };
};
const active = (turn: ChatTurn): ChatActiveTurn =>
  ({ turnId: turn.id, status: 'streaming', turn, events: [], partials: {} });
const noop = () => {};

afterEach(() => vi.clearAllMocks());

describe('ChatThread ordering (new API)', () => {
  it('does NOT duplicate an answer that is both in history and would appear in live if both existed (they never should — different ids)', () => {
    // history has the settled turn; activeTurn is a DIFFERENT turn (the next one)
    const settled = t({ id: 'settled-1', msgs: [{ content: 'Answer one', role: 'assistant' }] });
    const liveNext = t({ id: 'live-2', msgs: [{ content: 'Question two', role: 'user' }] });
    render(
      <ChatThread sessionId="s1" turns={[settled]} activeTurn={active(liveNext)} onRetry={noop} />,
    );
    expect(screen.getAllByText('Answer one')).toHaveLength(1);
    expect(screen.getAllByText('Question two')).toHaveLength(1);
  });

  it('shows the in-flight turn live, then only in history after it settles (no duplicate)', () => {
    const userTurn = t({ id: 'turn-1', msgs: [{ content: 'Q2', role: 'user' }] });
    const { rerender } = render(
      <ChatThread sessionId="s1" turns={[]} activeTurn={active(userTurn)} onRetry={noop} />,
    );
    expect(screen.getAllByText('Q2')).toHaveLength(1); // shown live

    // turn settles: page appends it to history, activeTurn goes null
    const settled = t({ id: 'turn-1', msgs: [{ content: 'Q2', role: 'user' }, { content: 'live answer', role: 'assistant' }] });
    rerender(<ChatThread sessionId="s1" turns={[settled]} activeTurn={null} onRetry={noop} />);
    expect(screen.getAllByText('live answer')).toHaveLength(1); // only in history
    expect(screen.getAllByText('Q2')).toHaveLength(1); // not doubled
  });

  it('renders prior turn from history and current live turn separately', () => {
    const hist = t({
      id: 'h1',
      msgs: [{ content: 'Q-a', role: 'user' }, { content: 'A-a', role: 'assistant' }],
    });
    const liveTurn = t({ id: 'live', msgs: [{ content: 'Q-b', role: 'user' }] });
    render(<ChatThread sessionId="s1" turns={[hist]} activeTurn={active(liveTurn)} onRetry={noop} />);
    expect(screen.getAllByText('A-a')).toHaveLength(1);
    expect(screen.getAllByText('Q-b')).toHaveLength(1);
  });
});
