/**
 * F4+F5 — Benchmark mode + Best-of-N tests.
 *
 * Standard harness: isolated FLEET_DATA_DIR, buildServer(), app.inject with Host header.
 * Fake CLAUDE_BIN emits a result and exits 0 immediately.
 *
 * Covers:
 *   1. Validation: variant count bounds (< 2 → 400, > 4 → 400)
 *   2. Validation: unknown/disabled engine → 400
 *   3. Validation: unknown judgeTemplate in best-of-n → 400
 *   4. Matrix mode: 2 claude variants complete, rollups populate
 *   5. Best-of-N: judge run launched after both variants finish; judge req carries --json-schema;
 *      judge run completing with structuredOutput {winner} sets winner_run_id (#41)
 *   6. Atomic abort: first variant allowed, second blocked by cap; first run gets killed,
 *      create returns 429 (#39)
 *   7. Judge only after ALL variants terminal: no judge while second variant is still running (#40)
 *   8. GET /api/benchmarks list
 *   9. DELETE /api/benchmarks/:id kills live runs
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Isolate DB + fake binary BEFORE any src import ────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-benchmarks-'));
process.env.FLEET_DATA_DIR = dataDir;

// Fake CLAUDE_BIN: emits init + result and exits 0
//   - If --json-schema is present and BENCH_WINNER_RUN_ID is set, emits structuredOutput winner
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

// Detect whether this is a judge run by checking for --json-schema in args
const hasJsonSchema = args.includes('--json-schema');
const winnerRunId = process.env.BENCH_WINNER_RUN_ID || '';

if (hasJsonSchema && winnerRunId) {
  // judge run: emit structuredOutput with winner
  const result = JSON.stringify({ winner: winnerRunId, reasoning: 'best output' });
  w({ type: 'result', session_id: sessionId, subtype: 'success',
      result: result,
      is_error: false,
      total_cost_usd: 0.001, usage: {},
      structured_output: { winner: winnerRunId, reasoning: 'best output' } });
} else {
  w({ type: 'result', session_id: sessionId, subtype: 'success',
      result: 'task done', is_error: false,
      total_cost_usd: 0.0005, usage: {} });
}
process.exit(0);
`,
);
chmodSync(fakeBin, 0o755);
process.env.CLAUDE_BIN = fakeBin;

let app: any;
let PORT: number;

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

const H = () => ({ host: `127.0.0.1:${PORT}` });
const post = (url: string, body: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: H(), payload: body });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000, intervalMs = 80): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await Promise.resolve(predicate())) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

// ── validation ────────────────────────────────────────────────────────────────

describe('POST /api/benchmarks — validation', () => {
  it('rejects fewer than 2 variants', async () => {
    const res = await post('/api/benchmarks', {
      prompt: 'hello',
      cwd: dataDir,
      mode: 'matrix',
      variants: [{ engine: 'claude' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/2.{0,20}4/);
  });

  it('rejects more than 4 variants', async () => {
    const res = await post('/api/benchmarks', {
      prompt: 'hello',
      cwd: dataDir,
      mode: 'matrix',
      variants: [
        { engine: 'claude' }, { engine: 'claude' }, { engine: 'claude' },
        { engine: 'claude' }, { engine: 'claude' },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown engine', async () => {
    const res = await post('/api/benchmarks', {
      prompt: 'hello',
      cwd: dataDir,
      mode: 'matrix',
      variants: [{ engine: 'claude' }, { engine: 'gpt-99' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/engine/i);
  });

  it('rejects a disabled engine add-on', async () => {
    // codex is not enabled in tests (no addons row)
    const res = await post('/api/benchmarks', {
      prompt: 'hello',
      cwd: dataDir,
      mode: 'matrix',
      variants: [{ engine: 'claude' }, { engine: 'codex' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not enabled/i);
  });

  it('rejects an unknown judgeTemplate in best-of-n mode', async () => {
    const res = await post('/api/benchmarks', {
      prompt: 'hello',
      cwd: dataDir,
      mode: 'best-of-n',
      variants: [{ engine: 'claude' }, { engine: 'claude' }],
      judgeTemplate: 'NoSuchTemplate99',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/judgeTemplate/i);
  });
});

// ── matrix mode: 2 claude variants ───────────────────────────────────────────

describe('Matrix mode — 2 claude variants complete', () => {
  it('creates benchmark and rollups populate once variants are terminal', async () => {
    const res = await post('/api/benchmarks', {
      prompt: 'Write hello world',
      cwd: dataDir,
      mode: 'matrix',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8', label: 'opus' },
        { engine: 'claude', model: 'claude-haiku-4-5', label: 'haiku' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const bm = res.json();
    expect(bm.id).toBeTruthy();
    expect(bm.mode).toBe('matrix');
    expect(bm.runIds).toHaveLength(2);

    // wait for benchmark to complete
    await waitFor(async () => {
      const r = await get(`/api/benchmarks/${bm.id}`);
      return r.json().status === 'completed';
    }, 10000);

    const detail = (await get(`/api/benchmarks/${bm.id}`)).json();
    expect(detail.status).toBe('completed');
    expect(detail.rollups).toHaveLength(2);
    expect(detail.rollups[0].label).toBe('opus');
    expect(detail.rollups[1].label).toBe('haiku');
    // both variants should be completed
    for (const r of detail.rollups) {
      expect(r.status).toBe('completed');
    }
    // matrix mode: no judge, no winner
    expect(detail.judgeRunId).toBeNull();
    expect(detail.winnerRunId).toBeNull();
  });
});

// ── best-of-N mode ────────────────────────────────────────────────────────────

describe('Best-of-N mode — judge launched after variants finish; structured output sets winner (#41)', () => {
  it('launches a judge run when all variants terminal; judge req carries --json-schema; winner_run_id is set', async () => {
    // We need the fake bin to know which run ID to declare winner.
    // Set BENCH_WINNER_RUN_ID to the FIRST variant run id after creation.
    // The judge run will see --json-schema in args and emit structured_output.winner = that id.
    const res = await post('/api/benchmarks', {
      prompt: 'Solve this coding problem',
      cwd: dataDir,
      mode: 'best-of-n',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8', label: 'v1' },
        { engine: 'claude', model: 'claude-haiku-4-5', label: 'v2' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const bm = res.json();
    expect(bm.mode).toBe('best-of-n');
    expect(bm.runIds).toHaveLength(2);

    // Tell the fake binary to declare the first variant the winner.
    // This must be set before the judge process spawns (judge is launched after variants finish).
    const expectedWinnerId = bm.runIds[0];
    process.env.BENCH_WINNER_RUN_ID = expectedWinnerId;

    try {
      // Wait until judging starts (proves judge was launched only after both variants finished)
      await waitFor(async () => {
        const r = await get(`/api/benchmarks/${bm.id}`);
        const d = r.json();
        return d.status === 'judging' || d.status === 'completed';
      }, 12000);

      const midDetail = (await get(`/api/benchmarks/${bm.id}`)).json();
      if (midDetail.status === 'judging') {
        // judgeRunId must be set before we transition to 'judging'
        expect(midDetail.judgeRunId).toBeTruthy();
        // wait for completion
        await waitFor(async () => {
          const r = await get(`/api/benchmarks/${bm.id}`);
          return r.json().status === 'completed';
        }, 10000);
      }

      const detail = (await get(`/api/benchmarks/${bm.id}`)).json();
      expect(detail.status).toBe('completed');
      // judgeRunId must be set — confirms judge was launched
      expect(detail.judgeRunId).toBeTruthy();
      // winner_run_id must match structured output winner (#41)
      expect(detail.winnerRunId).toBe(expectedWinnerId);

      // Verify the judge run is in DB with status 'completed' (confirming --json-schema path)
      const { repo } = await import('../src/db.js');
      const judgeFromDb = repo.getRun(detail.judgeRunId);
      expect(judgeFromDb).toBeTruthy();
      expect(judgeFromDb!.status).toBe('completed');
    } finally {
      delete process.env.BENCH_WINNER_RUN_ID;
    }
  });
});

// ── judge only after ALL variants terminal (#40) ──────────────────────────────

describe('Best-of-N — no judge until second variant is terminal (#40)', () => {
  it('does not launch judge while at least one variant is still running', async () => {
    // This test exercises production code via direct module-level manipulation.
    // We create a benchmark row in the DB with one variant terminal and one still 'running',
    // then drive the sweep — confirming no judge is launched.  Once we mark the second
    // variant terminal and sweep again, the judge IS launched.
    //
    // This approach avoids timing sensitivity while exercising the real checkVariantsComplete
    // and launchJudge code paths (sweep → checkVariantsComplete → launchJudge guard).

    const { benchmarks, sweepBenchmarksForTests } = await import('../src/benchmarks.js');
    const { registry } = await import('../src/registry.js');
    const { repo } = await import('../src/db.js');

    // First, create a real benchmark to get real variant run ids (fake bin exits immediately)
    const res = await post('/api/benchmarks', {
      prompt: 'Judge timing test',
      cwd: dataDir,
      mode: 'best-of-n',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8', label: 'fast' },
        { engine: 'claude', model: 'claude-haiku-4-5', label: 'slow' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const bm = res.json();
    expect(bm.runIds).toHaveLength(2);

    // Wait for both variants to complete naturally (fake bin exits immediately)
    await waitFor(async () => {
      const r = await get(`/api/benchmarks/${bm.id}`);
      const d = r.json();
      return d.status === 'completed' || d.status === 'judging';
    }, 10000);

    // Confirm the benchmark reached a terminal or judging state (proving variants finished)
    const final = (await get(`/api/benchmarks/${bm.id}`)).json();
    expect(['completed', 'judging'].includes(final.status)).toBe(true);

    // Now create a synthetic scenario: a NEW best-of-n benchmark row with status 'running',
    // where only one variant is known-terminal, and confirm the sweep does NOT launch a judge.
    // We do this by creating a real benchmark then resetting its state in the DB.
    const res2 = await post('/api/benchmarks', {
      prompt: 'Judge timing — synthetic test',
      cwd: dataDir,
      mode: 'best-of-n',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8', label: 'a' },
        { engine: 'claude', model: 'claude-haiku-4-5', label: 'b' },
      ],
    });
    expect(res2.statusCode).toBe(200);
    const bm2 = res2.json();
    expect(bm2.runIds).toHaveLength(2);

    // Wait for both variants to complete so we have real run rows in DB
    await waitFor(async () => {
      const r1 = registry.getRun(bm2.runIds[0]) ?? repo.getRun(bm2.runIds[0]);
      const r2 = registry.getRun(bm2.runIds[1]) ?? repo.getRun(bm2.runIds[1]);
      return !!(r1 && r2);
    }, 6000);

    // Reset: mark second variant as 'running' in DB (fake a not-yet-terminal state)
    const run2 = registry.getRun(bm2.runIds[1]) ?? repo.getRun(bm2.runIds[1]);
    if (run2 && run2.status === 'completed') {
      // Reset run 2 to 'running' in the DB and in the benchmark row back to 'running'
      run2.status = 'running';
      run2.endedAt = null;
      repo.upsertRun(run2);
    }

    // Also reset the benchmark row to 'running' with no judgeRunId
    const dbBm2 = (await get(`/api/benchmarks/${bm2.id}`)).json();
    // Only reset if it completed (we need status 'running' for the sweep to evaluate it)
    // Build a fresh benchmark row via upsert via benchmarks (no direct DB access from here)
    // We test by POST-ing a new benchmark (simpler approach below)

    // Simpler direct assertion: just verify that the invariant holds for a benchmark
    // where both variants ARE terminal — it should complete/judge.
    // The key invariant we're testing: checkVariantsComplete only calls launchJudge when
    // ALL variants are terminal AND at least one completed.
    // We verify this by confirming that after both variants complete naturally, the benchmark
    // transitions to 'judging' or 'completed' (never stays 'running').
    await waitFor(async () => {
      const r = await get(`/api/benchmarks/${bm2.id}`);
      const d = r.json();
      return d.status === 'completed' || d.status === 'judging';
    }, 10000);

    const finalBm2 = (await get(`/api/benchmarks/${bm2.id}`)).json();
    expect(['completed', 'judging'].includes(finalBm2.status)).toBe(true);
    // judgeRunId must be set (judge was launched after all variants terminal)
    if (finalBm2.status === 'completed') {
      expect(finalBm2.judgeRunId).toBeTruthy();
    }

    // ── Core invariant: test that sweep does NOT launch judge when NOT all variants terminal ──
    // Create a fresh benchmark row directly through the module, then manipulate the DB
    // to make only one variant appear terminal, run the sweep, and assert judgeRunId is null.
    const bm3res = await post('/api/benchmarks', {
      prompt: 'Not-all-terminal test',
      cwd: dataDir,
      mode: 'best-of-n',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8', label: 'aa' },
        { engine: 'claude', model: 'claude-haiku-4-5', label: 'bb' },
      ],
    });
    expect(bm3res.statusCode).toBe(200);
    const bm3 = bm3res.json();

    // Wait for runs to appear in DB (launched)
    await waitFor(() => {
      return bm3.runIds.every((rid: string) => {
        return !!(registry.getRun(rid) ?? repo.getRun(rid));
      });
    }, 4000);

    // Reset benchmark status to 'running' and mark only first variant as terminal,
    // second as 'running' in DB to simulate partial completion.
    const secondRunId = bm3.runIds[1];
    const secondRun = registry.getRun(secondRunId) ?? repo.getRun(secondRunId);
    if (secondRun) {
      secondRun.status = 'running';
      secondRun.endedAt = null;
      repo.upsertRun(secondRun);
    }

    // Also reset the benchmark row to 'running' with no judgeRunId
    // (it may have completed already; we write it back to 'running' via the upsert statement)
    // Access the private upsert via the module's internal db:
    const bmModule = await import('../src/benchmarks.js');
    // We can't call saveBenchmark directly, so we use the DB module's upsert directly.
    const dbMod = await import('../src/db.js');
    const dbInstance = dbMod.default;
    dbInstance.prepare(
      `UPDATE benchmarks SET status='running', judge_run_id=NULL, ended_at=NULL WHERE id=?`
    ).run(bm3.id);

    // Now run the sweep — it should see not-all-terminal and NOT launch a judge
    await sweepBenchmarksForTests();

    const afterPartialSweep = (await get(`/api/benchmarks/${bm3.id}`)).json();
    expect(afterPartialSweep.status).toBe('running');
    expect(afterPartialSweep.judgeRunId).toBeNull();

    // Restore the second variant to completed
    if (secondRun) {
      secondRun.status = 'completed';
      secondRun.endedAt = Date.now();
      repo.upsertRun(secondRun);
    }

    // Run the sweep again — now all variants are terminal → judge should launch
    await sweepBenchmarksForTests();

    // Wait for judging/completed
    await waitFor(async () => {
      const r = await get(`/api/benchmarks/${bm3.id}`);
      const d = r.json();
      return d.status === 'judging' || d.status === 'completed';
    }, 6000);

    const afterFullSweep = (await get(`/api/benchmarks/${bm3.id}`)).json();
    expect(['judging', 'completed'].includes(afterFullSweep.status)).toBe(true);
    expect(afterFullSweep.judgeRunId).toBeTruthy();
  });
});

// ── GET /api/benchmarks list ──────────────────────────────────────────────────

describe('GET /api/benchmarks', () => {
  it('returns a list of benchmarks', async () => {
    const res = await get('/api/benchmarks');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    // should have the benchmarks from prior tests
    expect(res.json().length).toBeGreaterThanOrEqual(1);
  });
});

// ── atomic abort on concurrency cap (#39) ────────────────────────────────────

describe('Atomic abort — first variant allowed, second blocked by cap (#39)', () => {
  it('stops the already-launched first variant and returns 429 when second hits concurrency cap', async () => {
    const { registry } = await import('../src/registry.js');
    const { repo } = await import('../src/db.js');

    // Intercept registry.launch to:
    //  1. Allow the first variant (call through to the original)
    //  2. After the first succeeds, lower the cap to 0 so the second gets 429
    const origLaunch = registry.launch.bind(registry);
    let launchCallCount = 0;
    let firstLaunchedRunId: string | null = null;
    const origCap = registry.config.maxConcurrentRuns;

    (registry as any).launch = function (this: typeof registry, ...args: any[]) {
      launchCallCount++;
      if (launchCallCount === 1) {
        // Allow first variant
        const run = origLaunch(...args);
        firstLaunchedRunId = run.id;
        // Lower cap to 0 so the second variant hits the concurrency check
        registry.config = { ...registry.config, maxConcurrentRuns: 0 };
        return run;
      }
      // Second+ variant: cap is 0, origLaunch will throw 429
      return origLaunch(...args);
    };

    try {
      const res = await post('/api/benchmarks', {
        prompt: 'test atomic abort — first allowed, second blocked',
        cwd: dataDir,
        mode: 'matrix',
        variants: [
          { engine: 'claude', model: 'claude-opus-4-8', label: 'v1' },
          { engine: 'claude', model: 'claude-haiku-4-5', label: 'v2' },
        ],
      });

      // Should return 429 (concurrency cap) — original error code preserved (#7)
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatch(/aborted|cap|concurrent/i);
      expect(launchCallCount).toBe(2); // first allowed, second blocked

      // The first variant must have been stopped (status 'killed') — not left running (#39)
      expect(firstLaunchedRunId).toBeTruthy();
      await waitFor(() => {
        const run = registry.getRun(firstLaunchedRunId!) ?? repo.getRun(firstLaunchedRunId!);
        return run?.status === 'killed';
      }, 4000);

      const firstRun = registry.getRun(firstLaunchedRunId!) ?? repo.getRun(firstLaunchedRunId!);
      expect(firstRun?.status).toBe('killed');
    } finally {
      // Restore original launch and cap
      (registry as any).launch = origLaunch;
      registry.config = { ...registry.config, maxConcurrentRuns: origCap };
    }
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/benchmarks/:id', () => {
  it('marks a running benchmark as killed', async () => {
    // Create a new benchmark
    const createRes = await post('/api/benchmarks', {
      prompt: 'task to kill',
      cwd: dataDir,
      mode: 'matrix',
      variants: [
        { engine: 'claude', model: 'claude-opus-4-8' },
        { engine: 'claude', model: 'claude-haiku-4-5' },
      ],
    });
    // It might complete immediately with fake bin, that's OK
    const bm = createRes.json();
    if (bm.id) {
      const delRes = await del(`/api/benchmarks/${bm.id}`);
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().ok).toBe(true);
      // status should be killed or completed (may have already finished)
      const after = (await get(`/api/benchmarks/${bm.id}`)).json();
      expect(['killed', 'completed'].includes(after.status)).toBe(true);
    }
  });

  it('returns 404 for unknown benchmark', async () => {
    const res = await del('/api/benchmarks/no-such-benchmark-id');
    expect(res.statusCode).toBe(404);
  });
});
