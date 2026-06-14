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
import { chatLive } from './chatLive.js';
import type {
  ChatSession, ChatMessage, ChatRole, ChatMessageKind,
  CreateChatSessionRequest, RunEngine, EffortLevel, PermissionMode,
  ChatTurnResponse, AddChatMessageRequest, ChatAttachment, ChatSessionState,
} from '@fleet/shared';

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
 *  Claude, or launches a fresh engine one-shot with a reconstructed prompt for engines.
 *  §6 — files in `attachments` become path-reference tokens in the prompt; dirs become --add-dir. */
export async function startTurn(sessionId: string, message: string, attachments?: ChatAttachment[]): Promise<ChatTurnResponse> {
  const session = chatRepo.getSession(sessionId);
  if (!session) throw Object.assign(new Error('session not found'), { statusCode: 404 });
  if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('message is required'), { statusCode: 400 });

  const userMessage = chatRepo.addMessage({ sessionId, role: 'user', kind: 'text', content: message, runId: null, attachments });

  // §6.2 — files become path-reference tokens in the prompt; dirs become --add-dir for this turn.
  const files = (attachments ?? []).filter((a) => a.kind === 'file').map((a) => a.path);
  const addDirs = (attachments ?? []).filter((a) => a.kind === 'dir').map((a) => a.path);
  const refSuffix = files.length ? `\n\nReferenced files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';
  const prompt = message + refSuffix;

  const baseOpts = {
    cwd: session.cwd, model: session.model, effort: session.effort, permissionMode: session.permissionMode,
    allowedTools: session.allowedTools ?? undefined, skills: session.skills ?? undefined,
    ...(addDirs.length ? { addDirs } : {}),
  };

  let run: { id: string };
  if (session.engine && session.engine !== 'claude') {
    const history = chatRepo.listMessages(sessionId).slice(0, -1); // exclude the just-added user msg
    const enginePrompt = buildEnginePrompt(history.map((m) => ({ role: m.role, content: m.content })), prompt);
    run = await registry.launchEngine({ ...baseOpts, engine: session.engine, prompt: enginePrompt });
  } else if (!session.runId) {
    run = await registry.launch({ ...baseOpts, prompt });
  } else {
    run = await registry.resume(session.runId, prompt, undefined, addDirs.length ? addDirs : undefined);
  }
  chatRepo.setSessionRun(sessionId, run.id);
  return { runId: run.id, userMessage };
}

const TERMINAL_RUN = new Set(['completed', 'failed', 'killed']);

/** §3.1 — derive (never store) a session's lifecycle from the live manager + backing run status. */
export function deriveSessionState(session: ChatSession): { state: ChatSessionState; live: boolean } {
  const live = chatLive.isLive(session.id);
  if (live) return { state: 'live', live: true };
  const run = session.runId ? registry.getRun(session.runId) : null;
  if (run && !TERMINAL_RUN.has(run.status)) return { state: 'running', live: false };
  if (run && run.status === 'killed') return { state: 'killed', live: false };
  return { state: 'idle', live: false };
}

/** The chat-control envelope the chat-scoped SSE emits alongside run events (§4). Owned here; the
 *  ChatSessionState literal is from @fleet/shared. */
export interface SessionStateEnvelope { kind: 'session_state'; state: ChatSessionState; live: boolean; }

/**
 * §4 — chat-scoped SSE. Subscribes to the SESSION (not a run id): proxies whichever run currently
 * backs it, so a kill→resume (run id changes underneath) and a page reload both re-attach cleanly.
 * `mkSse` is server.ts's connection-capped SSE factory (passed in to keep the hijack plumbing there).
 */
export function registerChatStreamRoute(
  app: FastifyInstance,
  mkSse: (reply: any, req: any) => { send: (obj: unknown) => void; stop: () => void } | null,
) {
  app.get('/api/chat/sessions/:id/stream', (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) { reply.code(404).send({ error: 'not found' }); return; }
    const s = mkSse(reply, req);
    if (!s) return; // 503 already sent (connection cap)
    const { send, stop } = s;

    // initial chat-control frame
    const st = deriveSessionState(session);
    send({ kind: 'session_state', state: st.state, live: st.live } satisfies SessionStateEnvelope);

    // proxy the current backing run, if any (re-resolve per connect so reload re-attaches).
    const runId = chatLive.liveRunId(id) ?? session.runId;
    let unsub: (() => void) | null = null;
    if (runId) unsub = registry.subscribeRun(runId, send);

    reply.raw.on('close', () => { unsub?.(); stop(); });
  });
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
    return { session: { ...session, ...deriveSessionState(session) }, messages: chatRepo.listMessages(id) };
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
      const id = (req.params as any).id;
      const body = (req.body ?? {}) as { message?: string; attachments?: ChatAttachment[] };
      const res = await startTurn(id, body.message as string, body.attachments);
      chatLive.touch(id); // a turn is activity — keep a live session warm
      return res;
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

  // §3.3 — mid-turn input / permission decisions, written to the live process stdin. 409 if not live.
  // Body: { message: string; attachments?: ChatAttachment[] }  (client sends `message`; `text` accepted for
  // backward-compat with the existing agents /input pattern). `attachments` is accepted but not yet forwarded
  // to stdin (the agent reads file content at turn time, not on mid-turn input).
  app.post('/api/chat/sessions/:id/input', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const body = (req.body as any) ?? {};
    // Accept `message` (chat-surface convention) or `text` (agents /input legacy).
    const text: unknown = body.message ?? body.text;
    if (typeof text !== 'string' || text.length === 0) return reply.code(400).send({ error: 'text must be a non-empty string' });
    const runId = chatLive.liveRunId(id) ?? session.runId;
    if (!runId) return reply.code(409).send({ error: 'session is not live; send a normal turn instead' });
    try {
      registry.sendInput(runId, text);
      chatLive.touch(id);
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'input failed' });
    }
  });

  // §3.3 — stop the current turn. Keeps the held process live where possible; else the stop marks it
  // killed (the session stays resumable either way). No backing run → a harmless ack.
  app.post('/api/chat/sessions/:id/interrupt', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const runId = chatLive.liveRunId(id) ?? session.runId;
    if (!runId) return { ok: true };
    try {
      registry.stop(runId);
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'interrupt failed' });
    }
  });
}
