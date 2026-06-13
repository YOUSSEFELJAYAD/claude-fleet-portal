/**
 * Manual run scoring + annotations (A7). Lets a human attach a numeric rating
 * (with optional comment) to any run, and exposes per-run aggregates for the
 * history view. Self-contained table, defined idempotently here so the module
 * owns its own schema (mirrors the db.ts DDL style; snake_case columns).
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import db, { onRunDeleted } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  comment TEXT,
  source TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_run ON scores(run_id);
`);

const insertScoreStmt = db.prepare(`
INSERT INTO scores (id, run_id, name, value, comment, source, ts)
VALUES (@id, @run_id, @name, @value, @comment, @source, @ts)
`);

const listByRunStmt = db.prepare('SELECT * FROM scores WHERE run_id = ? ORDER BY ts DESC');
const deleteScoreStmt = db.prepare('DELETE FROM scores WHERE id = ?');
// Cascade: drop a deleted run's scores. scores has no FK to runs, so db.ts fires onRunDeleted
// and we clean our own rows here (mirrors tags.ts / projects.onProjectDeleted) — no orphans.
const deleteScoresForRunStmt = db.prepare('DELETE FROM scores WHERE run_id = ?');
onRunDeleted((runId) => deleteScoresForRunStmt.run(runId));
const summaryStmt = db.prepare(
  'SELECT run_id AS runId, AVG(value) AS avg, COUNT(*) AS count FROM scores GROUP BY run_id',
);

function rowToScore(row: any) {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    value: row.value,
    comment: row.comment ?? null,
    source: row.source,
    ts: row.ts,
  };
}

export function registerScoreRoutes(app: FastifyInstance) {
  // all scores for a run, newest first
  app.get('/api/agents/:id/scores', async (req) => {
    const id = (req.params as any).id;
    return (listByRunStmt.all(id) as any[]).map(rowToScore);
  });

  // attach a human rating to a run
  app.post('/api/agents/:id/scores', async (req, reply) => {
    const id = (req.params as any).id;
    const body = (req.body as any) ?? {};
    const { name, value, comment } = body;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reply.code(400);
      return { error: 'value must be a finite number' };
    }
    if (typeof name !== 'string' || !name.trim()) {
      reply.code(400);
      return { error: 'name must be a non-empty string' };
    }
    const row = {
      id: randomUUID(),
      run_id: id,
      name: name.trim(),
      value,
      comment: typeof comment === 'string' && comment.trim() ? comment.trim() : null,
      source: 'human',
      ts: Date.now(),
    };
    insertScoreStmt.run(row);
    return rowToScore(row);
  });

  // remove a single score by its id
  app.delete('/api/scores/:scoreId', async (req) => {
    const scoreId = (req.params as any).scoreId;
    deleteScoreStmt.run(scoreId);
    return { ok: true };
  });

  // per-run averages for the history view
  app.get('/api/scores/summary', async () => {
    return summaryStmt.all() as { runId: string; avg: number; count: number }[];
  });
}
