/**
 * Task 3.2 — chat FTS: searchChat + backfillChatFts.
 * Isolated DB (FLEET_DATA_DIR set before any src import).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-search-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let chatRepo: typeof import('../src/chatRepo.js').chatRepo;
let searchChat: typeof import('../src/chatRepo.js').searchChat;
let backfillChatFts: typeof import('../src/chatRepo.js').backfillChatFts;
let db: typeof import('../src/db.js').default;

beforeAll(async () => {
  ({ chatRepo, searchChat, backfillChatFts } = await import('../src/chatRepo.js'));
  ({ default: db } = await import('../src/db.js'));
});

// ── helpers ───────────────────────────────────────────────────────────────────

function seed(title: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const session = chatRepo.createSession({ cwd: '/tmp/search-test', title });
  const sid = session.id;
  const tid = chatRepo.newTurnId();
  for (const m of messages) {
    chatRepo.addMessage({ sessionId: sid, role: m.role, kind: 'text', content: m.content, runId: null, turnId: tid });
  }
  return { session, turnId: tid };
}

// ── cross-session search ──────────────────────────────────────────────────────

describe('searchChat — cross-session', () => {
  it('returns hits from both sessions when the needle appears in each', () => {
    const { session: sA, turnId: tA } = seed('Session Alpha', [
      { role: 'user', content: 'needle in session alpha' },
      { role: 'assistant', content: 'found it here in alpha' },
    ]);
    const { session: sB, turnId: tB } = seed('Session Beta', [
      { role: 'user', content: 'needle in session beta too' },
    ]);

    const hits = searchChat('needle');
    const sessionIds = hits.map(h => h.sessionId);
    expect(sessionIds).toContain(sA.id);
    expect(sessionIds).toContain(sB.id);

    for (const hit of hits) {
      expect(hit.snippet.length).toBeGreaterThan(0);
      expect(hit.turnId).toBeTruthy();
      if (hit.sessionId === sA.id) {
        expect(hit.sessionTitle).toBe('Session Alpha');
        expect(hit.turnId).toBe(tA);
      }
      if (hit.sessionId === sB.id) {
        expect(hit.sessionTitle).toBe('Session Beta');
        expect(hit.turnId).toBe(tB);
      }
    }
  });
});

// ── session-scoped search ─────────────────────────────────────────────────────

describe('searchChat — session-scoped', () => {
  it('restricts results to the given sessionId', () => {
    const { session: sC } = seed('Session C', [{ role: 'user', content: 'unique-needle-xyz in C' }]);
    const { session: sD } = seed('Session D', [{ role: 'user', content: 'unique-needle-xyz in D' }]);

    const hitsAll = searchChat('unique-needle-xyz');
    expect(hitsAll.length).toBeGreaterThanOrEqual(2);

    const hitsC = searchChat('unique-needle-xyz', sC.id);
    expect(hitsC.every(h => h.sessionId === sC.id)).toBe(true);
    expect(hitsC.some(h => h.sessionId === sD.id)).toBe(false);
  });
});

// ── operator-laden query safety ───────────────────────────────────────────────

describe('searchChat — bad query does not throw', () => {
  it('handles operator-laden input safely', () => {
    expect(() => searchChat('a"b*')).not.toThrow();
    expect(() => searchChat('AND OR NOT')).not.toThrow();
    expect(() => searchChat('NEAR/5(foo bar)')).not.toThrow();
  });
});

// ── backfill ──────────────────────────────────────────────────────────────────

describe('backfillChatFts', () => {
  it('indexes a pre-existing message inserted directly via SQL', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/backfill-fts' });
    const sid = session.id;
    const msgId = randomUUID();
    const tid = chatRepo.newTurnId();

    // Insert directly into chat_messages (bypasses addMessage → no FTS entry yet)
    db.prepare(`INSERT INTO chat_messages (id, session_id, role, kind, content, run_id, turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(msgId, sid, 'user', 'text', 'backfill-unique-token', tid, Date.now());

    // Before backfill: should not appear in search
    const before = searchChat('backfill-unique-token');
    expect(before.some(h => h.messageId === msgId)).toBe(false);

    backfillChatFts();

    // After backfill: should appear
    const after = searchChat('backfill-unique-token');
    expect(after.some(h => h.messageId === msgId)).toBe(true);
  });

  it('second backfill is a no-op (no duplicate hits)', () => {
    const session = chatRepo.createSession({ cwd: '/tmp/backfill-idem-fts' });
    const sid = session.id;
    const msgId = randomUUID();
    const tid = chatRepo.newTurnId();

    db.prepare(`INSERT INTO chat_messages (id, session_id, role, kind, content, run_id, turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(msgId, sid, 'user', 'text', 'idempotent-needle-abc', tid, Date.now());

    backfillChatFts();
    backfillChatFts(); // second call — must be a no-op

    const hits = searchChat('idempotent-needle-abc');
    const forMsg = hits.filter(h => h.messageId === msgId);
    expect(forMsg.length).toBe(1); // exactly one, not two
  });
});
