/**
 * Integration: typing `/` at start opens the SlashMenu; typing `@token` opens the
 * MentionMenu; picking a file adds a chip and removing it drops the attachment. We
 * mock the `api` module so the menus resolve deterministically.
 *
 * Also covers Step 3 HUD QA: file vs folder chips render DISTINCTLY (different icon
 * prefix: ▦ for file, ▣ for dir) so the user can tell at a glance what is attached.
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
    findFiles: vi.fn(async () => [
      { path: 'src/a.ts', kind: 'file', score: 9 },
      { path: 'src/', kind: 'dir', score: 8 },
    ]),
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
    // mock returns 2 results (file + dir)
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.mouseDown(container.querySelectorAll('[data-menu-item]')[0]!);
    // chip appears
    await waitFor(() => expect(container.querySelector('[data-chip]')?.textContent).toContain('src/a.ts'));
    // remove it
    fireEvent.click(container.querySelector('[data-chip] button')!);
    await waitFor(() => expect(container.querySelector('[data-chip]')).toBeNull());
  });

  it('sending after attaching passes the attachments to onSend', async () => {
    const { ta, container, onSend } = mount();
    fireEvent.change(ta, { target: { value: '@a' } });
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.mouseDown(container.querySelectorAll('[data-menu-item]')[0]!);
    await waitFor(() => expect(container.querySelector('[data-chip]')).not.toBeNull());
    fireEvent.change(ta, { target: { value: 'read this file' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('read this file', [{ path: 'src/a.ts', kind: 'file' }]);
  });

  // Step 3 HUD QA: a file chip and a folder chip render with DISTINCT icon prefixes.
  // The icon ▦ (file) vs ▣ (dir) lets the user distinguish what is attached at a glance.
  it('a file chip renders with ▦ prefix and a dir chip renders with ▣ prefix', async () => {
    const { ta, container } = mount();
    // Pick the file (first result)
    fireEvent.change(ta, { target: { value: '@a' } });
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.mouseDown(container.querySelectorAll('[data-menu-item]')[0]!); // file
    await waitFor(() => expect(container.querySelector('[data-chip]')).not.toBeNull());
    const fileChip = container.querySelector('[data-chip]') as HTMLElement;
    expect(fileChip.textContent).toContain('▦');
    expect(fileChip.textContent).not.toContain('▣');

    // Remove the file chip, then pick the dir (second result)
    fireEvent.click(fileChip.querySelector('button')!);
    await waitFor(() => expect(container.querySelector('[data-chip]')).toBeNull());

    // Re-open the mention picker and pick the dir
    fireEvent.change(ta, { target: { value: '@src' } });
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.mouseDown(container.querySelectorAll('[data-menu-item]')[1]!); // dir
    await waitFor(() => expect(container.querySelector('[data-chip]')).not.toBeNull());
    const dirChip = container.querySelector('[data-chip]') as HTMLElement;
    expect(dirChip.textContent).toContain('▣');
    expect(dirChip.textContent).not.toContain('▦');
  });
});
