import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunningAgentsPanel } from '../components/RunningAgentsPanel';
import { FakeEventSource } from './setup';

// fix 10A — the panel no longer owns a subscription; the page hoists ONE useChatStream and passes
// the derived values down as props. These tests drive the prop-driven shape and assert the panel
// opens NO EventSource of its own.
describe('RunningAgentsPanel (session-scoped, prop-driven)', () => {
  it('with no active session, shows an idle empty state and opens no stream', () => {
    FakeEventSource.reset();
    render(<RunningAgentsPanel sessionId={null} />);
    expect(FakeEventSource.instances.length).toBe(0);
    expect(screen.getByText(/no active session|none/i)).toBeTruthy();
  });

  it('lists the active session backing run + subagents from props (no own EventSource)', () => {
    FakeEventSource.reset();
    render(
      <RunningAgentsPanel
        sessionId="sess-1"
        state="live"
        live
        runId="run-a"
        subagents={[{ runId: 'sub-1', name: 'reviewer' }]}
      />,
    );
    // the panel must NOT open its own stream — that is the page's single hoisted subscription.
    expect(FakeEventSource.instances.length).toBe(0);
    expect(screen.getByText(/run-a/)).toBeTruthy();
    expect(screen.getByText(/reviewer/)).toBeTruthy();
  });

  it('shows "none running" when a session is active but has no backing run', () => {
    render(<RunningAgentsPanel sessionId="sess-2" state="idle" live={false} runId={null} subagents={[]} />);
    expect(screen.getByText(/none running/i)).toBeTruthy();
  });
});
