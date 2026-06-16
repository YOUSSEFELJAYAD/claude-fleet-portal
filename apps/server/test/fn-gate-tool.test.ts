import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, listGates, resolveGate } from '../src/gate.js';
import { handleAskHuman } from '../src/gateServer.js';

describe('ask_human handler', () => {
  beforeEach(() => __clearGatesForTests());

  it('parks a gate, blocks, and returns the selection as text content', async () => {
    const p = handleAskHuman('s1', { question: 'A or B?', options: ['A', 'B'] });
    const g = listGates()[0];
    expect(g.sessionId).toBe('s1');
    resolveGate(g.id, { selection: ['B'] });
    const result = await p;
    expect(result).toEqual({ content: [{ type: 'text', text: 'B' }] });
  });

  it('joins multi-select answers and appends free text', async () => {
    const p = handleAskHuman('s1', { question: 'q', options: ['A', 'B'], multiSelect: true, allowFreeText: true });
    const g = listGates()[0];
    resolveGate(g.id, { selection: ['A', 'B'], text: 'also C' });
    const result = await p;
    expect(result.content[0].text).toBe('A, B\n\nNote: also C');
  });

  it('rejects malformed args with an error result (no throw to transport)', async () => {
    const result = await handleAskHuman('s1', { options: ['A'] } as any);
    expect(result.isError).toBe(true);
  });
});
