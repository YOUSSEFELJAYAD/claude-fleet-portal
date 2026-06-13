/**
 * Real/behavioral coverage for src/campaigns.ts — the portal's campaign engine.
 *
 * Strategy: drive the engine's REAL logic (create → plan → schedule workers →
 * synthesize/finalize → kill) by controlling only the registry boundary. We
 * replace registry.launch/getRun/stop with deterministic stubs and capture the
 * engine's onRunTerminal handler (registered in init()) so we can synchronously
 * feed it terminal Run snapshots. Every test asserts real DB side-effects (the
 * campaign/task rows) and the messages broadcast to subscribers — never just
 * "called it for coverage".
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-cov-campaigns-'));

let repo: any;
let registry: any;
let campaigns: any;
let planHasCycle: (t: { id: string; dependsOn?: string[] }[]) => boolean;
let planHasDupIds: (t: { id: string }[]) => boolean;
let seedTemplates: () => void;
let projects: typeof import('../src/projects.js');

// The engine's terminal handler, captured when init() subscribes via registry.onRunTerminal.
let terminalCb: (run: any) => void;

// In-memory fake run store the stubs read/write. We never spawn a real CLI.
const fakeRuns = new Map<string, any>();
let launchQueue: any[] = []; // runs launch() returns, FIFO
let launchCalls: any[] = []; // every LaunchRequest seen
let stopCalls: string[] = [];

const mkFakeRun = (over: Partial<any> = {}): any => ({
  id: 'run-' + Math.random().toString(36).slice(2, 9),
  status: 'running',
  campaignId: null,
  resultText: null,
  structuredOutput: null,
  costUsd: 0,
  ...over,
});

beforeAll(async () => {
  ({ repo } = await import('../src/db.js'));
  ({ registry } = await import('../src/registry.js'));
  projects = await import('../src/projects.js');
  ({ seedTemplates } = await import('../src/templates.js'));
  const camMod = await import('../src/campaigns.js');
  campaigns = camMod.campaigns;
  planHasCycle = camMod.planHasCycle;
  planHasDupIds = camMod.planHasDupIds;

  // Populate the agent_templates table so tpl() resolves real built-ins by role/name.
  seedTemplates();

  // ── stub the registry boundary on the singleton ──
  registry.launch = (req: any) => {
    launchCalls.push(req);
    const run = launchQueue.shift() ?? mkFakeRun({ campaignId: req.campaignId });
    run.campaignId = req.campaignId ?? run.campaignId;
    fakeRuns.set(run.id, run);
    return run; // launch() can return sync (Run) or Promise<Run>; sync is allowed
  };
  registry.getRun = (id: string) => (fakeRuns.has(id) ? { ...fakeRuns.get(id) } : null);
  registry.stop = (id: string) => {
    stopCalls.push(id);
    const r = fakeRuns.get(id);
    if (r && !['completed', 'failed', 'killed'].includes(r.status)) r.status = 'killed';
  };

  // Capture the engine's terminal handler instead of letting it ride the real run lifecycle.
  registry.onRunTerminal = (cb: any) => {
    terminalCb = cb;
    return () => {};
  };

  // init() wires onRunTerminal + onProjectDeleted — the heart of the reactive engine.
  campaigns.init();
});

beforeEach(() => {
  // Kill every leftover live campaign FIRST. The engine's handleRunTerminal ends with
  // tickActive(), which re-schedules ALL non-terminal campaigns from the shared DB — a
  // stale 'spawning'/'running' campaign from a prior test would otherwise steal this
  // test's queued launch runs. Terminal (killed) campaigns are skipped by tickActive().
  for (const c of repo.listCampaigns()) {
    if (!['completed', 'failed', 'killed'].includes(c.status)) {
      try { campaigns.kill(c.id); } catch { /* already gone */ }
    }
  }
  launchQueue = [];
  launchCalls = [];
  stopCalls = [];
});

// Helper: collect every campaign/task message a subscriber receives for an id.
function collect(id: string) {
  const msgs: any[] = [];
  const unsub = campaigns.subscribe(id, (m: any) => msgs.push(m));
  return { msgs, unsub };
}

// Helper: fire the engine's terminal handler for a fake run, then drain microtasks.
// handleRunTerminal kicks off the ASYNC schedule()/launchWorker() chain as fire-and-forget
// (`void this.schedule()`), so worker launches land on later microtasks — we await them out.
async function terminal(runId: string, patch: Partial<any> = {}) {
  const r = { ...fakeRuns.get(runId), ...patch };
  fakeRuns.set(runId, r);
  terminalCb(r);
  await drain();
}

// Flush the microtask queue a few times so chained awaits (schedule → launchWorker →
// recompute → emit) all settle before assertions read the DB.
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Look up the live runId the engine actually assigned to a task, then terminate THAT run.
// (onOrchestratorDone fires schedule() AND handleRunTerminal fires tickActive() → a task can
// be launched twice under the synchronous stub; the persisted runId is the authoritative one.)
function taskRunId(campaignId: string, taskId: string): string {
  const t = repo.getTasks(campaignId).find((x: any) => x.id === taskId);
  if (!t?.runId) throw new Error(`task ${taskId} has no runId`);
  return t.runId;
}
async function finishTask(campaignId: string, taskId: string, status: 'completed' | 'failed', patch: any = {}) {
  const runId = taskRunId(campaignId, taskId);
  const r = fakeRuns.get(runId);
  if (r) Object.assign(r, { status, ...patch });
  await terminal(runId, { status, ...patch });
}

// ── pure validators ───────────────────────────────────────────────────────────
describe('planHasCycle / planHasDupIds — edge cases', () => {
  it('detects 2-node cycles, self-deps; clears acyclic + dangling-dep plans', () => {
    expect(planHasCycle([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toBe(true);
    expect(planHasCycle([{ id: 'a', dependsOn: ['a'] }])).toBe(true); // self-edge
    // 3-node back-edge a→b→c→a
    expect(planHasCycle([
      { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: ['a'] },
    ])).toBe(true);
    // diamond (a→b, a→c, b→d, c→d) is a DAG, not a cycle
    expect(planHasCycle([
      { id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a'] }, { id: 'd', dependsOn: ['b', 'c'] },
    ])).toBe(false);
    expect(planHasCycle([{ id: 'a', dependsOn: ['ghost'] }])).toBe(false); // dep outside id-set ignored
    expect(planHasCycle([])).toBe(false);
    // numeric ids coerce through String() — a self-dep across number/string still detected
    expect(planHasCycle([{ id: 1 as any, dependsOn: [1 as any] }])).toBe(true);
  });

  it('flags duplicate ids (incl. number/string collisions); passes unique sets', () => {
    expect(planHasDupIds([{ id: 'x' }, { id: 'x' }])).toBe(true);
    expect(planHasDupIds([{ id: 'x' }, { id: 'y' }, { id: 'x' }])).toBe(true);
    expect(planHasDupIds([{ id: 1 as any }, { id: '1' as any }])).toBe(true); // String() coercion collides
    expect(planHasDupIds([{ id: 'x' }, { id: 'y' }, { id: 'z' }])).toBe(false);
    expect(planHasDupIds([])).toBe(false);
  });
});

// ── create() ────────────────────────────────────────────────────────────────────
describe('create() — validation, persistence, orchestrator launch', () => {
  it('rejects a blank objective or cwd with a 400', async () => {
    await expect(campaigns.create({ objective: '   ', cwd: '/tmp' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(campaigns.create({ objective: 'x', cwd: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(campaigns.create({ objective: 'x' } as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('persists a planning campaign, launches the orchestrator, and records its runId', async () => {
    const orch = mkFakeRun({ id: 'orch-ok', status: 'running' });
    launchQueue = [orch];
    const c = await campaigns.create({ objective: 'Build a thing', cwd: '/tmp', maxParallel: 99 });

    // returned campaign + persisted row agree, status flips planning→has orchestrator
    const row = repo.getCampaign(c.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('planning');
    expect(row.orchestratorRunId).toBe('orch-ok');
    expect(row.maxParallel).toBe(16); // clamped to [1,16]
    expect(row.objective).toBe('Build a thing');

    // the orchestrator launch carried the campaign id, the json-schema, and non-interactive flag
    const orchLaunch = launchCalls.find((l) => l.jsonSchema);
    expect(orchLaunch).toBeTruthy();
    expect(orchLaunch.campaignId).toBe(c.id);
    expect(orchLaunch.interactive).toBe(false);
  });

  it('falls back by role when an unknown orchestrator template name is given', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-fb' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', orchestratorTemplate: 'NoSuchTemplate' });
    // tpl() ignored the bad name and fell back to the role:'orchestrator' built-in.
    expect(repo.getCampaign(c.id).orchestratorTemplate).toBe('Orchestrator');
  });

  it('fails the campaign and rethrows when the orchestrator launch throws', async () => {
    const boom = Object.assign(new Error('cli missing'), { statusCode: 500 });
    const realLaunch = registry.launch;
    registry.launch = () => { throw boom; };
    let createdId: string | undefined;
    // capture the id via a list subscription (the failed campaign is still emitted)
    const seen: any[] = [];
    const unsub = campaigns.subscribeList((c: any) => seen.push(c));
    try {
      await expect(campaigns.create({ objective: 'o', cwd: '/tmp' })).rejects.toThrow('cli missing');
    } finally {
      registry.launch = realLaunch;
      unsub();
    }
    const failed = seen.find((c) => c.status === 'failed');
    expect(failed).toBeTruthy();
    createdId = failed.id;
    expect(repo.getCampaign(createdId).status).toBe('failed');
    expect(repo.getCampaign(createdId).endedAt).toBeTruthy();
  });
});

// ── subscribe / onCampaignTerminal ───────────────────────────────────────────────
describe('subscribe() + onCampaignTerminal() pub/sub', () => {
  it('subscribe returns null for an unknown campaign and a hello frame for a known one', async () => {
    expect(campaigns.subscribe('does-not-exist', () => {})).toBeNull();

    launchQueue = [mkFakeRun({ id: 'orch-sub' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp' });
    const { msgs, unsub } = collect(c.id);
    expect(msgs[0]?.kind).toBe('campaign-hello'); // immediate hello on subscribe
    expect(msgs[0].campaign.id).toBe(c.id);
    unsub();
  });

  it('a throwing subscriber (per-id, list, or terminal) never breaks the broadcast', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-throw' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp' });

    // 1) a throwing per-id subscriber must not stop a well-behaved one from receiving.
    // (subscribe() delivers the initial 'campaign-hello' OUTSIDE the broadcast try/catch, so
    // only throw on later broadcast frames — the path lines 144-150 actually guard.)
    const good: any[] = [];
    const unsubBad = campaigns.subscribe(c.id, (m: any) => { if (m.kind !== 'campaign-hello') throw new Error('bad per-id sub'); });
    const unsubGood = campaigns.subscribe(c.id, (m: any) => good.push(m));
    // 2) a throwing list subscriber must not stop the engine from persisting/emitting.
    const unsubListBad = campaigns.subscribeList(() => { throw new Error('bad list sub'); });
    // 3) a throwing onCampaignTerminal subscriber must not break the terminal broadcast.
    const unsubTermBad = campaigns.onCampaignTerminal(() => { throw new Error('bad terminal sub'); });

    try {
      campaigns.kill(c.id); // drives emitCampaign → broadcast(per-id) + listSubs, plus terminal
    } finally {
      unsubBad(); unsubGood(); unsubListBad(); unsubTermBad();
    }
    // engine still persisted the kill despite every subscriber throwing
    expect(repo.getCampaign(c.id).status).toBe('killed');
    // the good per-id subscriber still received the terminal campaign frame
    expect(good.some((m) => m.kind === 'campaign' && m.campaign.status === 'killed')).toBe(true);
  });

  it('fires onCampaignTerminal exactly once per campaign, only on a terminal status', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-term' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp' });
    const fired: string[] = [];
    const unsub = campaigns.onCampaignTerminal((x: any) => fired.push(x.status));
    try {
      // re-emit a non-terminal status → no fire
      campaigns.view(c.id); // touch
      // kill makes it terminal → exactly one fire even though kill re-emits twice (status + cost rollup)
      campaigns.kill(c.id);
      campaigns.kill(c.id); // idempotent: already terminal, returns early, no second emit
      expect(fired).toEqual(['killed']);
    } finally {
      unsub();
    }
  });
});

// ── handleRunTerminal → onOrchestratorDone (plan validation) ─────────────────────
describe('orchestrator completion → plan validation', () => {
  async function planningCampaign(orchId: string) {
    launchQueue = [mkFakeRun({ id: orchId, status: 'running' })];
    return campaigns.create({ objective: 'obj', cwd: '/tmp', autoSynthesize: false });
  }

  it('fails the campaign when the orchestrator produced no usable plan', async () => {
    const c = await planningCampaign('orch-noplan');
    const { msgs, unsub } = collect(c.id);
    // completed run but structuredOutput null + non-JSON resultText → no plan
    await terminal('orch-noplan', { status: 'completed', resultText: 'not json', structuredOutput: null });
    unsub();
    expect(repo.getCampaign(c.id).status).toBe('failed');
    expect(msgs.some((m) => m.kind === 'campaign' && m.campaign.status === 'failed')).toBe(true);
  });

  it('fails when the run itself did not complete (status=failed)', async () => {
    const c = await planningCampaign('orch-failed');
    await terminal('orch-failed', { status: 'failed', structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p' }] } });
    expect(repo.getCampaign(c.id).status).toBe('failed');
  });

  it('rejects a plan with duplicate task ids', async () => {
    const c = await planningCampaign('orch-dup');
    await terminal('orch-dup', {
      status: 'completed',
      structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p' }, { id: 't1', title: 'b', prompt: 'q' }] },
    });
    expect(repo.getCampaign(c.id).status).toBe('failed');
    expect(repo.getTasks(c.id).length).toBe(0); // never persisted the malformed tasks
  });

  it('rejects a plan containing a dependency cycle', async () => {
    const c = await planningCampaign('orch-cycle');
    await terminal('orch-cycle', {
      status: 'completed',
      structuredOutput: { tasks: [
        { id: 't1', title: 'a', prompt: 'p', dependsOn: ['t2'] },
        { id: 't2', title: 'b', prompt: 'q', dependsOn: ['t1'] },
      ] },
    });
    expect(repo.getCampaign(c.id).status).toBe('failed');
  });

  it('parses a legacy JSON-string resultText when structuredOutput is absent', async () => {
    const c = await planningCampaign('orch-legacy');
    // single task, no deps → schedules immediately, launching one worker
    await terminal('orch-legacy', {
      status: 'completed',
      structuredOutput: null,
      resultText: JSON.stringify({ tasks: [{ id: 't1', title: 'only', prompt: 'do it' }] }),
    });
    const tasks = repo.getTasks(c.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe('t1');
    // the legacy JSON-string plan was accepted and a worker run was launched for it
    expect(tasks[0].status).toBe('running');
    expect(tasks[0].runId).toBeTruthy();
    // the worker launch carried the campaign id and was non-interactive
    const workerLaunch = launchCalls.find((l) => !l.jsonSchema && l.campaignId === c.id);
    expect(workerLaunch).toBeTruthy();
    expect(workerLaunch.interactive).toBe(false);
  });
});

// ── full schedule lifecycle: DAG, cascade-skip, finalize, synthesize ─────────────
describe('scheduler — dependency DAG, cascade-skip, finalize', () => {
  it('honors dependsOn + maxParallel, then finalizes completed (no synth)', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-dag' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', maxParallel: 1, autoSynthesize: false });

    // plan: t1 then t2(dep t1). maxParallel 1 → only t1 launches first.
    await terminal('orch-dag', {
      status: 'completed',
      structuredOutput: { tasks: [
        { id: 't1', title: 'first', prompt: 'p1' },
        { id: 't2', title: 'second', prompt: 'p2', dependsOn: ['t1'] },
      ] },
    });
    let tasks = repo.getTasks(c.id);
    expect(tasks.find((t: any) => t.id === 't1').status).toBe('running');
    expect(tasks.find((t: any) => t.id === 't2').status).toBe('pending'); // dep not done + cap=1
    expect(repo.getCampaign(c.id).status).toBe('running');

    // complete t1 → t2's dep satisfied → t2 launches
    await finishTask(c.id, 't1', 'completed');
    tasks = repo.getTasks(c.id);
    expect(tasks.find((t: any) => t.id === 't1').status).toBe('completed');
    expect(tasks.find((t: any) => t.id === 't2').status).toBe('running');

    // complete t2 → all terminal, no synth → finalize completed
    await finishTask(c.id, 't2', 'completed');
    const fin = repo.getCampaign(c.id);
    expect(fin.status).toBe('completed');
    expect(fin.endedAt).toBeTruthy();
  });

  it('cascade-skips a pending task whose dependency failed', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-skip' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', maxParallel: 1, autoSynthesize: false });

    await terminal('orch-skip', {
      status: 'completed',
      structuredOutput: { tasks: [
        { id: 't1', title: 'a', prompt: 'p1' },
        { id: 't2', title: 'b', prompt: 'p2', dependsOn: ['t1'] },
      ] },
    });
    // t1 FAILS → t2 can never run → cascade-skip → campaign finalizes (none completed → failed).
    await finishTask(c.id, 't1', 'failed');
    const tasks = repo.getTasks(c.id);
    expect(tasks.find((t: any) => t.id === 't1').status).toBe('failed');
    expect(tasks.find((t: any) => t.id === 't2').status).toBe('skipped');
    // all terminal, none completed → finalize as failed
    expect(repo.getCampaign(c.id).status).toBe('failed');
  });

  it('launches a synthesizer when autoSynthesize is on and any task completed', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-syn' })];
    const c = await campaigns.create({
      objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: true, synthesizerTemplate: 'Synthesizer',
    });
    await terminal('orch-syn', {
      status: 'completed',
      structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p1' }] },
    });
    // complete the only worker (with a result) → all terminal + autoSynthesize → synthesizer launches
    await finishTask(c.id, 't1', 'completed', { resultText: 'worker output' });

    const mid = repo.getCampaign(c.id);
    expect(mid.status).toBe('synthesizing');
    expect(mid.synthesizerRunId).toBeTruthy();
    // synth prompt embedded the worker result + objective
    const synLaunch = launchCalls.find((l) => l.prompt?.includes('Synthesize'));
    expect(synLaunch).toBeTruthy();
    expect(synLaunch.prompt).toContain('worker output');

    // synth completes → finalize completed
    await terminal(mid.synthesizerRunId, { status: 'completed' });
    expect(repo.getCampaign(c.id).status).toBe('completed');
  });

  it('leaves a worker pending (not failed) when launch is rate-limited (429)', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-429' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: false });
    // orchestrator done → schedule tries to launch the worker but registry.launch throws 429
    const realLaunch = registry.launch;
    registry.launch = (req: any) => {
      if (req.campaignId === c.id && !req.jsonSchema) {
        throw Object.assign(new Error('busy'), { statusCode: 429 });
      }
      return realLaunch(req);
    };
    try {
      await terminal('orch-429', {
        status: 'completed',
        structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p1' }] },
      });
    } finally {
      registry.launch = realLaunch;
    }
    const t = repo.getTasks(c.id).find((x: any) => x.id === 't1');
    expect(t.status).toBe('pending'); // transient → retried later, NOT failed
    expect(t.runId).toBeNull();
    expect(repo.getCampaign(c.id).status).toBe('running');
  });

  it('marks a task FAILED when its worker launch throws a NON-transient error', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-wfail' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: false });
    const realLaunch = registry.launch;
    registry.launch = (req: any) => {
      if (req.campaignId === c.id && !req.jsonSchema) {
        throw Object.assign(new Error('bad cwd'), { statusCode: 500 }); // not 429/daily-cap
      }
      return realLaunch(req);
    };
    try {
      await terminal('orch-wfail', {
        status: 'completed',
        structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p1' }] },
      });
    } finally {
      registry.launch = realLaunch;
    }
    const t = repo.getTasks(c.id).find((x: any) => x.id === 't1');
    expect(t.status).toBe('failed'); // permanent error → task failed (DAG not wedged)
    // all tasks terminal, none completed, no synth → campaign finalizes failed
    expect(repo.getCampaign(c.id).status).toBe('failed');
  });

  it('reverts to running (not failed) when the SYNTHESIZER launch is rate-limited (429)', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-s429' })];
    const c = await campaigns.create({
      objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: true, synthesizerTemplate: 'Synthesizer',
    });
    await terminal('orch-s429', {
      status: 'completed',
      structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p1' }] },
    });
    // when the worker completes, schedule() tries the synthesizer launch — make THAT throw 429.
    const realLaunch = registry.launch;
    registry.launch = (req: any) => {
      if (req.prompt?.includes('Synthesize')) throw Object.assign(new Error('busy'), { statusCode: 429 });
      return realLaunch(req);
    };
    try {
      await finishTask(c.id, 't1', 'completed', { resultText: 'r' });
    } finally {
      registry.launch = realLaunch;
    }
    const row = repo.getCampaign(c.id);
    expect(row.status).toBe('running'); // capped → retried later, synthesizerRunId still null
    expect(row.synthesizerRunId).toBeNull();
  });

  it('fails the campaign when the SYNTHESIZER launch throws a non-transient error', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-sfail' })];
    const c = await campaigns.create({
      objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: true, synthesizerTemplate: 'Synthesizer',
    });
    await terminal('orch-sfail', {
      status: 'completed',
      structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p1' }] },
    });
    const realLaunch = registry.launch;
    registry.launch = (req: any) => {
      if (req.prompt?.includes('Synthesize')) throw Object.assign(new Error('corrupt template'), { statusCode: 500 });
      return realLaunch(req);
    };
    try {
      await finishTask(c.id, 't1', 'completed', { resultText: 'r' });
    } finally {
      registry.launch = realLaunch;
    }
    // permanent error would wedge the campaign in 'running' forever → engine fails it instead
    expect(repo.getCampaign(c.id).status).toBe('failed');
  });
});

// ── kill / killAll / view / list ─────────────────────────────────────────────────
describe('control + reads — kill, killAll, view, list', () => {
  it('kill() throws 404 for an unknown campaign', () => {
    expect(() => campaigns.kill('ghost-campaign')).toThrowError(/not found/);
  });

  it('kill() marks terminal first, stops live runs, skips non-terminal tasks, rolls up cost', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-kill', status: 'running', costUsd: 1 })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: false });
    await terminal('orch-kill', {
      status: 'completed', costUsd: 1,
      structuredOutput: { tasks: [{ id: 't1', title: 'a', prompt: 'p' }] },
    });
    expect(repo.getTasks(c.id)[0].status).toBe('running');

    // pin the live worker's cost so rollup is deterministic (orchestrator 1 + worker 2)
    const workerRunId = taskRunId(c.id, 't1');
    fakeRuns.get(workerRunId).costUsd = 2;

    campaigns.kill(c.id);
    const row = repo.getCampaign(c.id);
    expect(row.status).toBe('killed');
    expect(row.endedAt).toBeTruthy();
    // the live worker run was stopped; the running task flipped to skipped
    expect(stopCalls).toContain(workerRunId);
    expect(repo.getTasks(c.id)[0].status).toBe('skipped');
    // cost rolled up = orchestrator(1) + worker(2)
    expect(row.costUsd).toBe(3);
  });

  it('kill() is a no-op on an already-terminal campaign', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-noop' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp' });
    campaigns.kill(c.id);
    stopCalls = [];
    campaigns.kill(c.id); // already killed → returns early, no stop() calls
    expect(stopCalls).toEqual([]);
  });

  it('killAll() kills every live campaign and returns the count', async () => {
    // start from a clean slate count of live campaigns
    for (const c of repo.listCampaigns()) {
      if (!['completed', 'failed', 'killed'].includes(c.status)) campaigns.kill(c.id);
    }
    launchQueue = [mkFakeRun({ id: 'ka1' })];
    const a = await campaigns.create({ objective: 'o1', cwd: '/tmp' });
    launchQueue = [mkFakeRun({ id: 'ka2' })];
    const b = await campaigns.create({ objective: 'o2', cwd: '/tmp' });
    const killed = campaigns.killAll();
    expect(killed).toBe(2);
    expect(repo.getCampaign(a.id).status).toBe('killed');
    expect(repo.getCampaign(b.id).status).toBe('killed');
    expect(campaigns.killAll()).toBe(0); // nothing live left
  });

  it('view() returns null for unknown, and rich counters for a real campaign', async () => {
    expect(campaigns.view('nope')).toBeNull();

    launchQueue = [mkFakeRun({ id: 'orch-view' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', maxParallel: 4, autoSynthesize: false });
    await terminal('orch-view', {
      status: 'completed', costUsd: 1,
      structuredOutput: { tasks: [
        { id: 't1', title: 'a', prompt: 'p' },
        { id: 't2', title: 'b', prompt: 'q', dependsOn: ['t1'] },
      ] },
    });
    // pin the orchestrator + live worker costs so the live rollup is deterministic
    fakeRuns.get('orch-view').costUsd = 1;
    fakeRuns.get(taskRunId(c.id, 't1')).costUsd = 5;

    const v = campaigns.view(c.id);
    expect(v.taskCount).toBe(2);
    expect(v.tasks.length).toBe(2);
    expect(v.liveWorkers).toBe(1); // only t1 running (t2 blocked on t1)
    expect(v.doneCount).toBe(0); // none terminal yet
    // non-terminal campaign → cost recomputed live (orchestrator 1 + worker 5)
    expect(v.costUsd).toBe(6);
  });

  it('list() returns campaigns with per-row counters', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-list' })];
    const c = await campaigns.create({ objective: 'list-me', cwd: '/tmp' });
    const rows = campaigns.list();
    const mine = rows.find((r: any) => r.id === c.id);
    expect(mine).toBeTruthy();
    expect(typeof mine.taskCount).toBe('number');
    expect(typeof mine.liveWorkers).toBe('number');
  });
});

// ── onProjectDeleted cascade (init wiring) ───────────────────────────────────────
describe('project deletion cascade kills live campaigns of that project', () => {
  it('kills only the deleted project’s non-terminal campaigns', async () => {
    launchQueue = [mkFakeRun({ id: 'orch-proj' })];
    const c = await campaigns.create({ objective: 'o', cwd: '/tmp', projectId: 'proj-XYZ' } as any);
    expect(repo.getCampaign(c.id).projectId).toBe('proj-XYZ');
    expect(['planning', 'spawning', 'running']).toContain(repo.getCampaign(c.id).status);

    // deleteProject() synchronously fires every onProjectDeleted listener — including the one
    // the campaign engine registered in init() — regardless of whether a project row exists.
    projects.projectsRepo.deleteProject('proj-XYZ');

    expect(repo.getCampaign(c.id).status).toBe('killed');
  });
});
