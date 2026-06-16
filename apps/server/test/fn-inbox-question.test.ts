import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, enqueueGate } from '../src/gate.js';
import { getInboxItems } from '../src/inbox.js';

describe('inbox question items', () => {
  beforeEach(() => __clearGatesForTests());
  it('surfaces a pending gate as a question item', () => {
    enqueueGate({ sessionId: 's1', question: 'Scope?', options: ['narrow', 'wide'], multiSelect: false, allowFreeText: true });
    const items = getInboxItems();
    const q = items.find((i) => i.kind === 'question');
    expect(q).toBeTruthy();
    expect(q!.question).toMatchObject({ question: 'Scope?', options: ['narrow', 'wide'], allowFreeText: true });
  });
});
