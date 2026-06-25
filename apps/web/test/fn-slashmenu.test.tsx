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
  { name: 'kill', group: 'control', description: 'stop a run', usage: '/kill <run-id>', args: [{ name: 'run-id', required: true, type: 'run-id', source: 'running-runs' }], resultKind: 'ack' },
  { name: 'memory', group: 'knowledge', description: 'fleet memory', usage: '/memory', args: [], resultKind: 'text' },
];
const skills = [{ name: 'graphify', scope: 'user', path: '/x', description: 'to graph', kind: 'skill' }];
const subagents = [{ name: 'reviewer', scope: 'project', path: '/y', description: 'reviews' }];

vi.mock('../lib/api', () => ({
  api: {
    listCommands: vi.fn(async () => commands),
    skills: vi.fn(async () => skills),
    subagents: vi.fn(async () => subagents),
    commandArgs: vi.fn(async () => [
      { value: 'run-abc', label: 'fix the bug' },
      { value: 'run-xyz', label: 'other task' },
    ]),
  },
}));

import { SlashMenu, ArgMenu } from '../components/SlashMenu';

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

// ── ArgMenu — Task 4.1 second-stage arg-value picker ─────────────────────────────────────────────

describe('ArgMenu — rendering', () => {
  it('renders all values when query is empty', () => {
    const values = [{ value: 'run-abc', label: 'fix the bug' }, { value: 'run-xyz', label: 'other task' }];
    const { container } = render(<ArgMenu values={values} query="" onPick={() => {}} onClose={() => {}} />);
    expect(container.querySelectorAll('[data-menu-item]').length).toBe(2);
  });

  it('filters values by query (value or label match)', () => {
    const values = [{ value: 'run-abc', label: 'fix the bug' }, { value: 'run-xyz', label: 'other task' }];
    const { container } = render(<ArgMenu values={values} query="abc" onPick={() => {}} onClose={() => {}} />);
    expect(container.querySelectorAll('[data-menu-item]').length).toBe(1);
  });

  it('filters by label too', () => {
    const values = [{ value: 'run-abc', label: 'fix the bug' }, { value: 'run-xyz', label: 'other task' }];
    const { container } = render(<ArgMenu values={values} query="fix" onPick={() => {}} onClose={() => {}} />);
    expect(container.querySelectorAll('[data-menu-item]').length).toBe(1);
  });

  it('calls onPick with the selected value on Enter', async () => {
    const onPick = vi.fn();
    const values = [{ value: 'run-abc' }, { value: 'run-xyz' }];
    const { container } = render(<ArgMenu values={values} query="" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('run-abc');
  });

  it('calls onPick with the correct value after ArrowDown', async () => {
    const onPick = vi.fn();
    const values = [{ value: 'run-abc' }, { value: 'run-xyz' }];
    const { container } = render(<ArgMenu values={values} query="" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('run-xyz');
  });

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn();
    const values = [{ value: 'run-abc' }];
    const { container } = render(<ArgMenu values={values} query="" onPick={() => {}} onClose={onClose} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onPick on mousedown', async () => {
    const onPick = vi.fn();
    const values = [{ value: 'run-abc', label: 'fix the bug' }];
    const { container } = render(<ArgMenu values={values} query="" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
    expect(onPick).toHaveBeenCalledWith('run-abc');
  });
});

describe('SlashMenu — keyboard nav', () => {
  it('ArrowDown/ArrowUp move the active row and Enter picks it', async () => {
    const onPick = vi.fn();
    const { container } = render(<SlashMenu query="" cwd="/work" onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'Enter' });
    // started at 0, +1 +1 -1 = index 1 → the second catalog row ('kill')
    expect(onPick).toHaveBeenCalledWith('kill');
  });
  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={onClose} />);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

// ── Integration: ChatComposer → ArgMenu (Task 4.1) ───────────────────────────────────────────────

describe('ChatComposer → ArgMenu integration (Task 4.1)', () => {
  let ChatComposer: typeof import('../components/ChatComposer').ChatComposer;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ ChatComposer } = await import('../components/ChatComposer'));
  });

  it('after typing "/kill " shows the arg-value list from api.commandArgs', async () => {
    const { api } = await import('../lib/api');
    const { container } = render(
      <ChatComposer disabled={false} running={false} cwd="/work" sessionId="sess-1" onSend={() => {}} onCommand={() => {}} onStop={() => {}} />,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    // pick /kill via SlashMenu first so cmds catalog is populated
    fireEvent.change(ta, { target: { value: '/kill ' } });
    // wait for api.commandArgs to be called and ArgMenu to appear
    await waitFor(() => expect((api.commandArgs as any).mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBeGreaterThan(0));
  });

  it('selecting a value from ArgMenu inserts it into the textarea', async () => {
    const { container } = render(
      <ChatComposer disabled={false} running={false} cwd="/work" sessionId="sess-1" onSend={() => {}} onCommand={() => {}} onStop={() => {}} />,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/kill ' } });
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBeGreaterThan(0));
    // pick the first item via Enter
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(ta.value).toMatch(/^\/kill run-abc /));
  });
});
