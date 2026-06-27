import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Turn } from '../components/Turn';
import { ChatThread } from '../components/ChatThread';
import type { ChatTurn, ChatMessage } from '@fleet/shared';

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm' + Math.random(), sessionId: 's1', role: 'user', kind: 'text', content: '', runId: null, turnId: 't1', createdAt: 0, ...over };
}
function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 't1', sessionId: 's1', status: 'settled', messages: [], createdAt: 0, settledAt: Date.now(), ...over };
}

describe('Turn — timestamp + regenerate', () => {
  it('shows a relative timestamp for a settled turn', () => {
    render(<Turn turn={turn({
      createdAt: Date.now() - 60_000,
      messages: [msg({ role: 'assistant', kind: 'text', content: 'hi' })],
    })} />);
    expect(screen.getByText(/ago|now/)).toBeTruthy();
  });

  it('a settled (non-failed) turn shows a retry/regenerate button that fires onRetry', () => {
    const onRetry = vi.fn();
    render(<Turn turn={turn({
      messages: [msg({ role: 'user', content: 'q' }), msg({ role: 'assistant', kind: 'text', content: 'a' })],
    })} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('ChatThread — scroll to bottom', () => {
  const noop = () => {};
  it('shows a scroll-to-bottom button when scrolled up; clicking pins to bottom', () => {
    const t = turn({ messages: [msg({ role: 'assistant', kind: 'text', content: 'hi' })] });
    const { container } = render(<ChatThread sessionId="s1" turns={[t]} activeTurn={null} onRetry={noop} />);
    const sc = container.querySelector('[data-testid="chat-scroll"]') as HTMLElement;
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
    // simulate scrolled-up geometry, then a scroll event
    Object.defineProperty(sc, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(sc, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(sc, 'scrollTop', { value: 0, writable: true, configurable: true });
    fireEvent.scroll(sc);
    expect(screen.getByTestId('scroll-to-bottom')).toBeTruthy();
    fireEvent.click(screen.getByTestId('scroll-to-bottom'));
    expect(sc.scrollTop).toBe(1000);
  });
});
