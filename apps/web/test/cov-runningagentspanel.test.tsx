import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RunningAgentsPanel } from '../components/RunningAgentsPanel';
import { FakeEventSource } from './setup';

describe('RunningAgentsPanel (session-scoped)', () => {
  it('with no active session, shows an idle empty state and opens no stream', () => {
    FakeEventSource.reset();
    render(<RunningAgentsPanel sessionId={null} />);
    expect(FakeEventSource.instances.length).toBe(0);
    expect(screen.getByText(/no active session|none/i)).toBeTruthy();
  });

  it('subscribes to the active session stream and lists its backing run + subagents', () => {
    render(<RunningAgentsPanel sessionId="sess-1" />);
    const es = FakeEventSource.last();
    expect(es.url).toContain('/api/chat/sessions/sess-1/stream');
    act(() => es.emitOpen());
    act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [{ runId: 'sub-1', name: 'reviewer' }] }));
    expect(screen.getByText(/run-a/)).toBeTruthy();
    expect(screen.getByText(/reviewer/)).toBeTruthy();
  });
});
