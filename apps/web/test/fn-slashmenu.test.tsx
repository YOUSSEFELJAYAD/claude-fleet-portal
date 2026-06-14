/**
 * SlashMenu — the `/` palette. Fetches GET /api/commands once, merges GET /api/skills
 * + GET /api/subagents, groups (control/project/knowledge/config/meta · Skills ·
 * Subagents), and filters CLIENT-SIDE over the cached list by the `query` prop. We
 * mock the `api` module so no network happens.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';

const commands = [
  { name: 'launch', group: 'control', description: 'start a run', usage: '/launch <prompt>', args: [], resultKind: 'ack' },
  { name: 'kill', group: 'control', description: 'stop a run', usage: '/kill <run-id>', args: [{ name: 'run-id', required: true, type: 'run-id' }], resultKind: 'ack' },
  { name: 'memory', group: 'knowledge', description: 'fleet memory', usage: '/memory', args: [], resultKind: 'text' },
];
const skills = [{ name: 'graphify', scope: 'user', path: '/x', description: 'to graph', kind: 'skill' }];
const subagents = [{ name: 'reviewer', scope: 'project', path: '/y', description: 'reviews' }];

vi.mock('../lib/api', () => ({
  api: {
    listCommands: vi.fn(async () => commands),
    skills: vi.fn(async () => skills),
    subagents: vi.fn(async () => subagents),
  },
}));

import { SlashMenu } from '../components/SlashMenu';

beforeEach(() => { vi.clearAllMocks(); });

describe('SlashMenu', () => {
  it('loads the merged catalog and renders grouped rows (empty query = all)', async () => {
    const { container } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
    const headers = [...container.querySelectorAll('[data-group-header]')].map((h) => h.textContent);
    expect(headers).toEqual(['control', 'knowledge', 'Skills', 'Subagents']);
  });

  it('filters client-side by the query prop across name + description', async () => {
    const { container, rerender } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
    rerender(<SlashMenu query="kil" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => {
      const labels = [...container.querySelectorAll('[data-menu-item]')].map((r) => r.textContent);
      expect(labels.length).toBe(1);
      expect(labels[0]).toContain('/kill');
    });
  });

  it('only fetches the catalog ONCE even as the query changes (cached)', async () => {
    const { api } = await import('../lib/api');
    const { container, rerender } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect((api.listCommands as any).mock.calls.length).toBe(1));
    rerender(<SlashMenu query="k" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    rerender(<SlashMenu query="ki" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    expect((api.listCommands as any).mock.calls.length).toBe(1);
  });

  it('picks a command by name on row mousedown', async () => {
    const onPick = vi.fn();
    const { container } = render(<SlashMenu query="mem" cwd="/work" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
    expect(onPick).toHaveBeenCalledWith('memory');
  });
});
