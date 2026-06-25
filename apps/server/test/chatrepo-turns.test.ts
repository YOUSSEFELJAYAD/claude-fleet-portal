/**
 * Task 1.2 — chatRepo persistence: turn_id column + legacy backfill.
 * Isolated DB (FLEET_DATA_DIR set before any src import).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chatrepo-turns-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let chatRepo: typeof import('../src/chatRepo.js').chatRepo;
let backfillChatTurns: typeof import('../src/chatRepo.js').backfillChatTurns;
let db: typeof import('../src/db.js').default;

beforeAll(async () => {
  ({ chatRepo } = await import('../src/chatRepo.js'));
  ({ backfillChatTurns } = await import('../src/chatRepo.js'));
  ({ default: db } = await import('../src/db.js'));
});

describe('backfillChatTurns + listTurns', () => {
  it('groups legacy NULL-turn_id messages by user-message boundaries', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/backfill-test' });
    const sid = session.id;

    // Simulate legacy rows: raw INSERT with turn_id = NULL (no addMessage)
    const now = Date.now();
    const insLegacy = db.prepare(`
      INSERT INTO chat_messages (id, session_id, role, kind, content, run_id, created_at)
      VALUES (@id, @session_id, @role, @kind, @content, @run_id, @created_at)
    `);
    insLegacy.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'hello', run_id: null, created_at: now });
    insLegacy.run({ id: randomUUID(), session_id: sid, role: 'assistant', kind: 'text', content: 'hi there', run_id: 'r1', created_at: now + 1 });
    insLegacy.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'follow-up', run_id: null, created_at: now + 2 });

    // Verify they are NULL before backfill
    const nullCount = (db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ? AND turn_id IS NULL').get(sid) as any).c;
    expect(nullCount).toBe(3);

    backfillChatTurns();

    const turns = chatRepo.listTurns(sid);
    expect(turns.length).toBe(2); // two user boundaries → two turns
    expect(turns[0].messages[0].role).toBe('user');
    expect(turns.every(t => t.messages.every(m => m.turnId === t.id))).toBe(true);
  });

  it('second backfill is a no-op (idempotent)', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/backfill-idem' });
    const sid = session.id;
    const now = Date.now();
    const ins = db.prepare(`
      INSERT INTO chat_messages (id, session_id, role, kind, content, run_id, created_at)
      VALUES (@id, @session_id, @role, @kind, @content, @run_id, @created_at)
    `);
    ins.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'q', run_id: null, created_at: now });

    backfillChatTurns();
    const turns1 = chatRepo.listTurns(sid);
    const firstTurnId = turns1[0]?.id;
    expect(firstTurnId).toBeTruthy();

    // Second backfill must not change existing turn_ids
    backfillChatTurns();
    const turns2 = chatRepo.listTurns(sid);
    expect(turns2[0]?.id).toBe(firstTurnId);
  });
});

describe('chatRepo.addMessage with turnId', () => {
  it('persists turnId and returns it on listTurns', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/addmsg-test' });
    const sid = session.id;
    const tid = chatRepo.newTurnId();

    chatRepo.addMessage({ sessionId: sid, role: 'user', kind: 'text', content: 'hi', runId: null, turnId: tid });
    chatRepo.addMessage({ sessionId: sid, role: 'assistant', kind: 'text', content: 'hello', runId: 'r1', turnId: tid });

    const turns = chatRepo.listTurns(sid);
    expect(turns.length).toBe(1);
    expect(turns[0].id).toBe(tid);
    expect(turns[0].messages).toHaveLength(2);
    expect(turns[0].messages.every(m => m.turnId === tid)).toBe(true);
  });
});

describe('chatRepo.getTurn', () => {
  it('returns a single turn by id, null for unknown', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/getturn-test' });
    const sid = session.id;
    const tid = chatRepo.newTurnId();
    chatRepo.addMessage({ sessionId: sid, role: 'user', kind: 'text', content: 'q', runId: null, turnId: tid });

    const turn = chatRepo.getTurn(sid, tid);
    expect(turn).not.toBeNull();
    expect(turn!.id).toBe(tid);

    expect(chatRepo.getTurn(sid, 'bogus')).toBeNull();
  });
});

describe('chatRepo.listTurns pagination', () => {
  it('before cursor filters out newer turns', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/page-test' });
    const sid = session.id;
    const t1 = chatRepo.newTurnId();
    const t2 = chatRepo.newTurnId();
    const base = Date.now();

    // Insert with explicit timestamps to guarantee ordering despite same-ms execution
    const ins = db.prepare(`INSERT INTO chat_messages (id,session_id,role,kind,content,run_id,turn_id,created_at)
      VALUES (@id,@session_id,@role,@kind,@content,@run_id,@turn_id,@created_at)`);
    ins.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'first', run_id: null, turn_id: t1, created_at: base });
    ins.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'second', run_id: null, turn_id: t2, created_at: base + 10 });

    const allTurns = chatRepo.listTurns(sid);
    expect(allTurns.length).toBe(2);

    // allTurns[0] is newest (t2, base+10); before = base+10 → only t1 (base) qualifies
    const newerCreatedAt = allTurns[0].createdAt;
    const filtered = chatRepo.listTurns(sid, { before: newerCreatedAt });
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe(t1);
  });
});
