import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { __clearPermissionsForTests, enqueuePermission, listPermissions } from '../src/permissionGate.js';
import { getInboxItems, registerInboxRoutes } from '../src/inbox.js';

describe('permission gate ↔ inbox', () => {
  beforeEach(() => __clearPermissionsForTests());

  it('surfaces a pending permission as a viaHook permission item with a synthetic run', () => {
    enqueuePermission({ sessionId: 'run-x', tool: 'Bash', input: { command: 'rm -rf x' }, toolUseId: 'tu', cwd: '/tmp' });
    const items = getInboxItems();
    const perm = items.find((i) => i.kind === 'permission' && i.viaHook);
    expect(perm).toBeTruthy();
    expect(perm!.request?.payload.tool).toBe('Bash');
    expect(perm!.request?.id).toMatch(/^perm_/);
    expect(perm!.run?.status).toBe('awaiting-permission');
  });

  it('decide route resolves the pending answer (approve → allow)', async () => {
    const app = Fastify();
    registerInboxRoutes(app);
    await app.ready();
    const p = enqueuePermission({ sessionId: 'run-y', tool: 'Write', input: {}, toolUseId: 'tu', cwd: '/tmp' });
    const res = await app.inject({
      method: 'POST', url: `/api/inbox/permissions/${p.id}/decide`,
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.statusCode).toBe(200);
    await expect(p.answer).resolves.toMatchObject({ decision: 'allow' });
    expect(listPermissions()).toHaveLength(0);
    await app.close();
  });

  it('decide route rejects an invalid decision with 400', async () => {
    const app = Fastify();
    registerInboxRoutes(app);
    await app.ready();
    const p = enqueuePermission({ sessionId: 'run-z', tool: 'Bash', input: {}, toolUseId: 'tu', cwd: '/tmp' });
    const res = await app.inject({
      method: 'POST', url: `/api/inbox/permissions/${p.id}/decide`,
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.statusCode).toBe(400);
    expect(listPermissions()).toHaveLength(1); // untouched
    await app.close();
  });
});
