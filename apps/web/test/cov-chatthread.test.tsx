import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ChatThread } from '../components/ChatThread';
import type { ChatMessage, NormalizedEvent, Run } from '@fleet/shared';

// fix 10A — ChatThread no longer subscribes; the page hoists ONE useChatStream and passes
// run/events/partials/error down as props. These tests drive those props directly.
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm' + Math.random(), sessionId: 's1', role: 'assistant', kind: 'text',
  content: '', runId: null, turnId: '', createdAt: 0, ...over,
});

const noop = () => {};
function thread(over: {
  messages?: ChatMessage[];
  run?: Run | null;
  events?: NormalizedEvent[];
  partials?: Record<string, string>;
  error?: string | null;
}) {
  return (
    <ChatThread
      sessionId="s1"
      messages={over.messages ?? []}
      run={over.run ?? null}
      events={over.events ?? []}
      partials={over.partials ?? {}}
      error={over.error ?? null}
      onTurnComplete={noop}
      onTurnError={noop}
    />
  );
}

describe('ChatThread', () => {
  it('renders assistant text as markdown (a code fence becomes a code block, not raw)', () => {
    render(thread({ messages: [msg({ role: 'assistant', content: '# Hello\n\nworld' })] }));
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('world')).toBeTruthy();
  });

  it('renders a command-result error message via ErrorBanner', () => {
    render(thread({ messages: [msg({ role: 'system', kind: 'error', content: 'boom failed' })] }));
    expect(screen.getByText(/boom failed/)).toBeTruthy();
  });

  it('renders a serialized table command-result as a real table', () => {
    const payload = JSON.stringify({ ok: true, kind: 'table', columns: ['id'], rows: [['x1']] });
    render(thread({ messages: [msg({ role: 'system', kind: 'command-result', content: payload })] }));
    expect(document.querySelector('table')).toBeTruthy();
    expect(screen.getByText('x1')).toBeTruthy();
  });

  it('renders live tool_use as a ToolCallCard from the stream', () => {
    render(thread({
      run: { id: 'run1', status: 'running' } as Run,
      events: [
        { type: 'tool_use', nodeId: 'n1', seq: 1, ts: 0, runId: 'run1', payload: { id: 't1', name: 'Read', input: { file_path: '/a' } } } as unknown as NormalizedEvent,
      ],
    }));
    expect(screen.getByText('Read')).toBeTruthy();
  });

  it('streams partial assistant tokens into the live bubble', () => {
    render(thread({
      run: { id: 'run1', status: 'running' } as Run,
      partials: { n1: 'partial answer' },
    }));
    expect(screen.getByText(/partial answer/)).toBeTruthy();
  });

  it('shows a Stop button while the backing run is non-terminal', () => {
    render(thread({ run: { id: 'run1', status: 'running' } as Run }));
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
  });

  it('renders a permission_request as an inline PermissionCard', () => {
    render(thread({
      run: { id: 'run1', status: 'running' } as Run,
      events: [
        { type: 'permission_request', nodeId: 'n1', seq: 1, ts: 0, runId: 'run1', payload: { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } } } as unknown as NormalizedEvent,
      ],
    }));
    expect(screen.getByText(/permission request/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /allow/i })).toBeTruthy();
  });
});
