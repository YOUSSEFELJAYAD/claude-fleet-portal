/**
 * Feature F-LEARN — Skill auto-learning loop (hermes-agent closed learning loop, DC.md §29).
 *
 * On completion of an operator-launched claude run that is "complex" enough (cost /
 * subagents / depth / duration past configurable thresholds), distill a REUSABLE
 * SKILL.md from the run's trajectory via the Claude CLI and write it to
 * ~/.claude/skills/learned-<slug>/SKILL.md — which catalog.ts auto-discovers, so the
 * skill becomes immediately attachable to any agent profile. A copy is dropped into a
 * personal-rag-watched folder (~/rag-sys-perso/learned-skills) so the skill also
 * becomes semantically searchable on personal-rag's next scan (no second process
 * touches ChromaDB — respects its single-writer constraint).
 *
 * Fully autonomous when enabled; ships DISABLED by default. Every write to the user's
 * GLOBAL ~/.claude/skills is provenance-stamped (`learned: true`, `source_run`) and
 * individually deletable, and we NEVER overwrite a dir we did not author. This feature
 * deliberately crosses the PRD "skills are read-only / authoring out of scope" non-goal
 * at the operator's explicit request (DC.md §29).
 *
 * The distiller runs as a RAW async subprocess (not via the run registry) with
 * --strict-mcp-config, so it never recurses into the fleet or this very hook, and never
 * blocks the event loop.
 *
 * Routes: GET/PUT /api/learner (config), GET /api/learner/skills (list),
 * DELETE /api/learner/skills/:id, POST /api/learner/distill/:runId (manual, force).
 *
 * Self-owned tables; no edits to db.ts or registry.ts.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Run, NormalizedEvent, LearnerConfig, LearnedSkill } from '@fleet/shared';
import db, { repo } from './db.js';
import { registry } from './registry.js';
import { HOME, USER_SKILLS_DIR } from './config.js';

// ── schema (idempotent) ───────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS learner_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  min_cost_usd REAL NOT NULL DEFAULT 0.5,
  min_subagents INTEGER NOT NULL DEFAULT 3,
  min_depth INTEGER NOT NULL DEFAULT 2,
  min_duration_ms INTEGER NOT NULL DEFAULT 300000,
  max_per_day INTEGER NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS learned_skills (
  id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  rag_path TEXT,
  task_sig TEXT NOT NULL,
  source_cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learned_sig ON learned_skills(task_sig);
CREATE INDEX IF NOT EXISTS idx_learned_created ON learned_skills(created_at);
`);

// ── config ────────────────────────────────────────────────────────────────────

const DEFAULT_CFG: LearnerConfig = {
  enabled: false,
  minCostUsd: 0.5,
  minSubagents: 3,
  minDepth: 2,
  minDurationMs: 300_000, // 5 min
  maxPerDay: 10,
};

function getConfig(): LearnerConfig {
  const row = db.prepare('SELECT * FROM learner_config WHERE id = 1').get() as any;
  if (!row) return { ...DEFAULT_CFG };
  return {
    enabled: !!row.enabled,
    minCostUsd: row.min_cost_usd,
    minSubagents: row.min_subagents,
    minDepth: row.min_depth,
    minDurationMs: row.min_duration_ms,
    maxPerDay: row.max_per_day,
  };
}

function setConfig(cfg: LearnerConfig): void {
  db.prepare(
    `INSERT INTO learner_config (id, enabled, min_cost_usd, min_subagents, min_depth, min_duration_ms, max_per_day)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled, min_cost_usd = excluded.min_cost_usd,
       min_subagents = excluded.min_subagents, min_depth = excluded.min_depth,
       min_duration_ms = excluded.min_duration_ms, max_per_day = excluded.max_per_day`,
  ).run(
    cfg.enabled ? 1 : 0,
    cfg.minCostUsd,
    cfg.minSubagents,
    cfg.minDepth,
    cfg.minDurationMs,
    cfg.maxPerDay,
  );
}

/** Validate a PUT body, merging onto current config. Throws on bad input. */
function validateConfigBody(body: any): LearnerConfig {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const out = getConfig();

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    out.enabled = body.enabled;
  }
  const num = (key: keyof LearnerConfig, min: number) => {
    if (body[key] === undefined) return;
    const v = body[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min)
      throw new Error(`${String(key)} must be a number >= ${min}`);
    (out as any)[key] = v;
  };
  num('minCostUsd', 0);
  num('minSubagents', 0);
  num('minDepth', 0);
  num('minDurationMs', 0);
  if (body.maxPerDay !== undefined) {
    const v = body.maxPerDay;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
      throw new Error('maxPerDay must be an integer >= 1');
    out.maxPerDay = v;
  }
  return out;
}

// ── §31 settings panel — live read/update of the learner config (reuses the validation
//    + persistence the PUT /api/learner route uses, so /settings and /learning stay in sync). ──
export function getLearnerConfig(): LearnerConfig {
  return getConfig();
}
export function updateLearnerConfig(patch: Partial<LearnerConfig>): LearnerConfig {
  let next: LearnerConfig;
  try {
    next = validateConfigBody(patch);
  } catch (e: any) {
    throw Object.assign(new Error(e?.message ?? 'invalid learner config'), { statusCode: 400 });
  }
  setConfig(next);
  return next;
}

// ── paths (env-overridable so tests never touch the real ~/.claude/skills) ──────

function skillsDir(): string {
  return process.env.LEARNER_SKILLS_DIR || USER_SKILLS_DIR;
}
function ragDir(): string {
  return process.env.LEARNER_RAG_DIR || path.join(HOME, 'rag-sys-perso', 'learned-skills');
}
function claudeBin(): string {
  return process.env.LEARNER_CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude';
}

// ── pure helpers (unit-tested directly) ─────────────────────────────────────────

export function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'skill';
}

export function taskSignature(task: string): string {
  const norm = (task || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(norm).digest('hex');
}

/** A run is "complex" (worth a skill) if ANY configured threshold is met. */
export function isComplex(run: Run, cfg: LearnerConfig): boolean {
  const dur = (run.endedAt ?? 0) - (run.startedAt ?? 0);
  return (
    run.costUsd >= cfg.minCostUsd ||
    run.subagentCount >= cfg.minSubagents ||
    run.maxDepth >= cfg.minDepth ||
    dur >= cfg.minDurationMs
  );
}

/** Gate: only completed, operator-launched (non-campaign, non-PM), complex runs. */
export function shouldLearn(run: Run, cfg: LearnerConfig): boolean {
  if (!cfg.enabled) return false;
  if (run.status !== 'completed') return false;
  if (run.campaignId || run.projectId) return false; // operator runs only (mirrors memory.ts)
  if (!run.task || !run.task.trim()) return false;
  return isComplex(run, cfg);
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse the distiller's raw output into a skill. Returns 'skip' when the model
 * declined, or null when the output isn't a usable SKILL.md.
 */
export function parseSkill(raw: string): ParsedSkill | 'skip' | null {
  const text = raw.trim();
  if (text.toUpperCase() === 'SKIP') return 'skip';
  // Tolerate an accidental code fence around the whole thing.
  const unfenced = text
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  const m = unfenced.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const body = m[2].trim();
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k) fm[k] = v;
  }
  const name = (fm.name || '').trim();
  const description = (fm.description || '').trim();
  if (!name || !description || !body) return null;
  return { name, description, body };
}

// ── trajectory assembly for the distiller prompt ────────────────────────────────

const MAX_TRAJECTORY_CHARS = 6000;

/** Extract indexable text from one event (local copy of search.ts's extractor). */
function eventText(e: NormalizedEvent): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'assistant_text':
    case 'thinking':
    case 'agent_message':
      return typeof p.text === 'string' ? p.text : null;
    case 'tool_result':
      return typeof p.text === 'string' ? (p.text as string).slice(0, 600) : null;
    case 'result':
      return typeof p.result === 'string' ? (p.result as string) : null;
    case 'tool_use': {
      const name = typeof p.name === 'string' ? p.name : '';
      let input = '';
      try {
        input = JSON.stringify(p.input ?? {}).slice(0, 400);
      } catch {
        /* ignore */
      }
      return (name + (input ? ' ' + input : '')).trim() || null;
    }
    default:
      return null;
  }
}

function buildTrajectory(runId: string): string {
  let events: NormalizedEvent[] = [];
  try {
    events = repo.getEvents(runId);
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const e of events) {
    const t = eventText(e);
    if (t) parts.push(`[${e.type}] ${t}`);
  }
  let joined = parts.join('\n');
  if (joined.length > MAX_TRAJECTORY_CHARS) {
    // Keep the plan (head) and the outcome (tail) — the middle is the most droppable.
    const head = joined.slice(0, Math.floor(MAX_TRAJECTORY_CHARS * 0.4));
    const tail = joined.slice(joined.length - Math.floor(MAX_TRAJECTORY_CHARS * 0.6));
    joined = `${head}\n…\n${tail}`;
  }
  return joined;
}

const DISTILL_SYS =
  'You distill a REUSABLE Claude Code skill from a completed agent run. ' +
  'Output ONLY a valid SKILL.md and nothing else — no preamble, no code fences. ' +
  'Exact format:\n' +
  '---\nname: <kebab-case-noun-phrase>\ndescription: Use when <situation> — <what it does>.\n---\n\n' +
  '# <Title>\n\n<2-6 short sections of procedural knowledge: When to use, Steps, Gotchas>\n\n' +
  'Generalize away run-specific paths, names, and values — capture the METHOD, not the task. ' +
  'If the run has no generalizable, reusable procedure, output exactly: SKIP';

function buildPrompt(run: Run): string {
  const trajectory = buildTrajectory(run.id);
  return [
    `Task:\n${(run.task || '').slice(0, 1200)}`,
    run.resultText ? `Final result:\n${run.resultText.slice(0, 2000)}` : '',
    trajectory ? `Trajectory (truncated):\n${trajectory}` : '',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function distillArgs(): string[] {
  return [
    '-p',
    '--strict-mcp-config', // ignore all other MCP configs (prevents recursion into personal-rag/fleet)
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--append-system-prompt',
    DISTILL_SYS,
  ];
}

// ── distiller runner (async subprocess; injectable for tests) ───────────────────

export type Runner = (args: string[], prompt: string) => Promise<string>;

const defaultRunner: Runner = (args, prompt) =>
  new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude distiller timed out after 180s'));
    }, 180_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`claude binary not found: ${claudeBin()}`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`));
      const trimmed = out.trim();
      if (!trimmed) return reject(new Error('claude distiller returned empty output'));
      resolve(trimmed);
    });
    child.stdin.end(prompt);
  });

// ── disk writers (never clobber a dir we did not author) ────────────────────────

function isLearnedDir(dir: string): boolean {
  try {
    const md = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    return /(^|\n)learned:\s*true\b/.test(md);
  } catch {
    return false;
  }
}

function resolveSkillDir(baseSlug: string, sourceRunId: string): string {
  const base = skillsDir();
  const full = path.join(base, `learned-${baseSlug}`);
  if (!existsSync(full)) return full;
  if (isLearnedDir(full)) return full; // our own — safe to overwrite (re-learning)
  return path.join(base, `learned-${baseSlug}-${sourceRunId.slice(0, 6)}`); // avoid clobbering hand-authored
}

function renderSkillMd(parsed: ParsedSkill, sourceRunId: string, generatedAt: string): string {
  return (
    `---\n` +
    `name: ${slugify(parsed.name)}\n` +
    `description: ${parsed.description.replace(/\s+/g, ' ')}\n` +
    `learned: true\n` +
    `source_run: ${sourceRunId}\n` +
    `generated_at: ${generatedAt}\n` +
    `---\n\n` +
    `${parsed.body}\n`
  );
}

function recordRow(r: Omit<LearnedSkill, 'id' | 'createdAt'>): LearnedSkill {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO learned_skills
       (id, source_run_id, name, slug, skill_path, rag_path, task_sig, source_cost_usd, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    r.sourceRunId,
    r.name,
    r.slug,
    r.skillPath,
    r.ragPath,
    r.taskSig,
    r.sourceCostUsd,
    r.status,
    r.error,
    createdAt,
  );
  return { id, createdAt, ...r };
}

// ── dedup + rate gates ──────────────────────────────────────────────────────────

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

function isDuplicate(sig: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM learned_skills WHERE task_sig = ? AND status = 'ok' AND created_at >= ? LIMIT 1`)
    .get(sig, Date.now() - THIRTY_DAYS);
  return !!row;
}

function learnedToday(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM learned_skills WHERE status = 'ok' AND created_at >= ?`)
    .get(Date.now() - ONE_DAY) as any;
  return row?.c ?? 0;
}

// ── the distillation pipeline ───────────────────────────────────────────────────

export interface DistillResult {
  status: 'ok' | 'skipped' | 'failed';
  id?: string;
  name?: string;
  slug?: string;
  skillPath?: string;
  ragPath?: string | null;
  error?: string;
}

/**
 * Distill a skill from a run and write it to disk + the personal-rag notes dir.
 * Records an outcome row either way. `force` bypasses the dedup gate (manual route).
 */
export async function distillAndWrite(
  run: Run,
  runner: Runner = defaultRunner,
  opts: { force?: boolean } = {},
): Promise<DistillResult> {
  const sig = taskSignature(run.task);
  if (!opts.force && isDuplicate(sig)) return { status: 'skipped', error: 'duplicate task signature' };

  let raw: string;
  try {
    raw = await runner(distillArgs(), buildPrompt(run));
  } catch (e: any) {
    const error = (e?.message ?? 'distiller failed').slice(0, 300);
    recordRow({ sourceRunId: run.id, name: '', slug: '', skillPath: '', ragPath: null, taskSig: sig, sourceCostUsd: run.costUsd, status: 'failed', error });
    return { status: 'failed', error };
  }

  const parsed = parseSkill(raw);
  if (parsed === 'skip') {
    recordRow({ sourceRunId: run.id, name: '', slug: '', skillPath: '', ragPath: null, taskSig: sig, sourceCostUsd: run.costUsd, status: 'skipped', error: 'model declined (SKIP)' });
    return { status: 'skipped', error: 'model declined (SKIP)' };
  }
  if (!parsed) {
    recordRow({ sourceRunId: run.id, name: '', slug: '', skillPath: '', ragPath: null, taskSig: sig, sourceCostUsd: run.costUsd, status: 'failed', error: 'unparseable distiller output' });
    return { status: 'failed', error: 'unparseable distiller output' };
  }

  const slug = slugify(parsed.name);
  const generatedAt = new Date().toISOString();
  const content = renderSkillMd(parsed, run.id, generatedAt);

  let skillPath: string;
  try {
    const dir = resolveSkillDir(slug, run.id);
    mkdirSync(dir, { recursive: true });
    skillPath = path.join(dir, 'SKILL.md');
    writeFileSync(skillPath, content, 'utf8');
  } catch (e: any) {
    const error = (e?.message ?? 'write failed').slice(0, 300);
    recordRow({ sourceRunId: run.id, name: slug, slug, skillPath: '', ragPath: null, taskSig: sig, sourceCostUsd: run.costUsd, status: 'failed', error });
    return { status: 'failed', error };
  }

  // RAG copy — best-effort; a failure here does NOT fail the skill (it's still attachable).
  let ragPath: string | null = null;
  try {
    const rdir = ragDir();
    mkdirSync(rdir, { recursive: true });
    ragPath = path.join(rdir, `${path.basename(path.dirname(skillPath))}.md`);
    writeFileSync(ragPath, content, 'utf8');
  } catch (e: any) {
    console.warn('[learner] RAG copy failed (skill still written):', e?.message);
    ragPath = null;
  }

  const row = recordRow({ sourceRunId: run.id, name: slug, slug, skillPath, ragPath, taskSig: sig, sourceCostUsd: run.costUsd, status: 'ok', error: null });
  return { status: 'ok', id: row.id, name: slug, slug, skillPath, ragPath };
}

// ── terminal-run subscription (autonomous trigger) ──────────────────────────────

let inFlight = 0;
const MAX_INFLIGHT = 2;
const inFlightSigs = new Set<string>();

function handleTerminal(run: Run): void {
  const cfg = getConfig();
  if (!shouldLearn(run, cfg)) return;
  if (learnedToday() >= cfg.maxPerDay) return;
  const sig = taskSignature(run.task);
  if (inFlightSigs.has(sig)) return; // a near-simultaneous run with the same task is already distilling
  if (isDuplicate(sig)) return;
  if (inFlight >= MAX_INFLIGHT) return; // best-effort backpressure

  inFlight++;
  inFlightSigs.add(sig);
  // Async + off the hot path: the registry callback must stay fast and never throw.
  distillAndWrite(run)
    .catch((e) => console.warn('[learner] distill failed:', e?.message))
    .finally(() => {
      inFlight--;
      inFlightSigs.delete(sig);
    });
}

/** Subscribe to terminal runs. Call once from the main loop (mirrors initMemory). */
export function initLearner(): void {
  registry.onRunTerminal((run) => {
    try {
      handleTerminal(run);
    } catch {
      /* best-effort — a learning failure must never destabilize the terminal hook */
    }
  });
}

// ── list / delete ───────────────────────────────────────────────────────────────

function rowToSkill(r: any): LearnedSkill {
  return {
    id: r.id,
    sourceRunId: r.source_run_id,
    name: r.name,
    slug: r.slug,
    skillPath: r.skill_path,
    ragPath: r.rag_path ?? null,
    taskSig: r.task_sig,
    sourceCostUsd: r.source_cost_usd,
    status: r.status,
    error: r.error ?? null,
    createdAt: r.created_at,
  };
}

function listLearnedSkills(): LearnedSkill[] {
  const rows = db.prepare('SELECT * FROM learned_skills ORDER BY created_at DESC LIMIT 200').all();
  return rows.map(rowToSkill);
}

/** Remove a learned skill's SKILL.md dir (only if we authored it) + RAG copy + row. */
function deleteLearnedSkill(id: string): boolean {
  const row = db.prepare('SELECT * FROM learned_skills WHERE id = ?').get(id) as any;
  if (!row) return false;
  try {
    if (row.skill_path) {
      const dir = path.dirname(row.skill_path);
      if (existsSync(dir) && isLearnedDir(dir)) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
  try {
    if (row.rag_path && existsSync(row.rag_path)) rmSync(row.rag_path, { force: true });
  } catch {
    /* best-effort */
  }
  db.prepare('DELETE FROM learned_skills WHERE id = ?').run(id);
  return true;
}

// ── routes ───────────────────────────────────────────────────────────────────────

export function registerLearnerRoutes(app: FastifyInstance): void {
  /** GET /api/learner — current config */
  app.get('/api/learner', async () => getConfig());

  /** PUT /api/learner — update config */
  app.put('/api/learner', async (req, reply) => {
    try {
      const next = validateConfigBody(req.body);
      setConfig(next);
      return getConfig();
    } catch (e: any) {
      reply.code(400);
      return { error: e.message };
    }
  });

  /** GET /api/learner/skills — list distillation outcomes (newest first) */
  app.get('/api/learner/skills', async () => listLearnedSkills());

  /** DELETE /api/learner/skills/:id — remove a learned skill (escape hatch) */
  app.delete('/api/learner/skills/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteLearnedSkill(id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });

  /** POST /api/learner/distill/:runId — manually distill a specific run (bypasses dedup) */
  app.post('/api/learner/distill/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = repo.getRun(runId);
    if (!run) {
      reply.code(404);
      return { error: 'run not found' };
    }
    try {
      const result = await distillAndWrite(run, defaultRunner, { force: true });
      if (result.status !== 'ok') reply.code(422);
      return result;
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? 'distill failed' };
    }
  });
}
