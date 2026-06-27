import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ChatSessionList } from '../components/ChatSessionList';
import type { ChatSession } from '@fleet/shared';

const base: Omit<ChatSession, 'id' | 'title' | 'state' | 'live' | 'updatedAt'> = {
  engine: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'default',
  cwd: '/w', allowedTools: null, skills: null, runId: null, createdAt: 0,
} as any;
const sess = (over: Partial<ChatSession>): ChatSession => ({ ...(base as any), id: 'a', title: 'Alpha', state: 'idle', updatedAt: Date.now(), ...over });

beforeEach(() => localStorage.clear());

function renderList(sessions: ChatSession[], handlers: Partial<Record<string, any>> = {}) {
  const noop = () => {};
  return render(
    <ChatSessionList
      sessions={sessions} activeId={sessions[0]?.id ?? null} previews={{}}
      onSelect={noop} onNew={noop} onRename={noop} onKill={noop} onResume={noop} onDelete={noop}
      onDuplicate={handlers.onDuplicate}
    />,
  );
}

describe('ChatSessionList — filter / pin / duplicate', () => {
  it('filters sessions by title (case-insensitive)', () => {
    renderList([sess({ id: 'a', title: 'Alpha' }), sess({ id: 'b', title: 'Beta' })]);
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: 'be' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(within(opts[0]).getByText('Beta')).toBeTruthy();
  });

  it('pinning a session sorts it to the top', () => {
    renderList([sess({ id: 'a', title: 'Alpha' }), sess({ id: 'b', title: 'Beta' })]);
    const rows = screen.getAllByRole('option');
    fireEvent.click(within(rows[1]).getByLabelText(/pin/i));
    const after = screen.getAllByRole('option');
    expect(within(after[0]).getByText('Beta')).toBeTruthy();
  });

  it('the duplicate action calls onDuplicate with the session', () => {
    const onDuplicate = vi.fn();
    renderList([sess({ id: 'a', title: 'Alpha' })], { onDuplicate });
    fireEvent.click(screen.getByText(/duplicate/i));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('groups sessions into Today and Earlier by updatedAt', () => {
    const old = Date.now() - 5 * 24 * 3600 * 1000;
    renderList([sess({ id: 'a', title: 'Recent', updatedAt: Date.now() }), sess({ id: 'b', title: 'Old', updatedAt: old })]);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Earlier')).toBeTruthy();
  });

  it('a pinned session appears under a Pinned header', () => {
    renderList([sess({ id: 'a', title: 'Alpha', updatedAt: Date.now() })]);
    fireEvent.click(screen.getByLabelText(/pin/i));
    expect(screen.getByText('Pinned')).toBeTruthy();
  });
});
