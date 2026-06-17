/**
 * F-perm — localhost callback for the PreToolUse permission hook.
 *
 * The spawned `tools/fleet-permission-hook.mjs` POSTs the PreToolUse payload here and blocks
 * on the response. We enqueue a pending permission and hold the HTTP response open until the
 * operator decides in /inbox (resolvePermission) or the store TTL auto-denies it. Same
 * trust model as /mcp/:sessionId — bound to 127.0.0.1, no auth (the control plane is local).
 */
import type { FastifyInstance } from 'fastify';
import { enqueuePermission, resolvePermission } from './permissionGate.js';

export function registerPermissionHookRoutes(app: FastifyInstance) {
  app.post('/internal/permission', async (req, reply) => {
    const b = (req.body as any) ?? {};
    const sessionId = b.session_id ?? b.sessionId ?? '';
    const tool = b.tool_name ?? b.tool ?? '';
    // Fail-fast deny on a malformed/empty payload (the hook's documented "deny on no-session"
    // contract). Enqueuing a session-less entry would block the hook for the full TTL and leave an
    // un-rejectable synthetic card in /inbox, since rejectPermissionsForSession can never match ''.
    if (!sessionId || !tool) return { decision: 'deny', reason: 'missing session or tool' };
    const p = enqueuePermission({
      sessionId,
      tool,
      input: b.tool_input ?? b.input ?? null,
      toolUseId: b.tool_use_id ?? b.toolUseId ?? '',
      cwd: b.cwd ?? '',
    });
    // If the hook gives up (its ~880s AbortSignal, just under the store TTL) or otherwise
    // disconnects before the operator decides, drop the pending entry immediately so it can't
    // linger as a stale, no-longer-enforceable "Approve" card in /inbox. Deny is the fail-closed
    // default (the hook already reported deny to claude on its end). Listen on reply.raw (the
    // ServerResponse) — NOT req.raw, whose 'close' fires the moment the request body is read,
    // which would deny every permission instantly — matching the SSE routes' disconnect idiom.
    let settled = false;
    reply.raw.on('close', () => {
      if (!settled) resolvePermission(p.id, { decision: 'deny', reason: 'hook disconnected' });
    });
    // Block until the operator decides (or the store TTL fires → deny). Fastify keeps the
    // socket open while we await; the hook on the other end is waiting on this same request.
    const answer = await p.answer;
    settled = true;
    return { decision: answer.decision, reason: answer.reason ?? '' };
  });
}
