import { describe, it, expect } from 'vitest';
import db, { chatRepo } from '../src/chat.js';
import type { ChatAttachment } from '@fleet/shared';

describe('chat_messages attachments migration', () => {
  it('adds a nullable attachments column (additive; old rows unaffected)', () => {
    const cols = (db.prepare("PRAGMA table_info('chat_messages')").all() as any[]).map((c) => c.name);
    expect(cols).toContain('attachments');
  });

  it('round-trips attachments through add/list; messages without them read back undefined', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/att' });
    const atts: ChatAttachment[] = [
      { path: 'src/index.ts', kind: 'file' },
      { path: 'docs', kind: 'dir' },
    ];
    chatRepo.addMessage({ sessionId: s.id, role: 'user', kind: 'text', content: 'see these', runId: null, attachments: atts });
    chatRepo.addMessage({ sessionId: s.id, role: 'assistant', kind: 'text', content: 'ok', runId: 'r1' });

    const msgs = chatRepo.listMessages(s.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].attachments).toEqual(atts);
    // a message added WITHOUT attachments must read back undefined, not [] or null
    expect(msgs[1].attachments).toBeUndefined();

    chatRepo.deleteSession(s.id);
  });
});
