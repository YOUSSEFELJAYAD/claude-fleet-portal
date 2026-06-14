/**
 * MentionMenu — the `@` file/folder picker. Debounces GET /api/files/find (scoped to
 * the session cwd) on the `query` prop and renders ranked results. Picking a row hands
 * a ChatAttachment {path, kind} back to the composer. We use fake timers to step past
 * the debounce and mock the `api` module.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const results = [
  { path: 'src/a.ts', kind: 'file', score: 9 },
  { path: 'src/', kind: 'dir', score: 8 },
];
const findFiles = vi.fn(async () => results);
vi.mock('../lib/api', () => ({ api: { findFiles: (...a: any[]) => (findFiles as any)(...a) } }));

import { MentionMenu } from '../components/MentionMenu';

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('MentionMenu', () => {
  it('debounces the search and renders the ranked results', async () => {
    const { container } = render(<MentionMenu query="a" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    // before the debounce window elapses, no fetch has fired
    expect(findFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(findFiles).toHaveBeenCalledWith('/work', 'a', expect.any(Number));
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
  });

  it('picks a result as a ChatAttachment with its kind', async () => {
    const onPick = vi.fn();
    const { container } = render(<MentionMenu query="a" cwd="/work" onPick={onPick} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    const rows = container.querySelectorAll('[data-menu-item]');
    fireEvent.mouseDown(rows[1]); // the dir
    expect(onPick).toHaveBeenCalledWith({ path: 'src/', kind: 'dir' });
  });

  it('coalesces rapid query changes into a single trailing fetch', async () => {
    const { rerender } = render(<MentionMenu query="a" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    rerender(<MentionMenu query="ab" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    rerender(<MentionMenu query="abc" cwd="/work" onPick={() => {}} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200);
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(findFiles).toHaveBeenLastCalledWith('/work', 'abc', expect.any(Number));
  });
});

describe('MentionMenu — keyboard nav', () => {
  it('ArrowDown + Enter picks the highlighted result', async () => {
    const onPick = vi.fn();
    const { container } = render(<MentionMenu query="a" cwd="/work" onPick={onPick} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith({ path: 'src/', kind: 'dir' });
  });
});
