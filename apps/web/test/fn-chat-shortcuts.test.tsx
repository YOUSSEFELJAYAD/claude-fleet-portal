import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const sess = {
  id: 's1', title: 'Sess', engine: 'claude', model: 'm', effort: 'high',
  permissionMode: 'bypassPermissions', cwd: '/w', allowedTools: null, skills: null,
  runId: null, state: 'idle', live: false, createdAt: 0, updatedAt: 0,
};

const aTurn = {
  id: 't1', sessionId: 's1', status: 'settled', createdAt: 0, settledAt: 0,
  messages: [{ id: 'm1', sessionId: 's1', role: 'user', kind: 'text', content: 'hi', runId: null, turnId: 't1', createdAt: 0 }],
};

const { createChatSession, chatInterrupt } = vi.hoisted(() => ({
  createChatSession: vi.fn(async () => ({ id: 'new1', title: 'New chat' })),
  chatInterrupt: vi.fn(async () => ({})),
}));

vi.mock('@/lib/live', () => ({
  useChatStream: () => ({ state: 'running', activeTurn: null, error: null, clearError: () => {} }),
  usePendingQuestions: () => ({ questions: [], refresh: () => {} }),
}));
vi.mock('@/lib/api', () => ({
  api: new Proxy({}, {
    get: (_t, p: string) => {
      if (p === 'createChatSession') return createChatSession;
      if (p === 'chatInterrupt') return chatInterrupt;
      if (p === 'chatSessions') return vi.fn(async () => [sess]);
      if (p === 'chatSession') return vi.fn(async () => ({ session: sess, turns: [aTurn] }));
      return vi.fn(async () => []);
    },
  }),
}));

import ChatPage from '../app/chat/page';
import { ChatComposer } from '../components/ChatComposer';

beforeEach(() => vi.clearAllMocks());

describe('composer autofocus', () => {
  it('focuses the composer textarea when a session is set', () => {
    render(<ChatComposer disabled={false} running={false} engine="claude" cwd="/w" sessionId="s1"
      onSend={() => {}} onCommand={() => {}} onStop={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
  });
});

describe('chat global shortcuts', () => {
  it('Cmd/Ctrl+K opens the session switcher palette', async () => {
    render(<ChatPage />);
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText(/switch session/i)).toBeTruthy();
  });

  it('Cmd/Ctrl+N creates a new session', () => {
    render(<ChatPage />);
    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
    expect(createChatSession).toHaveBeenCalled();
  });

  it('Esc stops a running turn once a session is active', async () => {
    render(<ChatPage />);
    fireEvent.click(await screen.findByText('Sess')); // select → loadSession (async)
    await screen.findByRole('combobox'); // composer renders once the session is active (activeId set)
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(chatInterrupt).toHaveBeenCalled());
  });

  it('? opens the keyboard shortcuts overlay', () => {
    render(<ChatPage />);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByText(/keyboard shortcuts/i)).toBeTruthy();
  });

  it('the export button copies the conversation as Markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ChatPage />);
    fireEvent.click(await screen.findByText('Sess'));
    fireEvent.click(await screen.findByLabelText(/export conversation/i));
    expect(writeText).toHaveBeenCalled();
  });
});
