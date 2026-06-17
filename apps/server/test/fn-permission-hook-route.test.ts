import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { __clearPermissionsForTests, listPermissions, resolvePermission } from '../src/permissionGate.js';
import { registerPermissionHookRoutes } from '../src/permissionHookServer.js';

describe('permission hook callback route', () => {
  beforeEach(() => __clearPermissionsForTests());

  it('enqueues from the PreToolUse payload and returns the operator decision', async () => {
    const app = Fastify();
    registerPermissionHookRoutes(app);
    await app.ready();

    const pending = app.inject({
      method: 'POST',
      url: '/internal/permission',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        session_id: 'run-1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf ./dist' },
        tool_use_id: 'tu_1',
        cwd: '/tmp',
      }),
    });

    // Wait a tick for the route to enqueue, then resolve as the operator would.
    await new Promise((r) => setTimeout(r, 20));
    const [p] = listPermissions();
    expect(p).toMatchObject({ sessionId: 'run-1', tool: 'Bash', toolUseId: 'tu_1' });
    resolvePermission(p.id, { decision: 'allow', reason: 'operator approve' });

    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ decision: 'allow', reason: 'operator approve' });
    await app.close();
  });
});
