/**
 * Full-text transcript search (F7).
 * FTS5 virtual table over event payloads — enables /api/search?q= queries.
 *
 * Cycle-free design: search.ts does NOT import db.ts. Instead it exports
 * `initSearch(dbHandle)` which db.ts calls once with the shared Database
 * handle, and `indexEvents(events)` which db.ts calls from insertEvents.
 * This setter pattern avoids the import cycle entirely.
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { NormalizedEvent } from '@fleet/shared';
import { createFts, sanitizeFtsQuery, ftsSnippet } from './fts.js';

// ── FTS availability flag ─────────────────────────────────────────────────────
export let searchAvailable = false;

let _db: InstanceType<typeof Database> | null = null;

// Use a loose statement type so positional .run/.all/.get calls typecheck cleanly.
// better-sqlite3's Statement<P> defaults to unknown[] but the ReturnType helper
// resolves to Statement<[unknown]> which rejects multi-arg calls — use any[] instead.
type Stmt = { run: (...args: any[]) => any; all: (...args: any[]) => any[]; get: (...args: any[]) => any };

// Prepared statements (set after init)
let _insert: Stmt | null = null;
let _search: Stmt | null = null;
let _count: Stmt | null = null;

/**
 * Called by db.ts once with the shared SQLite handle (avoids import cycle).
 * Creates the FTS5 table and prepared statements; sets searchAvailable.
 */
export function initSearch(db: InstanceType<typeof Database>): void {
  _db = db;
  try {
    createFts(db, 'events_fts', ['run_id UNINDEXED', 'seq UNINDEXED', 'node_id UNINDEXED', 'text']);
    // Prepare all statements now (will throw if FTS5 really isn't present).
    _insert = db.prepare(
      `INSERT INTO events_fts (run_id, seq, node_id, text) VALUES (?, ?, ?, ?)`,
    );
    _search = db.prepare(`
      SELECT run_id, seq, node_id,
             ${ftsSnippet('events_fts', 3)} AS snippet
      FROM events_fts
      WHERE events_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    _count = db.prepare(`SELECT COUNT(*) AS c FROM events_fts`);

    searchAvailable = true;
    console.log('[search] FTS5 index ready');
  } catch (err: any) {
    console.warn('[search] FTS5 unavailable — full-text search disabled:', err?.message);
    searchAvailable = false;
  }
}

/**
 * Extract indexable text from a single event.
 * Returns null for event types that carry no useful text.
 */
function extractText(event: NormalizedEvent): string | null {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'assistant_text':
    case 'thinking':
    case 'agent_message':
      return typeof p.text === 'string' ? p.text : null;
    case 'tool_result':
      return typeof p.text === 'string' ? p.text : null;
    case 'result':
      return typeof p.result === 'string' ? p.result : null;
    case 'tool_use': {
      const name = typeof p.name === 'string' ? p.name : '';
      let inputStr = '';
      try {
        inputStr = JSON.stringify(p.input ?? {});
      } catch {
        /* ignore */
      }
      const raw = name + (inputStr ? ' ' + inputStr : '');
      return raw.slice(0, 2000) || null;
    }
    default:
      return null;
  }
}

/**
 * Index a batch of events into the FTS table.
 * Called by db.ts inside insertEvents — wrapped best-effort, never throws.
 */
export function indexEvents(events: NormalizedEvent[]): void {
  if (!searchAvailable || !_db || !_insert) return;
  try {
    const tx = _db.transaction((items: NormalizedEvent[]) => {
      for (const e of items) {
        const text = extractText(e);
        if (text == null) continue;
        try {
          _insert!.run(e.runId, e.seq, e.nodeId, text);
        } catch {
          /* row already indexed (INSERT OR IGNORE equivalent handled by FTS content= none) */
        }
      }
    });
    tx(events);
  } catch {
    /* best-effort — never propagate into the write path */
  }
}


export interface SearchHit {
  runId: string;
  seq: number;
  nodeId: string;
  snippet: string;
  run: {
    id: string;
    task: string;
    status: string;
    startedAt: number;
    model: string;
  };
}

export interface SearchResult {
  available: boolean;
  hits: SearchHit[];
}

/**
 * Backfill the FTS index from the events table (called at register time
 * when the FTS table is empty but events exist).
 */
function backfill(db: InstanceType<typeof Database>): void {
  if (!searchAvailable || !_insert) return;
  try {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c as number;
    if (count === 0) return;

    const ftsCount = (_count!.get() as any).c as number;
    if (ftsCount > 0) return; // already indexed

    console.log(`[search] backfilling FTS index from ${count} events (cap 100k)…`);
    let offset = 0;
    const batchSize = 5000;

    while (true) {
      const rows = db
        .prepare(
          `SELECT run_id, node_id, seq, ts, type, payload
           FROM events
           ORDER BY rowid DESC
           LIMIT ? OFFSET ?`,
        )
        .all(batchSize, offset) as any[];
      if (rows.length === 0) break;

      const evs: NormalizedEvent[] = rows.map((r) => ({
        sessionId: '',
        runId: r.run_id,
        nodeId: r.node_id,
        parentNodeId: null,
        nodeType: 'root' as const,
        seq: r.seq,
        ts: r.ts,
        type: r.type,
        payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
      }));

      indexEvents(evs);
      offset += rows.length;
      if (offset >= 100_000) break;
    }
    console.log(`[search] backfill complete — indexed up to ${offset} events`);
  } catch (err: any) {
    console.warn('[search] backfill failed:', err?.message);
  }
}

/**
 * Perform a full-text search over indexed event payloads.
 * Returns { available: false, hits: [] } when FTS5 is unavailable.
 */
function search(db: InstanceType<typeof Database>, q: string, limit: number): SearchResult {
  if (!searchAvailable || !_search) {
    return { available: false, hits: [] };
  }
  try {
    const safeQ = sanitizeFtsQuery(q);
    const rows = _search.all(safeQ, limit) as Array<{
      run_id: string;
      seq: number;
      node_id: string;
      snippet: string;
    }>;

    if (rows.length === 0) return { available: true, hits: [] };

    // Fetch slim run info for all distinct run ids in one query
    const runIds = [...new Set(rows.map((r) => r.run_id))];
    const placeholders = runIds.map(() => '?').join(',');
    const runRows = db
      .prepare(
        `SELECT id, task, status, started_at, model FROM runs WHERE id IN (${placeholders})`,
      )
      .all(...runIds) as Array<{
      id: string;
      task: string;
      status: string;
      started_at: number;
      model: string;
    }>;
    const runMap = new Map(runRows.map((r) => [r.id, r]));

    const hits: SearchHit[] = [];
    for (const row of rows) {
      const run = runMap.get(row.run_id);
      if (!run) continue; // run deleted — skip orphan
      hits.push({
        runId: row.run_id,
        seq: row.seq,
        nodeId: row.node_id,
        snippet: row.snippet,
        run: {
          id: run.id,
          task: run.task,
          status: run.status,
          startedAt: run.started_at,
          model: run.model,
        },
      });
    }
    return { available: true, hits };
  } catch (err: any) {
    // FTS syntax error or other runtime failure → return empty safely
    console.warn('[search] query error:', err?.message);
    return { available: true, hits: [] };
  }
}

export function registerSearchRoutes(app: FastifyInstance): void {
  if (!_db) return; // safety: should not happen after initSearch

  const db = _db;

  // Run backfill at register time (synchronous, capped at 100k events)
  backfill(db);

  app.get('/api/search', async (req, reply) => {
    const query = req.query as any;
    const q = String(query?.q ?? '').trim();
    const rawLimit = parseInt(String(query?.limit ?? '30'), 10);
    const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 30 : rawLimit, 100);

    if (!searchAvailable) {
      return { available: false, hits: [] };
    }

    if (!q) {
      return { available: true, hits: [] };
    }

    return search(db, q, limit);
  });
}
