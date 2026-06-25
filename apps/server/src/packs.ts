/**
 * Tool/skill packs (DC.md §23) — operator-defined presets pairing allowed-tools
 * entries with skills ("Web Dev pack", "Read-only auditor", …), applied with one
 * click in the launch modal / template editor instead of re-picking every time.
 *
 * Routes:
 *   GET    /api/packs       — list (name order)
 *   POST   /api/packs       — create (409 on duplicate name)
 *   PUT    /api/packs/:id   — update (rename keeps the uniqueness guarantee)
 *   DELETE /api/packs/:id
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ToolPack } from '@fleet/shared';
import db from './db.js';

// projects.ts pattern — the module owns its table; runs after db.ts's migration loop.
db.exec(`
CREATE TABLE IF NOT EXISTS tool_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`);

const MAX_ENTRIES = 100;
const MAX_ENTRY_LEN = 120;

/** H9 spirit — packs feed `--allowedTools` verbatim on later launches, so garbage
 *  is rejected at the door: name 1–60 chars, entries trimmed/deduped/bounded. */
export function validatePack(input: unknown): { name: string; description: string; tools: string[]; skills: string[] } {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('pack must be an object'), { statusCode: 400 });
  }
  const i = input as Record<string, unknown>;
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

  if (typeof i.name !== 'string' || !i.name.trim()) throw bad('name is required');
  const name = i.name.trim();
  if (name.length > 60) throw bad('name must be at most 60 characters');

  let description = '';
  if (i.description !== undefined) {
    if (typeof i.description !== 'string') throw bad('description must be a string');
    description = i.description.trim().slice(0, 300);
  }

  const list = (key: 'tools' | 'skills'): string[] => {
    if (i[key] === undefined) return [];
    if (!Array.isArray(i[key])) throw bad(`${key} must be an array of strings`);
    const out: string[] = [];
    for (const v of i[key] as unknown[]) {
      if (typeof v !== 'string') throw bad(`${key} must be an array of strings`);
      const s = v.trim();
      if (!s) continue;
      if (s.length > MAX_ENTRY_LEN) throw bad(`${key} entries must be at most ${MAX_ENTRY_LEN} characters`);
      if (!out.includes(s)) out.push(s);
    }
    if (out.length > MAX_ENTRIES) throw bad(`${key} can hold at most ${MAX_ENTRIES} entries`);
    return out;
  };

  return { name, description, tools: list('tools'), skills: list('skills') };
}

export function rowToPack(row: any): ToolPack {
  const arr = (s: string): string[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tools: arr(row.tools),
    skills: arr(row.skills),
    createdAt: row.created_at,
  };
}

const isDupName = (e: unknown) => /UNIQUE constraint failed: tool_packs\.name/i.test((e as any)?.message ?? '');

export function registerPackRoutes(app: FastifyInstance) {
  app.get('/api/packs', async () => {
    return (db.prepare('SELECT * FROM tool_packs ORDER BY name COLLATE NOCASE').all() as any[]).map(rowToPack);
  });

  app.post('/api/packs', async (req, reply) => {
    let p: ReturnType<typeof validatePack>;
    try {
      p = validatePack(req.body ?? {});
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid pack' });
    }
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO tool_packs (id, name, description, tools, skills, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        p.name,
        p.description,
        JSON.stringify(p.tools),
        JSON.stringify(p.skills),
        Date.now(),
      );
    } catch (e) {
      if (isDupName(e)) return reply.code(409).send({ error: `a pack named "${p.name}" already exists`, code: 'duplicate-name' });
      throw e;
    }
    return rowToPack(db.prepare('SELECT * FROM tool_packs WHERE id = ?').get(id));
  });

  app.put('/api/packs/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const row = db.prepare('SELECT * FROM tool_packs WHERE id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'unknown pack' });
    let p: ReturnType<typeof validatePack>;
    try {
      // partial update: missing fields keep the stored value
      p = validatePack({ ...rowToPack(row), ...(req.body as object ?? {}) });
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid pack' });
    }
    try {
      db.prepare('UPDATE tool_packs SET name = ?, description = ?, tools = ?, skills = ? WHERE id = ?').run(
        p.name,
        p.description,
        JSON.stringify(p.tools),
        JSON.stringify(p.skills),
        id,
      );
    } catch (e) {
      if (isDupName(e)) return reply.code(409).send({ error: `a pack named "${p.name}" already exists`, code: 'duplicate-name' });
      throw e;
    }
    return rowToPack(db.prepare('SELECT * FROM tool_packs WHERE id = ?').get(id));
  });

  app.delete('/api/packs/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const res = db.prepare('DELETE FROM tool_packs WHERE id = ?').run(id);
    if (res.changes === 0) return reply.code(404).send({ error: 'unknown pack' });
    return { ok: true };
  });
}
