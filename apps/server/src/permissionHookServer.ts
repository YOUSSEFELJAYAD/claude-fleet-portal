/**
 * F-perm — localhost callback for the PreToolUse permission hook.
 *
 * The spawned `tools/fleet-permission-hook.mjs` POSTs the PreToolUse payload here and blocks
 * on the response. We enqueue a pending permission and hold the HTTP response open until the
 * operator decides in /inbox (resolvePermission) or the store TTL auto-denies it. Same
 * trust model as /mcp/:sessionId — bound to 127.0.0.1, no auth (the control plane is local).
 */
import type { FastifyInstance } from 'fastify';
import { enqueuePermission } from './permissionGate.js';

export function registerPermissionHookRoutes(app: FastifyInstance) {
  app.post('/internal/permission', async (req) => {
    const b = (req.body as any) ?? {};
    const p = enqueuePermission({
      sessionId: b.session_id ?? b.sessionId ?? '',
      tool: b.tool_name ?? b.tool ?? 'unknown',
      input: b.tool_input ?? b.input ?? null,
      toolUseId: b.tool_use_id ?? b.toolUseId ?? '',
      cwd: b.cwd ?? '',
    });
    // Block until the operator decides (or the store TTL fires → deny). Fastify keeps the
    // socket open while we await; the hook on the other end is waiting on this same request.
    const answer = await p.answer;
    return { decision: answer.decision, reason: answer.reason ?? '' };
  });
}
