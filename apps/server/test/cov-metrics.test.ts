/**
 * Real coverage tests for metrics.ts — the read-only aggregate dashboard
 * (GET /api/metrics). These SEED real run rows via repo.upsertRun with varied
 * model / effort / status / cost / tokens / started_at / ended_at, then drive the
 * REAL fastify app via buildServer().inject() and assert the computed aggregates:
 *   - totals (COUNT/SUM)                     (lines 29-43)
 *   - byModel rollup + ORDER BY costUsd DESC (lines 46-65)
 *   - byEffort rollup                        (lines 68-83)
 *   - statusCounts open-ended map            (lines 86-90)
 *   - durations p50/p95 via percentile()     (lines 14-18, 92-102)
 *   - topCost top-8 ordering                 (lines 104-111)
 *   - dailySpend day-bucketing in JS         (lines 113-130)
 *   - the `since=` window applied uniformly  (lines 22-26 + per-aggregate WHERE)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-metrics-'));

let app: any;
let PORT: number;
let repo: any;
const HOST = () => ({ host: `127.0.0.1:${PORT}` }); // satisfy the H3 host allowlist
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

// A fixed "now" used to keep every seeded started_at deterministic and inside a
// single local calendar day (so dailySpend bucketing is predictable).
const DAY0 = new Date(2026, 0, 15, 12, 0, 0, 0).getTime(); // 2026-01-15 local noon
const DAY1 = new Date(2026, 0, 16, 9, 0, 0, 0).getTime(); // 2026-01-16 local
const DAY1_KEY = '2026-01-16';
const DAY0_KEY = '2026-01-15';

function makeRun(over: Partial<any>): any {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    sessionId: 's',
    task: 'task',
    cwd: '/tmp',
    model: 'opus',
    engine: undefined,
    fastMode: false,
    effort: 'high',
    workflowsEnabled: true,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'completed',
    startedAt: DAY0,
    endedAt: DAY0 + 1000,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    exitCode: 0,
    killReason: null,
    error: null,
    budgetUsd: null,
    permissionMode: 'default',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: null,
    structuredOutput: null,
    pid: null,
    retryOf: null,
    archivedAt: null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: DAY0,
    ...over,
  };
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const dbmod = await import('../src/db.js');
  repo = dbmod.repo;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();

  // ── Seed a deterministic fleet of terminal runs ─────────────────────────────
  // Models: opus (2 runs, high cost), sonnet (1 run, low cost). byModel ORDER BY costUsd DESC
  // Efforts: high (2 runs), medium (1). Status: completed x2, failed x1.
  // Durations (ended-started ms): 1000, 5000, 9000  → p50 idx floor(.5*2)=1 →5000, p95 idx floor(.95*2)=1 →5000.
  // Costs: 7.5, 2.5, 1.0 → topCost order opus-high, opus-med? -> sort by cost desc.
  repo.upsertRun(
    makeRun({
      id: 'run-opus-a',
      task: 'expensive-opus',
      model: 'opus',
      effort: 'high',
      status: 'completed',
      costUsd: 7.5,
      tokensIn: 100,
      tokensOut: 200,
      startedAt: DAY0,
      endedAt: DAY0 + 1000, // 1s
    }),
  );
  repo.upsertRun(
    makeRun({
      id: 'run-opus-b',
      task: 'mid-opus',
      model: 'opus',
      effort: 'medium',
      status: 'failed',
      costUsd: 2.5,
      tokensIn: 50,
      tokensOut: 60,
      startedAt: DAY0 + 60_000,
      endedAt: DAY0 + 60_000 + 9000, // 9s
    }),
  );
  repo.upsertRun(
    makeRun({
      id: 'run-sonnet-c',
      task: 'cheap-sonnet',
      model: 'sonnet',
      effort: 'high',
      status: 'completed',
      costUsd: 1.0,
      tokensIn: 10,
      tokensOut: 20,
      startedAt: DAY1,
      endedAt: DAY1 + 5000, // 5s, different calendar day
    }),
  );
});

afterAll(async () => {
  await app?.close();
  try {
    rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('GET /api/metrics — seeded aggregates (no since window)', () => {
  it('totals sum COUNT/cost/tokens across all seeded runs', async () => {
    const b = (await get('/api/metrics')).json();
    expect(b.totals.runs).toBe(3);
    expect(b.totals.costUsd).toBeCloseTo(11.0, 6); // 7.5+2.5+1.0
    expect(b.totals.tokensIn).toBe(160); // 100+50+10
    expect(b.totals.tokensOut).toBe(280); // 200+60+20
  });

  it('byModel rolls up per-model and is ordered by costUsd DESC', async () => {
    const b = (await get('/api/metrics')).json();
    expect(b.byModel.map((m: any) => m.model)).toEqual(['opus', 'sonnet']); // opus 10.0 > sonnet 1.0
    const opus = b.byModel.find((m: any) => m.model === 'opus');
    expect(opus.runs).toBe(2);
    expect(opus.costUsd).toBeCloseTo(10.0, 6); // 7.5 + 2.5
    expect(opus.tokensIn).toBe(150);
    expect(opus.tokensOut).toBe(260);
    const sonnet = b.byModel.find((m: any) => m.model === 'sonnet');
    expect(sonnet.runs).toBe(1);
    expect(sonnet.costUsd).toBeCloseTo(1.0, 6);
  });

  it('byEffort rolls up per-effort with cost, ordered by costUsd DESC', async () => {
    const b = (await get('/api/metrics')).json();
    // high: 7.5 + 1.0 = 8.5 (2 runs); medium: 2.5 (1 run) → high first
    expect(b.byEffort.map((e: any) => e.effort)).toEqual(['high', 'medium']);
    const high = b.byEffort.find((e: any) => e.effort === 'high');
    expect(high.runs).toBe(2);
    expect(high.costUsd).toBeCloseTo(8.5, 6);
    const medium = b.byEffort.find((e: any) => e.effort === 'medium');
    expect(medium.runs).toBe(1);
    expect(medium.costUsd).toBeCloseTo(2.5, 6);
  });

  it('statusCounts is an open-ended map keyed by real status values', async () => {
    const b = (await get('/api/metrics')).json();
    expect(b.statusCounts).toEqual({ completed: 2, failed: 1 });
  });

  it('durations computes p50/p95 from terminal run spans via percentile()', async () => {
    const b = (await get('/api/metrics')).json();
    // durations sorted: [1000, 5000, 9000]; n=3
    // p50 → idx floor(0.5*2)=1 → 5000; p95 → idx floor(0.95*2)=1 → 5000
    expect(b.durations.p50Ms).toBe(5000);
    expect(b.durations.p95Ms).toBe(5000);
  });

  it('topCost lists runs by cost_usd DESC with id/task/costUsd', async () => {
    const b = (await get('/api/metrics')).json();
    expect(b.topCost.length).toBe(3);
    expect(b.topCost.map((r: any) => r.id)).toEqual(['run-opus-a', 'run-opus-b', 'run-sonnet-c']);
    expect(b.topCost[0]).toEqual({ id: 'run-opus-a', task: 'expensive-opus', costUsd: 7.5 });
  });

  it('dailySpend buckets by local calendar day, oldest→newest, with per-day totals', async () => {
    const b = (await get('/api/metrics')).json();
    expect(b.dailySpend.map((d: any) => d.day)).toEqual([DAY0_KEY, DAY1_KEY]); // sorted ascending
    const d0 = b.dailySpend.find((d: any) => d.day === DAY0_KEY);
    expect(d0.runs).toBe(2); // run-opus-a + run-opus-b are both on DAY0
    expect(d0.costUsd).toBeCloseTo(10.0, 6);
    const d1 = b.dailySpend.find((d: any) => d.day === DAY1_KEY);
    expect(d1.runs).toBe(1);
    expect(d1.costUsd).toBeCloseTo(1.0, 6);
  });
});

describe('GET /api/metrics?since= — window applied uniformly to every aggregate', () => {
  it('a since cutoff between DAY0 and DAY1 keeps only the DAY1 (sonnet) run', async () => {
    // started_at >= cutoff → only run-sonnet-c (DAY1) survives in every aggregate.
    const cutoff = DAY0 + 3_600_000; // 1h after DAY0, well before DAY1
    const b = (await get('/api/metrics?since=' + cutoff)).json();
    expect(b.totals.runs).toBe(1);
    expect(b.totals.costUsd).toBeCloseTo(1.0, 6);
    expect(b.byModel.map((m: any) => m.model)).toEqual(['sonnet']);
    expect(b.byEffort.map((e: any) => e.effort)).toEqual(['high']);
    expect(b.statusCounts).toEqual({ completed: 1 });
    expect(b.topCost.map((r: any) => r.id)).toEqual(['run-sonnet-c']);
    expect(b.dailySpend.map((d: any) => d.day)).toEqual([DAY1_KEY]);
    // the only terminal run in-window has a 5000ms span → both percentiles 5000
    expect(b.durations.p50Ms).toBe(5000);
    expect(b.durations.p95Ms).toBe(5000);
  });

  it('a future since cutoff yields an empty/zeroed dashboard (percentile([],p)===0)', async () => {
    const b = (await get('/api/metrics?since=' + (DAY1 + 86_400_000))).json();
    expect(b.totals.runs).toBe(0);
    expect(b.totals.costUsd).toBe(0);
    expect(b.byModel).toEqual([]);
    expect(b.byEffort).toEqual([]);
    expect(b.statusCounts).toEqual({});
    expect(b.topCost).toEqual([]);
    expect(b.dailySpend).toEqual([]);
    // no terminal rows → percentile() short-circuits the n===0 branch (line 16) → 0
    expect(b.durations).toEqual({ p50Ms: 0, p95Ms: 0 });
  });

  it('a non-numeric since= is ignored (Number.isFinite=false → no WHERE)', async () => {
    const b = (await get('/api/metrics?since=not-a-number')).json();
    expect(b.totals.runs).toBe(3); // full unfiltered fleet, since param discarded
  });
});
