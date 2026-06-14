import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub the chat stream so we drive the thread's event rendering directly.
const streamState: any = { run: null, events: [], partials: {}, state: 'idle', connected: true, error: null };
vi.mock('../lib/live', () => ({ useChatStream: () => streamState }));

import { ChatThread } from '../components/ChatThread';
import type { ChatMessage } from '@fleet/shared';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm' + Math.random(), sessionId: 's1', role: 'assistant', kind: 'text',
  content: '', runId: null, createdAt: 0, ...over,
});

beforeEach(() => {
  streamState.events = []; streamState.partials = {}; streamState.state = 'idle'; streamState.run = null;
});

describe('ChatThread', () => {
  it('renders assistant text as markdown (a code fence becomes a code block, not raw)', () => {
    render(<ChatThread sessionId="s1" messages={[msg({ role: 'assistant', content: '# Hello\n\nworld' })]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('world')).toBeTruthy();
  });

  it('renders a command-result error message via ErrorBanner', () => {
    render(<ChatThread sessionId="s1" messages={[msg({ role: 'system', kind: 'error', content: 'boom failed' })]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getByText(/boom failed/)).toBeTruthy();
  });

  it('renders a serialized table command-result as a real table', () => {
    const payload = JSON.stringify({ ok: true, kind: 'table', columns: ['id'], rows: [['x1']] });
    render(<ChatThread sessionId="s1" messages={[msg({ role: 'system', kind: 'command-result', content: payload })]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(document.querySelector('table')).toBeTruthy();
    expect(screen.getByText('x1')).toBeTruthy();
  });

  it('renders live tool_use as a ToolCallCard from the stream', () => {
    streamState.run = { id: 'run1', status: 'running' };
    streamState.state = 'running';
    streamState.events = [
      { type: 'tool_use', nodeId: 'n1', seq: 1, ts: 0, runId: 'run1', payload: { id: 't1', name: 'Read', input: { file_path: '/a' } } },
    ];
    render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getByText('Read')).toBeTruthy();
  });

  it('streams partial assistant tokens into the live bubble', () => {
    streamState.state = 'running';
    streamState.run = { id: 'run1', status: 'running' };
    streamState.partials = { n1: 'partial answer' };
    render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getByText(/partial answer/)).toBeTruthy();
  });

  it('shows a Stop button while state is running', () => {
    streamState.state = 'running';
    streamState.run = { id: 'run1', status: 'running' };
    render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
  });

  it('renders a permission_request as an inline PermissionCard', () => {
    streamState.state = 'running';
    streamState.run = { id: 'run1', status: 'running' };
    streamState.events = [
      { type: 'permission_request', nodeId: 'n1', seq: 1, ts: 0, runId: 'run1', payload: { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } } },
    ];
    render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
    expect(screen.getByText(/permission request/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /allow/i })).toBeTruthy();
  });
});
