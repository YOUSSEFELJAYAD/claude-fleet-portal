import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ChatSessionList } from '../components/ChatSessionList';
import type { ChatSession } from '@fleet/shared';

const base: Omit<ChatSession, 'id' | 'title' | 'state' | 'live' | 'updatedAt'> = {
  engine: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'default',
  cwd: '/w', allowedTools: null, skills: null, runId: null, createdAt: 0,
} as any;
const sess = (over: Partial<ChatSession>): ChatSession => ({ ...(base as any), id: 'a', title: 'Alpha', updatedAt: Date.now(), ...over });

describe('ChatSessionList', () => {
  const noop = () => {};
  function renderList(sessions: ChatSession[], handlers: Partial<Record<string, any>> = {}) {
    return render(
      <ChatSessionList
        sessions={sessions} activeId={sessions[0]?.id ?? null}
        previews={{ a: 'last assistant line' }}
        onSelect={noop} onNew={noop} onDelete={noop}
        onRename={handlers.onRename ?? noop}
        onKill={handlers.onKill ?? noop}
        onResume={handlers.onResume ?? noop}
      />,
    );
  }

  it('shows the last-message preview and a relative timestamp', () => {
    renderList([sess({ state: 'idle', updatedAt: Date.now() - 60_000 })]);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('last assistant line')).toBeTruthy();
    expect(screen.getByText(/ago|now/)).toBeTruthy();
  });

  it('a live session shows a Kill control; an idle session shows Resume', () => {
    const onKill = vi.fn();
    const { rerender } = renderList([sess({ id: 'a', state: 'live', live: true })], { onKill });
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText(/kill/i));
    expect(onKill).toHaveBeenCalledWith('a');

    const onResume = vi.fn();
    rerender(
      <ChatSessionList sessions={[sess({ id: 'a', state: 'idle' })]} activeId="a"
        previews={{}} onSelect={() => {}} onNew={() => {}} onDelete={() => {}}
        onRename={() => {}} onKill={() => {}} onResume={onResume} />,
    );
    fireEvent.click(screen.getByText(/resume/i));
    expect(onResume).toHaveBeenCalledWith('a');
  });

  it('inline rename: editing the active row and pressing Enter calls onRename(id, title) — no window.prompt', () => {
    const onRename = vi.fn();
    renderList([sess({ id: 'a', state: 'idle' })], { onRename });
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText(/rename/i));
    const input = screen.getByDisplayValue('Alpha') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('a', 'Renamed');
  });

  it('renders a status dot region for a killed session', () => {
    renderList([sess({ id: 'a', state: 'killed' })]);
    fireEvent.click(screen.getByRole('button'));
    // killed rows expose a Resume affordance (kill is not delete)
    // ponytail: use getByRole('option') — getByText('Alpha') is ambiguous after the popover opens
    // because the trigger button also renders an Alpha span; the option div is the session row
    expect(within(screen.getByRole('option')).queryByText(/resume/i)).toBeTruthy();
  });
});
