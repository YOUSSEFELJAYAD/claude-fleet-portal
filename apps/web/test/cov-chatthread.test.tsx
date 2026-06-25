/**
 * cov-chatthread — Task 2.3 new-API tests.
 * ChatThread now accepts: sessionId, turns (settled history), activeTurn (live), onRetry.
 * It renders <Turn> for each history turn then <Turn active={…}> for the live turn.
 * It exposes a "load older" trigger to paginate history via api.chatTurns.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatTurn, ChatMessage } from '@fleet/shared';
import type { ChatActiveTurn } from '../lib/live';

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      chatTurns: vi.fn(async () => []),
      chatInterrupt: vi.fn(async () => {}),
    },
  };
});

// Import AFTER mock registration so the component picks up the mock.
const { ChatThread } = await import('../components/ChatThread');
const { api } = await import('@/lib/api');

function mkMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${Math.random().toString(36).slice(2)}`,
    sessionId: 's1', role: 'user', kind: 'text', content: '',
    runId: null, turnId: 't0', createdAt: 0, ...over,
  };
}

function mkTurn(over: Partial<ChatTurn> & { msgs?: Partial<ChatMessage>[] } = {}): ChatTurn {
  const { msgs = [], ...rest } = over;
  return {
    id: `turn-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1', status: 'settled',
    messages: msgs.map((m) => mkMsg(m)),
    createdAt: Date.now(), settledAt: Date.now(), ...rest,
  };
}

function mkActive(turn: ChatTurn, status: ChatActiveTurn['status'] = 'streaming'): ChatActiveTurn {
  return { turnId: turn.id, status, turn, events: [], partials: {} };
}

const noop = () => {};

afterEach(() => vi.clearAllMocks());

describe('ChatThread (new prop API)', () => {
  it('renders history turns in document order, active turn last', () => {
    const t1 = mkTurn({ id: 'A', msgs: [{ content: 'first', role: 'user' }] });
    const t2 = mkTurn({ id: 'B', msgs: [{ content: 'second', role: 'user' }] });
    const live = mkTurn({ id: 'C', msgs: [{ content: 'live question', role: 'user' }] });
    render(
      <ChatThread sessionId="s1" turns={[t1, t2]} activeTurn={mkActive(live)} onRetry={noop} />,
    );
    const body = document.body.textContent ?? '';
    const i1 = body.indexOf('first');
    const i2 = body.indexOf('second');
    const iL = body.indexOf('live question');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(iL).toBeGreaterThan(i2);
  });

  it('does NOT duplicate a settled turn when a different activeTurn is live', () => {
    const hist = mkTurn({ id: 'hist-1', msgs: [{ content: 'settled reply', role: 'assistant' }] });
    const live = mkTurn({ id: 'live-1', msgs: [{ content: 'new question', role: 'user' }] });
    render(
      <ChatThread sessionId="s1" turns={[hist]} activeTurn={mkActive(live)} onRetry={noop} />,
    );
    expect(screen.getAllByText('settled reply')).toHaveLength(1);
    expect(screen.getAllByText('new question')).toHaveLength(1);
  });

  it('renders only history when activeTurn is null', () => {
    const t = mkTurn({ id: 't1', msgs: [{ content: 'history only', role: 'user' }] });
    render(<ChatThread sessionId="s1" turns={[t]} activeTurn={null} onRetry={noop} />);
    expect(screen.getByText('history only')).toBeTruthy();
  });

  it('calls api.chatTurns with the oldest turn createdAt as cursor when "load older" is clicked', async () => {
    const old = mkTurn({ id: 'old', createdAt: 1000 });
    const newer = mkTurn({ id: 'new', createdAt: 2000 });
    render(
      <ChatThread sessionId="s1" turns={[old, newer]} activeTurn={null} onRetry={noop} />,
    );
    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => expect(api.chatTurns).toHaveBeenCalledWith('s1', 1000));
  });

  it('prepends older turns above existing history after "load older"', async () => {
    const older = mkTurn({ id: 'even-older', createdAt: 500, msgs: [{ content: 'ancient msg', role: 'user' }] });
    vi.mocked(api.chatTurns).mockResolvedValueOnce([older]);
    const current = mkTurn({ id: 'curr', createdAt: 1000, msgs: [{ content: 'current msg', role: 'user' }] });
    render(<ChatThread sessionId="s1" turns={[current]} activeTurn={null} onRetry={noop} />);
    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => screen.getByText('ancient msg'));
    const body = document.body.textContent ?? '';
    expect(body.indexOf('ancient msg')).toBeLessThan(body.indexOf('current msg'));
  });

  it('calls onRetry with the failed turn when the retry button is clicked', () => {
    const onRetry = vi.fn();
    const failed = mkTurn({
      id: 'fail-1', status: 'failed',
      msgs: [{ content: 'user question', role: 'user' }],
    });
    render(<ChatThread sessionId="s1" turns={[failed]} activeTurn={null} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it('shows a stop button while the active turn is in flight', () => {
    const live = mkTurn({ id: 'live', msgs: [{ content: 'q', role: 'user' }] });
    render(<ChatThread sessionId="s1" turns={[]} activeTurn={mkActive(live, 'streaming')} onRetry={noop} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
  });
});
