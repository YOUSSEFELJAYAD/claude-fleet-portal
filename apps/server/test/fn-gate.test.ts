import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, enqueueGate, resolveGate, listGates, rejectGatesForSession } from '../src/gate.js';

describe('gate store', () => {
  beforeEach(() => __clearGatesForTests());

  it('enqueues a gate and lists it', () => {
    const { id } = enqueueGate({ sessionId: 's1', question: 'A or B?', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    const gates = listGates();
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ id, sessionId: 's1', question: 'A or B?', options: ['A', 'B'] });
  });

  it('resolveGate settles the awaited promise with the selection and removes the gate', async () => {
    const g = enqueueGate({ sessionId: 's1', question: 'q', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    const settled = g.answer; // Promise<{ selection: string[]; text?: string }>
    resolveGate(g.id, { selection: ['B'] });
    await expect(settled).resolves.toEqual({ selection: ['B'] });
    expect(listGates()).toHaveLength(0);
  });

  it('rejectGatesForSession rejects pending gates for a run', async () => {
    const g = enqueueGate({ sessionId: 's9', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    rejectGatesForSession('s9', 'run ended');
    await expect(g.answer).rejects.toThrow('run ended');
    expect(listGates()).toHaveLength(0);
  });

  it('resolveGate on an unknown id is a no-op', () => {
    expect(() => resolveGate('nope', { selection: ['A'] })).not.toThrow();
  });
});
