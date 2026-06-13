/**
 * Real, behavioral coverage for registry.ts — the control-plane core.
 *
 * Strategy: set FLEET_DATA_DIR to a fresh mkdtemp BEFORE importing any src module so the
 * registry singleton boots against an empty, isolated SQLite DB. Then drive the PURE helpers
 * and the DB-backed READ paths with REAL rows seeded through the real `repo`, asserting real
 * outputs / side-effects (broadcasts, persisted status, derived rollups, thrown HTTP errors).
 *
 * Untestable in a unit harness (not exercised here): launch()/launchEngine()/resume() spawn the
 * real claude/engine binary, the SSE socket lifecycle for live runs, the 30s sweep / 60s evict
 * timers, the process-group kill of a live child, and OS/IO catch blocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, RunNode, NormalizedEvent, StreamMessage, FleetMessage } from '@fleet/shared';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-registry-'));

let R: typeof import('../src/registry.js');
let repo: typeof import('../src/db.js').repo;

const startOfToday = (): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

let seq = 0;
function mkRun(overrides: Partial<Run> = {}): Run {
  const now = Date.now();
  const id = (overrides.id as string) ?? randomUUID();
  return {
    id,
    sessionId: id,
    task: 'do the thing',
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    workflowsEnabled: true,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'completed',
    startedAt: now,
    endedAt: now,
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0,
    exitCode: 0,
    killReason: null,
    error: null,
    budgetUsd: 5,
    permissionMode: 'default',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: 'ok',
    structuredOutput: null,
    pid: null,
    retryOf: null,
    archivedAt: null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: now,
    ...overrides,
  } as Run;
}

function mkNode(runId: string, overrides: Partial<RunNode> = {}): RunNode {
  return {
    id: overrides.id ?? randomUUID(),
    runId,
    parentId: null,
    nodeType: 'root',
    label: 'root',
    status: 'completed',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    startedAt: Date.now(),
    endedAt: Date.now(),
    depth: 0,
    ...overrides,
  } as RunNode;
}

function mkEvent(runId: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sessionId: runId,
    runId,
    nodeId: runId,
    parentNodeId: null,
    nodeType: 'root',
    seq: seq++,
    ts: Date.now(),
    type: 'assistant_text' as any,
    payload: {},
    ...overrides,
  } as NormalizedEvent;
}

beforeAll(async () => {
  R = await import('../src/registry.js');
  repo = (await import('../src/db.js')).repo;
});

afterAll(() => {
  try { rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── pure helper: tailTruncatedBefore (H18) ──────────────────────────────────
describe('tailTruncatedBefore', () => {
  it('returns undefined when fewer than 5000 events (no truncation)', () => {
    expect(R.tailTruncatedBefore([])).toBeUndefined();
    const few = [mkEvent('r', { seq: 7 })];
    expect(R.tailTruncatedBefore(few)).toBeUndefined();
  });

  it('returns undefined at exactly the cap when the earliest seq is 0 (nothing before)', () => {
    const full = Array.from({ length: 5000 }, (_, i) => mkEvent('r', { seq: i }));
    expect(full[0].seq).toBe(0);
    expect(R.tailTruncatedBefore(full)).toBeUndefined();
  });

  it('returns the earliest seq when the page is full AND earlier events were omitted', () => {
    const full = Array.from({ length: 5000 }, (_, i) => mkEvent('r', { seq: i + 100 }));
    expect(R.tailTruncatedBefore(full)).toBe(100);
  });
});

// ── pure helper: buildPermissionControlResponse (H14) ───────────────────────
describe('buildPermissionControlResponse', () => {
  it('maps approve → behavior:allow in the verified control_response shape', () => {
    const m = R.buildPermissionControlResponse('req-1', 'approve');
    expect(m).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow' },
      },
    });
  });

  it('maps deny → behavior:deny and echoes the request id', () => {
    const m = R.buildPermissionControlResponse('req-XYZ', 'deny');
    expect(m.response.request_id).toBe('req-XYZ');
    expect(m.response.response).toEqual({ behavior: 'deny' });
  });
});

// ── config get / set + clamp (H9) ───────────────────────────────────────────
describe('config get/set with validation + clamp', () => {
  it('getConfig returns the live in-memory config object', () => {
    const c = R.registry.getConfig();
    expect(typeof c.maxConcurrentRuns).toBe('number');
    expect(R.registry.config).toBe(c);
  });

  it('setConfig validates, persists, and updates the in-memory copy', () => {
    R.registry.setConfig({
      maxConcurrentRuns: 3,
      defaultBudgetUsd: 2,
      ultracodeBudgetUsd: 4,
      permissionDefault: 'default',
      subagentConcurrentCeiling: 4,
      subagentTotalCeiling: 50,
      dailySpendCeilingUsd: 10,
      maxRunMinutes: 30,
    });
    expect(R.registry.getConfig().maxConcurrentRuns).toBe(3);
    expect(R.registry.getConfig().dailySpendCeilingUsd).toBe(10);
    // persisted to DB
    expect(repo.getConfig().maxConcurrentRuns).toBe(3);
    expect(repo.getConfig().maxRunMinutes).toBe(30);
  });

  it('setConfig fills defaults for absent keys (partial PUT cannot disable guardrails)', () => {
    R.registry.setConfig({ maxConcurrentRuns: 9 });
    const c = R.registry.getConfig();
    expect(c.maxConcurrentRuns).toBe(9);
    // absent dailySpendCeilingUsd falls back to DEFAULT_CONFIG (null = off)
    expect(c.dailySpendCeilingUsd).toBeNull();
    expect(c.defaultBudgetUsd).toBeGreaterThan(0);
  });

  it('setConfig throws a 400 on an out-of-range value (does not mutate config)', () => {
    const before = R.registry.getConfig().maxConcurrentRuns;
    expect(() => R.registry.setConfig({ maxConcurrentRuns: 0 })).toThrow(/maxConcurrentRuns/);
    try {
      R.registry.setConfig({ maxConcurrentRuns: 999 });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
    expect(R.registry.getConfig().maxConcurrentRuns).toBe(before);
  });

  it('setConfig throws a 400 when input is not an object', () => {
    expect(() => R.registry.setConfig(null)).toThrow(/config must be an object/);
  });
});

// ── spend() — DB aggregates + active-run count ──────────────────────────────
describe('spend', () => {
  it('sums today cost, counts today runs, and reports 0 active when nothing is live', () => {
    const today = startOfToday();
    repo.upsertRun(mkRun({ startedAt: today + 1000, costUsd: 1.5 }));
    repo.upsertRun(mkRun({ startedAt: today + 2000, costUsd: 2.25 }));
    // a run from "yesterday" must not be counted
    repo.upsertRun(mkRun({ startedAt: today - 86_400_000, costUsd: 99 }));

    const s = R.registry.spend();
    expect(s.todayUsd).toBeCloseTo(3.75, 5);
    expect(s.totalRunsToday).toBe(2);
    expect(s.activeRuns).toBe(0); // no live in-memory runs in this harness
  });
});

// ── listRuns() — DB source of truth + filters ───────────────────────────────
describe('listRuns', () => {
  it('returns persisted rows and respects the status filter', () => {
    const failedId = randomUUID();
    repo.upsertRun(mkRun({ id: failedId, status: 'failed', task: 'a failing job', effort: 'low' }));
    repo.upsertRun(mkRun({ status: 'completed', task: 'a passing job' }));

    const failed = R.registry.listRuns({ status: 'failed' });
    expect(failed.every((r) => r.status === 'failed')).toBe(true);
    expect(failed.some((r) => r.id === failedId)).toBe(true);

    const byEffort = R.registry.listRuns({ effort: 'low' });
    expect(byEffort.some((r) => r.id === failedId)).toBe(true);
  });

  it('excludes archived runs by default but includes them with archived:include', () => {
    const archId = randomUUID();
    repo.upsertRun(mkRun({ id: archId, status: 'completed' }));
    repo.archiveRun(archId, Date.now());

    const def = R.registry.listRuns();
    expect(def.some((r) => r.id === archId)).toBe(false);

    const inc = R.registry.listRuns({ archived: 'include' });
    expect(inc.some((r) => r.id === archId)).toBe(true);

    const only = R.registry.listRuns({ archived: 'only' });
    expect(only.every((r) => r.archivedAt != null)).toBe(true);
    expect(only.some((r) => r.id === archId)).toBe(true);
  });

  it('q filter matches the task text', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, task: 'UNIQUEMARKER refactor parser' }));
    const hits = R.registry.listRuns({ q: 'UNIQUEMARKER' });
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(id);
  });
});

// ── getRun() — DB read with node-derived rollups ────────────────────────────
describe('getRun', () => {
  it('returns null for an unknown run', () => {
    expect(R.registry.getRun('nope-' + randomUUID())).toBeNull();
  });

  it('derives subagentCount + maxDepth from persisted nodes and zeroes liveSubagents', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, liveSubagents: 7 }));
    repo.upsertNodes([
      mkNode(id, { id, depth: 0, nodeType: 'root' }),
      mkNode(id, { parentId: id, depth: 1, nodeType: 'subagent', label: 'sub-a' }),
      mkNode(id, { parentId: id, depth: 1, nodeType: 'teammate', label: 'mate' }),
      mkNode(id, { parentId: id, depth: 2, nodeType: 'subagent', label: 'deep' }),
    ]);
    const got = R.registry.getRun(id)!;
    expect(got).not.toBeNull();
    expect(got.subagentCount).toBe(3); // 2 subagent + 1 teammate
    expect(got.maxDepth).toBe(2);
    expect(got.liveSubagents).toBe(0); // forced to 0 on the DB read path
  });
});

// ── getNodes() / getTree() — DB replay + assembleFromFlat ────────────────────
describe('getNodes / getTree', () => {
  it('getNodes returns the persisted flat node list', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id }));
    repo.upsertNodes([
      mkNode(id, { id, depth: 0 }),
      mkNode(id, { parentId: id, depth: 1, label: 'child' }),
    ]);
    const nodes = R.registry.getNodes(id);
    expect(nodes.length).toBe(2);
    expect(nodes.some((n) => n.label === 'child')).toBe(true);
  });

  it('getTree returns null for a run with no nodes', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id }));
    expect(R.registry.getTree(id)).toBeNull();
  });

  it('getTree assembles a nested tree from flat DB nodes, children sorted by startedAt', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id }));
    const t0 = Date.now();
    const childLate = randomUUID();
    const childEarly = randomUUID();
    repo.upsertNodes([
      mkNode(id, { id, depth: 0, startedAt: t0 }),
      mkNode(id, { id: childLate, parentId: id, depth: 1, label: 'late', startedAt: t0 + 500 }),
      mkNode(id, { id: childEarly, parentId: id, depth: 1, label: 'early', startedAt: t0 + 100 }),
    ]);
    const tree = R.registry.getTree(id)!;
    expect(tree).not.toBeNull();
    expect(tree.id).toBe(id);
    expect(tree.children!.map((c) => c.label)).toEqual(['early', 'late']);
  });
});

// ── subscribeFleet — fleet-hello carries the current runs + spend snapshot ───
describe('subscribeFleet', () => {
  it('immediately delivers a fleet-hello with runs and spend, then unsubscribes', () => {
    const msgs: FleetMessage[] = [];
    const unsub = R.registry.subscribeFleet((m) => msgs.push(m));
    expect(msgs.length).toBe(1);
    expect(msgs[0].kind).toBe('fleet-hello');
    const hello = msgs[0] as Extract<FleetMessage, { kind: 'fleet-hello' }>;
    expect(Array.isArray(hello.runs)).toBe(true);
    expect(typeof hello.spend.todayUsd).toBe('number');
    unsub();
    // after unsubscribe, no further broadcasts reach this callback
    const before = msgs.length;
    R.registry.spend();
    expect(msgs.length).toBe(before);
  });
});

// ── subscribeRun — hello snapshot for a DB-only run + null for unknown ───────
describe('subscribeRun', () => {
  it('returns null for a run that does not exist', () => {
    expect(R.registry.subscribeRun('ghost-' + randomUUID(), () => {})).toBeNull();
  });

  it('delivers a hello snapshot (run + nodes + tail events) for a persisted run', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id }));
    repo.upsertNodes([mkNode(id, { id, depth: 0 })]);
    repo.insertEvents([mkEvent(id, { seq: 1000 }), mkEvent(id, { seq: 1001 })]);

    const msgs: StreamMessage[] = [];
    const unsub = R.registry.subscribeRun(id, (m) => msgs.push(m));
    expect(unsub).not.toBeNull();
    expect(msgs.length).toBe(1);
    const hello = msgs[0] as Extract<StreamMessage, { kind: 'hello' }>;
    expect(hello.kind).toBe('hello');
    expect(hello.run.id).toBe(id);
    expect(hello.nodes.length).toBe(1);
    expect(hello.events.length).toBe(2);
    expect(hello.truncatedBefore).toBeUndefined(); // only 2 events, well under the cap
    unsub!();
  });
});

// ── stop() — non-live run via persisted pid path (PRD §10) ───────────────────
describe('stop (non-live run)', () => {
  it('does nothing for an unknown run id', () => {
    // no throw, no broadcast crash
    expect(() => R.registry.stop('unknown-' + randomUUID())).not.toThrow();
  });

  it('returns silently for a non-live run that is already terminal (no status change)', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed' }));
    R.registry.stop(id);
    expect(repo.getRun(id)!.status).toBe('completed'); // terminal row left untouched
  });

  it('marks a non-live NON-terminal run killed, records the reason, and broadcasts', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'running', endedAt: null, exitCode: null, pid: null }));

    const fleet: FleetMessage[] = [];
    const unsubFleet = R.registry.subscribeFleet((m) => fleet.push(m));
    const runMsgs: StreamMessage[] = [];
    const unsubRun = R.registry.subscribeRun(id, (m) => runMsgs.push(m));

    R.registry.stop(id, 'timeout');

    const persisted = repo.getRun(id)!;
    expect(persisted.status).toBe('killed');
    expect(persisted.killReason).toBe('timeout');
    expect(persisted.endedAt).not.toBeNull();
    // open run page got a 'run' update reflecting the kill
    expect(runMsgs.some((m) => m.kind === 'run' && (m as any).run.status === 'killed')).toBe(true);
    // fleet got a run + spend broadcast
    expect(fleet.some((m) => m.kind === 'run' && (m as any).run.id === id)).toBe(true);
    expect(fleet.some((m) => m.kind === 'spend')).toBe(true);
    unsubFleet();
    unsubRun!();
  });
});

// ── deleteRun / archiveRun error + success paths ────────────────────────────
describe('deleteRun', () => {
  it('throws 404 when the run does not exist', () => {
    try {
      R.registry.deleteRun('missing-' + randomUUID());
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 409 for a non-terminal run', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'running', endedAt: null }));
    try {
      R.registry.deleteRun(id);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
    }
  });

  it('deletes a terminal run, broadcasts run-removed + spend', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed' }));
    const fleet: FleetMessage[] = [];
    const unsub = R.registry.subscribeFleet((m) => fleet.push(m));
    R.registry.deleteRun(id);
    expect(repo.getRun(id)).toBeNull();
    expect(fleet.some((m) => m.kind === 'run-removed' && (m as any).runId === id)).toBe(true);
    expect(fleet.some((m) => m.kind === 'spend')).toBe(true);
    unsub();
  });
});

describe('archiveRun', () => {
  it('throws 404 for an unknown run', () => {
    try {
      R.registry.archiveRun('x-' + randomUUID(), true);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 409 for a non-terminal run', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'running', endedAt: null }));
    try {
      R.registry.archiveRun(id, true);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
    }
  });

  it('archives a terminal run (sets archivedAt) and restores it (null), broadcasting both', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed', archivedAt: null }));
    const fleet: FleetMessage[] = [];
    const unsub = R.registry.subscribeFleet((m) => fleet.push(m));

    const archived = R.registry.archiveRun(id, true);
    expect(archived.archivedAt).not.toBeNull();
    expect(repo.getRun(id)!.archivedAt).not.toBeNull();

    const restored = R.registry.archiveRun(id, false);
    expect(restored.archivedAt).toBeNull();
    expect(repo.getRun(id)!.archivedAt).toBeNull();

    expect(fleet.filter((m) => m.kind === 'run' && (m as any).run.id === id).length).toBeGreaterThanOrEqual(2);
    unsub();
  });
});

// ── resume() error paths (the spawn path is untestable) ──────────────────────
describe('resume (error paths)', () => {
  it('throws 404 for an unknown run', () => {
    try {
      R.registry.resume('nope-' + randomUUID());
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws 409 when the run is still live (non-terminal)', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'running', endedAt: null }));
    try {
      R.registry.resume(id);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.message).toMatch(/cannot resume/i);
    }
  });

  it('throws 409 engine-unsupported for an engine add-on run', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed', engine: 'codex' as any }));
    try {
      R.registry.resume(id);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('engine-unsupported');
    }
  });

  it('throws 400 when the working directory no longer exists', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed', cwd: '/nonexistent/path/' + randomUUID() }));
    try {
      R.registry.resume(id);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/no longer exists/i);
    }
  });
});

// ── sendInput / decidePermission — "not live" 409s ──────────────────────────
describe('sendInput / decidePermission (not live)', () => {
  it('sendInput throws 409 when the run is not in the live map', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed' }));
    try {
      R.registry.sendInput(id, 'hi');
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.message).toMatch(/Resume instead/);
    }
  });

  it('decidePermission throws 409 when the run is not live', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed' }));
    try {
      R.registry.decidePermission(id, 'req-1', 'approve');
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(409);
      expect(e.message).toMatch(/not live/i);
    }
  });
});

// ── sweepTimeouts — guardrail config branch (no live runs to act on) ─────────
describe('sweepTimeouts', () => {
  it('is a no-op when maxRunMinutes is null (guardrail off)', () => {
    R.registry.setConfig({ maxConcurrentRuns: 8, maxRunMinutes: null });
    expect(() => R.registry.sweepTimeouts()).not.toThrow();
  });

  it('does nothing when there are no live runs even with the guardrail enabled', () => {
    R.registry.setConfig({ maxConcurrentRuns: 8, maxRunMinutes: 1 });
    const before = R.registry.listRuns().length;
    R.registry.sweepTimeouts(Date.now());
    // no live runs → nothing changes
    expect(R.registry.listRuns().length).toBe(before);
    // restore guardrail off so it can't interfere with nothing else
    R.registry.setConfig({ maxConcurrentRuns: 8, maxRunMinutes: null });
  });
});

// ── dead-subscriber catch blocks — a throwing callback must not break broadcasts ─
describe('broadcast resilience (dead subscribers)', () => {
  it('broadcastFleet swallows a throwing fleet subscriber and still reaches healthy ones', () => {
    const good: FleetMessage[] = [];
    // subscribeFleet delivers the initial fleet-hello SYNCHRONOUSLY at registration (not via the
    // try/catch'd broadcast loop) — so only throw on subsequent broadcasts, via a counter.
    let badCalls = 0;
    const unsubBad = R.registry.subscribeFleet(() => {
      badCalls++;
      if (badCalls > 1) throw new Error('dead fleet sub');
    });
    const unsubGood = R.registry.subscribeFleet((m) => good.push(m));
    good.length = 0;
    // a delete triggers broadcastFleet(run-removed + spend); the bad sub throws, good still gets them
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'completed' }));
    expect(() => R.registry.deleteRun(id)).not.toThrow();
    expect(good.some((m) => m.kind === 'run-removed')).toBe(true);
    unsubBad();
    unsubGood();
  });

  it('broadcastRun swallows a throwing per-run subscriber (stop still broadcasts)', () => {
    const id = randomUUID();
    repo.upsertRun(mkRun({ id, status: 'running', endedAt: null }));
    // subscribeRun delivers an immediate hello to the throwing cb (caught at registration? no —
    // hello is called directly, so throw it on the SECOND message): use a counter.
    let calls = 0;
    const unsub = R.registry.subscribeRun(id, () => {
      calls++;
      if (calls > 1) throw new Error('dead run sub');
    })!;
    // stop() → broadcastRun({kind:'run'}) hits the now-throwing sub; must be swallowed.
    expect(() => R.registry.stop(id)).not.toThrow();
    expect(repo.getRun(id)!.status).toBe('killed');
    unsub();
  });
});

// ── resetAllData — destructive clear of all persisted rows + config restore ──
describe('resetAllData', () => {
  it('clears every persisted run (counts them) and restores DEFAULT config', () => {
    // seed a handful of rows including an archived one (listRunsForExport includes archived)
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) repo.upsertRun(mkRun({ id, status: 'completed' }));
    repo.archiveRun(ids[2], Date.now());
    // mutate config away from default first
    R.registry.setConfig({ maxConcurrentRuns: 5 });

    const fleet: FleetMessage[] = [];
    const unsub = R.registry.subscribeFleet((m) => fleet.push(m));
    fleet.length = 0;

    const res = R.registry.resetAllData();
    expect(res.clearedRuns).toBeGreaterThanOrEqual(ids.length);
    // every run gone
    for (const id of ids) expect(repo.getRun(id)).toBeNull();
    expect(R.registry.listRuns({ archived: 'include' }).length).toBe(0);
    // config reset to default (maxConcurrentRuns default is 8, not the 5 we set)
    expect(R.registry.getConfig().maxConcurrentRuns).toBe(8);
    // a final fleet-hello is broadcast after the reset
    expect(fleet.some((m) => m.kind === 'fleet-hello')).toBe(true);
    unsub();
  });
});

// ── stopAll / onRunTerminal — no live runs path ─────────────────────────────
describe('stopAll / onRunTerminal', () => {
  it('stopAll returns 0 when nothing is live', () => {
    expect(R.registry.stopAll()).toBe(0);
  });

  it('onRunTerminal registers and unsubscribes a terminal callback without firing', () => {
    let fired = 0;
    const off = R.registry.onRunTerminal(() => { fired++; });
    expect(typeof off).toBe('function');
    off();
    expect(fired).toBe(0); // no terminal transition happened in this harness
  });
});
