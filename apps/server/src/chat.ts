/**
 * Chat Dashboard (§30) — multi-session agent control-plane.
 * A chat session maps to one run id, advanced resume-per-turn (DC §D-029). This module owns
 * session/message persistence, turn orchestration, and the HTTP routes.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import db from './db.js';
import { registry } from './registry.js';
import { dispatchCommand } from './commands.js';
import type {
  ChatSession, ChatMessage, ChatRole, ChatMessageKind,
  CreateChatSessionRequest, RunEngine, EffortLevel, PermissionMode,
  ChatTurnResponse, AddChatMessageRequest, ChatAttachment,
} from '@fleet/shared';

export { db };
export default db;

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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
`);

// §6 — additive migration: nullable attachments (JSON array of ChatAttachment).
// Guarded by table_info so it is idempotent (safe on existing DBs + repeated test runs);
// old rows keep attachments = NULL.
{
  const hasAttachments = (db.prepare("PRAGMA table_info('chat_messages')").all() as any[])
    .some((c) => c.name === 'attachments');
  if (!hasAttachments) db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT');
}

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
  (id,session_id,role,kind,content,run_id,attachments,created_at)
  VALUES (@id,@session_id,@role,@kind,@content,@run_id,@attachments,@created_at)`);
const listMessagesStmt = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC');

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
    content: r.content, runId: r.run_id ?? null, createdAt: r.created_at,
  };
  if (r.attachments) {
    try { msg.attachments = JSON.parse(r.attachments) as ChatAttachment[]; } catch { /* leave undefined on garbage */ }
  }
  return msg;
}

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
  getSession(id: string): ChatSession | null { const r = getSessionStmt.get(id); return r ? rowToSession(r) : null; },
  renameSession(id: string, title: string) { renameStmt.run(title, Date.now(), id); },
  setSessionRun(id: string, runId: string | null) { setRunStmt.run(runId, Date.now(), id); },
  deleteSession(id: string) { delMessagesStmt.run(id); delSessionStmt.run(id); },
  addMessage(m: { sessionId: string; role: ChatRole; kind: ChatMessageKind; content: string; runId: string | null; attachments?: ChatAttachment[] }): ChatMessage {
    const row = {
      id: randomUUID(), session_id: m.sessionId, role: m.role, kind: m.kind, content: m.content,
      run_id: m.runId,
      attachments: m.attachments && m.attachments.length ? JSON.stringify(m.attachments) : null,
      created_at: Date.now(),
    };
    insMessage.run(row);
    return rowToMessage(row);
  },
  listMessages(sessionId: string): ChatMessage[] { return (listMessagesStmt.all(sessionId) as any[]).map(rowToMessage); },
};

const ENGINE_PROMPT_CAP = 6_000;

/** Engines (codex/opencode) cannot resume, so reconstruct a capped transcript prefix into each
 *  turn's prompt (DC §D-030). Keeps the most recent turns when over the cap. */
export function buildEnginePrompt(history: Array<{ role: string; content: string }>, message: string): string {
  const tail = `\nUser: ${message}\nAssistant:`;
  const turns = history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  let body = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    const next = turns[i] + '\n' + body;
    if (next.length + tail.length > ENGINE_PROMPT_CAP) break;
    body = next;
  }
  return (body + tail).trimStart();
}

/** Run one chat turn. Persists the user message, then launches (turn 1) or resumes (turn N) for
 *  Claude, or launches a fresh engine one-shot with a reconstructed prompt for engines. */
export async function startTurn(sessionId: string, message: string): Promise<ChatTurnResponse> {
  const session = chatRepo.getSession(sessionId);
  if (!session) throw Object.assign(new Error('session not found'), { statusCode: 404 });
  if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('message is required'), { statusCode: 400 });

  const userMessage = chatRepo.addMessage({ sessionId, role: 'user', kind: 'text', content: message, runId: null });
  const opts = {
    cwd: session.cwd, model: session.model, effort: session.effort, permissionMode: session.permissionMode,
    allowedTools: session.allowedTools ?? undefined, skills: session.skills ?? undefined,
  };

  let run: { id: string };
  if (session.engine && session.engine !== 'claude') {
    const history = chatRepo.listMessages(sessionId).slice(0, -1); // exclude the just-added user msg
    const prompt = buildEnginePrompt(history.map((m) => ({ role: m.role, content: m.content })), message);
    run = await registry.launchEngine({ ...opts, engine: session.engine, prompt });
  } else if (!session.runId) {
    run = await registry.launch({ ...opts, prompt: message });
  } else {
    run = await registry.resume(session.runId, message, undefined);
  }
  chatRepo.setSessionRun(sessionId, run.id);
  return { runId: run.id, userMessage };
}

export function registerChatRoutes(app: FastifyInstance) {
  app.get('/api/chat/sessions', async () => chatRepo.listSessions());

  app.post('/api/chat/sessions', async (req, reply) => {
    const b = (req.body ?? {}) as CreateChatSessionRequest;
    if (!b.cwd || typeof b.cwd !== 'string') return reply.code(400).send({ error: 'cwd is required' });
    return chatRepo.createSession(b);
  });

  app.get('/api/chat/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return { session, messages: chatRepo.listMessages(id) };
  });

  app.patch('/api/chat/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!chatRepo.getSession(id)) return reply.code(404).send({ error: 'not found' });
    const title = (req.body as any)?.title;
    if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: 'title is required' });
    chatRepo.renameSession(id, title.trim());
    return chatRepo.getSession(id);
  });

  app.delete('/api/chat/sessions/:id', async (req) => {
    chatRepo.deleteSession((req.params as any).id);
    return { ok: true };
  });

  app.post('/api/chat/sessions/:id/turn', async (req, reply) => {
    try {
      return await startTurn((req.params as any).id, (req.body as any)?.message);
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'turn failed' });
    }
  });

  // Generic add-message — the client persists the assistant reply on stream-terminal (plan note 1).
  app.post('/api/chat/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id;
    if (!chatRepo.getSession(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as AddChatMessageRequest;
    if (typeof b.content !== 'string') return reply.code(400).send({ error: 'content is required' });
    return chatRepo.addMessage({ sessionId: id, role: b.role, kind: b.kind, content: b.content, runId: b.runId ?? null });
  });

  app.post('/api/chat/sessions/:id/command', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const line = (req.body as any)?.line;
    if (typeof line !== 'string' || !line.trim()) return reply.code(400).send({ error: 'line is required' });
    chatRepo.addMessage({ sessionId: id, role: 'user', kind: 'command', content: line, runId: null });
    const result = await dispatchCommand(line, session.cwd);
    chatRepo.addMessage({ sessionId: id, role: 'system', kind: result.ok ? 'command-result' : 'error', content: result.text ?? JSON.stringify(result), runId: result.runId ?? null });
    return result;
  });
}
