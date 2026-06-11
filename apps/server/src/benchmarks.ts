/**
 * F4+F5 — Benchmark mode / Best-of-N (PRD §F4).
 *
 * Launches 2–4 variant runs in parallel (claude or engine add-ons), waits for all to
 * reach a terminal state, then (in best-of-n mode) launches a judge claude run that
 * returns structuredOutput.winner = the winning run id.
 *
 * Atomicity guarantee (PRD): if any variant launch is blocked by the concurrency cap
 * (429) or daily-cap (409), all already-launched variants are stopped and the whole
 * create returns 409 (or 429, matching the original error).
 *
 * Routes:
 *   POST /api/benchmarks
 *   GET  /api/benchmarks
 *   GET  /api/benchmarks/:id
 *   DELETE /api/benchmarks/:id
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { repo } from './db.js';
import { registry } from './registry.js';
import { isEngineEnabled } from './addons.js';
import type { Run } from '@fleet/shared';
import db from './db.js';

// ── table ─────────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('matrix', 'best-of-n')),
  variants TEXT NOT NULL DEFAULT '[]',
  run_ids TEXT NOT NULL DEFAULT '[]',
  judge_template TEXT,
  judge_run_id TEXT,
  winner_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
`);

// ── types ─────────────────────────────────────────────────────────────────────

export interface BenchmarkVariant {
  label?: string;
  engine: 'claude' | 'codex' | 'opencode';
  model?: string;
  engineModel?: string;
  thinkingLevel?: string;
  effort?: string;
}

export interface CreateBenchmarkRequest {
  prompt: string;
  cwd: string;
  mode: 'matrix' | 'best-of-n';
  variants: BenchmarkVariant[];
  judgeTemplate?: string;
  budgetPerRunUsd?: number;
}

export interface Benchmark {
  id: string;
  prompt: string;
  cwd: string;
  mode: 'matrix' | 'best-of-n';
  variants: BenchmarkVariant[];
  runIds: string[];
  judgeTemplate: string | null;
  judgeRunId: string | null;
  winnerRunId: string | null;
  status: 'running' | 'judging' | 'completed' | 'failed' | 'killed';
  createdAt: number;
  endedAt: number | null;
}

export interface BenchmarkRunRollup {
  runId: string;
  label: string;
  engine: string;
  model: string | null;
  status: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number | null;
  resultPreview: string | null;
  isWinner: boolean;
}

export interface BenchmarkDetail extends Benchmark {
  rollups: BenchmarkRunRollup[];
}

// ── persistence helpers ───────────────────────────────────────────────────────

function toRow(b: Benchmark): Record<string, unknown> {
  return {
    id: b.id,
    prompt: b.prompt,
    cwd: b.cwd,
    mode: b.mode,
    variants: JSON.stringify(b.variants),
    run_ids: JSON.stringify(b.runIds),
    judge_template: b.judgeTemplate,
    judge_run_id: b.judgeRunId,
    winner_run_id: b.winnerRunId,
    status: b.status,
    created_at: b.createdAt,
    ended_at: b.endedAt,
  };
}

function fromRow(row: any): Benchmark {
  return {
    id: row.id,
    prompt: row.prompt,
    cwd: row.cwd,
    mode: row.mode as Benchmark['mode'],
    variants: JSON.parse(row.variants || '[]'),
    runIds: JSON.parse(row.run_ids || '[]'),
    judgeTemplate: row.judge_template ?? null,
    judgeRunId: row.judge_run_id ?? null,
    winnerRunId: row.winner_run_id ?? null,
    status: row.status as Benchmark['status'],
    createdAt: row.created_at,
    endedAt: row.ended_at ?? null,
  };
}

const upsert = db.prepare(`
  INSERT INTO benchmarks (id, prompt, cwd, mode, variants, run_ids, judge_template, judge_run_id, winner_run_id, status, created_at, ended_at)
  VALUES (@id, @prompt, @cwd, @mode, @variants, @run_ids, @judge_template, @judge_run_id, @winner_run_id, @status, @created_at, @ended_at)
  ON CONFLICT(id) DO UPDATE SET
    variants = excluded.variants,
    run_ids = excluded.run_ids,
    judge_template = excluded.judge_template,
    judge_run_id = excluded.judge_run_id,
    winner_run_id = excluded.winner_run_id,
    status = excluded.status,
    ended_at = excluded.ended_at
`);

function saveBenchmark(b: Benchmark) {
  upsert.run(toRow(b));
}

function getBenchmark(id: string): Benchmark | null {
  const row = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(id) as any;
  if (!row) return null;
  return fromRow(row);
}

function listBenchmarks(): Benchmark[] {
  const rows = db.prepare('SELECT * FROM benchmarks ORDER BY created_at DESC').all() as any[];
  return rows.map(fromRow);
}

// ── rollup helpers ────────────────────────────────────────────────────────────

function buildRollup(b: Benchmark): BenchmarkRunRollup[] {
  return b.runIds.map((runId, idx) => {
    const variant = b.variants[idx] ?? { engine: 'claude' as const };
    const run = registry.getRun(runId) ?? repo.getRun(runId);
    if (!run) {
      return {
        runId,
        label: variant.label ?? `variant-${idx + 1}`,
        engine: variant.engine ?? 'claude',
        model: variant.model ?? variant.engineModel ?? null,
        status: 'unknown',
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: null,
        resultPreview: null,
        isWinner: false,
      };
    }
    const durationMs = run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null;
    return {
      runId,
      label: variant.label ?? `variant-${idx + 1}`,
      engine: variant.engine ?? 'claude',
      model: run.model,
      status: run.status,
      costUsd: run.costUsd,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      durationMs,
      resultPreview: run.resultText ? run.resultText.slice(0, 500) : null,
      isWinner: run.id === b.winnerRunId,
    };
  });
}

// ── terminal tracking ─────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed']);

function isTerminal(status: string) {
  return TERMINAL_STATUSES.has(status);
}

// ── judge prompt + schema ─────────────────────────────────────────────────────

const JUDGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    winner: {
      type: 'string',
      description: 'The run ID of the best response',
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of why this variant was chosen',
    },
  },
  required: ['winner', 'reasoning'],
  additionalProperties: false,
};

function buildJudgePrompt(originalTask: string, variants: Array<{ runId: string; label: string; resultText: string | null }>): string {
  const variantSections = variants
    .map((v) => {
      const text = v.resultText ? v.resultText.slice(0, 4000) : '(no result)';
      return `## Variant "${v.label}" (run id: ${v.runId})\n${text}`;
    })
    .join('\n\n---\n\n');

  return (
    `You are a neutral judge evaluating AI agent outputs for the following task:\n\n` +
    `**Task:**\n${originalTask}\n\n` +
    `---\n\n` +
    `Below are the outputs from ${variants.length} variants:\n\n` +
    `${variantSections}\n\n` +
    `---\n\n` +
    `Evaluate which variant best completed the task. Consider: correctness, completeness, clarity, and efficiency.\n` +
    `Return the run ID of the best variant in the "winner" field, with a brief reasoning in the "reasoning" field.\n` +
    `The winner must be one of these exact run IDs: ${variants.map((v) => v.runId).join(', ')}.`
  );
}

// ── engine class ──────────────────────────────────────────────────────────────

/** Guards the 45s sweep against concurrent in-flight attempts */
let sweepInFlight = false;

class BenchmarkEngine {
  private terminalUnsub: (() => void) | null = null;
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  init() {
    this.terminalUnsub = registry.onRunTerminal((run) => this.handleRunTerminal(run));

    // ── #3/#8/#11/#12: 45s sweep — boot reconcile + judge-cap-stall recovery ──
    // This sweep is the single code path for both:
    //   (a) restart convergence: rows stuck 'running'/'judging' whose runs are
    //       already terminal in the DB (reconcileOrphans marked them failed without
    //       firing terminal events to us).
    //   (b) judge cap-stall recovery: launchJudge failed (429/daily-cap) and left
    //       the benchmark 'running' after all variants finished — no further terminal
    //       event will ever arrive, so a periodic sweep is needed.
    const sweepRef = setInterval(() => this.sweep(), 45_000);
    // unref so the sweep doesn't keep the process alive in test environments
    if (sweepRef.unref) sweepRef.unref();
    this.sweepInterval = sweepRef;

    // Run an initial sweep shortly after boot so reconcileOrphans-failed rows
    // converge quickly without waiting a full 45s interval.
    const bootRef = setTimeout(() => this.sweep(), 500);
    if (bootRef.unref) bootRef.unref();
  }

  /**
   * Sweep all non-terminal benchmarks from DB and converge any whose runs are
   * already terminal but whose benchmark row hasn't caught up.  This handles both
   * restart convergence (#8/#12) and judge cap-stall recovery (#3/#11).
   */
  private async sweep() {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      const all = listBenchmarks();
      for (const b of all) {
        if (b.status === 'running') {
          // Check if all variants are terminal in the DB
          const allTerminal = b.runIds.every((runId) => {
            const r = registry.getRun(runId) ?? repo.getRun(runId);
            return r ? isTerminal(r.status) : true; // unknown → treat as terminal
          });
          if (allTerminal) {
            await this.checkVariantsComplete(b);
          }
        } else if (b.status === 'judging' && b.judgeRunId) {
          // Restart convergence: judge run may have been failed by reconcileOrphans
          const judgeRun = registry.getRun(b.judgeRunId) ?? repo.getRun(b.judgeRunId);
          if (judgeRun && isTerminal(judgeRun.status)) {
            await this.onJudgeDone(b, judgeRun);
          }
        }
      }
    } finally {
      sweepInFlight = false;
    }
  }

  private async handleRunTerminal(run: Run) {
    // find any benchmark that contains this run id
    const all = listBenchmarks();
    for (const b of all) {
      // ── #1 (kill() race): short-circuit on terminal benchmarks ──
      if (b.status === 'running' && b.runIds.includes(run.id)) {
        await this.checkVariantsComplete(b);
      } else if (b.status === 'judging' && b.judgeRunId === run.id) {
        await this.onJudgeDone(b, run);
      }
      // benchmarks in 'completed'/'failed'/'killed' are ignored — no action
    }
  }

  private async checkVariantsComplete(b: Benchmark) {
    const fresh = getBenchmark(b.id);
    // ── #1 (kill() race): short-circuit if the benchmark is already terminal ──
    if (!fresh || fresh.status !== 'running') return;

    const allTerminal = fresh.runIds.every((runId) => {
      const r = registry.getRun(runId) ?? repo.getRun(runId);
      return r ? isTerminal(r.status) : true;
    });

    if (!allTerminal) return;

    if (fresh.mode === 'matrix') {
      // matrix: no judge, just mark completed
      fresh.status = 'completed';
      fresh.endedAt = Date.now();
      saveBenchmark(fresh);
    } else {
      // best-of-n: launch a judge run only if at least one variant completed
      // (#1: all killed/failed → no judge → status 'failed'/'killed')
      const atLeastOneCompleted = fresh.runIds.some((runId) => {
        const r = registry.getRun(runId) ?? repo.getRun(runId);
        return r?.status === 'completed';
      });
      if (!atLeastOneCompleted) {
        // All variants failed or were killed — finalize without a judge
        const allKilled = fresh.runIds.every((runId) => {
          const r = registry.getRun(runId) ?? repo.getRun(runId);
          return r ? r.status === 'killed' : true;
        });
        fresh.status = allKilled ? 'killed' : 'failed';
        fresh.endedAt = Date.now();
        saveBenchmark(fresh);
      } else {
        await this.launchJudge(fresh);
      }
    }
  }

  private async launchJudge(b: Benchmark) {
    // resolve the judge template (if named)
    let judgeProfile: {
      model?: string;
      effort?: string;
      permissionMode?: string;
      appendSystemPrompt?: string;
      budgetUsd?: number | null;
    } = {};
    if (b.judgeTemplate) {
      const t = repo.getTemplateByName(b.judgeTemplate);
      if (t) {
        judgeProfile = {
          model: t.model,
          effort: t.effort,
          permissionMode: t.permissionMode,
          appendSystemPrompt: t.systemPrompt,
          budgetUsd: t.budgetUsd,
        };
      }
    }

    // build variant summaries for the judge
    const variantSummaries = b.runIds.map((runId, idx) => {
      const variant = b.variants[idx] ?? { engine: 'claude' as const };
      const run = registry.getRun(runId) ?? repo.getRun(runId);
      return {
        runId,
        label: variant.label ?? `variant-${idx + 1}`,
        resultText: run?.resultText ?? null,
      };
    });

    const judgePrompt = buildJudgePrompt(b.prompt, variantSummaries);

    try {
      const judgeRun = registry.launch({
        prompt: judgePrompt,
        cwd: b.cwd,
        model: judgeProfile.model ?? 'claude-opus-4-8',
        effort: (judgeProfile.effort as any) ?? 'high',
        permissionMode: (judgeProfile.permissionMode as any) ?? 'default',
        appendSystemPrompt: judgeProfile.appendSystemPrompt,
        budgetUsd: judgeProfile.budgetUsd ?? undefined,
        jsonSchema: JUDGE_JSON_SCHEMA,
        interactive: false,
      });
      b.judgeRunId = judgeRun.id;
      b.status = 'judging';
      saveBenchmark(b);
    } catch (e: any) {
      // Judge launch failed (cap/daily-cap). Leave status 'running' so the 45s
      // sweep can retry (#3/#11). Log for observability.
      console.warn(`[benchmark ${b.id}] judge launch failed (will retry via sweep): ${e?.message ?? e}`);
    }
  }

  private async onJudgeDone(b: Benchmark, judgeRun: Run) {
    const fresh = getBenchmark(b.id);
    if (!fresh || fresh.status !== 'judging') return;

    if (judgeRun.status === 'completed') {
      // parse structuredOutput.winner
      const so = judgeRun.structuredOutput as any;
      if (so?.winner && typeof so.winner === 'string' && fresh.runIds.includes(so.winner)) {
        fresh.winnerRunId = so.winner;
      }
    }

    fresh.status = 'completed';
    fresh.endedAt = Date.now();
    saveBenchmark(fresh);
  }

  async create(req: CreateBenchmarkRequest): Promise<Benchmark> {
    // ── validation ────────────────────────────────────────────────────────────
    if (!req.prompt?.trim()) {
      throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
    }
    if (!req.cwd?.trim()) {
      throw Object.assign(new Error('cwd is required'), { statusCode: 400 });
    }
    if (!['matrix', 'best-of-n'].includes(req.mode)) {
      throw Object.assign(new Error('mode must be matrix or best-of-n'), { statusCode: 400 });
    }
    if (!Array.isArray(req.variants) || req.variants.length < 2 || req.variants.length > 4) {
      throw Object.assign(new Error('variants must be an array of 2–4 items'), { statusCode: 400 });
    }
    for (const v of req.variants) {
      if (!['claude', 'codex', 'opencode'].includes(v.engine)) {
        throw Object.assign(new Error(`engine must be one of claude, codex, opencode (got: ${v.engine})`), { statusCode: 400 });
      }
      if (v.engine !== 'claude' && !isEngineEnabled(v.engine)) {
        throw Object.assign(
          new Error(`Engine add-on '${v.engine}' is not enabled — enable it in the Add-on Marketplace first`),
          { statusCode: 400 },
        );
      }
    }
    if (req.mode === 'best-of-n' && req.judgeTemplate) {
      const t = repo.getTemplateByName(req.judgeTemplate);
      if (!t) {
        throw Object.assign(new Error(`judgeTemplate '${req.judgeTemplate}' not found`), { statusCode: 400 });
      }
    }

    const now = Date.now();
    const b: Benchmark = {
      id: randomUUID(),
      prompt: req.prompt,
      cwd: req.cwd,
      mode: req.mode,
      variants: req.variants,
      runIds: [],
      judgeTemplate: req.judgeTemplate ?? null,
      judgeRunId: null,
      winnerRunId: null,
      status: 'running',
      createdAt: now,
      endedAt: null,
    };

    // ── atomic launch: if ANY variant is blocked → stop launched ones + preserve error code ──
    const launchedRunIds: string[] = [];

    for (const v of req.variants) {
      let run: Run;
      try {
        if (v.engine === 'claude') {
          run = registry.launch({
            prompt: req.prompt,
            cwd: req.cwd,
            model: v.model ?? 'claude-opus-4-8',
            effort: (v.effort as any) ?? 'high',
            permissionMode: 'default',
            thinkingLevel: v.thinkingLevel as any,
            budgetUsd: req.budgetPerRunUsd ?? undefined,
            interactive: false,
          });
        } else {
          run = await registry.launchEngine({
            prompt: req.prompt,
            cwd: req.cwd,
            engine: v.engine,
            engineModel: v.engineModel,
            thinkingLevel: v.thinkingLevel as any,
            effort: (v.effort as any) ?? 'high',
            permissionMode: 'default',
            budgetUsd: req.budgetPerRunUsd ?? undefined,
            model: 'claude-opus-4-8', // required field; engine uses engineModel
            interactive: false,
          });
        }
        launchedRunIds.push(run.id);
      } catch (e: any) {
        // ── #7: atomic abort — preserve original statusCode/message ──
        // Stop already-launched variants (best-effort; already launched = in the live map)
        for (const rid of launchedRunIds) {
          try {
            registry.stop(rid);
          } catch {
            /* best-effort */
          }
        }
        // Preserve the original error code: 429 stays 429 (concurrency cap);
        // 409 'daily-cap' stays 409; 400 validation stays 400.
        const statusCode = e?.statusCode ?? 409;
        throw Object.assign(
          new Error(`Benchmark create aborted (atomic): variant launch failed — ${e?.message ?? e}`),
          { statusCode, code: e?.code },
        );
      }
    }

    b.runIds = launchedRunIds;
    saveBenchmark(b);
    return b;
  }

  getDetail(id: string): BenchmarkDetail | null {
    const b = getBenchmark(id);
    if (!b) return null;
    return { ...b, rollups: buildRollup(b) };
  }

  list(): Benchmark[] {
    return listBenchmarks();
  }

  /**
   * Kill a benchmark (H2 pattern from campaigns.ts): mark terminal FIRST, then
   * stop variant/judge runs so that handleRunTerminal short-circuits on the
   * already-terminal row and cannot launch an orphaned judge mid-kill (#1).
   */
  kill(id: string) {
    const b = getBenchmark(id);
    if (!b) throw Object.assign(new Error('benchmark not found'), { statusCode: 404 });
    if (b.status === 'completed' || b.status === 'killed') return;

    // ── #1 (kill() race — H2 pattern): persist 'killed' BEFORE stopping runs ──
    // registry.stop() synchronously fires onRunTerminal → handleRunTerminal.
    // If the benchmark were still 'running' at that point, checkVariantsComplete
    // could see all variants terminal and launch a judge — an orphaned judge whose
    // judge_run_id would then be clobbered when kill() continues.
    b.status = 'killed';
    b.endedAt = Date.now();
    saveBenchmark(b);

    // stop live variant runs
    for (const runId of b.runIds) {
      const r = registry.getRun(runId) ?? repo.getRun(runId);
      if (r && !isTerminal(r.status)) {
        try {
          registry.stop(runId);
        } catch {
          /* best-effort */
        }
      }
    }
    // stop judge if running
    if (b.judgeRunId) {
      const j = registry.getRun(b.judgeRunId) ?? repo.getRun(b.judgeRunId);
      if (j && !isTerminal(j.status)) {
        try {
          registry.stop(b.judgeRunId);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

export const benchmarks = new BenchmarkEngine();

/** Exposed for tests: runs the 45s sweep cycle immediately (idempotent). */
export async function sweepBenchmarksForTests(): Promise<void> {
  return (benchmarks as any).sweep();
}

// ── routes ────────────────────────────────────────────────────────────────────

export function registerBenchmarkRoutes(app: FastifyInstance) {
  benchmarks.init();

  app.post('/api/benchmarks', async (req, reply) => {
    try {
      const b = await benchmarks.create(req.body as CreateBenchmarkRequest);
      return b;
    } catch (e: any) {
      reply.code(e?.statusCode ?? 500);
      return { error: e.message, ...(e.code ? { code: e.code } : {}) };
    }
  });

  app.get('/api/benchmarks', async () => {
    return benchmarks.list();
  });

  app.get('/api/benchmarks/:id', async (req, reply) => {
    const detail = benchmarks.getDetail((req.params as any).id);
    if (!detail) {
      reply.code(404);
      return { error: 'not found' };
    }
    return detail;
  });

  app.delete('/api/benchmarks/:id', async (req, reply) => {
    try {
      benchmarks.kill((req.params as any).id);
      return { ok: true };
    } catch (e: any) {
      reply.code(e?.statusCode ?? 500);
      return { error: e.message };
    }
  });
}
