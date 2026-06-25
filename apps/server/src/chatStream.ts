/**
 * Task 1.4 — turn-scoped SSE route (Phase 2 protocol).
 *
 * Replaces the old run-proxy stream in chat.ts. The route:
 *   1. Sends { kind: 'session_state', state } — NO runId, NO live (ChatStreamFrame contract).
 *   2. Subscribes chatTurns.subscribe — synchronous replay covers a mid-turn connect.
 *   3. Forwards every frame until the client disconnects.
 *
 * No ensureLive on connect (the old "fix 04" warm-up). The client triggers turns explicitly.
 */
import type { FastifyInstance } from 'fastify';
import { chatRepo } from './chatRepo.js';
import { chatTurns } from './chatTurn.js';
import { chatLive } from './chatLive.js';
import { registry } from './registry.js';
import type { ChatSession, ChatSessionState } from '@fleet/shared';

const TERMINAL_RUN = new Set(['completed', 'failed', 'killed']);

/** Derive a session's state. Inlined here to avoid a circular import with chat.ts. */
function deriveState(session: ChatSession): ChatSessionState {
  if (chatLive.isLive(session.id)) return 'live';
  const run = session.runId ? registry.getRun(session.runId) : null;
  if (run && !TERMINAL_RUN.has(run.status)) return 'running';
  if (run && run.status === 'killed') return 'killed';
  return 'idle';
}

export function registerChatStreamRoute(
  app: FastifyInstance,
  mkSse: (reply: any, req: any) => { send: (obj: unknown) => void; stop: () => void } | null,
) {
  app.get('/api/chat/sessions/:id/stream', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) { reply.code(404).send({ error: 'not found' }); return; }

    const s = mkSse(reply, req);
    if (!s) return; // 503 already sent (connection cap)
    const { send, stop } = s;

    // First frame: session state with NO runId — Phase 2 ChatStreamFrame contract.
    send({ kind: 'session_state', state: deriveState(session) });

    // Subscribe to turn frames. chatTurns.subscribe synchronously replays the active turn's
    // buffered frames so a mid-turn connect sees turn:start + events already emitted.
    const unsub = chatTurns.subscribe(id, (frame) => send(frame));

    reply.raw.on('close', () => { unsub(); stop(); });
  });
}
