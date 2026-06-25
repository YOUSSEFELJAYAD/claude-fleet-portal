import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Turn } from '../components/Turn';
import type { ChatTurn, ChatMessage, NormalizedEvent } from '@fleet/shared';
import type { ChatActiveTurn } from '../lib/live';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMsg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm' + Math.random(),
    sessionId: 's1',
    role: 'user',
    kind: 'text',
    content: '',
    runId: null,
    turnId: 't1',
    createdAt: 0,
    ...over,
  };
}

function makeTurn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: 't1',
    sessionId: 's1',
    status: 'settled',
    messages: [],
    createdAt: 0,
    settledAt: Date.now(),
    ...over,
  };
}

function makeActive(
  over: Partial<Omit<ChatActiveTurn, 'turn'>> & { messages?: ChatMessage[] } = {},
): ChatActiveTurn {
  const turn = makeTurn({ messages: over.messages ?? [], status: over.status ?? 'streaming' });
  return {
    turnId: turn.id,
    status: turn.status,
    turn,
    events: over.events ?? [],
    partials: over.partials ?? {},
  };
}

function fakeEvent(type: NormalizedEvent['type'], payload: Record<string, unknown>, seq = 1): NormalizedEvent {
  return {
    type,
    nodeId: 'n1',
    runId: 'r1',
    sessionId: 's1',
    parentNodeId: null,
    nodeType: 'root',
    seq,
    ts: 0,
    payload,
  } as unknown as NormalizedEvent;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Turn', () => {
  it('(a) settled turn renders user and assistant text messages', () => {
    const turn = makeTurn({
      status: 'settled',
      messages: [
        makeMsg({ role: 'user', kind: 'text', content: 'Hello?' }),
        makeMsg({ role: 'assistant', kind: 'text', content: 'Hi there!' }),
      ],
    });
    render(<Turn turn={turn} />);
    expect(screen.getByText('Hello?')).toBeTruthy();
    expect(screen.getByText('Hi there!')).toBeTruthy();
  });

  it('(b) active turn with tool_use + tool_result renders a ToolCallCard', () => {
    const events: NormalizedEvent[] = [
      fakeEvent('tool_use', { id: 'tu1', name: 'Bash', input: { command: 'ls' } }, 1),
      fakeEvent('tool_result', { forId: 'tu1', text: 'file1.txt', isError: false }, 2),
    ];
    const active = makeActive({ events });
    render(<Turn active={active} />);
    // ToolCallCard renders the tool name
    expect(screen.getByText('Bash')).toBeTruthy();
  });

  it('(c) streaming partials are shown as a live bubble', () => {
    const active = makeActive({ partials: { n1: 'streaming answer' } });
    render(<Turn active={active} />);
    expect(screen.getByText(/streaming answer/)).toBeTruthy();
  });

  it('(d) failed settled turn shows error block and fires onRetry on button click', () => {
    const onRetry = vi.fn();
    const turn = makeTurn({ status: 'failed' });
    render(<Turn turn={turn} onRetry={onRetry} />);
    // error block is visible
    expect(screen.getByText(/turn failed/i)).toBeTruthy();
    // retry button is rendered and wired
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
