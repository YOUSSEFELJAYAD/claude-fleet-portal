import { describe, it, expect } from 'vitest';
import { turnsToMarkdown } from '../lib/chatExport';
import type { ChatTurn, ChatMessage } from '@fleet/shared';

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm' + Math.random(), sessionId: 's1', role: 'user', kind: 'text', content: '', runId: null, turnId: 't', createdAt: 0, ...over };
}
function turn(over: Partial<ChatTurn>): ChatTurn {
  return { id: 't1', sessionId: 's1', status: 'settled', messages: [], createdAt: 0, settledAt: 0, ...over };
}

describe('turnsToMarkdown', () => {
  it('serializes user/assistant text turns with rule separators, skipping non-text', () => {
    const md = turnsToMarkdown([
      turn({ id: 't1', messages: [msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'hello' })] }),
      turn({ id: 't2', messages: [msg({ role: 'user', content: 'next' }), msg({ role: 'assistant', kind: 'command', content: '/clear' })] }),
    ]);
    expect(md).toContain('**You:**\n\nhi');
    expect(md).toContain('**Assistant:**\n\nhello');
    expect(md).toContain('\n\n---\n\n'); // turn separator
    expect(md).toContain('**You:**\n\nnext');
    expect(md).not.toContain('/clear'); // command message skipped
  });

  it('returns empty string for no text content', () => {
    expect(turnsToMarkdown([turn({ messages: [msg({ kind: 'command', content: '/x' })] })])).toBe('');
  });
});
