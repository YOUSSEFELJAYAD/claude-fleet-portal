/**
 * cov-chatthread-order — regression for the "chat order" bug: the live turn must NOT
 * re-render turns that are already in the persisted transcript. The backing run is reused
 * across turns and the stream replays the run's full event history, so without a guard a
 * completed turn appears twice (persisted message + live dump) and out of order on reload.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ChatThread } from '../components/ChatThread';
import { FakeEventSource } from './setup';
import type { ChatMessage } from '@fleet/shared';

function msg(p: Partial<ChatMessage>): ChatMessage {
  return { id: Math.random().toString(36).slice(2), sessionId: 's', role: 'assistant', kind: 'text', content: '', runId: null, createdAt: 0, ...p };
}

describe('ChatThread ordering', () => {
  it('does NOT duplicate a completed turn that the stream replays (run terminal)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'm1', role: 'user', kind: 'text', content: 'Question one' }),
      msg({ id: 'm2', role: 'assistant', kind: 'text', content: 'Answer one' }),
    ];
    render(<ChatThread sessionId="s1" messages={messages} onTurnComplete={() => {}} onTurnError={() => {}} />);
    const es = FakeEventSource.last();
    act(() => {
      es.emitOpen();
      // server replays the backing run's full history with a TERMINAL run (no turn in flight)
      es.emit({
        kind: 'hello', run: { id: 's1', status: 'completed' }, state: 'idle', live: false, runId: 's1',
        events: [{ runId: 's1', nodeId: 's1', seq: 1, type: 'assistant_text', payload: { text: 'Answer one' } }],
      });
    });
    // appears once (the persisted message), not duplicated by a live dump
    expect(screen.getAllByText('Answer one')).toHaveLength(1);
  });

  it('shows the in-flight turn live, then hands off cleanly to the persisted message', () => {
    const messages: ChatMessage[] = [msg({ id: 'm1', role: 'user', kind: 'text', content: 'Q2' })];
    const { rerender } = render(<ChatThread sessionId="s2" messages={messages} onTurnComplete={() => {}} onTurnError={() => {}} />);
    const es = FakeEventSource.last();
    act(() => {
      es.emitOpen();
      es.emit({ kind: 'hello', run: { id: 's2', status: 'running' }, state: 'running', live: true, runId: 's2', events: [] });
      es.emit({ kind: 'event', event: { runId: 's2', nodeId: 's2', seq: 1, type: 'assistant_text', payload: { text: 'live answer' } } });
    });
    expect(screen.getAllByText('live answer')).toHaveLength(1); // shown live while running

    // turn completes → run terminal; the page would persist the assistant message
    const messages2 = [...messages, msg({ id: 'm2', role: 'assistant', content: 'live answer' })];
    act(() => { es.emit({ kind: 'run', run: { id: 's2', status: 'completed' } }); });
    rerender(<ChatThread sessionId="s2" messages={messages2} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getAllByText('live answer')).toHaveLength(1); // not duplicated after handoff
  });

  it('clears the prior turn from the live view when a new turn starts on the same connection', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'm1', role: 'user', kind: 'text', content: 'Q-a' }),
      msg({ id: 'm2', role: 'assistant', kind: 'text', content: 'A-a' }),
      msg({ id: 'm3', role: 'user', kind: 'text', content: 'Q-b' }),
    ];
    render(<ChatThread sessionId="s3" messages={messages} onTurnComplete={() => {}} onTurnError={() => {}} />);
    const es = FakeEventSource.last();
    act(() => {
      es.emitOpen();
      es.emit({ kind: 'hello', run: { id: 's3', status: 'completed' }, state: 'idle', live: false, runId: 's3', events: [] });
      // turn A streamed earlier on this connection
      es.emit({ kind: 'run', run: { id: 's3', status: 'running' } });
      es.emit({ kind: 'event', event: { runId: 's3', nodeId: 's3', seq: 1, type: 'assistant_text', payload: { text: 'A-a' } } });
      es.emit({ kind: 'run', run: { id: 's3', status: 'completed' } });
      // turn B starts (resume reuses the run id) → prior turn's live events must be dropped
      es.emit({ kind: 'run', run: { id: 's3', status: 'running' } });
      es.emit({ kind: 'event', event: { runId: 's3', nodeId: 's3', seq: 2, type: 'assistant_text', payload: { text: 'A-b' } } });
    });
    // "A-a" only in the persisted transcript (once); the live view shows only turn B's "A-b"
    expect(screen.getAllByText('A-a')).toHaveLength(1);
    expect(screen.getAllByText('A-b')).toHaveLength(1);
  });
});
