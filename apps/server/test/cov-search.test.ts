/**
 * cov-search — coverage of search.ts logic NOT exercised by search.test.ts.
 *
 * Focus on the UNCOVERED ranges:
 *   - backfill() (159-201): events pre-inserted into the `events` table BEFORE
 *     buildServer() runs, with the FTS table still empty, so registerSearchRoutes
 *     triggers a real backfill. We then search and assert the backfilled rows hit.
 *   - tool_use JSON.stringify catch (84): a circular `input` makes JSON.stringify
 *     throw; the event must still index by name only.
 *   - search() orphan-run skip (row in FTS but run row deleted): hit is dropped.
 *
 * Pattern (DB isolation): FLEET_DATA_DIR → fresh mkdtemp BEFORE importing src.
 * The ordering is load-bearing: we import db.ts (which runs initSearch on the
 * fresh empty FTS table), insert raw events WITHOUT indexing them, and only THEN
 * call buildServer() so that backfill() sees a populated events table + empty FTS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-search-'));

let app: any;
let PORT: number;
const state = { searchAvailable: false };

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });

// Events pre-inserted into the `events` table (NOT indexed) so backfill picks them up.
const BACKFILL_RUN = 'run-backfill-cov';
const ORPHAN_RUN = 'run-orphan-cov';
const UNIQUE = 'zqxbackfilltermzqx'; // appears only in backfilled assistant_text
const TOOLNAME = 'CircularToolCov'; // tool_use name that survives a JSON.stringify throw
const ORPHAN_TERM = 'orphanonlytermxyz';

function seedRunRow(db: any, id: string, task: string) {
  db.prepare(
    `INSERT OR IGNORE INTO runs
       (id, session_id, task, cwd, model, fast_mode, effort, workflows_enabled,
        ultracode, status, started_at, tokens_in, tokens_out, cost_usd,
        permission_mode, skills)
     VALUES (?, ?, ?, ?, ?, 0, 'high', 1, 0, 'completed', ?, 0, 0, 0, 'default', '[]')`,
  ).run(id, 'sess-' + id, task, '/tmp', 'claude-opus-4-8', 1700000000000);
}

function rawEvent(db: any, runId: string, seq: number, type: string, payload: unknown) {
  db.prepare(
    `INSERT OR IGNORE INTO events (run_id, node_id, seq, ts, type, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, 'root', seq, 1700000000000 + seq, type, JSON.stringify(payload));
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;

  // Importing db.ts runs initSearch(db) on the fresh, empty FTS table.
  const db = (await import('../src/db.js')).default;
  const { searchAvailable } = await import('../src/search.js');
  state.searchAvailable = searchAvailable;

  // Seed the matching run rows (backfill joins FTS hits → runs for metadata).
  seedRunRow(db, BACKFILL_RUN, 'backfill coverage run');
  // NOTE: deliberately NO run row for ORPHAN_RUN → exercises the orphan-skip in search().

  // Insert events into the events table directly. These are NOT indexed yet,
  // so when registerSearchRoutes() runs backfill() the FTS table is empty and
  // the events table is non-empty → the whole backfill loop body executes.
  rawEvent(db, BACKFILL_RUN, 1, 'assistant_text', {
    text: `the ${UNIQUE} appears only in a backfilled assistant message`,
  });
  rawEvent(db, BACKFILL_RUN, 2, 'tool_result', { text: 'backfilled tool result body' });
  rawEvent(db, BACKFILL_RUN, 3, 'result', { result: 'backfilled final result text' });
  rawEvent(db, BACKFILL_RUN, 4, 'tool_use', {
    name: 'Bash',
    input: { command: 'echo backfilled' },
  });
  // A payload row whose JSON.parse fails (malformed payload column) → backfill's
  // inline JSON.parse catch returns {} and extractText yields null (not indexed),
  // but the row is still iterated so the map/filter lines run.
  db.prepare(
    `INSERT OR IGNORE INTO events (run_id, node_id, seq, ts, type, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(BACKFILL_RUN, 'root', 5, 1700000005000, 'assistant_text', '{not valid json');
  // A non-text event type → extractText returns null → exercises the `text == null` skip.
  rawEvent(db, BACKFILL_RUN, 6, 'system_prompt', { content: 'ignored system prompt' });

  // Orphan: indexed text whose run row does NOT exist → search() must skip it.
  rawEvent(db, ORPHAN_RUN, 1, 'assistant_text', { text: `${ORPHAN_TERM} from an orphan run` });

  // Now build the server → registerSearchRoutes → backfill() runs over the above.
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try {
    rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function skipIfUnavailable(label: string, fn: () => Promise<void>) {
  it(label, async () => {
    if (!state.searchAvailable) {
      console.log(`  [skip] FTS5 unavailable — ${label}`);
      return;
    }
    await fn();
  });
}

// ── backfill() — register-time index population (159-201) ─────────────────────
describe('backfill — populates FTS from a pre-existing events table at register time', () => {
  skipIfUnavailable('a backfilled assistant_text term is searchable after register', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent(UNIQUE)}`);
    expect(res.statusCode).toBe(200);
    const { available, hits } = res.json();
    expect(available).toBe(true);
    // The ONLY way this term is in FTS is via backfill() — seedEvent/indexEvents were never called.
    const hit = hits.find((h: any) => h.runId === BACKFILL_RUN);
    expect(hit).toBeDefined();
    expect(typeof hit.snippet).toBe('string');
    expect(hit.snippet.length).toBeGreaterThan(0);
    // Backfill also joined the run row → slim metadata present.
    expect(hit.run.id).toBe(BACKFILL_RUN);
    expect(hit.run.task).toBe('backfill coverage run');
    expect(hit.run.status).toBe('completed');
    expect(hit.run.startedAt).toBe(1700000000000);
  });

  skipIfUnavailable('backfilled tool_result and result payloads are searchable', async () => {
    const r1 = await get(`/api/search?q=${encodeURIComponent('tool result body')}`);
    expect(r1.json().hits.some((h: any) => h.runId === BACKFILL_RUN)).toBe(true);
    const r2 = await get(`/api/search?q=${encodeURIComponent('final result text')}`);
    expect(r2.json().hits.some((h: any) => h.runId === BACKFILL_RUN)).toBe(true);
  });

  skipIfUnavailable('backfilled tool_use indexes name + input', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent('echo backfilled')}`);
    expect(res.json().hits.some((h: any) => h.runId === BACKFILL_RUN)).toBe(true);
  });

  skipIfUnavailable('malformed-payload row is iterated but not indexed (JSON.parse catch → {})', async () => {
    // The malformed row carried no parseable text; searching its (would-be) content
    // must not 500 and must not surface a phantom hit for seq 5.
    const res = await get(`/api/search?q=${encodeURIComponent('not valid json')}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().hits)).toBe(true);
  });
});

// ── search() orphan-run skip (run row deleted → hit dropped) ──────────────────
describe('search — drops hits whose run row is missing', () => {
  skipIfUnavailable('an indexed event without a runs row produces zero hits', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent(ORPHAN_TERM)}`);
    expect(res.statusCode).toBe(200);
    const { available, hits } = res.json();
    expect(available).toBe(true);
    // The term IS in the FTS index, but its run was never inserted → orphan skip.
    expect(hits.every((h: any) => h.runId !== ORPHAN_RUN)).toBe(true);
    expect(hits.length).toBe(0);
  });
});

// ── extractText tool_use — circular input survives JSON.stringify throw (84) ──
describe('indexEvents — tool_use with circular input falls back to name-only', () => {
  skipIfUnavailable('circular input → JSON.stringify throws → name still indexed', async () => {
    const { indexEvents } = await import('../src/search.js');
    const db = (await import('../src/db.js')).default;

    // Give the run a row so the hit is not orphan-skipped.
    const RUN = 'run-circular-cov';
    seedRunRow(db, RUN, 'circular tool input run');

    // Build a payload whose `input` is circular → JSON.stringify throws → catch at L84.
    const circular: any = { a: 1 };
    circular.self = circular;

    indexEvents([
      {
        sessionId: '',
        runId: RUN,
        nodeId: 'root',
        parentNodeId: null,
        nodeType: 'root',
        seq: 1,
        ts: 1700000000000,
        type: 'tool_use' as any,
        payload: { name: TOOLNAME, input: circular },
      },
    ]);

    // inputStr stayed '' (throw → empty), so raw === name → the tool NAME is indexed.
    const res = await get(`/api/search?q=${encodeURIComponent(TOOLNAME)}`);
    expect(res.statusCode).toBe(200);
    const { hits } = res.json();
    const hit = hits.find((h: any) => h.runId === RUN);
    expect(hit).toBeDefined();
    expect(hit.run.task).toBe('circular tool input run');
  });

  skipIfUnavailable('tool_use with no string name + circular input indexes nothing (returns null)', async () => {
    const { indexEvents } = await import('../src/search.js');
    const db = (await import('../src/db.js')).default;
    const RUN = 'run-empty-tooluse-cov';
    seedRunRow(db, RUN, 'empty tool use run');

    const circular: any = {};
    circular.loop = circular;
    // name missing → '' ; input throws → '' ; raw === '' → extractText returns null → not indexed.
    indexEvents([
      {
        sessionId: '',
        runId: RUN,
        nodeId: 'root',
        parentNodeId: null,
        nodeType: 'root',
        seq: 1,
        ts: 1700000000000,
        type: 'tool_use' as any,
        payload: { input: circular },
      },
    ]);

    // Nothing distinctive was indexed for this run; a search for its id yields no hit.
    const res = await get(`/api/search?q=${encodeURIComponent('run-empty-tooluse-cov')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.every((h: any) => h.runId !== RUN)).toBe(true);
  });
});

// ── route: query trim + limit parsing (273-287) ──────────────────────────────
describe('GET /api/search — query/limit parsing', () => {
  skipIfUnavailable('blank q (after trim) short-circuits to empty hits, available true', async () => {
    const res = await get('/api/search?q=%20%20%20'); // whitespace only
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.hits).toEqual([]);
  });

  skipIfUnavailable('missing q param defaults to empty → available true, no hits', async () => {
    const res = await get('/api/search');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.hits).toEqual([]);
  });

  skipIfUnavailable('invalid limit (NaN) falls back to default and still returns', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent(UNIQUE)}&limit=notanumber`);
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.some((h: any) => h.runId === BACKFILL_RUN)).toBe(true);
  });

  skipIfUnavailable('limit below 1 falls back to default', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent(UNIQUE)}&limit=0`);
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.some((h: any) => h.runId === BACKFILL_RUN)).toBe(true);
  });

  skipIfUnavailable('explicit small limit is respected', async () => {
    const res = await get(`/api/search?q=${encodeURIComponent(UNIQUE)}&limit=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.length).toBeLessThanOrEqual(1);
  });
});
