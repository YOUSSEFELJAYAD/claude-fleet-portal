/**
 * Real tests for the runtime helpers in @fleet/shared (the frozen contract):
 *   emptyUsage() — fresh zeroed token-usage accumulator
 *   isLive()     — whether a RunStatus is controllable / consuming budget
 */
import { describe, it, expect } from 'vitest';
import { emptyUsage, isLive, LIVE_STATUSES } from '@fleet/shared';
import type { RunStatus } from '@fleet/shared';

describe('emptyUsage', () => {
  it('returns an all-zero usage object', () => {
    expect(emptyUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('returns a fresh object each call (no shared mutable singleton)', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    expect(a).not.toBe(b);
    a.inputTokens = 99;
    expect(b.inputTokens).toBe(0);
  });
});

describe('isLive', () => {
  const live: RunStatus[] = ['starting', 'running', 'awaiting-input', 'awaiting-permission', 'orchestrating'];
  const terminal: RunStatus[] = ['completed', 'failed', 'killed'];

  it('is true for every live status', () => {
    for (const s of live) expect(isLive(s)).toBe(true);
  });

  it('is false for every terminal status', () => {
    for (const s of terminal) expect(isLive(s)).toBe(false);
  });

  it('agrees exactly with the exported LIVE_STATUSES set', () => {
    expect([...live].sort()).toEqual([...LIVE_STATUSES].sort());
  });
});
