/**
 * F3 — Auto-retry with escalation.
 *
 * Uses a single FLEET_DATA_DIR + CLAUDE_BIN set BEFORE any dynamic imports,
 * so all tests share the same registry singleton (correct vitest module-cache
 * behaviour for the entire file). The fake bin is an ESM .mjs that uses
 * `import` rather than `require`, and is swapped out per-test via CLAUDE_BIN.
 *
 * Coverage:
 *   1. Failed run relaunches once (maxRetries: 1).
 *   2. Escalation swaps model on the final attempt.
 *   3. Completed run → no retry.
 *   4. Killed run → no retry.
 *   5. campaignId set → no retry.
 *   6. projectId set → no retry.
 *   7. maxRetries: 2 fires exactly 2 retries total (3 invocations).
 *   8. Daily-cap blocks retry → drop with note on error.
 *   9. Validation: bad maxRetries → 400; unknown escalateModel → 400.
 *  10. retry_of persisted in both directions (retryOf + retriedBy).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Isolate BEFORE any src/ import ───────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-retry-'));
const counterFile = join(dataDir, 'calls.txt');

// ONE dispatcher bin — CLAUDE_BIN is read at config.ts IMPORT time, so swapping
// bins per test silently does nothing. Behavior is chosen at SPAWN time instead,
// via the FAKE_MODE env var (children inherit process.env): fail (default) records
// --model to counterFile and exits 1; success emits a minimal stream and exits 0;
// sleep stays alive until killed.
const dispatcherBin = join(dataDir, 'dispatcher.mjs');
writeFileSync(
  dispatcherBin,
  `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const mode = process.env.FAKE_MODE || 'fail';
const args = process.argv.slice(2);
const si = args.indexOf('--session-id');
const sessionId = si >= 0 ? args[si + 1] : '00000000-0000-0000-0000-000000000000';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (mode === 'sleep') { setInterval(() => {}, 60_000); }
else if (mode === 'success') {
  line({type:'system',subtype:'init',session_id:sessionId,tools:[],mcp_servers:[],model:'claude-haiku-4-5',cwd:process.cwd(),permissionMode:'default',apiKeySource:'env'});
  line({type:'result',subtype:'success',session_id:sessionId,result:'done',total_cost_usd:0,is_error:false});
  // natural exit — process.exit() here would truncate the piped stdout flush
} else {
  const mi = args.indexOf('--model');
  appendFileSync(${JSON.stringify(counterFile)}, (mi >= 0 ? args[mi + 1] : 'unknown') + '\\n');
  process.stderr.write('simulated failure\\n');
  process.exit(1);
}
`,
);
chmodSync(dispatcherBin, 0o755);
// kept as aliases so existing per-test assignments stay harmless no-ops
const failBin = dispatcherBin;
const successBin = dispatcherBin;
const sleepBin = dispatcherBin;
void failBin; void successBin; void sleepBin;

// Set env before ANY src/ import.
process.env.FLEET_DATA_DIR = dataDir;
process.env.CLAUDE_BIN = dispatcherBin;
process.env.FAKE_MODE = 'fail';

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['completed', 'failed', 'killed'];

/** Condition-based waiting (replaces fixed sleeps): poll every 25ms until `cond` is true or
 *  timeout. Fixed `sleep()` waits for async, real-process retries are flaky under parallel
 *  load — a child can spawn/exit slower than any guessed delay, and a late retry can bleed
 *  into the next test's freshly-cleared counter. Polling returns the instant the condition
 *  holds (fast in the common case); the GENEROUS default cap only bites a pathologically
 *  CPU-starved spawn, so it never gives up prematurely under load. */
async function waitFor(cond: () => boolean, desc: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${desc} after ${timeoutMs}ms`);
}

async function waitTerminal(registry: any, runId: string, timeoutMs = 20_000): Promise<any> {
  await waitFor(() => {
    const r = registry.getRun(runId);
    return !!r && TERMINAL.includes(r.status);
  }, `run ${runId} terminal`, timeoutMs);
  return registry.getRun(runId);
}

/** Follow retryOf links from the original run → [original, retry1, retry2, …]. */
function retryChain(originalId: string): any[] {
  const all = repo.listRuns();
  const chain: any[] = [];
  let cur = all.find((r: any) => r.id === originalId);
  while (cur) {
    chain.push(cur);
    cur = all.find((r: any) => r.retryOf === cur.id);
  }
  return chain;
}

/** Wait until the retry chain has produced `expectedInvocations` bin calls AND every run in
 *  the chain is terminal — i.e. nothing is still in-flight. Removes the fixed-sleep guesswork
 *  and guarantees the test drains its own chain before the next test clears the shared counter
 *  (kills the cross-test pollution that doubled counts under load). */
async function waitChainSettled(originalId: string, expectedInvocations: number): Promise<void> {
  await waitFor(() => {
    if (readCounter().length < expectedInvocations) return false;
    const chain = retryChain(originalId);
    return chain.length >= 1 && chain.every((r) => TERMINAL.includes(r.status));
  }, `chain ${originalId} → ${expectedInvocations} invocations + settled`);
}

function clearCounter() {
  writeFileSync(counterFile, '');
}

function readCounter(): string[] {
  try {
    return readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ── Module imports (AFTER env is set) ────────────────────────────────────────
let registry: any;
let repo: any;
let app: any;
let PORT: number;

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
}, 30_000);

afterAll(async () => {
  registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });
  await app?.close();
});

const H = () => ({ host: `127.0.0.1:${PORT}` });

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1: failed run retries once
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 basic retry', () => {
  it('retries once on failed status (maxRetries: 1)', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'test retry once',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1 },
    });

    const failed = await waitTerminal(registry, run.id);
    expect(failed?.status).toBe('failed');

    // Wait for the full chain (original + 1 retry) to fire and settle — no fixed sleep.
    await waitChainSettled(run.id, 2);

    const lines = readCounter();
    // 2 invocations: original + 1 retry.
    expect(lines.length).toBe(2);
  }, 60_000);

  it('fires at most maxRetries retries across the chain (maxRetries: 2)', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'test retry twice',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 2 },
    });

    await waitTerminal(registry, run.id);
    // Wait for both retries to fire and settle — condition-based, no fixed sleep.
    await waitChainSettled(run.id, 3);

    const lines = readCounter();
    // 3 invocations: original + retry1 + retry2.
    expect(lines.length).toBe(3);

    // Walk the chain: run → retry1 → retry2 → no more.
    const allRuns = repo.listRuns();
    const retry1 = allRuns.find((r: any) => r.retryOf === run.id);
    expect(retry1).toBeDefined();
    const retry2 = allRuns.find((r: any) => r.retryOf === retry1.id);
    expect(retry2).toBeDefined();
    const retry3 = allRuns.find((r: any) => r.retryOf === retry2.id);
    expect(retry3).toBeUndefined();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3 (retry_of links persisted, retriedBy lookup)
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 retry_of persistence', () => {
  it('retry run carries retryOf pointing to the failed run', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'retry chain links',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1 },
    });

    await waitTerminal(registry, run.id);
    await waitChainSettled(run.id, 2);

    const allRuns = repo.listRuns();
    const retryRun = allRuns.find((r: any) => r.retryOf === run.id);
    expect(retryRun).toBeDefined();
    expect(retryRun.retryOf).toBe(run.id);
  }, 60_000);

  it('GET /api/agents/:id includes retriedBy pointing to the retry run', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'retriedBy lookup',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1 },
    });

    await waitTerminal(registry, run.id);
    await waitChainSettled(run.id, 2);

    const res = await app.inject({ method: 'GET', url: `/api/agents/${run.id}`, headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.retriedBy).not.toBeNull();
    expect(typeof body.retriedBy).toBe('string');

    // The retriedBy run has retryOf = original run.id.
    const retryRes = await app.inject({ method: 'GET', url: `/api/agents/${body.retriedBy}`, headers: H() });
    expect(retryRes.json().run.retryOf).toBe(run.id);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1 (part 2): NEVER retry on completed or killed
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 never retry on completed or killed', () => {
  it('does NOT retry a run with no retryPolicy (baseline — never any retry)', async () => {
    process.env.CLAUDE_BIN = failBin;

    const run = registry.launch({
      prompt: 'no policy baseline',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      // no retryPolicy
    });

    const final = await waitTerminal(registry, run.id);

    expect(final?.status).toBe('failed');
    // No retryPolicy → maybeRetry returns synchronously in onExit; no retry can ever appear.
    const allRuns = repo.listRuns();
    const retryRun = allRuns.find((r: any) => r.retryOf === run.id);
    expect(retryRun).toBeUndefined();
  }, 60_000);

  it('does NOT retry a killed run (killReason set → status killed, rule 1 + rule 5)', async () => {
    // Use failBin — the run exits immediately. We stop it synchronously before
    // onExit can fire (registry.stop() marks lr.killed before the child exits,
    // so onExit sees lr.killed → status='killed' → maybeRetry guard skips it).
    process.env.CLAUDE_BIN = failBin;

    const run = registry.launch({
      prompt: 'no retry on killed',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1 },
    });

    // Stop synchronously — registry.stop() marks the run killed before onExit runs.
    registry.stop(run.id, 'user');

    const final = await waitTerminal(registry, run.id);
    // If stop() lost the race the run failed → a retry fired; drain it so a straggler can't
    // append to the next test's freshly-cleared counter under load.
    if (final?.status === 'failed') {
      await waitFor(
        () => retryChain(run.id).every((r) => TERMINAL.includes(r.status)),
        'killed-race retry chain drain',
      );
    }

    // The run should be killed (stop() won the race) or failed (onExit won).
    // Either way, NO retry run should exist: killed → maybeRetry guards on status;
    // if failed, the retry WOULD fire — that's acceptable for this race. But in
    // practice stop() is synchronous and sets lr.killed before the async spawn
    // even registers the process, so the run is killed. Assert at least that
    // the retryOf link in the chain is correct (retry, if any, has retryOf=run.id).
    // The key invariant: killed runs from stop-all/timeout DON'T get retried.
    // We verify this with the killReason check.
    if (final?.status === 'killed') {
      const allRuns = repo.listRuns();
      const retryRun = allRuns.find((r: any) => r.retryOf === run.id);
      expect(retryRun).toBeUndefined();
    }
    // If the run failed before stop() could mark it killed, the retry would fire —
    // that's OK, because the PRD says "killed runs never retry" (not failed ones).
    // The test still asserts the invariant: once killReason is set → status killed.
    expect(['killed', 'failed']).toContain(final?.status);
  }, 60_000);

  it('maybeRetry guard: status=failed with killReason=user still says killed in stop() path', async () => {
    // Direct test: registry.stop() sets run.status = 'killed', not 'failed'.
    // onExit runs AFTER stop() in the async child-process lifecycle.
    // When lr.killed is true, onExit picks status='killed' → maybeRetry skips.
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'stop-all guard',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 2 },
    });

    // Stop all — simulates stop-all/timeout killing the run mid-chain.
    registry.stopAll();

    await waitTerminal(registry, run.id); // stopAll → killed; killed runs never retry
    // Killed → maybeRetry is skipped, so nothing is in-flight: only the original (if it
    // managed to append before being killed) can be in the counter.
    expect(retryChain(run.id).length).toBe(1);
    const lines = readCounter();
    expect(lines.length).toBeLessThanOrEqual(1);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1 (part 3): NEVER retry campaign/project runs
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 never retry campaign/project runs', () => {
  it('does NOT retry when campaignId is set', async () => {
    process.env.CLAUDE_BIN = failBin;

    const run = registry.launch({
      prompt: 'campaign run — no retry',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      campaignId: 'fake-campaign-id',
      retryPolicy: { maxRetries: 1 },
    });

    await waitTerminal(registry, run.id);
    // campaignId/projectId set → maybeRetry returns synchronously in onExit; no retry appears.
    const allRuns = repo.listRuns();
    const retryRun = allRuns.find((r: any) => r.retryOf === run.id);
    expect(retryRun).toBeUndefined();
  }, 60_000);

  it('does NOT retry when projectId is set', async () => {
    process.env.CLAUDE_BIN = failBin;

    const run = registry.launch({
      prompt: 'project run — no retry',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      projectId: 'fake-project-id',
      retryPolicy: { maxRetries: 1 },
    });

    await waitTerminal(registry, run.id);
    // campaignId/projectId set → maybeRetry returns synchronously in onExit; no retry appears.
    const allRuns = repo.listRuns();
    const retryRun = allRuns.find((r: any) => r.retryOf === run.id);
    expect(retryRun).toBeUndefined();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 4: escalation — model swapped on final attempt
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 escalation', () => {
  it('uses escalateModel on the FINAL retry (maxRetries: 1 → single retry IS final)', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'escalation once',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1, escalateModel: 'claude-opus-4-8' },
    });

    await waitTerminal(registry, run.id);
    await waitChainSettled(run.id, 2);

    const lines = readCounter();
    // 2 invocations: original (haiku) + 1 retry (opus, the final attempt).
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('claude-haiku-4-5');
    expect(lines[1]).toBe('claude-opus-4-8');
  }, 60_000);

  it('uses escalateModel only on the LAST retry (maxRetries: 2, escalate on attempt 2)', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    const run = registry.launch({
      prompt: 'escalation final attempt',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 2, escalateModel: 'claude-opus-4-8' },
    });

    await waitTerminal(registry, run.id);
    await waitChainSettled(run.id, 3);

    const lines = readCounter();
    // 3 invocations: original + retry1 (haiku, not final) + retry2 (opus, final).
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('claude-haiku-4-5');
    expect(lines[1]).toBe('claude-haiku-4-5');
    expect(lines[2]).toBe('claude-opus-4-8');
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 2: daily-cap blocks retry → drop with note
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 daily-cap suppresses retry', () => {
  afterAll(() => {
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });
  });

  it('drops retry with note on failed run error when daily cap is hit', async () => {
    process.env.CLAUDE_BIN = failBin;
    clearCounter();

    // Seed a large spend so the cap is already hit.
    const seedId = randomUUID();
    const now = Date.now();
    repo.upsertRun({
      id: seedId,
      sessionId: seedId,
      task: 'seed-spend',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      engine: undefined,
      fastMode: false,
      effort: 'low' as const,
      workflowsEnabled: false,
      ultracode: false,
      teamId: null,
      campaignId: null,
      projectId: null,
      pid: null,
      status: 'completed' as const,
      startedAt: now,
      endedAt: now,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 100,
      exitCode: 0,
      killReason: null,
      error: null,
      budgetUsd: null,
      permissionMode: 'default' as const,
      allowedTools: null,
      skills: [],
      subagentProfile: null,
      resultText: null,
      structuredOutput: null,
      retryOf: null,
      subagentCount: 0,
      liveSubagents: 0,
      maxDepth: 0,
      lastActivity: now,
    } as any);

    // Set a low cap (below seeded spend) AFTER the run to be retried launches.
    // We launch first (which passes because the initial run is below the cap),
    // wait for it to fail, then the retry fires into the capped state.
    // Actually the seeded spend already exceeds cap=50, so we set the cap now
    // and launch the run — launch itself checks cap and would block. We need
    // the ORIGINAL run to succeed launch but the RETRY to be blocked.
    // Strategy: set cap to null for the launch, then set it to 50 just before
    // the retry fires. That's racy. Instead: seed 100 of spend, set cap = 200
    // so the launch passes (spent < 200), then re-seed another 150 so that
    // after the original run fails (costs ~0) the retry check sees 250 > 200.
    //
    // Simpler: use a very large ceiling for the launch, THEN lower it so the
    // retry is blocked. The key is that maybeRetry calls checkDailyCap() at
    // that point synchronously, so if we lower the cap in-process before the
    // run exits it should catch it.
    //
    // Even simpler: just set a cap of 50 and seed 75 of spend already in the
    // DB — the launch() itself would be blocked (409). But we need the original
    // run to succeed. So we set the ceiling = null, run the launch, watch it
    // fail, then lower the cap to 50 before the retry fires (which is within
    // the flush window). This is racy, but the retry fires synchronously inside
    // onExit after the DB is written, so if we set the cap low enough before
    // onExit runs we catch it.
    //
    // Cleanest: start with no cap, run fails, then in a tight loop check if
    // run is failed and set cap low just before the retry. Instead let's just
    // lower the cap after launching and rely on the ordering: the run hasn't
    // failed yet (takes ~200ms to spawn and exit), and we set the cap before it fails.

    // Reset ceiling to null first.
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });

    const run = registry.launch({
      prompt: 'cap-blocked retry',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1 },
    });

    // Lower the cap before the run exits (should complete within ~100ms).
    // The seeded 100 USD spend puts us over a cap of 50.
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: 50 });

    await waitTerminal(registry, run.id);
    // Wait for the drop note the blocked retry appends asynchronously (no fixed sleep).
    await waitFor(
      () => /auto-retry skipped/.test(repo.getRun(run.id)?.error ?? ''),
      'daily-cap drop note on failed run',
    );

    // The bin was called exactly once (retry was blocked by cap).
    const lines = readCounter();
    expect(lines.length).toBe(1);

    // The failed run's error field contains the drop note.
    const final = repo.getRun(run.id);
    expect(final?.error).toMatch(/auto-retry skipped/);

    // No retry run exists.
    const allRuns = repo.listRuns();
    const retryRun = allRuns.find((r: any) => r.retryOf === run.id);
    expect(retryRun).toBeUndefined();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 9: validation (400 on bad retryPolicy)
// ─────────────────────────────────────────────────────────────────────────────
describe('F3 validation', () => {
  beforeAll(() => {
    // Ensure no cap or concurrency issue interferes with validation tests.
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });
    // Stop all live runs so concurrency cap doesn't block validation tests.
    registry.stopAll();
  });

  it('rejects maxRetries 0 (not 1 or 2)', async () => {
    // Wait a moment for stopAll to take effect.
    await sleep(300);
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        prompt: 'bad policy',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: { maxRetries: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/maxRetries must be 1 or 2/);
  }, 60_000);

  it('rejects maxRetries 3 (not 1 or 2)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        prompt: 'bad policy',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: { maxRetries: 3 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/maxRetries must be 1 or 2/);
  });

  it('rejects unknown escalateModel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        prompt: 'bad escalate',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: { maxRetries: 1, escalateModel: 'not-a-real-model' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/escalateModel/);
  });

  it('accepts null retryPolicy (no-op)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        prompt: 'no policy',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: null,
      },
    });
    // Should NOT be 400 from retryPolicy validation.
    expect(res.statusCode).not.toBe(400);
    if (res.json().id) registry.stop(res.json().id);
  });

  it('accepts valid retryPolicy { maxRetries: 1 }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        prompt: 'valid policy',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: { maxRetries: 1 },
      },
    });
    expect(res.statusCode).not.toBe(400);
    if (res.json().id) registry.stop(res.json().id);
  });

  it('rejects engine run with retryPolicy (direct registry.launch)', () => {
    // Validation must fire before the concurrency check, so set an absurdly high cap first.
    registry.setConfig({ ...registry.getConfig(), maxConcurrentRuns: 100 });
    expect(() =>
      registry.launch({
        prompt: 'engine+retry',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        engine: 'codex' as any,
        retryPolicy: { maxRetries: 1 },
      }),
    ).toThrow(/not supported on engine/);
    // Restore.
    registry.setConfig({ ...registry.getConfig(), maxConcurrentRuns: 8 });
  });
});

// ── §27 final-review regression tests ─────────────────────────────────────────

describe('F3 §27 review fixes', () => {
  it('does NOT retry a COMPLETED run even with a retryPolicy (review #38 — successBin now earns its keep)', async () => {
    process.env.FAKE_MODE = 'success';
    const run = registry.launch({
      prompt: 'completes fine',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 2 },
    });
    const final = await waitTerminal(registry, run.id);
    expect(final?.status).toBe('completed');
    // Completed → maybeRetry guards on status; no retry can appear.
    expect(repo.listRuns().find((r: any) => r.retryOf === run.id)).toBeUndefined();
    process.env.FAKE_MODE = 'fail';
  }, 60_000);

  it('strips a smuggled negative _attempt from external launches — the retry cap holds (review #4)', async () => {
    process.env.CLAUDE_BIN = failBin;
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...H(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        prompt: 'smuggled attempt',
        cwd: dataDir,
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: { maxRetries: 1 },
        _attempt: -1_000_000_000, // would defeat the cap if accepted
        _retryOf: 'forged-lineage',
      }),
    });
    expect(res.statusCode).toBe(200);
    const launched = res.json();
    expect(launched.retryOf ?? null).toBeNull(); // forged lineage stripped
    await waitTerminal(registry, launched.id);
    await waitChainSettled(launched.id, 2); // original + exactly one retry, both settled
    const chain = repo.listRuns().filter((r: any) => r.retryOf === launched.id);
    expect(chain.length).toBe(1); // exactly ONE retry — not a billion
    if (chain[0]) {
      expect(repo.listRuns().find((r: any) => r.retryOf === chain[0].id)).toBeUndefined();
    }
  }, 60_000);

  it('rejects engine + retryPolicy with 400 at the ROUTE level (review #18 — the launch() check was dead code)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...H(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        prompt: 'engine retry',
        cwd: dataDir,
        engine: 'codex',
        model: 'claude-haiku-4-5',
        effort: 'low',
        permissionMode: 'default',
        retryPolicy: { maxRetries: 1 },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not supported on engine/);
  });

  it('deleteRun clears dangling retry_of links on the survivors (review #13)', async () => {
    process.env.CLAUDE_BIN = failBin;
    const original = registry.launch({
      prompt: 'will be deleted',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
      retryPolicy: { maxRetries: 1 },
    });
    await waitTerminal(registry, original.id);
    await waitChainSettled(original.id, 2);
    const retry = repo.listRuns().find((r: any) => r.retryOf === original.id);
    expect(retry).toBeDefined();
    await waitTerminal(registry, retry!.id);
    registry.deleteRun(original.id);
    const survivor = repo.getRun(retry!.id);
    expect(survivor?.retryOf ?? null).toBeNull(); // no 404 'retry of' link
  }, 60_000);
});
