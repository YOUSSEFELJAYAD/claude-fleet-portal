/**
 * Integration: typing `/` at start opens the SlashMenu; typing `@token` opens the
 * MentionMenu; picking a file adds a chip and removing it drops the attachment. We
 * mock the `api` module so the menus resolve deterministically.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  api: {
    listCommands: vi.fn(async () => [
      { name: 'sessions', group: 'control', description: 'list sessions', usage: '/sessions', args: [], resultKind: 'table' },
    ]),
    skills: vi.fn(async () => []),
    subagents: vi.fn(async () => []),
    findFiles: vi.fn(async () => [{ path: 'src/a.ts', kind: 'file', score: 9 }]),
  },
}));

import { ChatComposer } from '../components/ChatComposer';

function mount() {
  const onSend = vi.fn();
  const utils = render(
    <ChatComposer disabled={false} running={false} cwd="/work" onSend={onSend} onCommand={() => {}} onStop={() => {}} />,
  );
  const ta = utils.container.querySelector('textarea') as HTMLTextAreaElement;
  return { ...utils, ta, onSend };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('composer ↔ menus', () => {
  it('typing "/" at start opens the SlashMenu', async () => {
    const { ta, container } = mount();
    fireEvent.change(ta, { target: { value: '/' } });
    await waitFor(() => expect(container.querySelector('[data-floating-menu]')).not.toBeNull());
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
  });

  it('typing "@a" opens the MentionMenu and a pick adds + removes a chip', async () => {
    const { ta, container } = mount();
    fireEvent.change(ta, { target: { value: 'see @a' } });
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
    // chip appears
    await waitFor(() => expect(container.querySelector('[data-chip]')?.textContent).toContain('src/a.ts'));
    // remove it
    fireEvent.click(container.querySelector('[data-chip] button')!);
    await waitFor(() => expect(container.querySelector('[data-chip]')).toBeNull());
  });

  it('sending after attaching passes the attachments to onSend', async () => {
    const { ta, container, onSend } = mount();
    fireEvent.change(ta, { target: { value: '@a' } });
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
    await waitFor(() => expect(container.querySelector('[data-chip]')).not.toBeNull());
    fireEvent.change(ta, { target: { value: 'read this file' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('read this file', [{ path: 'src/a.ts', kind: 'file' }]);
  });
});
