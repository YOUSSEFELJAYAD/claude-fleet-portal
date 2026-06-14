/**
 * ChatSessionList engine degradation (spec §8, §12, D8): an engine (codex/opencode) session row
 * must NOT offer live-only controls (Kill / Resume) and must carry the honest
 * "one-shot · limited memory" badge. A claude session keeps its Kill/Resume controls.
 * Props are cast `as any` — vitest does not typecheck; the contract is what we assert.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatSessionList } from '../components/ChatSessionList';

const session = (over: any) => ({
  id: 's1', title: 'demo', engine: 'claude', model: 'claude-opus-4-8', effort: 'high',
  permissionMode: 'default', cwd: '/repo', allowedTools: null, skills: null, runId: null,
  state: 'idle', live: false, createdAt: 0, updatedAt: 0, ...over,
});

const baseProps = {
  activeId: 's1', onSelect: vi.fn(), onNew: vi.fn(), onRename: vi.fn(),
  onDelete: vi.fn(), onKill: vi.fn(), onResume: vi.fn(),
};

describe('ChatSessionList — engine degradation', () => {
  it('a claude session exposes Kill and Resume controls', () => {
    render(<ChatSessionList {...(baseProps as any)} sessions={[session({ engine: 'claude', state: 'live', live: true })] as any} />);
    expect(screen.queryByText(/kill/i)).not.toBeNull();
    expect(screen.queryByText(/resume/i)).not.toBeNull();
    expect(screen.queryByText(/one-shot/i)).toBeNull();
  });

  it('an engine session hides Kill/Resume and shows the one-shot · limited memory badge', () => {
    render(<ChatSessionList {...(baseProps as any)} sessions={[session({ id: 's1', engine: 'codex' })] as any} />);
    expect(screen.queryByText(/^kill$/i)).toBeNull();
    expect(screen.queryByText(/^resume$/i)).toBeNull();
    expect(screen.queryByText(/one-shot · limited memory/i)).not.toBeNull();
  });

  it('Kill / Resume on a claude row fire their callbacks with the session id', () => {
    const onKill = vi.fn(); const onResume = vi.fn();
    render(<ChatSessionList {...(baseProps as any)} onKill={onKill} onResume={onResume}
      sessions={[session({ engine: 'claude', state: 'live', live: true })] as any} />);
    fireEvent.click(screen.getByText(/^kill$/i));
    fireEvent.click(screen.getByText(/^resume$/i));
    expect(onKill).toHaveBeenCalledWith('s1');
    expect(onResume).toHaveBeenCalledWith('s1');
  });
});
