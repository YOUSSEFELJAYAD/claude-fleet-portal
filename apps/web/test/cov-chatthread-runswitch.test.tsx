/**
 * cov-chatthread-runswitch — Task 2.3 rewrite.
 * Old tests verified per-run seq dedup in ChatThread's onTurnComplete callback.
 * That client-side persistence logic is gone: turns are now server-side entities.
 * ChatThread no longer sees run IDs or fires onTurnComplete.
 *
 * These tests now verify that switching sessions (sessionId change) resets
 * ChatThread's prepended-turn state so old pagination doesn't bleed across sessions.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatTurn, ChatMessage } from '@fleet/shared';

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...real,
    api: { ...real.api, chatTurns: vi.fn(async () => []), chatInterrupt: vi.fn(async () => {}) },
  };
});

const { ChatThread } = await import('../components/ChatThread');
const { api } = await import('@/lib/api');

const m = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: Math.random().toString(36).slice(2), sessionId: 's', role: 'user', kind: 'text',
  content: '', runId: null, turnId: 't0', createdAt: 0, ...over,
});
const t = (id: string, content: string, createdAt = 1000): ChatTurn => ({
  id, sessionId: 's1', status: 'settled',
  messages: [m({ content, role: 'user' })],
  createdAt, settledAt: null,
});
const noop = () => {};

afterEach(() => vi.clearAllMocks());

describe('ChatThread session-switch isolation', () => {
  it('prepended turns from session A do not appear after switching to session B', async () => {
    const olderA = t('older-a', 'session A older', 500);
    const currentA = t('curr-a', 'session A current', 1000);
    vi.mocked(api.chatTurns).mockResolvedValueOnce([olderA]);

    const { rerender } = render(
      <ChatThread sessionId="sessionA" turns={[currentA]} activeTurn={null} onRetry={noop} />,
    );
    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => screen.getByText('session A older'));

    // Switch to session B — the prepended state should reset
    const currentB = t('curr-b', 'session B only', 2000);
    rerender(<ChatThread sessionId="sessionB" turns={[currentB]} activeTurn={null} onRetry={noop} />);

    expect(screen.queryByText('session A older')).toBeNull();
    expect(screen.getByText('session B only')).toBeTruthy();
  });
});
