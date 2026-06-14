/**
 * cov-chatthread-order — regression for the "chat order" bug: the live turn must NOT
 * re-render turns that are already in the persisted transcript. The backing run is reused
 * across turns, so without a guard a completed turn appears twice (persisted message + live
 * dump) and out of order on reload.
 *
 * fix 10A — ChatThread no longer owns the subscription: the page hoists ONE useChatStream and
 * passes run/events/partials down as props. The stream's terminal→active event-clearing reducer
 * is covered at the hook level (cov-usechatstream); here we drive the props directly and assert
 * ChatThread's OWN rendering contract (no duplication, clean handoff, result-driven persistence).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ChatThread } from '../components/ChatThread';
import type { ChatMessage, NormalizedEvent, Run } from '@fleet/shared';

function msg(p: Partial<ChatMessage>): ChatMessage {
  return { id: Math.random().toString(36).slice(2), sessionId: 's', role: 'assistant', kind: 'text', content: '', runId: null, createdAt: 0, ...p };
}
const ev = (p: Partial<NormalizedEvent> & { type: string }): NormalizedEvent =>
  ({ runId: 's', nodeId: 's', seq: 1, ts: 0, payload: {}, ...p } as unknown as NormalizedEvent);
const noop = () => {};

describe('ChatThread ordering', () => {
  it('does NOT duplicate a completed turn that the stream replays (run terminal)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'm1', role: 'user', kind: 'text', content: 'Question one' }),
      msg({ id: 'm2', role: 'assistant', kind: 'text', content: 'Answer one' }),
    ];
    // backing run TERMINAL (no turn in flight) → the live view renders nothing even if events exist.
    render(
      <ChatThread
        sessionId="s1"
        messages={messages}
        run={{ id: 's1', status: 'completed' } as Run}
        events={[ev({ type: 'assistant_text', payload: { text: 'Answer one' } })]}
        partials={{}}
        error={null}
        onTurnComplete={noop}
        onTurnError={noop}
      />,
    );
    expect(screen.getAllByText('Answer one')).toHaveLength(1);
  });

  it('shows the in-flight turn live, then hands off cleanly to the persisted message', () => {
    const messages: ChatMessage[] = [msg({ id: 'm1', role: 'user', kind: 'text', content: 'Q2' })];
    const { rerender } = render(
      <ChatThread
        sessionId="s2"
        messages={messages}
        run={{ id: 's2', status: 'running' } as Run}
        events={[ev({ type: 'assistant_text', payload: { text: 'live answer' } })]}
        partials={{}}
        error={null}
        onTurnComplete={noop}
        onTurnError={noop}
      />,
    );
    expect(screen.getAllByText('live answer')).toHaveLength(1); // shown live while running

    // turn completes → run terminal; the page persists the assistant message + the hook clears events.
    const messages2 = [...messages, msg({ id: 'm2', role: 'assistant', content: 'live answer' })];
    rerender(
      <ChatThread
        sessionId="s2"
        messages={messages2}
        run={{ id: 's2', status: 'completed' } as Run}
        events={[]}
        partials={{}}
        error={null}
        onTurnComplete={noop}
        onTurnError={noop}
      />,
    );
    expect(screen.getAllByText('live answer')).toHaveLength(1); // not duplicated after handoff
  });

  it('renders only the events it is handed for the current turn (prior turn lives in the transcript)', () => {
    // the hook clears the prior turn's events on a new turn; ChatThread receives ONLY turn B's events.
    const messages: ChatMessage[] = [
      msg({ id: 'm1', role: 'user', kind: 'text', content: 'Q-a' }),
      msg({ id: 'm2', role: 'assistant', kind: 'text', content: 'A-a' }),
      msg({ id: 'm3', role: 'user', kind: 'text', content: 'Q-b' }),
    ];
    render(
      <ChatThread
        sessionId="s3"
        messages={messages}
        run={{ id: 's3', status: 'running' } as Run}
        events={[ev({ type: 'assistant_text', seq: 2, payload: { text: 'A-b' } })]}
        partials={{}}
        error={null}
        onTurnComplete={noop}
        onTurnError={noop}
      />,
    );
    expect(screen.getAllByText('A-a')).toHaveLength(1); // only the persisted transcript
    expect(screen.getAllByText('A-b')).toHaveLength(1); // only the live view
  });
});

// Fix 05 — persist the assistant reply on the per-turn `result` event (not on run-terminal),
// deduped by the result event's seq so a reload (hello with stripped events) never re-persists.
// fix 10A — still ChatThread's own effect, now driven off the `events` prop.
describe('ChatThread result-driven persistence', () => {
  it('fires onTurnComplete EXACTLY ONCE for a result event, even across an events reset', () => {
    const onTurnComplete = vi.fn();
    const messages: ChatMessage[] = [msg({ id: 'm1', role: 'user', kind: 'text', content: 'Q' })];
    const base = {
      sessionId: 's1', messages, partials: {}, error: null,
      onTurnComplete, onTurnError: noop,
    } as const;
    const { rerender } = render(
      <ChatThread {...base} run={{ id: 's1', status: 'running' } as Run} events={[]} />,
    );
    act(() => {
      rerender(
        <ChatThread
          {...base}
          run={{ id: 's1', status: 'running' } as Run}
          events={[
            ev({ type: 'assistant_text', runId: 's1', seq: 1, payload: { text: 'the answer' } }),
            ev({ type: 'result', runId: 's1', seq: 2, payload: { result: 'the answer', isError: false, costUsd: 0 } }),
          ]}
        />,
      );
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenLastCalledWith('s1', 'the answer');

    // RELOAD: a fresh hello strips historical events (events prop reset to []) — must NOT re-fire.
    act(() => {
      rerender(<ChatThread {...base} run={{ id: 's1', status: 'completed' } as Run} events={[]} />);
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it('fires twice for two sequential turns (two result events, different seq)', () => {
    const onTurnComplete = vi.fn();
    const messages: ChatMessage[] = [msg({ id: 'm1', role: 'user', kind: 'text', content: 'Q1' })];
    const base = {
      sessionId: 's2', messages, partials: {}, error: null,
      onTurnComplete, onTurnError: noop, run: { id: 's2', status: 'running' } as Run,
    } as const;
    const { rerender } = render(<ChatThread {...base} events={[]} />);
    act(() => {
      rerender(
        <ChatThread {...base} events={[ev({ type: 'result', runId: 's2', seq: 1, payload: { result: 'reply one', isError: false, costUsd: 0 } })]} />,
      );
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenLastCalledWith('s2', 'reply one');

    act(() => {
      rerender(
        <ChatThread
          {...base}
          events={[
            ev({ type: 'result', runId: 's2', seq: 1, payload: { result: 'reply one', isError: false, costUsd: 0 } }),
            ev({ type: 'result', runId: 's2', seq: 2, payload: { result: 'reply two', isError: false, costUsd: 0 } }),
          ]}
        />,
      );
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(2);
    expect(onTurnComplete).toHaveBeenLastCalledWith('s2', 'reply two');
  });
});
