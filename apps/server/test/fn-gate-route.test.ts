import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { __clearGatesForTests, enqueueGate, listGates } from '../src/gate.js';
import { registerInboxRoutes } from '../src/inbox.js';

describe('answer route', () => {
  beforeEach(() => __clearGatesForTests());
  it('resolves the gate with the posted selection', async () => {
    const app = Fastify();
    registerInboxRoutes(app);
    await app.ready();
    const g = enqueueGate({ sessionId: 's1', question: 'q', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    const res = await app.inject({
      method: 'POST', url: `/api/inbox/questions/${g.id}/answer`,
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ selection: ['A'] }),
    });
    expect(res.statusCode).toBe(200);
    await expect(g.answer).resolves.toEqual({ selection: ['A'] });
    expect(listGates()).toHaveLength(0);
    await app.close();
  });
});
