import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __clearGatesForTests, enqueueGate, listGates } from '../src/gate.js';

describe('gate TTL', () => {
  beforeEach(() => { __clearGatesForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('auto-resolves an unanswered gate after the TTL and removes it', async () => {
    const g = enqueueGate({ sessionId: 's1', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    expect(listGates()).toHaveLength(1);
    vi.advanceTimersByTime(960_000 + 10);
    await expect(g.answer).resolves.toEqual({ selection: [] }); // "no answer"
    expect(listGates()).toHaveLength(0);
  });

  it('does not fire the TTL if answered first (no leak, timer cleared)', async () => {
    const { resolveGate } = await import('../src/gate.js');
    const g = enqueueGate({ sessionId: 's2', question: 'q', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    resolveGate(g.id, { selection: ['B'] });
    await expect(g.answer).resolves.toEqual({ selection: ['B'] });
    expect(listGates()).toHaveLength(0);
    // advancing past the TTL must not throw / double-resolve
    vi.advanceTimersByTime(960_000 + 10);
    expect(listGates()).toHaveLength(0);
  });
});
