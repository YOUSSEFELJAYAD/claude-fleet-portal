/**
 * Slice 06 tests: Manager template profile, applyRubricFloors (PURE), and runManagerLoop.
 *
 * The test file runs in two logical groups:
 *   1. Manager template profile (Task 06.1): seedTemplates plants a read-only Manager builtin.
 *   2. applyRubricFloors (Task 06.2): PURE deterministic rubric hard-floor matching.
 *   3. runManagerLoop (Tasks 06.3 + 06.4): backlog triage with a fake ControlPlane + intercepted registry.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Isolate SQLite to a temp dir per test run.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-mgr-'));

// ── 1. Manager template profile ───────────────────────────────────────────────

let seedTemplates: typeof import('../src/templates.js').seedTemplates;
let repo: typeof import('../src/db.js').repo;

describe('Manager template profile', () => {
  beforeAll(async () => {
    ({ seedTemplates } = await import('../src/templates.js'));
    ({ repo } = await import('../src/db.js'));
    seedTemplates();
  });

  it('seeds a read-only Manager builtin (no write/edit tools, default permission mode)', () => {
    const t = repo.getTemplateByName('Manager');
    expect(t).toBeTruthy();
    expect(t!.role).toBe('manager');
    expect(t!.isBuiltin).toBe(true);
    // read-only envelope: only inspection tools, never Edit/Write/Bash
    expect(t!.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(t!.allowedTools).not.toContain('Edit');
    expect(t!.allowedTools).not.toContain('Write');
    expect(t!.permissionMode).toBe('default');
  });
});

// ── 2. applyRubricFloors (PURE) ───────────────────────────────────────────────

describe('applyRubricFloors (PURE)', () => {
  let applyRubricFloors: typeof import('../src/manager.js').applyRubricFloors;

  beforeAll(async () => {
    ({ applyRubricFloors } = await import('../src/manager.js'));
  });

  const base = (over: Partial<{ id: string; title: string; body: string; labels: string[] }> = {}) => ({
    id: over.id ?? 'item-1',
    title: over.title ?? 'Tidy up the README',
    body: over.body ?? 'Fix a typo in the install section.',
    labels: over.labels ?? [],
  });
  const lowReady = { risk: 'low' as const, type: 'docs' as const, agentReady: true, reason: 'mechanical doc fix' };

  it('forces high + not-ready when a glob matches the title', () => {
    const item = base({ title: 'Rotate the auth secret key' });
    const rule = { glob: '*auth*', forceRisk: 'high' as const };
    const out = applyRubricFloors(item, lowReady, [rule]);
    expect(out.risk).toBe('high');
    expect(out.agentReady).toBe(false);
    expect(out.reason).toMatch(/\*auth\*/);
    expect(out.reason).toContain('mechanical doc fix'); // original reason preserved
  });

  it('matches against the body too', () => {
    const item = base({ title: 'Cleanup', body: 'Edit db/migrations/0007_add_col.sql' });
    const out = applyRubricFloors(item, lowReady, [{ glob: '*migrations*', forceRisk: 'high' }]);
    expect(out.risk).toBe('high');
    expect(out.agentReady).toBe(false);
  });

  it('matches against a label', () => {
    const item = base({ labels: ['area:ci', 'good-first-issue'] });
    const out = applyRubricFloors(item, lowReady, [{ glob: 'area:ci', forceRisk: 'medium' }]);
    expect(out.risk).toBe('medium');
    expect(out.agentReady).toBe(false);
  });

  it('is case-insensitive', () => {
    const item = base({ title: 'Update SECRETS handling' });
    const out = applyRubricFloors(item, lowReady, [{ glob: '*secrets*', forceRisk: 'high' }]);
    expect(out.risk).toBe('high');
    expect(out.agentReady).toBe(false);
  });

  it('hard-floor never LOWERS risk: forceRisk:medium on a high verdict stays high, agentReady false', () => {
    const highVerdict = { risk: 'high' as const, type: 'chore' as const, agentReady: true, reason: 'agent over-confident' };
    const item = base({ title: 'update ci config' });
    const out = applyRubricFloors(item, highVerdict, [{ glob: '*ci*', forceRisk: 'medium' as const }]);
    // The rule forceRisk is 'medium' but current risk is 'high' — must stay 'high'
    expect(out.risk).toBe('high');
    expect(out.agentReady).toBe(false);
    expect(out.reason).toMatch(/rubric override/);
  });

  it('returns the verdict UNCHANGED (fresh copy) when no rule matches', () => {
    const item = base({ title: 'Improve button hover state' });
    const out = applyRubricFloors(item, lowReady, [{ glob: '*migrations*', forceRisk: 'high' }]);
    expect(out).toEqual(lowReady);
    expect(out).not.toBe(lowReady); // PURE: does not mutate the input
  });

  it('first matching rule wins and never RAISES agentReady', () => {
    const item = base({ title: 'delete legacy auth module' });
    const out = applyRubricFloors(
      item,
      { risk: 'high', type: 'refactor', agentReady: false, reason: 'risky' },
      [{ glob: '*delete*', forceRisk: 'high' }, { glob: '*auth*', forceRisk: 'medium' }],
    );
    expect(out.risk).toBe('high'); // *delete* matched first
    expect(out.agentReady).toBe(false);
  });

  it('an empty rubric is a no-op (fresh copy)', () => {
    const item = base();
    const out = applyRubricFloors(item, lowReady, []);
    expect(out).toEqual(lowReady);
    expect(out).not.toBe(lowReady);
  });
});

// ── 3. runManagerLoop ─────────────────────────────────────────────────────────

let runManagerLoop: typeof import('../src/manager.js').runManagerLoop;
let registry: any;
let realLaunch: any;
let realGetRun: any;

// A captured-call fake ControlPlane (we assert on what the manager called).
type Verdict = { risk: string; type: string; agentReady: boolean; reason: string; questions?: string[] };
class FakeCP {
  backlog: Array<{ id: string; title: string; body: string; labels: string[] }>;
  classifyCalls: Array<{ id: string; v: Verdict }> = [];
  questionCalls: Array<{ id: string; questions: string[] }> = [];
  assessmentCalls: Array<{ id: string; markdown: string }> = [];
  constructor(backlog: any[]) {
    this.backlog = backlog;
  }
  async listBacklog() {
    return this.backlog;
  }
  async listReady() {
    return [];
  }
  async classify(id: string, v: Verdict) {
    this.classifyCalls.push({ id, v });
  }
  async postAssessment(id: string, markdown: string) {
    this.assessmentCalls.push({ id, markdown });
  }
  async attachQuestions(id: string, questions: string[]) {
    this.questionCalls.push({ id, questions });
  }
}

// Per-item structured verdicts keyed by the prompt fragment the manager builds (the item title).
let verdictByTitle: Record<string, Verdict> = {};

beforeAll(async () => {
  ({ registry } = await import('../src/registry.js'));
  ({ runManagerLoop } = await import('../src/manager.js'));

  // Intercept registry.launch: never spawn. The real `launch` returns a STILL-RUNNING run whose
  // structuredOutput is null; runManagerLoop then awaits the run to terminal (via
  // registry.onRunTerminal + registry.getRun) before reading structuredOutput. We model that by
  // making registry.getRun return an ALREADY-TERMINAL run (status 'completed' + the chosen verdict),
  // so awaitTerminal resolves immediately on its `getRun` fast-path — the stub stands in for a
  // terminal-resolved run (mirrors benchmarks.test.ts, which reads structuredOutput post-terminal).
  const runsById: Record<string, any> = {};
  realLaunch = registry.launch.bind(registry);
  realGetRun = registry.getRun.bind(registry);
  registry.launch = async (req: any) => {
    const match = Object.keys(verdictByTitle).find((title) => String(req.prompt).includes(title));
    const so = match
      ? verdictByTitle[match]
      : { risk: 'low', type: 'chore', agentReady: true, reason: 'default' };
    const id = `mgr-${Math.random().toString(36).slice(2)}`;
    runsById[id] = { id, status: 'completed', structuredOutput: so };
    return runsById[id];
  };
  // awaitTerminal calls registry.getRun(runId); return the terminal run so it resolves at once.
  registry.getRun = (id: string) => runsById[id] ?? null;
});

afterAll(() => {
  if (realLaunch) registry.launch = realLaunch;
  if (realGetRun) registry.getRun = realGetRun;
});

const project: any = { id: 'proj-1', rootDir: process.env.FLEET_DATA_DIR };
const loop = (over: Partial<any> = {}): any => ({
  id: 'loop-1',
  name: 'Triage',
  projectId: 'proj-1',
  kind: 'manager',
  controlPlane: 'board',
  scheduleId: null,
  mode: 'apply',
  consecutiveGoodRuns: 0,
  escalationThreshold: 3,
  mergePosture: 'human-gate',
  reviewPolicy: 'always',
  riskRubric: [],
  routableCeiling: 'low',
  enabled: true,
  lastRunId: null,
  lastEval: null,
  lastError: null,
  createdAt: 0,
  contract: {
    job: 'triage',
    inputs: 'backlog',
    allowed: [],
    forbidden: [],
    output: 'labels',
    evaluation: 'graded',
  },
  ...over,
});

describe('runManagerLoop', () => {
  it('marks a low-risk agent-ready item ready and always posts an assessment', async () => {
    verdictByTitle = { 'Fix typo': { risk: 'low', type: 'docs', agentReady: true, reason: 'one-char doc fix' } };
    const cp = new FakeCP([{ id: 'i1', title: 'Fix typo', body: 'README', labels: [] }]);
    await runManagerLoop(loop(), project, cp as any);

    expect(cp.classifyCalls).toHaveLength(1);
    expect(cp.classifyCalls[0].id).toBe('i1');
    expect(cp.classifyCalls[0].v.agentReady).toBe(true);
    expect(cp.classifyCalls[0].v.risk).toBe('low');
    expect(cp.questionCalls).toHaveLength(0); // ready → no questions
    expect(cp.assessmentCalls).toHaveLength(1); // assessment ALWAYS posted
    expect(cp.assessmentCalls[0].markdown).toMatch(/Agent-ready/i);
  });

  it('NEVER marks risk:high as agent-ready — classifies needs:human + attaches questions', async () => {
    verdictByTitle = {
      'Rotate keys': { risk: 'high', type: 'chore', agentReady: true, reason: 'agent over-confident', questions: [] },
    };
    const cp = new FakeCP([{ id: 'i2', title: 'Rotate keys', body: 'auth', labels: [] }]);
    await runManagerLoop(loop(), project, cp as any);

    expect(cp.classifyCalls[0].v.risk).toBe('high');
    // routableCeiling is 'low' → high can never be agent-ready even though the agent said true
    expect(cp.classifyCalls[0].v.agentReady).toBe(false);
    expect(cp.questionCalls).toHaveLength(1);
    expect(cp.assessmentCalls).toHaveLength(1);
  });

  it('rubric hard-floor forces high + not-ready even when the agent said low/ready', async () => {
    verdictByTitle = {
      'small change': { risk: 'low', type: 'refactor', agentReady: true, reason: 'looks trivial' },
    };
    const cp = new FakeCP([
      { id: 'i3', title: 'small change', body: 'touches db/migrations/0009.sql', labels: [] },
    ]);
    await runManagerLoop(
      loop({ riskRubric: [{ glob: '*migrations*', forceRisk: 'high' }] }),
      project,
      cp as any,
    );

    expect(cp.classifyCalls[0].v.risk).toBe('high');
    expect(cp.classifyCalls[0].v.agentReady).toBe(false);
    expect(cp.classifyCalls[0].v.reason).toMatch(/rubric override/i);
    expect(cp.questionCalls).toHaveLength(1);
  });

  it('processes every backlog item', async () => {
    verdictByTitle = {
      alpha: { risk: 'low', type: 'docs', agentReady: true, reason: 'a' },
      beta: { risk: 'medium', type: 'feature', agentReady: false, reason: 'b', questions: ['scope?'] },
    };
    const cp = new FakeCP([
      { id: 'a', title: 'alpha', body: '', labels: [] },
      { id: 'b', title: 'beta', body: '', labels: [] },
    ]);
    await runManagerLoop(loop(), project, cp as any);
    expect(cp.classifyCalls.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(cp.assessmentCalls).toHaveLength(2);
  });

  it('safety path: when registry.launch throws, verdict defaults to risk high + agentReady false', async () => {
    // Temporarily replace launch with a throwing stub.
    const savedLaunch = registry.launch;
    registry.launch = async () => { throw new Error('engine unavailable'); };
    try {
      const cp = new FakeCP([{ id: 'fail-item', title: 'Some task', body: 'body', labels: [] }]);
      await runManagerLoop(loop(), project, cp as any);

      // Fallback verdict must be risk 'high' + agentReady false.
      expect(cp.classifyCalls).toHaveLength(1);
      expect(cp.classifyCalls[0].v.risk).toBe('high');
      expect(cp.classifyCalls[0].v.agentReady).toBe(false);
      // Must still attach questions and post assessment (the safety path does both).
      expect(cp.questionCalls).toHaveLength(1);
      expect(cp.assessmentCalls).toHaveLength(1);
    } finally {
      registry.launch = savedLaunch;
    }
  });

  it('honors a higher routableCeiling (medium): medium stays ready, high never does', async () => {
    verdictByTitle = {
      'med ok': { risk: 'medium', type: 'feature', agentReady: true, reason: 'bounded medium work' },
      'hi no': { risk: 'high', type: 'feature', agentReady: true, reason: 'still too risky' },
    };
    const cp = new FakeCP([
      { id: 'm', title: 'med ok', body: '', labels: [] },
      { id: 'h', title: 'hi no', body: '', labels: [] },
    ]);
    await runManagerLoop(loop({ routableCeiling: 'medium' }), project, cp as any);

    const med = cp.classifyCalls.find((c) => c.id === 'm')!;
    const hi = cp.classifyCalls.find((c) => c.id === 'h')!;
    expect(med.v.risk).toBe('medium');
    expect(med.v.agentReady).toBe(true); // medium <= medium ceiling → ready
    expect(hi.v.agentReady).toBe(false); // high > medium ceiling → never ready
    expect(cp.questionCalls.map((q) => q.id)).toEqual(['h']); // only the high item escalated
  });
});
