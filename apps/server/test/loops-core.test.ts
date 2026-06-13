import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeLoopStubsWritable } from './setup-loop-stubs.js';

// Isolate the DB BEFORE any src module is imported (config.js reads FLEET_DATA_DIR at load).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-loops-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let loopsRepo: typeof import('../src/loops.js').loopsRepo;
let validateContract: typeof import('../src/loops.js').validateContract;
let compileContract: typeof import('../src/loops.js').compileContract;
let applyEvalResult: typeof import('../src/loops.js').applyEvalResult;
let loops: typeof import('../src/loops.js').loops;
let projectsRepo: typeof import('../src/projects.js').projectsRepo;
let db: typeof import('../src/db.js').default;
let app: any; let PORT: number; const H = () => ({ host: `127.0.0.1:${PORT}` });

const baseContract = () => ({
  job: 'triage backlog',
  inputs: 'open cards',
  allowed: ['Read', 'Grep'],
  forbidden: ['Edit'],
  output: 'classified cards',
  evaluation: 'no risk:high marked agent:ready',
});

// Re-establish the placeholder modules' default exports so a stub set inside one `it` never bleeds
// into the next (the namespaces are cached singletons; we reset them after every test).
async function resetLoopStubs(): Promise<void> {
  const controlplane = await import('../src/controlplane.js');
  const manager = await import('../src/manager.js');
  const loopEval = await import('../src/loopEval.js');
  (controlplane as any).controlPlaneFor = () => ({
    cp: {
      listBacklog: async () => [],
      listReady: async () => [],
      classify: async () => {},
      postAssessment: async () => {},
      attachQuestions: async () => {},
    },
    intended: [],
  });
  (manager as any).runManagerLoop = async () => [];
  (loopEval as any).gradeLoopRun = async () => ({ clean: true, score: 100, notes: '' });
}

let PID = '';
beforeAll(async () => {
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ loopsRepo, validateContract, compileContract, applyEvalResult, loops } = await import('../src/loops.js'));
  db = (await import('../src/db.js')).default;
  PORT = (await import('../src/config.js')).PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
  // Make the placeholder exports writable for THIS suite only (not a global setupFile).
  await makeLoopStubsWritable();
  await resetLoopStubs();
  // projectsRepo.createProject does not validate rootDir on disk (see kanban.test.ts).
  PID = projectsRepo.createProject({ name: 'loops-' + randomUUID().slice(0, 8), rootDir: '/tmp' }).id;
});

afterEach(async () => {
  // Restore the placeholder stubs to their known defaults so cross-`it` state never leaks.
  await resetLoopStubs();
});

afterAll(async () => {
  await app?.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('loopsRepo — CRUD + defaults', () => {
  it('create applies spec §4.1 defaults and round-trips the contract', () => {
    const loop = loopsRepo.create({
      name: 'mgr',
      projectId: PID,
      kind: 'manager',
      contract: baseContract(),
    });
    expect(loop.id).toBeTruthy();
    expect(loop.kind).toBe('manager');
    expect(loop.controlPlane).toBe('board'); // default
    expect(loop.mode).toBe('dry-run'); // forced-start default
    expect(loop.consecutiveGoodRuns).toBe(0);
    expect(loop.escalationThreshold).toBe(3);
    expect(loop.mergePosture).toBe('human-gate');
    expect(loop.reviewPolicy).toBe('always');
    expect(loop.routableCeiling).toBe('low');
    expect(loop.enabled).toBe(true);
    expect(loop.riskRubric).toEqual([]);
    expect(loop.contract.evaluation).toBe('no risk:high marked agent:ready');
    expect(loop.lastEval).toBeNull();
  });

  it('get / list / update / remove', () => {
    const loop = loopsRepo.create({ name: 'w', projectId: PID, kind: 'worker', contract: baseContract() });
    expect(loopsRepo.get(loop.id)?.name).toBe('w');
    expect(loopsRepo.list(PID).some((l) => l.id === loop.id)).toBe(true);
    expect(loopsRepo.list('no-such-project')).toEqual([]);

    const updated = loopsRepo.update(loop.id, { name: 'w2', enabled: false });
    expect(updated?.name).toBe('w2');
    expect(updated?.enabled).toBe(false);

    expect(loopsRepo.remove(loop.id)).toBe(true);
    expect(loopsRepo.get(loop.id)).toBeNull();
    expect(loopsRepo.remove(loop.id)).toBe(false);
  });

  it('enabledByKind filters by project + kind + enabled', () => {
    const a = loopsRepo.create({ name: 'kA', projectId: PID, kind: 'worker', contract: baseContract() });
    const b = loopsRepo.create({ name: 'kB', projectId: PID, kind: 'manager', contract: baseContract() });
    loopsRepo.update(a.id, { enabled: false });
    const workers = loopsRepo.enabledByKind(PID, 'worker');
    expect(workers.some((l) => l.id === a.id)).toBe(false); // disabled excluded
    const managers = loopsRepo.enabledByKind(PID, 'manager');
    expect(managers.some((l) => l.id === b.id)).toBe(true);
  });
});

describe('validateContract — EVALUATION required (spec §3)', () => {
  it('returns null for a complete contract', () => {
    expect(validateContract(baseContract())).toBeNull();
  });

  it('rejects an empty evaluation with a message', () => {
    const msg = validateContract({ ...baseContract(), evaluation: '   ' });
    expect(typeof msg).toBe('string');
    expect(msg).toMatch(/evaluation/i);
  });

  it('rejects a missing job / inputs / output', () => {
    expect(validateContract({ ...baseContract(), job: '' })).toMatch(/job/i);
    expect(validateContract({ ...baseContract(), inputs: '' })).toMatch(/inputs/i);
    expect(validateContract({ ...baseContract(), output: '' })).toMatch(/output/i);
  });

  // Fix 2 (spec §11): auto-low-risk with review off is an unsafe combination — no maker/checker
  // can ever run, so an auto-merge would have no review. Reject it at validateContract.
  it('rejects mergePosture=auto-low-risk + reviewPolicy=off (no review → no safe auto-merge)', () => {
    const msg = validateContract(baseContract(), { mergePosture: 'auto-low-risk', reviewPolicy: 'off' });
    expect(typeof msg).toBe('string');
    expect(msg).toMatch(/review/i);
  });

  it('allows auto-low-risk when review is on (always)', () => {
    expect(validateContract(baseContract(), { mergePosture: 'auto-low-risk', reviewPolicy: 'always' })).toBeNull();
  });

  it('allows human-gate + review off (no auto-merge → safe)', () => {
    expect(validateContract(baseContract(), { mergePosture: 'human-gate', reviewPolicy: 'off' })).toBeNull();
  });
});

describe('compileContract — permissions compilation (spec §10)', () => {
  it('manager → read-only mode; allowed maps to allowedTools', async () => {
    const loop = loopsRepo.create({
      name: 'm-compile',
      projectId: PID,
      kind: 'manager',
      contract: { ...baseContract(), allowed: ['Read', 'Grep', 'Glob'], forbidden: ['Edit', 'Write'] },
    });
    const project = projectsRepo.getProject(PID)!;
    const out = compileContract(loop, project);
    expect(out.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    // managers are read-only / non-interactive → never bypassPermissions
    expect(out.permissionMode).toBe('default');
    // forbidden is merged ON TOP of the project baseline (which always denies git push/remote)
    expect(out.disallowedTools).toContain('Edit');
    expect(out.disallowedTools).toContain('Write');
    expect(out.disallowedTools.some((t: string) => /git\s+push/.test(t))).toBe(true);
  });

  it('worker → bypassPermissions; forbidden may only ADD denies, never relax the baseline', async () => {
    const loop = loopsRepo.create({
      name: 'w-compile',
      projectId: PID,
      kind: 'worker',
      // even if a contract tries to "forbid nothing", the project baseline deny survives
      contract: { ...baseContract(), allowed: ['Edit', 'Bash'], forbidden: [] },
    });
    const project = projectsRepo.getProject(PID)!;
    const baseline = (await import('../src/pm.js')).disallowedToolsForProject(project);
    const out = compileContract(loop, project);
    expect(out.permissionMode).toBe('bypassPermissions');
    // every baseline deny is still present (compilation only adds, never removes)
    for (const d of baseline) expect(out.disallowedTools).toContain(d);
    // no duplicate entries
    expect(new Set(out.disallowedTools).size).toBe(out.disallowedTools.length);
  });
});

describe('applyEvalResult — escalation counter (spec §6.2, the heart of the lifecycle)', () => {
  const clean = (n: number) => ({ clean: true, score: n, notes: 'ok' });
  const dirty = { clean: false, score: 0, notes: 'risky' };

  it('a clean dry-run increments consecutive_good_runs; stays dry-run below threshold', () => {
    const loop = loopsRepo.create({
      name: 'esc-1', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1));
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(1);
    expect(loopsRepo.get(loop.id)!.mode).toBe('dry-run');
    applyEvalResult(loopsRepo.get(loop.id)!, clean(2));
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(2);
    expect(loopsRepo.get(loop.id)!.mode).toBe('dry-run');
  });

  it('a non-clean dry-run resets the counter to 0 and keeps dry-run', () => {
    const loop = loopsRepo.create({
      name: 'esc-2', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1));
    applyEvalResult(loopsRepo.get(loop.id)!, dirty);
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(0);
    expect(loopsRepo.get(loop.id)!.mode).toBe('dry-run');
  });

  it('reaching escalation_threshold auto-flips to apply and writes a notification', () => {
    const loop = loopsRepo.create({
      name: 'esc-3', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    const before = (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='loop-escalation'").get() as any).c;
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1));
    applyEvalResult(loopsRepo.get(loop.id)!, clean(2));
    applyEvalResult(loopsRepo.get(loop.id)!, clean(3));
    const fresh = loopsRepo.get(loop.id)!;
    expect(fresh.consecutiveGoodRuns).toBe(3);
    expect(fresh.mode).toBe('apply');
    const after = (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='loop-escalation'").get() as any).c;
    expect(after).toBe(before + 1);
  });

  it('an already-apply loop is a no-op for the counter (never re-grants)', () => {
    const loop = loopsRepo.create({
      name: 'esc-4', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 1,
    });
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1)); // flips to apply at threshold 1
    expect(loopsRepo.get(loop.id)!.mode).toBe('apply');
    applyEvalResult(loopsRepo.get(loop.id)!, dirty); // apply-mode: counter logic is skipped
    expect(loopsRepo.get(loop.id)!.mode).toBe('apply');
  });
});

describe('loops singleton — fire(manager) drives runManagerLoop → grade → escalate', () => {
  it('a dry-run manager fire grades the intended actions and bumps the counter on a clean eval', async () => {
    const loop = loopsRepo.create({
      name: 'fire-mgr', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });

    // Stub the cross-slice collaborators by property-reassign on their module namespaces
    const manager = await import('../src/manager.js');
    const controlplane = await import('../src/controlplane.js');
    const loopEval = await import('../src/loopEval.js');
    // The dry-run wrapper records intended actions INTO the tuple's `intended` array; fire() grades
    // THAT array (not runManagerLoop's return value).
    const intended: any[] = [];
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [{ id: 'c1', title: 't', body: '', labels: [] }], listReady: async () => [] }, intended });
    (manager as any).runManagerLoop = async (_l: any, _p: any, _cp: any) => { intended.push({ kind: 'classify' as const, itemId: 'c1', detail: {} }); return intended; };
    // gradeLoopRun receives the TUPLE's intended array (asserts the wiring routed it through).
    let graded: any[] | null = null;
    (loopEval as any).gradeLoopRun = async (_l: any, recvIntended: any[]) => { graded = recvIntended; return { clean: true, score: 1, notes: 'clean' }; };

    await loops.fire(loop.id);

    expect(graded).toEqual([{ kind: 'classify', itemId: 'c1', detail: {} }]); // graded the tuple's intended
    const fresh = loopsRepo.get(loop.id)!;
    expect(fresh.consecutiveGoodRuns).toBe(1);
    expect(fresh.lastEval?.clean).toBe(true);
    expect(fresh.mode).toBe('dry-run'); // below threshold
  });

  it('fire on a disabled / missing loop is a safe no-op (never throws)', async () => {
    await expect(loops.fire('no-such-loop')).resolves.toBeUndefined();
    const loop = loopsRepo.create({ name: 'fire-off', projectId: PID, kind: 'manager', contract: baseContract() });
    loopsRepo.update(loop.id, { enabled: false });
    await expect(loops.fire(loop.id)).resolves.toBeUndefined();
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(0);
  });

  it('a NON-cap error in fire() is swallowed into last_error and resets the dry-run counter', async () => {
    const loop = loopsRepo.create({
      name: 'fire-err', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    // Seed a non-zero counter so we can prove the error path resets it to 0.
    applyEvalResult(loopsRepo.get(loop.id)!, { clean: true, score: 1, notes: 'ok' });
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(1);

    const manager = await import('../src/manager.js');
    // A plain error (no statusCode 429 / code 'daily-cap') must NOT propagate.
    (manager as any).runManagerLoop = async () => { throw new Error('manager boom'); };

    await expect(loops.fire(loop.id)).resolves.toBeUndefined(); // (a) does not throw
    const fresh = loopsRepo.get(loop.id)!;
    expect(fresh.lastError).toBe('manager boom'); // (b) recordRun captured the message
    expect(fresh.consecutiveGoodRuns).toBe(0); // (c) the dry-run counter was reset
    expect(fresh.mode).toBe('dry-run'); // never auto-escalates on an error
  });

  it('hasWork is false for missing/disabled and reflects the control-plane list length', async () => {
    // Missing loop → false.
    expect(await loops.hasWork('no-such-loop')).toBe(false);

    // Disabled loop → false (no probe spend).
    const off = loopsRepo.create({ name: 'hw-off', projectId: PID, kind: 'manager', contract: baseContract() });
    loopsRepo.update(off.id, { enabled: false });
    expect(await loops.hasWork(off.id)).toBe(false);

    // Manager with backlog → true; empty backlog → false (stub controlPlaneFor's listBacklog).
    const controlplane = await import('../src/controlplane.js');
    const mgr = loopsRepo.create({ name: 'hw-mgr', projectId: PID, kind: 'manager', contract: baseContract() });
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [{ id: 'c1', title: 't', body: '', labels: [] }], listReady: async () => [] }, intended: [] });
    expect(await loops.hasWork(mgr.id)).toBe(true);
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [], listReady: async () => [] }, intended: [] });
    expect(await loops.hasWork(mgr.id)).toBe(false);

    // Worker probes listReady.
    const wkr = loopsRepo.create({ name: 'hw-wkr', projectId: PID, kind: 'worker', contract: baseContract() });
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [], listReady: async () => [{ id: 'r1', title: 't', body: '', labels: [] }] }, intended: [] });
    expect(await loops.hasWork(wkr.id)).toBe(true);

    // A throwing adapter never propagates — hasWork resolves false.
    (controlplane as any).controlPlaneFor = () => { throw new Error('adapter boom'); };
    expect(await loops.hasWork(mgr.id)).toBe(false);
  });
});

describe('loop routes (spec §16)', () => {
  it('POST /api/loops rejects an empty contract.evaluation with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r1', projectId: PID, kind: 'manager', contract: { ...baseContract(), evaluation: '' } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/evaluation/i);
  });

  it('POST /api/loops rejects auto-low-risk + reviewPolicy off with 400 (Fix 2 §11)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r-unsafe', projectId: PID, kind: 'worker', contract: baseContract(), mergePosture: 'auto-low-risk', reviewPolicy: 'off' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/review/i);
  });

  it('POST then GET list + detail', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r2', projectId: PID, kind: 'manager', contract: baseContract() },
    });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id;

    const list = await app.inject({ method: 'GET', url: '/api/loops', headers: H() });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).some((l: any) => l.id === id)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/loops/${id}`, headers: H() });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).mode).toBe('dry-run');
  });

  it('PUT re-validates the contract; promote/demote flip the mode; DELETE removes', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r3', projectId: PID, kind: 'manager', contract: baseContract() },
    });
    const id = JSON.parse(created.body).id;

    const badPut = await app.inject({
      method: 'PUT', url: `/api/loops/${id}`, headers: H(),
      payload: { contract: { ...baseContract(), evaluation: '' } },
    });
    expect(badPut.statusCode).toBe(400);

    const promote = await app.inject({ method: 'POST', url: `/api/loops/${id}/promote`, headers: H() });
    expect(promote.statusCode).toBe(200);
    expect(JSON.parse(promote.body).mode).toBe('apply');

    const demote = await app.inject({ method: 'POST', url: `/api/loops/${id}/demote`, headers: H() });
    const demoteBody = JSON.parse(demote.body);
    expect(demoteBody.mode).toBe('dry-run');
    expect(demoteBody.consecutiveGoodRuns).toBe(0); // demoting restarts the dry-run ramp

    const fired = await app.inject({ method: 'POST', url: `/api/loops/${id}/fire`, headers: H() });
    expect(fired.statusCode).toBe(200);
    const firedBody = JSON.parse(fired.body);
    expect(firedBody.ok).toBe(true);
    expect(firedBody).toHaveProperty('runId');
    expect(firedBody.loop.id).toBe(id);

    const del = await app.inject({ method: 'DELETE', url: `/api/loops/${id}`, headers: H() });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: `/api/loops/${id}`, headers: H() });
    expect(gone.statusCode).toBe(404);
  });
});
