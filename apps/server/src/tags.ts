/**
 * Run tags + saved searches (Feature A8). Lets the operator label runs with
 * free-form tags and persist named history-filter presets. Self-contained:
 * owns its own tables (run_tags, saved_searches), reuses the shared sqlite handle.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import db from './db.js';

// ── schema (idempotent) ────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS run_tags (
  run_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (run_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_run_tags_tag ON run_tags(tag);

CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filter TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_created ON saved_searches(created_at DESC);
`);

// ── prepared statements ─────────────────────────────────────────────────────
const listTagsForRunStmt = db.prepare(
  'SELECT tag FROM run_tags WHERE run_id = ? ORDER BY tag',
);
const insertTagStmt = db.prepare(
  'INSERT OR IGNORE INTO run_tags (run_id, tag) VALUES (?, ?)',
);
const deleteTagStmt = db.prepare(
  'DELETE FROM run_tags WHERE run_id = ? AND tag = ?',
);
// JOIN to runs so deleted runs (db.deleteRun does not cascade run_tags) don't
// inflate the global tag counts with orphaned rows.
const allTagsStmt = db.prepare(`
  SELECT t.tag AS tag, COUNT(*) AS count
  FROM run_tags t
  JOIN runs r ON r.id = t.run_id
  GROUP BY t.tag
  ORDER BY count DESC, t.tag
`);

const listSearchesStmt = db.prepare(
  'SELECT id, name, filter, created_at FROM saved_searches ORDER BY created_at DESC',
);
const insertSearchStmt = db.prepare(
  'INSERT INTO saved_searches (id, name, filter, created_at) VALUES (@id, @name, @filter, @created_at)',
);
const deleteSearchStmt = db.prepare('DELETE FROM saved_searches WHERE id = ?');

/** Normalize a tag the same way on write and on delete so the keys always match. */
function normTag(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function registerTagsRoutes(app: FastifyInstance) {
  // ── per-run tags ──────────────────────────────────────────────────────────
  app.get('/api/agents/:id/tags', async (req) => {
    const id = (req.params as any).id as string;
    return (listTagsForRunStmt.all(id) as any[]).map((r) => r.tag as string);
  });

  app.post('/api/agents/:id/tags', async (req, reply) => {
    const id = (req.params as any).id as string;
    const tag = normTag((req.body as any)?.tag);
    if (!tag) {
      reply.code(400);
      return { error: 'tag must be a non-empty string' };
    }
    insertTagStmt.run(id, tag);
    return (listTagsForRunStmt.all(id) as any[]).map((r) => r.tag as string);
  });

  app.delete('/api/agents/:id/tags/:tag', async (req) => {
    const id = (req.params as any).id as string;
    const tag = normTag((req.params as any).tag);
    deleteTagStmt.run(id, tag);
    return { ok: true };
  });

  // ── all distinct tags with counts ──────────────────────────────────────────
  app.get('/api/tags', async () => {
    return (allTagsStmt.all() as any[]).map((r) => ({
      tag: r.tag as string,
      count: r.count as number,
    }));
  });

  // ── saved searches ──────────────────────────────────────────────────────────
  app.get('/api/saved-searches', async () => {
    return (listSearchesStmt.all() as any[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      filter: safeJson(r.filter),
      createdAt: r.created_at as number,
    }));
  });

  app.post('/api/saved-searches', async (req, reply) => {
    const body = (req.body as any) ?? {};
    const name = String(body.name ?? '').trim();
    const filter = body.filter;
    if (!name) {
      reply.code(400);
      return { error: 'name must be a non-empty string' };
    }
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
      reply.code(400);
      return { error: 'filter must be a non-null object' };
    }
    const row = {
      id: randomUUID(),
      name,
      filter: JSON.stringify(filter),
      created_at: Date.now(),
    };
    insertSearchStmt.run(row);
    return { id: row.id, name: row.name, filter, createdAt: row.created_at };
  });

  app.delete('/api/saved-searches/:id', async (req) => {
    const id = (req.params as any).id as string;
    deleteSearchStmt.run(id);
    return { ok: true };
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
