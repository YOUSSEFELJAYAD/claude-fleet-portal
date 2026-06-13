/**
 * Real coverage tests for benchmarks.ts (F4/F5 — Benchmark mode / Best-of-N).
 *
 * Strategy: isolated FLEET_DATA_DIR + fake CLAUDE_BIN (set BEFORE any src import).
 * We seed real `run` rows via repo.upsertRun and craft benchmark rows directly through
 * the module-level sqlite `db` (the same handle benchmarks.ts uses), then drive the REAL
 * engine methods (getDetail / kill / create) and the REAL routes via buildServer().inject().
 * Every test asserts a real OUTPUT or DB side-effect — nothing is called just to paint
 * coverage.
 *
 * Targets the uncovered ranges:
 *   169-182  buildRollup — run-not-found ("unknown") rollup branch
 *   296-303  sweep — 'judging' convergence → onJudgeDone (winner parse + finalize)
 *   351-384  checkVariantsComplete — all-killed / all-failed finalize; launchJudge template resolution
 *   417-448  launchJudge catch (launch throws) ; onJudgeDone winner validation ; create validation
 *   504-526  create — engine (non-claude) launch branch + atomic abort stop loop
 *   580-593  kill — stop a live judge run
 *   626-628  GET /api/benchmarks/:id → 404
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run } from '@fleet/shared';

// ── Isolate DB + fake binary BEFORE any src import ────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-cov-benchmarks-'));
process.env.FLEET_DATA_DIR = dataDir;

// Fake CLAUDE_BIN: emits init + result and exits 0. If --json-schema is present and
// BENCH_WINNER_RUN_ID is set, emits structured_output.winner.
const fakeBin = join(dataDir, 'fake-claude.cjs');
writeFileSync(
  fakeBin,
  `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
const si = args.indexOf('--session-id');
const sessionId = si >= 0 ? args[si + 1] : 'test-session';
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
w({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [],
    model: 'claude-opus-4-8', apiKeySource: 'env', permissionMode: 'default' });
const hasJsonSchema = args.includes('--json-schema');
const winnerRunId = process.env.BENCH_WINNER_RUN_ID || '';
if (hasJsonSchema && winnerRunId) {
  w({ type: 'result', session_id: sessionId, subtype: 'success',
      result: JSON.stringify({ winner: winnerRunId, reasoning: 'best output' }),
      is_error: false, total_cost_usd: 0.001, usage: {},
      structured_output: { winner: winnerRunId, reasoning: 'best output' } });
} else {
  w({ type: 'result', session_id: sessionId, subtype: 'success',
      result: 'task done', is_error: false, total_cost_usd: 0.0005, usage: {} });
}
process.exit(0);
`,
);
chmodSync(fakeBin, 0o755);
process.env.CLAUDE_BIN = fakeBin;

let app: any;
let PORT: number;
let repo: typeof import('../src/db.js').repo;
let db: typeof import('../src/db.js').default;
let registry: typeof import('../src/registry.js').registry;
let benchmarks: typeof import('../src/benchmarks.js').benchmarks;
let sweepBenchmarksForTests: typeof import('../src/benchmarks.js').sweepBenchmarksForTests;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const post = (url: string, body: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: H(), payload: body });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H() });

// ── seed builders ──────────────────────────────────────────────────────────────
function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run-' + randomUUID(),
    sessionId: 'sess-' + randomUUID(),
    task: 'seeded task',
    cwd: dataDir,
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    workflowsEnabled: false,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'completed',
    startedAt: 1_000_000,
    endedAt: 1_065_000,
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0.42,
    exitCode: 0,
    killReason: null,
    error: null,
    budgetUsd: null,
    permissionMode: 'default',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: 'result text here',
    structuredOutput: null,
    pid: null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: 1_065_000,
    ...over,
  };
}

/** Insert a benchmark row directly via the same sqlite handle benchmarks.ts uses. */
function insertBenchmark(over: Partial<{
  id: string;
  prompt: string;
  cwd: string;
  mode: 'matrix' | 'best-of-n';
  variants: any[];
  runIds: string[];
  judgeTemplate: string | null;
  judgeRunId: string | null;
  winnerRunId: string | null;
  status: string;
  endedAt: number | null;
}> = {}): string {
  const id = over.id ?? randomUUID();
  db.prepare(
    `INSERT INTO benchmarks (id, prompt, cwd, mode, variants, run_ids, judge_template, judge_run_id, winner_run_id, status, created_at, ended_at)
     VALUES (@id,@prompt,@cwd,@mode,@variants,@run_ids,@judge_template,@judge_run_id,@winner_run_id,@status,@created_at,@ended_at)`,
  ).run({
    id,
    prompt: over.prompt ?? 'seeded prompt',
    cwd: over.cwd ?? dataDir,
    mode: over.mode ?? 'best-of-n',
    variants: JSON.stringify(over.variants ?? [{ engine: 'claude' }, { engine: 'claude' }]),
    run_ids: JSON.stringify(over.runIds ?? []),
    judge_template: over.judgeTemplate ?? null,
    judge_run_id: over.judgeRunId ?? null,
    winner_run_id: over.winnerRunId ?? null,
    status: over.status ?? 'running',
    created_at: Date.now(),
    ended_at: over.endedAt ?? null,
  });
  return id;
}

function bmRow(id: string): any {
  return db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(id);
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ repo } = await import('../src/db.js'));
  db = (await import('../src/db.js')).default;
  ({ registry } = await import('../src/registry.js'));
  ({ benchmarks, sweepBenchmarksForTests } = await import('../src/benchmarks.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ───────────────────────────────────────────────────────────────────────────────
// 169-182  buildRollup — run-not-found → "unknown" rollup branch (via getDetail)
// ───────────────────────────────────────────────────────────────────────────────
describe('buildRollup — missing run yields an "unknown" rollup (169-182)', () => {
  it('returns a placeholder rollup using variant metadata when the run row is absent', async () => {
    const missingId = 'no-such-run-' + randomUUID();
    const id = insertBenchmark({
      mode: 'matrix',
      status: 'running',
      runIds: [missingId],
      variants: [{ engine: 'codex', label: 'mylabel', engineModel: 'gpt-x' }],
    });

    const res = await get(`/api/benchmarks/${id}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.rollups).toHaveLength(1);
    const r = detail.rollups[0];
    expect(r.runId).toBe(missingId);
    expect(r.label).toBe('mylabel');
    expect(r.engine).toBe('codex');
    expect(r.model).toBe('gpt-x'); // falls back to variant.engineModel
    expect(r.status).toBe('unknown');
    expect(r.costUsd).toBe(0);
    expect(r.tokensIn).toBe(0);
    expect(r.durationMs).toBeNull();
    expect(r.resultPreview).toBeNull();
    expect(r.isWinner).toBe(false);
  });

  it('falls back to a synthesized label/engine when the variant is also missing', async () => {
    const missingId = 'no-run-' + randomUUID();
    const id = insertBenchmark({
      mode: 'matrix',
      status: 'running',
      runIds: [missingId],
      variants: [], // no variant at idx 0 → variant defaults to { engine: 'claude' }
    });
    const detail = (await get(`/api/benchmarks/${id}`)).json();
    expect(detail.rollups[0].label).toBe('variant-1');
    expect(detail.rollups[0].engine).toBe('claude');
    expect(detail.rollups[0].model).toBeNull();
    expect(detail.rollups[0].status).toBe('unknown');
  });

  it('builds a full rollup from a real run row (run-present branch), marking the winner', async () => {
    const winning = makeRun({ status: 'completed', costUsd: 0.9, tokensIn: 11, tokensOut: 22, startedAt: 5, endedAt: 25, resultText: 'X'.repeat(900) });
    repo.upsertRun(winning);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'completed',
      runIds: [winning.id],
      variants: [{ engine: 'claude', label: 'real' }],
      winnerRunId: winning.id,
    });
    const detail = (await get(`/api/benchmarks/${id}`)).json();
    const r = detail.rollups[0];
    expect(r.status).toBe('completed');
    expect(r.costUsd).toBe(0.9);
    expect(r.durationMs).toBe(20); // endedAt - startedAt
    expect(r.resultPreview.length).toBe(500); // sliced to 500
    expect(r.isWinner).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 296-303  sweep — 'judging' convergence → onJudgeDone (winner parse + finalize)
// ───────────────────────────────────────────────────────────────────────────────
describe('sweep — judging benchmark whose judge run is already terminal (296-303, 421-436)', () => {
  it('finalizes a judging benchmark and sets the winner from judge structuredOutput', async () => {
    const v1 = makeRun({ status: 'completed' });
    const v2 = makeRun({ status: 'completed' });
    repo.upsertRun(v1);
    repo.upsertRun(v2);
    const judge = makeRun({
      status: 'completed',
      structuredOutput: { winner: v1.id, reasoning: 'v1 best' },
    });
    repo.upsertRun(judge);

    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'judging',
      runIds: [v1.id, v2.id],
      judgeRunId: judge.id,
    });

    await sweepBenchmarksForTests();

    const row = bmRow(id);
    expect(row.status).toBe('completed');
    expect(row.winner_run_id).toBe(v1.id);
    expect(row.ended_at).toBeTypeOf('number');
  });

  it('finalizes judging without a winner when structuredOutput.winner is not a known run id', async () => {
    const v1 = makeRun({ status: 'completed' });
    repo.upsertRun(v1);
    const judge = makeRun({ status: 'completed', structuredOutput: { winner: 'not-a-variant', reasoning: 'x' } });
    repo.upsertRun(judge);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'judging',
      runIds: [v1.id],
      judgeRunId: judge.id,
    });
    await sweepBenchmarksForTests();
    const row = bmRow(id);
    expect(row.status).toBe('completed');
    expect(row.winner_run_id).toBeNull(); // winner not in runIds → ignored
  });

  it('does NOT finalize a judging benchmark while the judge run is still non-terminal', async () => {
    const judge = makeRun({ status: 'running', endedAt: null });
    repo.upsertRun(judge);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'judging',
      runIds: [makeRunId()],
      judgeRunId: judge.id,
    });
    await sweepBenchmarksForTests();
    expect(bmRow(id).status).toBe('judging'); // judge not terminal → untouched
  });
});

function makeRunId(): string {
  const r = makeRun({ status: 'completed' });
  repo.upsertRun(r);
  return r.id;
}

// ───────────────────────────────────────────────────────────────────────────────
// 351-362  checkVariantsComplete — all-killed / all-failed finalize (best-of-n, no judge)
//   driven through the sweep ('running' benchmark, all variants terminal, none completed)
// ───────────────────────────────────────────────────────────────────────────────
describe('checkVariantsComplete via sweep — no judge when no variant completed (351-362)', () => {
  it('marks best-of-n killed when every variant was killed', async () => {
    const v1 = makeRun({ status: 'killed', killReason: 'user' });
    const v2 = makeRun({ status: 'killed', killReason: 'user' });
    repo.upsertRun(v1);
    repo.upsertRun(v2);
    const id = insertBenchmark({ mode: 'best-of-n', status: 'running', runIds: [v1.id, v2.id] });

    await sweepBenchmarksForTests();

    const row = bmRow(id);
    expect(row.status).toBe('killed');
    expect(row.judge_run_id).toBeNull(); // no judge launched
    expect(row.ended_at).toBeTypeOf('number');
  });

  it('marks best-of-n failed when variants are a mix of failed (and not all killed)', async () => {
    const v1 = makeRun({ status: 'failed' });
    const v2 = makeRun({ status: 'killed' });
    repo.upsertRun(v1);
    repo.upsertRun(v2);
    const id = insertBenchmark({ mode: 'best-of-n', status: 'running', runIds: [v1.id, v2.id] });

    await sweepBenchmarksForTests();

    const row = bmRow(id);
    expect(row.status).toBe('failed'); // not allKilled → 'failed'
    expect(row.judge_run_id).toBeNull();
  });

  it('marks matrix completed when all variants terminal (no judge path)', async () => {
    const v1 = makeRun({ status: 'completed' });
    const v2 = makeRun({ status: 'failed' });
    repo.upsertRun(v1);
    repo.upsertRun(v2);
    const id = insertBenchmark({ mode: 'matrix', status: 'running', runIds: [v1.id, v2.id] });

    await sweepBenchmarksForTests();

    const row = bmRow(id);
    expect(row.status).toBe('completed');
    expect(row.judge_run_id).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 364-413  launchJudge — template resolution + successful judge launch (best-of-n)
//   driven through the sweep with one completed variant; the fake bin runs the judge
// ───────────────────────────────────────────────────────────────────────────────
describe('launchJudge via sweep — resolves a named judge template and launches a judge run (364-413)', () => {
  it('launches a judge (status → judging) using the named template profile', async () => {
    // seed a judge template that launchJudge will resolve (364-384)
    repo.upsertTemplate({
      id: randomUUID(),
      name: 'JudgeTmpl',
      role: 'reviewer',
      description: 'judge',
      systemPrompt: 'be fair',
      model: 'claude-opus-4-8',
      fastMode: false,
      effort: 'high',
      allowedTools: [],
      skills: [],
      permissionMode: 'default',
      budgetUsd: 0.5,
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const v1 = makeRun({ status: 'completed', resultText: 'the better answer' });
    const v2 = makeRun({ status: 'failed' });
    repo.upsertRun(v1);
    repo.upsertRun(v2);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'running',
      runIds: [v1.id, v2.id],
      judgeTemplate: 'JudgeTmpl',
    });

    // BENCH_WINNER_RUN_ID is unset → fake judge bin completes without a structured winner.
    await sweepBenchmarksForTests();

    // After the sweep, launchJudge ran registry.launch (fake bin) and persisted a judgeRunId.
    const row = bmRow(id);
    expect(row.judge_run_id).toBeTruthy();
    // status is 'judging' immediately after launch (may already be 'completed' once the
    // fake judge run's terminal event fires) — both prove the judge was launched.
    expect(['judging', 'completed']).toContain(row.status);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 417-418  launchJudge catch — registry.launch throws → benchmark stays 'running'
// ───────────────────────────────────────────────────────────────────────────────
describe('launchJudge catch — judge launch failure leaves benchmark running (417-418)', () => {
  it('swallows a launch error and does not set judgeRunId/status', async () => {
    const v1 = makeRun({ status: 'completed' });
    const v2 = makeRun({ status: 'completed' });
    repo.upsertRun(v1);
    repo.upsertRun(v2);
    const id = insertBenchmark({ mode: 'best-of-n', status: 'running', runIds: [v1.id, v2.id] });

    const origLaunch = registry.launch.bind(registry);
    (registry as any).launch = () => {
      throw Object.assign(new Error('daily-cap reached'), { statusCode: 409 });
    };
    try {
      await sweepBenchmarksForTests();
    } finally {
      (registry as any).launch = origLaunch;
    }

    const row = bmRow(id);
    expect(row.status).toBe('running'); // judge launch failed → left running for retry
    expect(row.judge_run_id).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 438-448  create — validation branches (prompt / cwd / mode / variant bounds)
// ───────────────────────────────────────────────────────────────────────────────
describe('create — validation (438-448) via engine.create + POST route', () => {
  it('throws 400 when prompt is missing/blank', async () => {
    await expect(
      benchmarks.create({ prompt: '   ', cwd: dataDir, mode: 'matrix', variants: [{ engine: 'claude' }, { engine: 'claude' }] }),
    ).rejects.toMatchObject({ statusCode: 400, message: /prompt is required/ });
  });

  it('throws 400 when cwd is missing/blank', async () => {
    await expect(
      benchmarks.create({ prompt: 'hi', cwd: '', mode: 'matrix', variants: [{ engine: 'claude' }, { engine: 'claude' }] }),
    ).rejects.toMatchObject({ statusCode: 400, message: /cwd is required/ });
  });

  it('throws 400 when mode is not matrix|best-of-n', async () => {
    await expect(
      benchmarks.create({ prompt: 'hi', cwd: dataDir, mode: 'bogus' as any, variants: [{ engine: 'claude' }, { engine: 'claude' }] }),
    ).rejects.toMatchObject({ statusCode: 400, message: /matrix or best-of-n/ });
  });

  it('route maps create validation errors to the right status code + error body', async () => {
    const res = await post('/api/benchmarks', { prompt: '', cwd: dataDir, mode: 'matrix', variants: [{ engine: 'claude' }, { engine: 'claude' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/prompt is required/);
  });

  it('throws 400 when variants is not an array / out of the 2–4 bound (449-451)', async () => {
    await expect(
      benchmarks.create({ prompt: 'hi', cwd: dataDir, mode: 'matrix', variants: 'nope' as any }),
    ).rejects.toMatchObject({ statusCode: 400, message: /2.{0,20}4/ });
    await expect(
      benchmarks.create({ prompt: 'hi', cwd: dataDir, mode: 'matrix', variants: [{ engine: 'claude' }] }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      benchmarks.create({
        prompt: 'hi', cwd: dataDir, mode: 'matrix',
        variants: [{ engine: 'claude' }, { engine: 'claude' }, { engine: 'claude' }, { engine: 'claude' }, { engine: 'claude' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 for an unknown engine (453-455)', async () => {
    await expect(
      benchmarks.create({ prompt: 'hi', cwd: dataDir, mode: 'matrix', variants: [{ engine: 'claude' }, { engine: 'gpt-99' as any }] }),
    ).rejects.toMatchObject({ statusCode: 400, message: /engine must be one of/ });
  });

  it('throws 400 for a known-but-disabled engine add-on (456-461)', async () => {
    const { setAddonEnabledById, isEngineEnabled } = await import('../src/addons.js');
    // ensure opencode is disabled, then assert the not-enabled branch fires
    try { await setAddonEnabledById('opencode', false); } catch { /* row may not exist */ }
    if (!isEngineEnabled('opencode')) {
      await expect(
        benchmarks.create({ prompt: 'hi', cwd: dataDir, mode: 'matrix', variants: [{ engine: 'claude' }, { engine: 'opencode' }] }),
      ).rejects.toMatchObject({ statusCode: 400, message: /not enabled/ });
    }
  });

  it('throws 400 for an unknown judgeTemplate in best-of-n (463-468)', async () => {
    await expect(
      benchmarks.create({
        prompt: 'hi', cwd: dataDir, mode: 'best-of-n',
        variants: [{ engine: 'claude' }, { engine: 'claude' }],
        judgeTemplate: 'NoSuchTemplateXYZ',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: /judgeTemplate.*not found/ });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 504-526  create — engine (non-claude) launch branch + atomic-abort stop loop
// ───────────────────────────────────────────────────────────────────────────────
describe('create — engine variant launch + atomic abort (504-526)', () => {
  it('launches a non-claude engine variant via registry.launchEngine and persists run ids', async () => {
    const { setAddonEnabledById } = await import('../src/addons.js');
    // enable the codex engine add-on so the v.engine !== claude validation passes
    let enabled = false;
    try {
      await setAddonEnabledById('codex', true);
      enabled = true;
    } catch { /* if the addon row isn't seeded we stub isEngineEnabled-independent path below */ }

    const { isEngineEnabled } = await import('../src/addons.js');
    if (!isEngineEnabled('codex')) {
      // Skip the strict assert path but still exercise the engine branch by stubbing
      // launchEngine; we cannot bypass the enabled check, so require it.
      expect(enabled).toBe(true);
    }

    const origLaunchEngine = registry.launchEngine.bind(registry);
    const seeded = makeRun({ engine: 'codex', status: 'running', endedAt: null });
    repo.upsertRun(seeded);
    let engineCalls = 0;
    (registry as any).launchEngine = async (opts: any) => {
      engineCalls++;
      expect(opts.engine).toBe('codex');
      expect(opts.prompt).toBe('engine path prompt');
      return seeded;
    };
    try {
      const b = await benchmarks.create({
        prompt: 'engine path prompt',
        cwd: dataDir,
        mode: 'matrix',
        variants: [{ engine: 'codex', engineModel: 'gpt-x' }, { engine: 'codex' }],
      });
      expect(engineCalls).toBe(2);
      expect(b.runIds).toHaveLength(2);
      expect(b.runIds[0]).toBe(seeded.id);
      // persisted
      expect(bmRow(b.id).run_ids).toBe(JSON.stringify([seeded.id, seeded.id]));
    } finally {
      (registry as any).launchEngine = origLaunchEngine;
    }
  });

  it('atomic abort: a blocked second variant stops the launched first and rethrows the original code (518-535)', async () => {
    const origLaunch = registry.launch.bind(registry);
    const first = makeRun({ status: 'running', endedAt: null });
    let call = 0;
    let stopped: string | null = null;
    const origStop = registry.stop.bind(registry);
    (registry as any).launch = async () => {
      call++;
      if (call === 1) {
        repo.upsertRun(first);
        return first;
      }
      throw Object.assign(new Error('concurrency cap reached'), { statusCode: 429, code: 'cap' });
    };
    (registry as any).stop = (id: string) => { stopped = id; };
    try {
      await expect(
        benchmarks.create({
          prompt: 'atomic abort test',
          cwd: dataDir,
          mode: 'matrix',
          variants: [{ engine: 'claude' }, { engine: 'claude' }],
        }),
      ).rejects.toMatchObject({ statusCode: 429, code: 'cap', message: /aborted \(atomic\)/ });
      expect(call).toBe(2);
      expect(stopped).toBe(first.id); // launched first variant was stopped
    } finally {
      (registry as any).launch = origLaunch;
      (registry as any).stop = origStop;
    }
  });

  it('atomic abort swallows a throwing registry.stop while aborting (524-526)', async () => {
    const origLaunch = registry.launch.bind(registry);
    const origStop = registry.stop.bind(registry);
    const first = makeRun({ status: 'running', endedAt: null });
    let call = 0;
    (registry as any).launch = async () => {
      call++;
      if (call === 1) { repo.upsertRun(first); return first; }
      throw Object.assign(new Error('daily cap'), { statusCode: 409, code: 'daily-cap' });
    };
    (registry as any).stop = () => { throw new Error('stop boom'); };
    try {
      await expect(
        benchmarks.create({
          prompt: 'atomic abort + stop throws',
          cwd: dataDir,
          mode: 'matrix',
          variants: [{ engine: 'claude' }, { engine: 'claude' }],
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'daily-cap', message: /aborted \(atomic\)/ });
      expect(call).toBe(2); // the throwing stop did not abort the create rejection
    } finally {
      (registry as any).launch = origLaunch;
      (registry as any).stop = origStop;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 580-593  kill — stops a live judge run (and live variant runs)
// ───────────────────────────────────────────────────────────────────────────────
describe('kill — stops live variant + judge runs (558-593)', () => {
  it('persists killed and calls registry.stop for the non-terminal variant and judge runs', async () => {
    const variant = makeRun({ status: 'running', endedAt: null });
    const judge = makeRun({ status: 'running', endedAt: null });
    repo.upsertRun(variant);
    repo.upsertRun(judge);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'judging',
      runIds: [variant.id],
      judgeRunId: judge.id,
    });

    const stopped: string[] = [];
    const origStop = registry.stop.bind(registry);
    (registry as any).stop = (rid: string) => { stopped.push(rid); };
    try {
      benchmarks.kill(id);
    } finally {
      (registry as any).stop = origStop;
    }

    const row = bmRow(id);
    expect(row.status).toBe('killed');
    expect(row.ended_at).toBeTypeOf('number');
    expect(stopped).toContain(variant.id); // live variant stopped (573-582)
    expect(stopped).toContain(judge.id); // live judge stopped (584-593)
  });

  it('does not stop already-terminal variant/judge runs', async () => {
    const variant = makeRun({ status: 'completed' });
    const judge = makeRun({ status: 'completed' });
    repo.upsertRun(variant);
    repo.upsertRun(judge);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'judging',
      runIds: [variant.id],
      judgeRunId: judge.id,
    });
    const stopped: string[] = [];
    const origStop = registry.stop.bind(registry);
    (registry as any).stop = (rid: string) => { stopped.push(rid); };
    try {
      benchmarks.kill(id);
    } finally {
      (registry as any).stop = origStop;
    }
    expect(bmRow(id).status).toBe('killed');
    expect(stopped).toHaveLength(0); // both already terminal → no stop calls
  });

  it('is a no-op for an already-completed benchmark and throws 404 for unknown id', () => {
    const id = insertBenchmark({ mode: 'matrix', status: 'completed', endedAt: Date.now() });
    expect(() => benchmarks.kill(id)).not.toThrow();
    expect(bmRow(id).status).toBe('completed'); // unchanged

    expect(() => benchmarks.kill('does-not-exist')).toThrow(/not found/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 580-593  kill — registry.stop throwing is swallowed (best-effort catch 580, 591)
// ───────────────────────────────────────────────────────────────────────────────
describe('kill — registry.stop throwing is swallowed (580, 591)', () => {
  it('still persists killed even when stopping the variant and judge runs throws', () => {
    const variant = makeRun({ status: 'running', endedAt: null });
    const judge = makeRun({ status: 'running', endedAt: null });
    repo.upsertRun(variant);
    repo.upsertRun(judge);
    const id = insertBenchmark({
      mode: 'best-of-n',
      status: 'judging',
      runIds: [variant.id],
      judgeRunId: judge.id,
    });
    const origStop = registry.stop.bind(registry);
    (registry as any).stop = () => { throw new Error('stop boom'); };
    try {
      expect(() => benchmarks.kill(id)).not.toThrow();
    } finally {
      (registry as any).stop = origStop;
    }
    expect(bmRow(id).status).toBe('killed');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 311-323 / 612 / 620 / 550-551  successful create route + live terminal event + list
// ───────────────────────────────────────────────────────────────────────────────
describe('POST create (success) + live terminal handler + list (311-323, 550-551, 609-620)', () => {
  it('creates a real benchmark via the route, drives it to completion via the live terminal handler, and lists it', async () => {
    // Real fake-bin launch: two claude variants exit 0 immediately. The registry fires
    // onRunTerminal → handleRunTerminal (311-323) → checkVariantsComplete → matrix completes.
    const res = await post('/api/benchmarks', {
      prompt: 'live matrix run',
      cwd: dataDir,
      mode: 'matrix',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8', label: 'a' },
        { engine: 'claude', model: 'claude-haiku-4-5', label: 'b' },
      ],
    });
    expect(res.statusCode).toBe(200); // 609-616 success return (612)
    const bm = res.json();
    expect(bm.runIds).toHaveLength(2);

    // wait for the live terminal handler to converge the benchmark to 'completed'
    const deadline = Date.now() + 8000;
    let status = bm.status;
    while (Date.now() < deadline) {
      status = (await get(`/api/benchmarks/${bm.id}`)).json().status;
      if (status === 'completed') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(status).toBe('completed');

    // list route exercises engine.list() / listBenchmarks (550-551, 619-620)
    const listRes = await get('/api/benchmarks');
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((b: any) => b.id === bm.id && b.status === 'completed')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 626-628  GET /api/benchmarks/:id → 404 when not found
// ───────────────────────────────────────────────────────────────────────────────
describe('GET /api/benchmarks/:id — 404 (626-628)', () => {
  it('returns 404 with an error body for an unknown benchmark', async () => {
    const res = await get('/api/benchmarks/does-not-exist-' + randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not found');
  });

  it('DELETE returns 404 for an unknown benchmark (kill 404 → route)', async () => {
    const res = await del('/api/benchmarks/missing-' + randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });
});
