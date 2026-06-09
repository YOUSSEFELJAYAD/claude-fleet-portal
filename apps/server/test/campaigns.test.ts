import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js) is imported.
// Static imports above are env-agnostic; src is pulled in lazily in beforeAll.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-'));

let repo: any;
let registry: any;
let campaigns: any;

beforeAll(async () => {
  ({ repo } = await import('../src/db.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ campaigns } = await import('../src/campaigns.js'));
});

describe('campaign KILL ordering (H2) — no cost-spending orphan workers', () => {
  it('persists campaign status=killed BEFORE stopping any run', () => {
    // The orphan leak: registry.stop() synchronously fires onRunTerminal →
    // handleRunTerminal, which re-reads the campaign from DB and only short-circuits
    // when its status is terminal. If kill() flips the status AFTER the stop() calls,
    // a dependency-freed worker can still be scheduled mid-kill and is never stopped
    // (kill()'s task snapshot predates it). Locking the invariant: the campaign must
    // already read 'killed' in the DB by the time the first stop() runs.
    const now = Date.now();
    repo.upsertCampaign({
      id: 'C1', objective: 'o', cwd: '/tmp', status: 'running',
      orchestratorTemplate: 'Orchestrator', workerTemplate: 'Implementer', synthesizerTemplate: null,
      orchestratorRunId: 'orch', synthesizerRunId: null,
      maxParallel: 4, autoSynthesize: false, budgetPerWorkerUsd: 5,
      model: 'claude-haiku-4-5', startedAt: now, endedAt: null, costUsd: 0,
      // v2 #4 — a standalone campaign sets none of these (null preserves v1 behavior).
      projectId: null, disallowedTools: null, permissionMode: null,
    });

    let statusAtFirstStop: string | undefined;
    const realStop = registry.stop.bind(registry);
    registry.stop = (runId: string) => {
      if (runId && statusAtFirstStop === undefined) {
        statusAtFirstStop = repo.getCampaign('C1')?.status;
      }
    };
    try {
      campaigns.kill('C1');
    } finally {
      registry.stop = realStop;
    }

    expect(statusAtFirstStop).toBe('killed'); // guard would short-circuit any reschedule
    expect(repo.getCampaign('C1')?.status).toBe('killed');
  });
});

const mkRun = (id: string, status: string): any => ({
  id, sessionId: id, task: 't', cwd: '/tmp', model: 'claude-haiku-4-5', fastMode: false,
  effort: 'medium', workflowsEnabled: true, ultracode: false, teamId: null, campaignId: null,
  pid: null, status, startedAt: 1, endedAt: status === 'running' ? null : 1, tokensIn: 0, tokensOut: 0,
  costUsd: 0, exitCode: null, budgetUsd: 5, permissionMode: 'default', allowedTools: null, skills: [],
  subagentProfile: null, resultText: null, structuredOutput: null, killReason: null, error: null,
  subagentCount: 0, liveSubagents: 0, maxDepth: 0, lastActivity: 1,
});

describe('failure diagnostics — killReason + error (H5)', () => {
  it('records killReason on stop() for runs not in the live map (post-restart path)', () => {
    repo.upsertRun(mkRun('rk', 'running'));
    registry.stop('rk', 'budget');
    expect(repo.getRun('rk')?.status).toBe('killed');
    expect(repo.getRun('rk')?.killReason).toBe('budget');

    repo.upsertRun(mkRun('ru', 'running'));
    registry.stop('ru'); // defaults to 'user'
    expect(repo.getRun('ru')?.killReason).toBe('user');
  });

  it('round-trips the error (captured stderr) column through SQLite', () => {
    const r = mkRun('re', 'failed');
    r.error = 'Error: invalid --model foo';
    repo.upsertRun(r);
    expect(repo.getRun('re')?.error).toBe('Error: invalid --model foo');
  });
});

describe('graceful shutdown primitives (H4)', () => {
  it('repo.checkpoint() and registry.shutdown() run without throwing (no live runs → no-op)', () => {
    expect(() => repo.checkpoint()).not.toThrow();
    expect(() => registry.shutdown()).not.toThrow();
  });
});

describe('SSE tail-truncation marker (H18)', () => {
  it('flags truncation only when a full 5000-event page starts past seq 0', async () => {
    const { tailTruncatedBefore } = await import('../src/registry.js');
    const ev = (seq: number): any => ({ seq });
    expect(tailTruncatedBefore([ev(0), ev(1), ev(2)])).toBeUndefined(); // small run
    const full = Array.from({ length: 5000 }, (_, i) => ev(i + 100)); // starts at seq 100
    expect(tailTruncatedBefore(full)).toBe(100);
    const fullFromZero = Array.from({ length: 5000 }, (_, i) => ev(i)); // starts at 0 → nothing omitted
    expect(tailTruncatedBefore(fullFromZero)).toBeUndefined();
  });
});

describe('permission control-response shape (H14)', () => {
  it('emits the verified SDK shape (subtype:success + behavior allow/deny)', async () => {
    const { buildPermissionControlResponse } = await import('../src/registry.js');
    const approve: any = buildPermissionControlResponse('req-1', 'approve');
    expect(approve.type).toBe('control_response');
    expect(approve.response.subtype).toBe('success');
    expect(approve.response.request_id).toBe('req-1');
    expect(approve.response.response.behavior).toBe('allow'); // NOT "decision"
    const deny: any = buildPermissionControlResponse('req-2', 'deny');
    expect(deny.response.response.behavior).toBe('deny');
  });
});

describe('campaign plan robustness (H20)', () => {
  it('detects dependency cycles, self-deps, and duplicate task ids', async () => {
    const { planHasCycle, planHasDupIds } = await import('../src/campaigns.js');
    expect(planHasCycle([{ id: 't1', dependsOn: ['t2'] }, { id: 't2', dependsOn: ['t1'] }])).toBe(true);
    expect(planHasCycle([{ id: 't1', dependsOn: ['t1'] }])).toBe(true);
    expect(planHasCycle([{ id: 't1', dependsOn: [] }, { id: 't2', dependsOn: ['t1'] }])).toBe(false);
    expect(planHasCycle([{ id: 't1', dependsOn: ['nope'] }])).toBe(false); // dangling dep ignored
    expect(planHasDupIds([{ id: 't1' }, { id: 't1' }])).toBe(true);
    expect(planHasDupIds([{ id: 't1' }, { id: 't2' }])).toBe(false);
  });
});

describe('SQLite write-path hardening (H15)', () => {
  it('sets synchronous=NORMAL + busy_timeout and drops the redundant events index', async () => {
    const db = (await import('../src/db.js')).default;
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_run'").get();
    expect(idx).toBeUndefined(); // redundant index dropped
  });
});
