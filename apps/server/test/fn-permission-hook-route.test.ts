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

  it('DENIES immediately without enqueuing when the payload has no session (fail-fast)', async () => {
    const app = Fastify();
    registerPermissionHookRoutes(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/internal/permission',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x' } }), // no session_id
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ decision: 'deny' });
    // crucially: nothing was enqueued, so no orphan inbox card lingers for the TTL
    expect(listPermissions()).toHaveLength(0);
    await app.close();
  });

  it('DENIES immediately when the tool name is missing', async () => {
    const app = Fastify();
    registerPermissionHookRoutes(app);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/permission',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ session_id: 'run-x' }), // no tool
    });
    expect(res.json()).toMatchObject({ decision: 'deny' });
    expect(listPermissions()).toHaveLength(0);
    await app.close();
  });

  // Regression (real socket — app.inject can't fire it): the disconnect handler must listen on
  // reply.raw, NOT req.raw. req.raw's 'close' fires the instant the request BODY is read, which
  // would auto-deny+remove every permission immediately (caught only by a live E2E). This uses a
  // real listening server + a real aborted request to assert (a) the entry stays PENDING on a live
  // connection and (b) is denied+removed only on an actual client disconnect.
  it('keeps the permission PENDING on a live connection; denies only on real disconnect (reply.raw not req.raw)', async () => {
    const app = Fastify();
    registerPermissionHookRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as any;

    const ac = new AbortController();
    const inflight = fetch(`http://127.0.0.1:${port}/internal/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'rs', tool_name: 'Bash', tool_input: { command: 'x' } }),
      signal: ac.signal,
    }).catch(() => null);

    // Body is read + entry enqueued by now. With the req.raw bug this would already be 0.
    await new Promise((r) => setTimeout(r, 250));
    expect(listPermissions()).toHaveLength(1);

    // Real client disconnect → reply.raw 'close' fires → disconnect handler denies + removes it.
    ac.abort();
    await inflight;
    await new Promise((r) => setTimeout(r, 150));
    expect(listPermissions()).toHaveLength(0);

    await app.close();
  });
});
