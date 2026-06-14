/**
 * fix 10A — the chat surface must open exactly ONE EventSource per active session. Before the fix,
 * `useChatStream(activeId)` was called in THREE places (page + ChatThread + RunningAgentsPanel) →
 * 3 EventSource connections per session, straining the per-session connection cap.
 *
 * This is a page-composition assertion: it wires the SAME hoisted hook + prop-driven children the
 * page uses, and asserts a single EventSource is created (ChatThread / RunningAgentsPanel no longer
 * subscribe — they receive the derived stream values as props).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChatThread } from '../components/ChatThread';
import { RunningAgentsPanel } from '../components/RunningAgentsPanel';
import { useChatStream } from '../lib/live';
import { FakeEventSource } from './setup';

function ChatSurface({ activeId }: { activeId: string | null }) {
  // ONE hoisted subscription (mirrors apps/web/app/chat/page.tsx)
  const { state, live, run, events, partials, error, runId, subagents } = useChatStream(activeId);
  return (
    <div>
      <ChatThread
        sessionId={activeId}
        messages={[]}
        run={run}
        events={events}
        partials={partials}
        error={error}
        onTurnComplete={() => {}}
        onTurnError={() => {}}
      />
      <RunningAgentsPanel sessionId={activeId} state={state} live={live} runId={runId} subagents={subagents} />
    </div>
  );
}

describe('chat surface — single SSE subscription', () => {
  it('opens exactly ONE EventSource for an active session', () => {
    FakeEventSource.reset();
    render(<ChatSurface activeId="sess-1" />);
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.last().url).toContain('/api/chat/sessions/sess-1/stream');
  });

  it('opens NO EventSource when there is no active session', () => {
    FakeEventSource.reset();
    render(<ChatSurface activeId={null} />);
    expect(FakeEventSource.instances.length).toBe(0);
  });
});
