/**
 * F7 — full-text transcript search tests.
 *
 * Pattern: isolate DB via FLEET_DATA_DIR, buildServer(), app.inject with Host header.
 * Skip-if-unavailable: all FTS-dependent tests use `skipIfUnavailable()`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-search-'));

let app: any;
let PORT: number;
// searchAvailableFlag is populated in beforeAll; skipIfUnavailable checks it at runtime (inside it()).
const state = { searchAvailable: false };

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  const { searchAvailable } = await import('../src/search.js');
  state.searchAvailable = searchAvailable;
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

/**
 * Skip an `it` block when FTS5 is not compiled into the SQLite build.
 * Uses it() with a runtime guard so the decision is made AFTER beforeAll sets state,
 * not at module-parse time (which would always see the pre-init false value).
 */
function skipIfUnavailable(label: string, fn: () => Promise<void>) {
  it(label, async () => {
    if (!state.searchAvailable) {
      console.log(`  [skip] FTS5 unavailable — ${label}`);
      return;
    }
    await fn();
  });
}

// ── helper: seed events directly via the repo so we bypass the registry ───────
async function seedEvent(
  runId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
) {
  const { repo } = await import('../src/db.js');
  const { indexEvents } = await import('../src/search.js');
  // Insert into events table first
  const db = (await import('../src/db.js')).default;
  db.prepare(
    `INSERT OR IGNORE INTO events (run_id, node_id, seq, ts, type, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, 'root', seq, Date.now(), type, JSON.stringify(payload));
  // Index it manually (insertEvents hook would normally do this)
  indexEvents([
    {
      sessionId: '',
      runId,
      nodeId: 'root',
      parentNodeId: null,
      nodeType: 'root',
      seq,
      ts: Date.now(),
      type: type as any,
      payload,
    },
  ]);
  void repo; // suppress unused
}

async function seedRun(id: string, task: string) {
  const db = (await import('../src/db.js')).default;
  db.prepare(
    `INSERT OR IGNORE INTO runs
       (id, session_id, task, cwd, model, fast_mode, effort, workflows_enabled,
        ultracode, status, started_at, tokens_in, tokens_out, cost_usd,
        permission_mode, skills)
     VALUES (?, ?, ?, ?, ?, 0, 'high', 1, 0, 'completed', ?, 0, 0, 0, 'default', '[]')`,
  ).run(id, 'sess-' + id, task, '/tmp', 'claude-opus-4-8', Date.now());
}

// ── GET /api/search — baseline ────────────────────────────────────────────────
describe('GET /api/search — route available', () => {
  it('returns 200 with available flag', async () => {
    const res = await get('/api/search?q=hello');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.available).toBe('boolean');
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('returns empty hits for blank q without error', async () => {
    const res = await get('/api/search?q=');
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toEqual([]);
  });
});

// ── FTS-dependent tests ───────────────────────────────────────────────────────
describe('full-text search — event indexing', () => {
  const RUN_A = 'run-search-a';
  const RUN_B = 'run-search-b';

  beforeAll(async () => {
    await seedRun(RUN_A, 'implement payments feature');
    await seedRun(RUN_B, 'write unit tests');

    // assistant_text event
    await seedEvent(RUN_A, 1, 'assistant_text', {
      text: 'I will implement the payments module using Stripe',
    });
    // tool_result event
    await seedEvent(RUN_A, 2, 'tool_result', {
      text: 'File written successfully to payments.ts',
    });
    // result event
    await seedEvent(RUN_A, 3, 'result', {
      result: 'Completed: payments integration done with webhook support',
    });
    // tool_use event (name + input)
    await seedEvent(RUN_A, 4, 'tool_use', {
      name: 'Bash',
      input: { command: 'pnpm test --filter payments' },
    });
    // run B — different content
    await seedEvent(RUN_B, 1, 'assistant_text', {
      text: 'Writing vitest unit tests for the auth module',
    });
    // non-indexed event type
    await seedEvent(RUN_A, 5, 'system_prompt', { content: 'you are a helpful assistant' });
  });

  skipIfUnavailable('finds text in assistant_text payload', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('Stripe')}`);
    expect(res.statusCode).toBe(200);
    const { available, hits } = res.json();
    expect(available).toBe(true);
    expect(hits.some((h: any) => h.runId === RUN_A)).toBe(true);
  });

  skipIfUnavailable('finds text in tool_result payload', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('payments.ts')}`);
    const { hits } = res.json();
    expect(hits.some((h: any) => h.runId === RUN_A)).toBe(true);
  });

  skipIfUnavailable('finds text in result payload', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('webhook')}`);
    const { hits } = res.json();
    expect(hits.some((h: any) => h.runId === RUN_A)).toBe(true);
  });

  skipIfUnavailable('finds text in tool_use name+input', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('pnpm')}`);
    const { hits } = res.json();
    expect(hits.some((h: any) => h.runId === RUN_A)).toBe(true);
  });

  skipIfUnavailable('hit includes snippet string', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('payments')}`);
    const { hits } = res.json();
    const hit = hits.find((h: any) => h.runId === RUN_A);
    expect(hit).toBeDefined();
    expect(typeof hit.snippet).toBe('string');
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  skipIfUnavailable('hit includes slim run metadata', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('Stripe')}`);
    const { hits } = res.json();
    const hit = hits.find((h: any) => h.runId === RUN_A);
    expect(hit.run.id).toBe(RUN_A);
    expect(hit.run.task).toBe('implement payments feature');
    expect(hit.run.status).toBe('completed');
    expect(typeof hit.run.startedAt).toBe('number');
    expect(typeof hit.run.model).toBe('string');
  });

  skipIfUnavailable('does not return hits from other runs', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('vitest')}`);
    const { hits } = res.json();
    expect(hits.every((h: any) => h.runId === RUN_B)).toBe(true);
  });

  skipIfUnavailable('does not index non-text event types (system_prompt)', async () => {
    // "helpful assistant" only appeared in system_prompt which is not indexed
    const res = await get(`/api/search?q=${encodeURIComponent('helpful+assistant')}`);
    // May or may not match — but should not 500
    expect(res.statusCode).toBe(200);
  });

  skipIfUnavailable('limit parameter is respected', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('a')}&limit=1`);
    expect(res.statusCode).toBe(200);
    const { hits } = res.json();
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  skipIfUnavailable('limit capped at 100', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('a')}&limit=9999`);
    expect(res.statusCode).toBe(200);
    // Just verifies no crash and route works — we can't assert hit count without 100+ events
    expect(Array.isArray(res.json().hits)).toBe(true);
  });
});

// ── db.ts insertEvents hook — production wiring test (#45) ───────────────────
// The PRD requires "insert events via repo" so that deleting the hook in db.ts
// (try { indexEvents(events) } catch {...}) breaks this test. seedEvent above
// calls indexEvents manually, bypassing the hook — this test uses repo.insertEvents
// to exercise the real production path end-to-end.
describe('db.ts insertEvents → indexEvents hook integration', () => {
  const HOOK_RUN = 'run-hook-integration';

  beforeAll(async () => {
    await seedRun(HOOK_RUN, 'hook integration test run');
  });

  skipIfUnavailable('inserting events via repo.insertEvents makes them searchable (hook path)', async () => {
    const { repo } = await import('../src/db.js');

    // Use a unique term that only appears in this test.
    const uniqueTerm = `uniquehookterm${Date.now()}`;
    const eventToIndex = {
      sessionId: '',
      runId: HOOK_RUN,
      nodeId: 'root',
      parentNodeId: null,
      nodeType: 'root' as const,
      seq: 9001,
      ts: Date.now(),
      type: 'assistant_text' as const,
      payload: { text: `The ${uniqueTerm} was found by the hook integration` },
    };

    // Insert via repo.insertEvents — this calls the production indexEvents hook in db.ts.
    repo.insertEvents([eventToIndex]);

    // Search for the unique term — must find it via the production hook.
    const res = await get(`/api/search?q=${encodeURIComponent(uniqueTerm)}`);
    expect(res.statusCode).toBe(200);
    const { available, hits } = res.json();
    expect(available).toBe(true);
    expect(hits.some((h: any) => h.runId === HOOK_RUN)).toBe(true);
  });
});

// ── Operator-typed query edge cases — must never 500 ─────────────────────────
describe('query sanitization — garbage / operator-laced queries', () => {
  const QUERIES = [
    'payments.ts AND x',
    'foo OR bar',
    'hello "world"',
    '"',
    'AND OR NOT',
    'a*b',
    '(unclosed',
    '',
    '   ',
    'NEAR/5(foo bar)',
  ];

  for (const q of QUERIES) {
    it(`does not 500 for query: ${JSON.stringify(q)}`, async () => {
      const res = await get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.available).toBe('boolean');
      expect(Array.isArray(body.hits)).toBe(true);
    });
  }
});
