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

beforeEach(() => {
  vi.clearAllMocks();
  // restore the default implementation so tests that override mockImplementation don't bleed
  findFiles.mockImplementation(async () => results);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('MentionMenu', () => {
  it('debounces the search and renders the ranked results', async () => {
    const { container } = render(<MentionMenu query="a" sessionId="sess-1" onPick={() => {}} onClose={() => {}} />);
    // before the debounce window elapses, no fetch has fired
    expect(findFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(findFiles).toHaveBeenCalledWith('sess-1', 'a', expect.any(Number), expect.any(AbortSignal));
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
  });

  it('picks a result as a ChatAttachment with its kind', async () => {
    const onPick = vi.fn();
    const { container } = render(<MentionMenu query="a" sessionId="sess-1" onPick={onPick} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    const rows = container.querySelectorAll('[data-menu-item]');
    fireEvent.mouseDown(rows[1]); // the dir
    expect(onPick).toHaveBeenCalledWith({ path: 'src/', kind: 'dir' });
  });

  it('coalesces rapid query changes into a single trailing fetch', async () => {
    const { rerender } = render(<MentionMenu query="a" sessionId="sess-1" onPick={() => {}} onClose={() => {}} />);
    rerender(<MentionMenu query="ab" sessionId="sess-1" onPick={() => {}} onClose={() => {}} />);
    rerender(<MentionMenu query="abc" sessionId="sess-1" onPick={() => {}} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200);
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(findFiles).toHaveBeenLastCalledWith('sess-1', 'abc', expect.any(Number), expect.any(AbortSignal));
  });

  it('passes an AbortSignal and aborts it when the query changes (in-flight request cancelled)', async () => {
    let capturedSignal: AbortSignal | undefined;
    (findFiles as any).mockImplementation((_: string, _q: string, _limit: number, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves — stays in-flight
    });
    const { rerender } = render(<MentionMenu query="a" sessionId="s" onPick={() => {}} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200); // debounce fires, findFiles("a") in-flight
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    rerender(<MentionMenu query="ab" sessionId="s" onPick={() => {}} onClose={() => {}} />);
    // cleanup runs synchronously: ctrl.abort() called before "ab" effect starts
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('drops stale results when an earlier request resolves after a later one', async () => {
    type FRResult = { path: string; kind: 'file'; score: number };
    let resolveA!: (v: FRResult[]) => void;
    const resultsA: FRResult[] = [{ path: 'a.ts', kind: 'file', score: 1 }];
    const resultsAb: FRResult[] = [{ path: 'ab.ts', kind: 'file', score: 1 }];

    (findFiles as any).mockImplementation((_: string, q: string) =>
      q === 'a'
        ? new Promise<FRResult[]>((resolve) => { resolveA = resolve; })
        : Promise.resolve(resultsAb),
    );

    const { rerender, container } = render(
      <MentionMenu query="a" sessionId="s" onPick={() => {}} onClose={() => {}} />,
    );
    await vi.advanceTimersByTimeAsync(200); // fires findFiles("a") — stays pending

    rerender(<MentionMenu query="ab" sessionId="s" onPick={() => {}} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200); // fires findFiles("ab") — resolves immediately

    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    expect(container.querySelector('[data-menu-item]')?.textContent).toContain('ab.ts');

    // "a" resolves late — should be ignored; "ab"'s results must stay
    resolveA(resultsA);
    // flush microtasks: the "a" async callback resumes and hits the alive=false guard
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelectorAll('[data-menu-item]').length).toBe(1);
    expect(container.querySelector('[data-menu-item]')?.textContent).toContain('ab.ts');
  });
});

describe('MentionMenu — keyboard nav', () => {
  it('ArrowDown + Enter picks the highlighted result', async () => {
    const onPick = vi.fn();
    const { container } = render(<MentionMenu query="a" sessionId="sess-1" onPick={onPick} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith({ path: 'src/', kind: 'dir' });
  });
});
