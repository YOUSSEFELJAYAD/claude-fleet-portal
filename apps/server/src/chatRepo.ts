/**
 * Chat persistence — pure DB layer for chat sessions and messages.
 * Moved from chat.ts (Task 1.2). Owns the chat_sessions / chat_messages DDL,
 * the turn_id column, grouping/pagination, and the legacy backfill.
 */
import { randomUUID } from 'node:crypto';
import db from './db.js';
import type {
  ChatSession, ChatMessage, ChatRole, ChatMessageKind,
  CreateChatSessionRequest, RunEngine, EffortLevel, PermissionMode,
  ChatAttachment, ChatTurn,
} from '@fleet/shared';

// ── DDL ──────────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'claude',
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  cwd TEXT NOT NULL,
  allowed_tools TEXT,
  skills TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id TEXT,
  turn_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
`);

// ── Additive migrations (idempotent) ─────────────────────────────────────────

for (const ddl of [
  'ALTER TABLE chat_messages ADD COLUMN attachments TEXT',
  'ALTER TABLE chat_messages ADD COLUMN turn_id TEXT',
]) {
  try {
    db.exec(ddl);
  } catch (e: any) {
    if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
  }
}

// ── Prepared statements ───────────────────────────────────────────────────────

const insSession = db.prepare(`INSERT INTO chat_sessions
  (id,title,engine,model,effort,permission_mode,cwd,allowed_tools,skills,run_id,created_at,updated_at)
  VALUES (@id,@title,@engine,@model,@effort,@permission_mode,@cwd,@allowed_tools,@skills,@run_id,@created_at,@updated_at)`);
const getSessionStmt = db.prepare('SELECT * FROM chat_sessions WHERE id = ?');
const listSessionsStmt = db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC');
const renameStmt = db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?');
const setRunStmt = db.prepare('UPDATE chat_sessions SET run_id = ?, updated_at = ? WHERE id = ?');
const delSessionStmt = db.prepare('DELETE FROM chat_sessions WHERE id = ?');
const delMessagesStmt = db.prepare('DELETE FROM chat_messages WHERE session_id = ?');
const insMessage = db.prepare(`INSERT INTO chat_messages
  (id,session_id,role,kind,content,run_id,turn_id,attachments,created_at)
  VALUES (@id,@session_id,@role,@kind,@content,@run_id,@turn_id,@attachments,@created_at)`);
const listMessagesStmt = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC');
const lastTurnIdStmt = db.prepare('SELECT turn_id FROM chat_messages WHERE session_id = ? AND turn_id IS NOT NULL ORDER BY created_at DESC LIMIT 1');
const getTurnStmt = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? AND turn_id = ? ORDER BY created_at ASC');

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToSession(r: any): ChatSession {
  return {
    id: r.id, title: r.title, engine: r.engine as RunEngine, model: r.model,
    effort: r.effort as EffortLevel, permissionMode: r.permission_mode as PermissionMode, cwd: r.cwd,
    allowedTools: r.allowed_tools ? JSON.parse(r.allowed_tools) : null,
    skills: r.skills ? JSON.parse(r.skills) : null,
    runId: r.run_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToMessage(r: any): ChatMessage {
  const msg: ChatMessage = {
    id: r.id, sessionId: r.session_id, role: r.role as ChatRole, kind: r.kind as ChatMessageKind,
    content: r.content, runId: r.run_id ?? null, turnId: r.turn_id ?? '', createdAt: r.created_at,
  };
  if (r.attachments) {
    try { msg.attachments = JSON.parse(r.attachments) as ChatAttachment[]; } catch { /* leave undefined on garbage */ }
  }
  return msg;
}

// ── chatRepo ─────────────────────────────────────────────────────────────────

export const chatRepo = {
  createSession(req: CreateChatSessionRequest): ChatSession {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      title: req.title?.trim() || 'New chat',
      engine: req.engine ?? 'claude',
      model: req.model ?? 'claude-opus-4-8',
      effort: req.effort ?? 'high',
      permission_mode: req.permissionMode ?? 'default',
      cwd: req.cwd,
      allowed_tools: req.allowedTools ? JSON.stringify(req.allowedTools) : null,
      skills: req.skills ? JSON.stringify(req.skills) : null,
      run_id: null as string | null,
      created_at: now, updated_at: now,
    };
    insSession.run(row);
    return rowToSession({ ...row });
  },

  listSessions(): ChatSession[] { return (listSessionsStmt.all() as any[]).map(rowToSession); },

  getSession(id: string): ChatSession | null {
    const r = getSessionStmt.get(id);
    return r ? rowToSession(r) : null;
  },

  renameSession(id: string, title: string) { renameStmt.run(title, Date.now(), id); },

  setSessionRun(id: string, runId: string | null) { setRunStmt.run(runId, Date.now(), id); },

  deleteSession(id: string) { delMessagesStmt.run(id); delSessionStmt.run(id); },

  addMessage(m: {
    sessionId: string;
    role: ChatRole;
    kind: ChatMessageKind;
    content: string;
    runId: string | null;
    turnId: string;
    attachments?: ChatAttachment[];
  }): ChatMessage {
    const row = {
      id: randomUUID(), session_id: m.sessionId, role: m.role, kind: m.kind, content: m.content,
      run_id: m.runId, turn_id: m.turnId,
      attachments: m.attachments && m.attachments.length ? JSON.stringify(m.attachments) : null,
      created_at: Date.now(),
    };
    insMessage.run(row);
    return rowToMessage(row);
  },

  listMessages(sessionId: string): ChatMessage[] {
    return (listMessagesStmt.all(sessionId) as any[]).map(rowToMessage);
  },

  /** The turn_id of the session's most recent message, or null if none. */
  lastTurnId(sessionId: string): string | null {
    const r = lastTurnIdStmt.get(sessionId) as { turn_id: string } | undefined;
    return r?.turn_id ?? null;
  },

  /** Groups a session's messages into ChatTurn[], newest turn first, messages ASC within.
   *  `before` is a createdAt cursor (exclusive upper bound on turn.createdAt). */
  listTurns(sessionId: string, opts?: { before?: number; limit?: number }): ChatTurn[] {
    const rows = (listMessagesStmt.all(sessionId) as any[]).map(rowToMessage);

    // Group by turn_id, preserving first-message-createdAt as the turn's createdAt
    const turnMap = new Map<string, { msgs: ChatMessage[]; createdAt: number }>();
    for (const msg of rows) {
      if (!msg.turnId) continue; // ponytail: skip unbackfilled rows — backfill runs on boot
      const existing = turnMap.get(msg.turnId);
      if (existing) {
        existing.msgs.push(msg);
      } else {
        turnMap.set(msg.turnId, { msgs: [msg], createdAt: msg.createdAt });
      }
    }

    const limit = opts?.limit ?? 50;
    const before = opts?.before;

    let groups = Array.from(turnMap.entries()).map(([id, { msgs, createdAt }]) => ({ id, msgs, createdAt }));

    // Newest-first sort; secondary sort by turn id keeps same-ms turns deterministic
    groups.sort((a, b) => (b.createdAt - a.createdAt) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));

    // Cursor filter: only turns older than `before`
    if (before !== undefined) {
      groups = groups.filter(g => g.createdAt < before);
    }

    // Limit
    groups = groups.slice(0, limit);

    return groups.map(g => ({
      id: g.id,
      sessionId,
      status: 'settled' as const,
      messages: g.msgs, // already ASC from the DB query
      createdAt: g.createdAt,
      settledAt: null,
    }));
  },

  getTurn(sessionId: string, turnId: string): ChatTurn | null {
    const rows = (getTurnStmt.all(sessionId, turnId) as any[]).map(rowToMessage);
    if (!rows.length) return null;
    return {
      id: turnId,
      sessionId,
      status: 'settled' as const,
      messages: rows,
      createdAt: rows[0].createdAt,
      settledAt: null,
    };
  },

  newTurnId(): string { return randomUUID(); },
};

// ── Legacy backfill ───────────────────────────────────────────────────────────

/** Group existing NULL turn_id messages by user-message boundaries (idempotent).
 *  Called once on boot; a second call is a no-op because we only UPDATE where turn_id IS NULL. */
export function backfillChatTurns(): void {
  const sessions = (db.prepare('SELECT id FROM chat_sessions').all() as any[]).map((r) => r.id as string);

  const listNullMsgs = db.prepare(
    'SELECT id, role FROM chat_messages WHERE session_id = ? AND turn_id IS NULL ORDER BY created_at ASC',
  );
  const updateTurnId = db.prepare(
    'UPDATE chat_messages SET turn_id = ? WHERE id = ? AND turn_id IS NULL',
  );

  const tx = db.transaction((sessionId: string) => {
    const msgs = listNullMsgs.all(sessionId) as Array<{ id: string; role: string }>;
    if (!msgs.length) return;

    let currentTurnId: string | null = null;
    for (const msg of msgs) {
      if (msg.role === 'user' || currentTurnId === null) {
        currentTurnId = randomUUID();
      }
      updateTurnId.run(currentTurnId, msg.id);
    }
  });

  for (const sid of sessions) {
    try { tx(sid); } catch (e) { console.warn('[chatRepo] backfill error for session', sid, e); }
  }
}

// Boot: run backfill (idempotent — only touches NULL turn_id rows)
backfillChatTurns();
