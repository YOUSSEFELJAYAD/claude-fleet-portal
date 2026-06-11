/**
 * Feature F9 — Fleet memory (compounding knowledge).
 *
 * File-based memory: on completion of operator-launched claude runs (not campaign
 * workers, not PM/project runs) appends a markdown summary to <dir>/fleet-runs.md
 * and a JSONL line to <dir>/fleet-runs.jsonl. The dir is point-able at any RAG
 * indexer (personal-rag MCP server, etc.).
 *
 * Routes: GET/PUT /api/memory (config), GET /api/memory/stats.
 *
 * Self-owned table; no edits to db.ts or registry.ts.
 */
import { mkdirSync, appendFileSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Run } from '@fleet/shared';
import db from './db.js';
import { registry } from './registry.js';
import { DATA_DIR } from './config.js';

// ── schema (idempotent) ───────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS memory_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  dir TEXT NOT NULL DEFAULT ''
);
`);

// ── config ────────────────────────────────────────────────────────────────────

interface MemoryConfig {
  enabled: boolean;
  dir: string;
}

const DEFAULT_DIR = path.join(DATA_DIR, 'memory');

function getConfig(): MemoryConfig {
  const row = db.prepare('SELECT enabled, dir FROM memory_config WHERE id = 1').get() as any;
  if (!row) return { enabled: false, dir: DEFAULT_DIR };
  return {
    enabled: !!row.enabled,
    dir: row.dir || DEFAULT_DIR,
  };
}

function setConfig(cfg: MemoryConfig) {
  db.prepare(`
    INSERT INTO memory_config (id, enabled, dir) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, dir = excluded.dir
  `).run(cfg.enabled ? 1 : 0, cfg.dir);
}

/**
 * Validate a config body — throws with a readable message on bad input.
 * dir must be absolute and must not contain '..'.
 */
function validateConfigBody(body: any): MemoryConfig {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const cur = getConfig();

  let enabled = cur.enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    enabled = body.enabled;
  }

  let dir = cur.dir;
  if (body.dir !== undefined) {
    if (typeof body.dir !== 'string') throw new Error('dir must be a string');
    const d = body.dir.trim();
    if (d && !d.startsWith('/')) throw new Error('dir must be an absolute path');
    if (d.includes('..')) throw new Error("dir must not contain '..'");
    dir = d || DEFAULT_DIR;
  }

  return { enabled, dir };
}

// ── write helpers ─────────────────────────────────────────────────────────────

function ensureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch (e: any) {
    console.warn('[memory] could not create dir', dir, e?.message);
    return false;
  }
}

function appendEntry(run: Run): void {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  // Skip campaign workers (campaignId set) and PM/project runs (projectId set).
  if (run.campaignId || run.projectId) return;

  // Only capture completed claude runs.
  if (run.status !== 'completed') return;

  const dir = cfg.dir || DEFAULT_DIR;
  if (!ensureDir(dir)) return;

  const ts = new Date().toISOString();
  const task = (run.task ?? '').slice(0, 300);
  const resultText = run.resultText ?? '';
  const resultTrimmed = resultText.slice(0, 1500);
  const cost = run.costUsd.toFixed(4);

  // Markdown entry (trimmed result)
  const mdEntry =
    `\n## ${ts} · ${run.model} · $${cost}\n` +
    `**task:** ${task}\n` +
    `**cwd:** ${run.cwd}\n` +
    `**result:**\n${resultTrimmed}\n`;

  // JSONL entry (full untrimmed result)
  const jsonlEntry =
    JSON.stringify({
      ts,
      model: run.model,
      costUsd: run.costUsd,
      task: run.task,
      cwd: run.cwd,
      resultText,
    }) + '\n';

  try {
    appendFileSync(path.join(dir, 'fleet-runs.md'), mdEntry, 'utf8');
  } catch (e: any) {
    console.warn('[memory] failed to append fleet-runs.md:', e?.message);
  }

  try {
    appendFileSync(path.join(dir, 'fleet-runs.jsonl'), jsonlEntry, 'utf8');
  } catch (e: any) {
    console.warn('[memory] failed to append fleet-runs.jsonl:', e?.message);
  }
}

// ── stats helper ──────────────────────────────────────────────────────────────

interface MemoryStats {
  entries: number;
  bytes: number;
  dir: string;
}

function getStats(): MemoryStats {
  const cfg = getConfig();
  const dir = cfg.dir || DEFAULT_DIR;
  const jsonlPath = path.join(dir, 'fleet-runs.jsonl');

  let entries = 0;
  let bytes = 0;

  try {
    const stat = statSync(jsonlPath);
    bytes = stat.size;
    // Count newline-delimited lines (each non-empty line = one entry)
    const content = readFileSync(jsonlPath, 'utf8');
    entries = content.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    // File doesn't exist yet — that's fine
  }

  return { entries, bytes, dir };
}

// ── subscription ──────────────────────────────────────────────────────────────

/** Subscribe to terminal runs. Call once from the main loop (mirrors notifier pattern). */
export function initMemory(): void {
  registry.onRunTerminal((run) => {
    try {
      appendEntry(run);
    } catch {
      /* best-effort — memory writes must not destabilize the terminal hook */
    }
  });
}

// ── routes ────────────────────────────────────────────────────────────────────

export function registerMemoryRoutes(app: FastifyInstance): void {
  /** GET /api/memory — current config */
  app.get('/api/memory', async () => getConfig());

  /** PUT /api/memory — update config */
  app.put('/api/memory', async (req, reply) => {
    try {
      const next = validateConfigBody(req.body);
      setConfig(next);
      return getConfig();
    } catch (e: any) {
      reply.code(400);
      return { error: e.message };
    }
  });

  /** GET /api/memory/stats — entry count + bytes for the current dir */
  app.get('/api/memory/stats', async () => getStats());
}
