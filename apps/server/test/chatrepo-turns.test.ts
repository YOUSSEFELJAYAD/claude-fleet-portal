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
  ({ chatRepo, backfillChatTurns } = await import('../src/chatRepo.js'));
  ({ default: db } = await import('../src/db.js'));
});

describe('backfillChatTurns + listTurns', () => {
  it('resolves a relative session cwd to an absolute path (fixes /api/skills + /api/subagents 400)', () => {
    expect(chatRepo.createSession({ cwd: '.' }).cwd.startsWith('/')).toBe(true);
    expect(chatRepo.createSession({ cwd: '/abs/keep' }).cwd).toBe('/abs/keep');
  });

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

    // allTurns is oldest-first: allTurns[0]=t1 (base), allTurns[last]=t2 (base+10)
    expect(allTurns[0].createdAt).toBeLessThan(allTurns[allTurns.length - 1].createdAt);
    // before = newest.createdAt → only t1 (base) qualifies
    const newerCreatedAt = allTurns[allTurns.length - 1].createdAt;
    const filtered = chatRepo.listTurns(sid, { before: newerCreatedAt });
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe(t1);
  });
});

// Fix 1 — assistant reply reuses the session's current turn when no turnId is provided
describe('chatRepo.lastTurnId', () => {
  it('returns the most recent turn_id; assistant with no explicit turnId reuses it', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/lastturn-test' });
    const sid = session.id;
    const tid = chatRepo.newTurnId();

    // fresh session → null
    expect(chatRepo.lastTurnId(sid)).toBeNull();

    chatRepo.addMessage({ sessionId: sid, role: 'user', kind: 'text', content: 'hi', runId: null, turnId: tid });
    expect(chatRepo.lastTurnId(sid)).toBe(tid);

    // Simulate the /messages route: assistant reply with no explicit turnId
    const replyTurnId = chatRepo.lastTurnId(sid) ?? chatRepo.newTurnId();
    chatRepo.addMessage({ sessionId: sid, role: 'assistant', kind: 'text', content: 'hello', runId: 'r1', turnId: replyTurnId });

    // both messages land in ONE turn
    const turns = chatRepo.listTurns(sid);
    expect(turns.length).toBe(1);
    expect(turns[0].id).toBe(tid);
    expect(turns[0].messages).toHaveLength(2);
  });
});

// Fix 2 — same-ms turns sort deterministically; before-cursor doesn't drop/duplicate
describe('chatRepo.listTurns stable sort', () => {
  it('ordering is deterministic when two turns share the same createdAt', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/stable-sort-test' });
    const sid = session.id;
    const t1 = chatRepo.newTurnId();
    const t2 = chatRepo.newTurnId();
    const t3 = chatRepo.newTurnId();
    const sameTs = Date.now();

    const ins = db.prepare(`INSERT INTO chat_messages (id,session_id,role,kind,content,run_id,turn_id,created_at)
      VALUES (@id,@session_id,@role,@kind,@content,@run_id,@turn_id,@created_at)`);
    // t1 and t2 share the SAME timestamp; t3 is one ms newer
    ins.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'm1', run_id: null, turn_id: t1, created_at: sameTs });
    ins.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'm2', run_id: null, turn_id: t2, created_at: sameTs });
    ins.run({ id: randomUUID(), session_id: sid, role: 'user', kind: 'text', content: 'm3', run_id: null, turn_id: t3, created_at: sameTs + 1 });

    const order1 = chatRepo.listTurns(sid).map(t => t.id);
    const order2 = chatRepo.listTurns(sid).map(t => t.id);
    // deterministic: same order on every call
    expect(order1).toEqual(order2);
    // t3 is newest → always last in oldest-first order
    expect(order1[order1.length - 1]).toBe(t3);

    // before = sameTs+1 → both t1 and t2 qualify, neither is dropped or duplicated
    const page = chatRepo.listTurns(sid, { before: sameTs + 1 });
    expect(page.length).toBe(2);
    const pageIds = new Set(page.map(t => t.id));
    expect(pageIds.has(t1)).toBe(true);
    expect(pageIds.has(t2)).toBe(true);
    // page order is also stable
    const page2 = chatRepo.listTurns(sid, { before: sameTs + 1 });
    expect(page.map(t => t.id)).toEqual(page2.map(t => t.id));
  });
});
