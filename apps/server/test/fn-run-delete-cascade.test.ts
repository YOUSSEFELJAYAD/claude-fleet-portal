/**
 * Real test for the run-deletion cascade fix (finding B): deleting a run must also drop its
 * tags (run_tags) and scores — they previously orphaned because deleteRun didn't touch those
 * tables and tags.ts/scores.ts owned them. db.ts now fires onRunDeleted; tags.ts + scores.ts
 * subscribe and clean their own rows. Driven through the REAL fastify app + SQLite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cascade-'));

let app: any;
let repo: any;
let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  repo = (await import('../src/db.js')).repo;
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

describe('deleteRun cascades into run_tags + scores', () => {
  it('removes a deleted run’s tags and scores (no orphans linger)', async () => {
    const runId = 'cascade-run-1';

    // attach a tag and a score to the (synthetic) run id
    expect((await post(`/api/agents/${runId}/tags`, { tag: 'keepme' })).statusCode).toBe(200);
    expect((await post(`/api/agents/${runId}/scores`, { name: 'quality', value: 5 })).statusCode).toBe(200);

    // sanity: they exist before deletion
    expect((await get(`/api/agents/${runId}/tags`)).json()).toContain('keepme');
    expect((await get(`/api/agents/${runId}/scores`)).json().length).toBe(1);

    // delete the run → onRunDeleted fires the tags + scores cleanup subscribers
    repo.deleteRun(runId);

    // both side tables are now empty for that run (cascade worked)
    expect((await get(`/api/agents/${runId}/tags`)).json()).toEqual([]);
    expect((await get(`/api/agents/${runId}/scores`)).json()).toEqual([]);
  });

  it('onRunDeleted is exported and additive (multiple subscribers all run)', async () => {
    const { onRunDeleted } = await import('../src/db.js');
    const hits: string[] = [];
    onRunDeleted((id) => hits.push('a:' + id));
    onRunDeleted((id) => hits.push('b:' + id));
    repo.deleteRun('cascade-run-2');
    expect(hits).toEqual(expect.arrayContaining(['a:cascade-run-2', 'b:cascade-run-2']));
  });
});
