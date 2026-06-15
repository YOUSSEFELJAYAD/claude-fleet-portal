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
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ChatThread } from '../components/ChatThread';
import { FakeEventSource } from './setup';
import type { ChatMessage, NormalizedEvent, Run, ChatSession, AddChatMessageRequest } from '@fleet/shared';

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

  // Fix 12 — the live-claude regression: ALL live turns share ONE held runId (delivered via
  // sendInput), and persisted assistant messages carry only {runId, content}. Two turns with
  // IDENTICAL text ('Done.') therefore collide on (runId, content). ChatThread's seq-dedup
  // already fires once per distinct result seq, so it MUST fire TWICE for two distinct seqs even
  // when the content is identical — the prior fix-05 test only used DISTINCT content and missed this.
  it('fires twice for two SAME-runId turns with IDENTICAL content (distinct result seq)', () => {
    const onTurnComplete = vi.fn();
    const RUN_ID = 'live-claude-1'; // the held runId is shared across every live turn
    const messages: ChatMessage[] = [msg({ id: 'u1', role: 'user', kind: 'text', content: 'first' })];
    const base = {
      sessionId: 's-live', messages, partials: {}, error: null,
      onTurnComplete, onTurnError: noop, run: { id: 's-live', status: 'running' } as Run,
    } as const;
    const { rerender } = render(<ChatThread {...base} events={[]} />);

    // Turn 1 → result 'Done.' (seq 1).
    act(() => {
      rerender(
        <ChatThread {...base} events={[ev({ type: 'result', runId: RUN_ID, seq: 1, payload: { result: 'Done.', isError: false, costUsd: 0 } })]} />,
      );
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenLastCalledWith(RUN_ID, 'Done.');

    // Turn 2 → result 'Done.' AGAIN (seq 2) — SAME runId, SAME content.
    act(() => {
      rerender(
        <ChatThread
          {...base}
          events={[
            ev({ type: 'result', runId: RUN_ID, seq: 1, payload: { result: 'Done.', isError: false, costUsd: 0 } }),
            ev({ type: 'result', runId: RUN_ID, seq: 2, payload: { result: 'Done.', isError: false, costUsd: 0 } }),
          ]}
        />,
      );
    });
    // Two distinct result seqs → onTurnComplete fires TWICE even though content is identical.
    expect(onTurnComplete).toHaveBeenCalledTimes(2);
    expect(onTurnComplete).toHaveBeenNthCalledWith(1, RUN_ID, 'Done.');
    expect(onTurnComplete).toHaveBeenNthCalledWith(2, RUN_ID, 'Done.');
  });
});

// Fix 12 — page-level regression: the page's onTurnComplete must PERSIST BOTH identical replies.
// The OLD guard (`messages.some(m => m.runId === runId && m.kind === 'text' && m.role ===
// 'assistant' && m.content === content) → return`) matched turn 1 and silently DROPPED turn 2's
// identical reply — it never persisted and vanished on reload. This drives the REAL ChatPage: two
// sequential SAME-runId, IDENTICAL-content result events must produce TWO addChatMessage POSTs.
describe('ChatPage persists identical-content live turns (fix 12)', () => {
  it('persists BOTH turns when two SAME-runId results carry identical content', async () => {
    const RUN_ID = 'live-claude-2';
    const SID = 'sess-fix12';
    const session: ChatSession = {
      id: SID, title: 'fix12', engine: 'claude', model: 'sonnet', effort: 'medium' as any,
      permissionMode: 'default' as any, cwd: '/tmp', allowedTools: null, skills: null,
      runId: RUN_ID, createdAt: 0, updatedAt: 0,
    };
    const user1 = msg({ id: 'u1', role: 'user', kind: 'text', content: 'first', runId: RUN_ID });

    const added: AddChatMessageRequest[] = [];
    vi.resetModules();
    vi.doMock('@/lib/api', async () => {
      const real = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return {
        ...real,
        api: {
          ...real.api,
          chatSessions: vi.fn(async () => [session]),
          chatSession: vi.fn(async () => ({ session, messages: [user1] })),
          chatTurn: vi.fn(async () => ({ runId: RUN_ID, userMessage: user1 })),
          addChatMessage: vi.fn(async (_id: string, body: AddChatMessageRequest) => {
            added.push(body);
            return msg({ role: 'assistant', kind: 'text', content: body.content, runId: body.runId });
          }),
        },
      };
    });
    FakeEventSource.reset();
    const { default: ChatPage } = await import('../app/chat/page');
    const { findByText } = render(<ChatPage />);

    // load the session (sidebar row) so the page has an activeId + the user message transcript.
    const row = await findByText('fix12');
    act(() => { row.click(); });
    // let loadSession resolve + the stream subscribe.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const es = FakeEventSource.last();
    expect(es.url).toContain(`/api/chat/sessions/${SID}/stream`);
    act(() => {
      es.emit({ kind: 'hello', run: { id: RUN_ID, status: 'running' }, events: [], state: 'live', live: true, runId: RUN_ID });
    });
    const composer = screen.getByPlaceholderText(/Message/i);
    // a result only persists while a USER turn is pending (a held process that emits before any
    // input must not inject a phantom reply) — so drive a real send before each result.
    const send = async () => {
      fireEvent.change(composer, { target: { value: 'first' } });
      fireEvent.keyDown(composer, { key: 'Enter' });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    };
    // Turn 1: send → result 'Done.'
    await send();
    act(() => {
      es.emit({ kind: 'event', event: { type: 'result', runId: RUN_ID, nodeId: RUN_ID, seq: 1, ts: 0, payload: { result: 'Done.', isError: false, costUsd: 0 } } });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Turn 2: send → result 'Done.' AGAIN (same runId, identical content, distinct seq)
    await send();
    act(() => {
      es.emit({ kind: 'event', event: { type: 'result', runId: RUN_ID, nodeId: RUN_ID, seq: 2, ts: 0, payload: { result: 'Done.', isError: false, costUsd: 0 } } });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // BOTH identical 'Done.' replies must persist — the page no longer early-returns on (runId, content).
    expect(added).toHaveLength(2);
    expect(added.every((b) => b.content === 'Done.' && b.runId === RUN_ID)).toBe(true);
    vi.doUnmock('@/lib/api');
  });

  it('does NOT persist a result that arrives with NO pending user turn (phantom held-process reply)', async () => {
    const RUN_ID = 'held-run';
    const SID = 'sess-phantom';
    const session: ChatSession = {
      id: SID, title: 'phantom', engine: 'claude', model: 'sonnet', effort: 'medium' as any,
      permissionMode: 'default' as any, cwd: '/tmp', allowedTools: null, skills: null,
      runId: RUN_ID, createdAt: 0, updatedAt: 0,
    };
    const added: AddChatMessageRequest[] = [];
    vi.resetModules();
    vi.doMock('@/lib/api', async () => {
      const real = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
      return { ...real, api: { ...real.api,
        chatSessions: vi.fn(async () => [session]),
        chatSession: vi.fn(async () => ({ session, messages: [] })),
        addChatMessage: vi.fn(async (_id: string, body: AddChatMessageRequest) => { added.push(body); return msg(body as any); }),
      } };
    });
    FakeEventSource.reset();
    const { default: ChatPage } = await import('../app/chat/page');
    const { findByText } = render(<ChatPage />);
    act(() => { (findByText('phantom') as any); });
    const row = await findByText('phantom');
    act(() => { row.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const es = FakeEventSource.last();
    act(() => { es.emit({ kind: 'hello', run: { id: RUN_ID, status: 'running' }, events: [], state: 'live', live: true, runId: RUN_ID }); });
    // The held process emits a result with NO preceding user send → must be dropped, not persisted.
    act(() => {
      es.emit({ kind: 'event', event: { type: 'result', runId: RUN_ID, nodeId: RUN_ID, seq: 1, ts: 0, payload: { result: 'phantom output', isError: false, costUsd: 0 } } });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(added).toHaveLength(0);
    vi.doUnmock('@/lib/api');
  });
});
