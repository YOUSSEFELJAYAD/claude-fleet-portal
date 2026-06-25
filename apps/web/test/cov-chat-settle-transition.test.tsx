/**
 * cov-chat-settle-transition — Task 2.3 review fixes C2 / CV1.
 *
 * Tests the gapless settle (C1) and failed-turn-to-history (CV1) contracts at the
 * ChatThread level (dedup gate) and via a thin page-logic harness (state transitions).
 *
 * The harness replicates ONLY the settle/fail effects from page.tsx so we can assert
 * rendering continuously without mocking the full ChatPage.
 */
import React, { useEffect, useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
const { api } = await import('@/lib/api');

// ── helpers ───────────────────────────────────────────────────────────────────

const mkMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  sessionId: 's1', role: 'user', kind: 'text', content: 'User Q',
  runId: null, turnId: 't1', createdAt: 0, ...over,
});

const mkTurn = (over: Partial<ChatTurn> = {}): ChatTurn => ({
  id: 'turn-1', sessionId: 's1', status: 'settled',
  messages: [mkMsg()], createdAt: 0, settledAt: null, ...over,
});

const mkActive = (turn: ChatTurn, status: ChatActiveTurn['status'] = 'streaming'): ChatActiveTurn =>
  ({ turnId: turn.id, status, turn, events: [], partials: {} });

const noop = () => {};

afterEach(() => vi.clearAllMocks());

// ── thin harness that replicates page.tsx's settle + failed effects ────────────

function PageLogicHarness({
  initialActive,
  sessionId = 's1',
}: {
  initialActive: ChatActiveTurn | null;
  sessionId?: string;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [activeTurn, setActiveTurn] = useState<ChatActiveTurn | null>(initialActive);

  // Expose a handle so tests can drive state (mirrors the SSE driving activeTurn in the page)
  (PageLogicHarness as any)._setActiveTurn = setActiveTurn;

  // Settle effect — mirrors page.tsx
  useEffect(() => {
    if (activeTurn?.status === 'settled' && sessionId) {
      const turnId = activeTurn.turnId;
      api.chatTurns(sessionId).then((fresh) => {
        setTurns((existing) => {
          const knownIds = new Set(existing.map((t) => t.id));
          const newOnes = fresh.filter((t) => !knownIds.has(t.id));
          return newOnes.length ? [...existing, ...newOnes] : existing;
        });
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurn?.status, activeTurn?.turnId, sessionId]);

  // Failed-turn effect — mirrors page.tsx
  useEffect(() => {
    if (activeTurn?.status === 'failed' && sessionId) {
      const { turnId, turn } = activeTurn;
      const failedTurn: ChatTurn = {
        id: turnId, sessionId, status: 'failed',
        messages: turn.messages, createdAt: turn.createdAt, settledAt: null,
      };
      setTurns((existing) => existing.some((t) => t.id === turnId) ? existing : [...existing, failedTurn]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurn?.status, activeTurn?.turnId, sessionId]);

  return <ChatThread sessionId={sessionId} turns={turns} activeTurn={activeTurn} onRetry={noop} />;
}

// ── C1: gapless settle ────────────────────────────────────────────────────────

describe('C1: gapless settle (ChatThread dedup gate)', () => {
  it('deduplicates: active card hidden when its turnId is already in history', () => {
    const turn = mkTurn({ id: 'turn-a', status: 'settled', messages: [mkMsg({ content: 'User Q', role: 'user' })] });
    const active = mkActive(turn, 'settled');
    render(
      <ChatThread sessionId="s1" turns={[turn]} activeTurn={active} onRetry={noop} />,
    );
    // Turn is visible exactly once — active card is suppressed because turn is in history
    expect(screen.getAllByText('User Q')).toHaveLength(1);
  });

  it('active card visible when its turnId is NOT in history (during refetch gap)', () => {
    const turn = mkTurn({ id: 'turn-b', status: 'settled', messages: [mkMsg({ content: 'Gapped Q', role: 'user' })] });
    const active = mkActive(turn, 'settled');
    // History is empty (refetch not yet complete)
    render(
      <ChatThread sessionId="s1" turns={[]} activeTurn={active} onRetry={noop} />,
    );
    // Turn is visible as active card during the gap
    expect(screen.getByText('Gapped Q')).toBeTruthy();
  });
});

describe('C2: settle transition is gapless (page-logic harness)', () => {
  it('turn is visible at every render frame during settle — never absent, never duplicated', async () => {
    // Arrange: async refetch resolves AFTER we check the gap
    let resolveRefetch!: (turns: ChatTurn[]) => void;
    const refetchPromise = new Promise<ChatTurn[]>((r) => { resolveRefetch = r; });
    vi.mocked(api.chatTurns).mockReturnValueOnce(refetchPromise);

    const userTurn = mkTurn({ id: 'gap-turn', status: 'streaming', messages: [mkMsg({ content: 'Gap test Q', role: 'user' })] });
    const active = mkActive(userTurn, 'streaming');

    render(<PageLogicHarness initialActive={active} />);
    expect(screen.getByText('Gap test Q')).toBeTruthy(); // visible as active

    // Transition activeTurn to status='settled' (SSE fired turn:settled)
    act(() => {
      (PageLogicHarness as any)._setActiveTurn(mkActive(userTurn, 'settled'));
    });

    // During refetch gap: turn STILL visible (active card, dedup not yet engaged)
    expect(screen.getByText('Gap test Q')).toBeTruthy();

    // Refetch resolves with settled turn in history
    const settledInHistory = mkTurn({
      id: 'gap-turn', status: 'settled',
      messages: [mkMsg({ content: 'Gap test Q', role: 'user' }), mkMsg({ content: 'Assistant reply', role: 'assistant' })],
    });
    await act(async () => { resolveRefetch([settledInHistory]); });

    // After refetch: turn in history, active card deduped → exactly once
    await waitFor(() => expect(screen.getByText('Assistant reply')).toBeTruthy());
    expect(screen.getAllByText('Gap test Q')).toHaveLength(1);
  });
});

// ── CV1: failed turn moves to history ────────────────────────────────────────

describe('CV1: failed turn is moved to history (page-logic harness)', () => {
  it('failed turn appears in history with a Retry control after turn:failed', async () => {
    const userTurn = mkTurn({ id: 'fail-turn', status: 'streaming', messages: [mkMsg({ content: 'Fail Q', role: 'user' })] });
    const active = mkActive(userTurn, 'streaming');

    render(<PageLogicHarness initialActive={active} />);
    expect(screen.getByText('Fail Q')).toBeTruthy();

    // Transition activeTurn to status='failed' (SSE fired turn:failed)
    act(() => {
      (PageLogicHarness as any)._setActiveTurn(mkActive(userTurn, 'failed'));
    });

    // Failed turn is now in history (via the effect), dedup suppresses active card
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    // 'Fail Q' visible (exactly once — history only)
    expect(screen.getAllByText('Fail Q')).toHaveLength(1);
  });

  it('subsequent new turn does not erase the failed turn from history', async () => {
    const userTurn = mkTurn({ id: 'fail-2', status: 'streaming', messages: [mkMsg({ content: 'Failed Q', role: 'user' })] });
    const active = mkActive(userTurn, 'streaming');

    render(<PageLogicHarness initialActive={active} />);

    // Fail the turn
    act(() => {
      (PageLogicHarness as any)._setActiveTurn(mkActive(userTurn, 'failed'));
    });
    await waitFor(() => screen.getByRole('button', { name: /retry/i }));

    // New turn starts (user retried)
    const newTurn = mkTurn({ id: 'new-turn', status: 'streaming', messages: [mkMsg({ content: 'New Q', role: 'user' })] });
    act(() => {
      (PageLogicHarness as any)._setActiveTurn(mkActive(newTurn, 'streaming'));
    });

    // Failed turn is still in history, new turn is in active slot
    expect(screen.getAllByText('Failed Q')).toHaveLength(1); // failed turn persists
    expect(screen.getByText('New Q')).toBeTruthy(); // new turn visible
  });
});
