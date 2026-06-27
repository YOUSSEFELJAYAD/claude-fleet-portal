import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatSessionList } from '../components/ChatSessionList';
import type { ChatSession } from '@fleet/shared';

const base: Omit<ChatSession, 'id' | 'title' | 'state' | 'live' | 'updatedAt'> = {
  engine: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'default',
  cwd: '/w', allowedTools: null, skills: null, runId: null, createdAt: 0,
} as any;
const sess = (over: Partial<ChatSession>): ChatSession => ({ ...(base as any), id: 'a', title: 'Alpha', updatedAt: Date.now(), ...over });

// Persistent panel (no popover): rows render directly, no trigger to click open.
describe('ChatSessionList (persistent panel)', () => {
  const noop = () => {};
  function renderList(sessions: ChatSession[], handlers: Partial<Record<string, any>> = {}) {
    return render(
      <ChatSessionList
        sessions={sessions} activeId={sessions[0]?.id ?? null}
        previews={{ a: 'last assistant line' }}
        onSelect={handlers.onSelect ?? noop} onNew={handlers.onNew ?? noop} onDelete={noop}
        onRename={handlers.onRename ?? noop}
        onKill={handlers.onKill ?? noop}
        onResume={handlers.onResume ?? noop}
      />,
    );
  }

  it('renders session rows directly, with preview + relative timestamp (no popover)', () => {
    renderList([sess({ state: 'idle', updatedAt: Date.now() - 60_000 })]);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('last assistant line')).toBeTruthy();
    expect(screen.getByText(/ago|now/)).toBeTruthy();
  });

  it('the New control calls onNew', () => {
    const onNew = vi.fn();
    renderList([sess({ state: 'idle' })], { onNew });
    fireEvent.click(screen.getByText(/new/i));
    expect(onNew).toHaveBeenCalled();
  });

  it('a live session shows a Kill control; an idle session shows Resume', () => {
    const onKill = vi.fn();
    const { rerender } = renderList([sess({ id: 'a', state: 'live', live: true })], { onKill });
    fireEvent.click(screen.getByText(/^kill$/i));
    expect(onKill).toHaveBeenCalledWith('a');

    const onResume = vi.fn();
    rerender(
      <ChatSessionList sessions={[sess({ id: 'a', state: 'idle' })]} activeId="a"
        previews={{}} onSelect={() => {}} onNew={() => {}} onDelete={() => {}}
        onRename={() => {}} onKill={() => {}} onResume={onResume} />,
    );
    fireEvent.click(screen.getByText(/^resume$/i));
    expect(onResume).toHaveBeenCalledWith('a');
  });

  it('inline rename: editing the active row and pressing Enter calls onRename(id, title)', () => {
    const onRename = vi.fn();
    renderList([sess({ id: 'a', state: 'idle' })], { onRename });
    fireEvent.click(screen.getByText(/rename/i));
    const input = screen.getByDisplayValue('Alpha') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('a', 'Renamed');
  });

  it('a killed session exposes a Resume affordance (kill is not delete)', () => {
    renderList([sess({ id: 'a', state: 'killed' })]);
    expect(screen.getByText(/^resume$/i)).toBeTruthy();
  });
});
