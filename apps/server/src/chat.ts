/**
 * Chat Dashboard (§30) — multi-session agent control-plane.
 * A chat session maps to one run id, advanced resume-per-turn (DC §D-029). This module owns
 * turn orchestration and the HTTP routes; pure persistence lives in chatRepo.ts (Task 1.2).
 */
import type { FastifyInstance } from 'fastify';
import db from './db.js';
import { chatRepo, searchChat } from './chatRepo.js';
import { registry } from './registry.js';
import { dispatchCommand } from './commands.js';
import { chatLive } from './chatLive.js';
import { chatTurns, buildEnginePrompt, containDirs } from './chatTurn.js';
import type {
  ChatSession, ChatAttachment, ChatSessionState,
  CreateChatSessionRequest,
} from '@fleet/shared';

export default db;
export { chatRepo };
// Turn orchestration + attachment helpers moved to chatTurn.ts (Task 1.3); re-exported for the
// existing callers/tests that still import them from chat.ts.
export { chatTurns, buildEnginePrompt, containDirs } from './chatTurn.js';

/** Run one chat turn (Task 1.3 — server-declared turn boundaries). Delegates to chatTurns; kept as
 *  a named export so existing callers/tests importing `startTurn` from chat.ts keep working. */
export const startTurn = (sessionId: string, message: string, attachments?: ChatAttachment[]) =>
  chatTurns.startTurn(sessionId, message, attachments);

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

/** Engines (codex/opencode) never hold a live process (spec §3.2 D8). Force live:false and
 *  collapse 'live' down to 'idle' for engine sessions; all other states pass through. */
export function engineSafeState(engine: string, derived: { state?: ChatSessionState; live?: boolean }):
  { state?: ChatSessionState; live?: boolean } {
  if (engine === 'claude') return derived;
  const state = derived.state === 'live' ? 'idle' : derived.state;
  return { state, live: false };
}

// Task 1.4 — re-export the new turn-scoped stream route from chatStream.ts.
// server.ts imports registerChatStreamRoute from chat.ts; the name is kept stable.
export { registerChatStreamRoute } from './chatStream.js';

export function registerChatRoutes(app: FastifyInstance) {
  app.get('/api/chat/search', async (req) => {
    const q = req.query as any;
    const query = String(q?.q ?? '').trim();
    if (!query) return { hits: [] };
    const sessionId = q?.sessionId ? String(q.sessionId) : undefined;
    const rawLimit = parseInt(String(q?.limit ?? '30'), 10);
    const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 30 : rawLimit, 100);
    return { hits: searchChat(query, sessionId, limit) };
  });

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
    const safe = engineSafeState(session.engine, deriveSessionState(session));
    // Task 1.4 — return { session, turns } (latest page); Phase 2 client consumes turns not messages.
    return { session: { ...session, ...safe }, turns: chatRepo.listTurns(id, { limit: 50 }) };
  });

  // Task 1.4 — cursor-paginated turn history. `before` is a createdAt timestamp (exclusive upper
  // bound); `limit` caps the page size (default 50). Newest turns first.
  app.get('/api/chat/sessions/:id/turns', async (req, reply) => {
    const id = (req.params as any).id;
    if (!chatRepo.getSession(id)) return reply.code(404).send({ error: 'not found' });
    const q = req.query as any;
    const before = q?.before !== undefined ? Number(q.before) : undefined;
    const limit = q?.limit !== undefined ? Math.min(Number(q.limit) || 50, 200) : 50;
    return chatRepo.listTurns(id, { before: Number.isFinite(before) ? before : undefined, limit });
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
      const res = await chatTurns.startTurn(id, body.message as string, body.attachments);
      return res; // ponytail: touch already happens inside startTurn (live branch)
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'turn failed' });
    }
  });

  app.post('/api/chat/sessions/:id/command', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const line = (req.body as any)?.line;
    if (typeof line !== 'string' || !line.trim()) return reply.code(400).send({ error: 'line is required' });
    const cmdTurnId = chatRepo.newTurnId();
    chatRepo.addMessage({ sessionId: id, role: 'user', kind: 'command', content: line, runId: null, turnId: cmdTurnId });
    const result = await dispatchCommand(line, session.cwd);
    chatRepo.addMessage({ sessionId: id, role: 'system', kind: result.ok ? 'command-result' : 'error', content: result.text ?? JSON.stringify(result), runId: result.runId ?? null, turnId: cmdTurnId });
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

  // Fix 06 — inline permission approve/deny. Resolves the backing run (live first, else the
  // session's stored run) and forwards the decision to the registry, mapping the wire verb
  // ('allow'|'deny') to the registry verb ('approve'|'deny'). Registry errors (e.g. a 409 when the
  // run is non-interactive) are surfaced with their statusCode.
  app.post('/api/chat/sessions/:id/permission', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const body = (req.body as any) ?? {};
    const requestId = body.requestId;
    const decision = body.decision;
    if (typeof requestId !== 'string' || !requestId || (decision !== 'allow' && decision !== 'deny')) {
      return reply.code(400).send({ error: 'requestId (non-empty string) and decision (allow|deny) are required' });
    }
    const runId = chatLive.liveRunId(id) ?? session.runId;
    if (!runId) return reply.code(409).send({ error: 'session is not live; no run to decide on' });
    try {
      registry.decidePermission(runId, requestId, decision === 'allow' ? 'approve' : 'deny');
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'permission decision failed' });
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

  // §3.1/§3.3 — revive a killed/idle session by resuming its backing run via registry.resume.
  // Returns 400 when there is no backing run (session never had a turn); 409 forwarded from
  // registry if the run is still live. Returns the updated ChatSession so the client resolves.
  app.post('/api/chat/sessions/:id/resume', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    if (!session.runId) return reply.code(400).send({ error: 'no run to resume — send a message to start' });
    try {
      const run = registry.resume(session.runId);
      chatRepo.setSessionRun(id, run.id);
      return chatRepo.getSession(id);
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'resume failed' });
    }
  });
}
