import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, enqueueGate, listGates, rejectGatesForSession } from '../src/gate.js';

describe('gate cleanup on terminal', () => {
  beforeEach(() => __clearGatesForTests());
  it('rejectGatesForSession clears a run\'s pending gates and rejects the awaiting call', async () => {
    const g = enqueueGate({ sessionId: 'sX', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    rejectGatesForSession('sX', 'run terminal');
    await expect(g.answer).rejects.toThrow('run terminal');
    expect(listGates()).toHaveLength(0);
  });
  it('only rejects gates for the matching session', async () => {
    const a = enqueueGate({ sessionId: 'sA', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    const b = enqueueGate({ sessionId: 'sB', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    rejectGatesForSession('sA', 'gone');
    await expect(a.answer).rejects.toThrow('gone');
    expect(listGates().map((x) => x.sessionId)).toEqual(['sB']);
    rejectGatesForSession('sB', 'cleanup'); // avoid an unhandled pending promise
    await expect(b.answer).rejects.toThrow();
  });
});
