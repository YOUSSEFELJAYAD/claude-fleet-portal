import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Loop, LoopContract, Project, Run } from '@fleet/shared';

// Isolate the DB BEFORE importing any src module (db.ts reads FLEET_DATA_DIR at import time).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-loopeval-'));

describe('LOOP_EVAL_JSON_SCHEMA', () => {
  it('declares clean:boolean, score:number, notes:string and forbids extra props', async () => {
    const { LOOP_EVAL_JSON_SCHEMA } = await import('../src/loopEval.js');
    const s = LOOP_EVAL_JSON_SCHEMA as any;
    expect(s.type).toBe('object');
    expect(s.properties.clean.type).toBe('boolean');
    expect(s.properties.score.type).toBe('number');
    expect(s.properties.score.minimum).toBe(0);
    expect(s.properties.score.maximum).toBe(100);
    expect(s.properties.notes.type).toBe('string');
    expect(s.required).toEqual(['clean', 'score', 'notes']);
    expect(s.additionalProperties).toBe(false);
  });
});

// ── helpers shared by Tasks 05.2–05.4 ────────────────────────────────────────

function fakeContract(over: Partial<LoopContract> = {}): LoopContract {
  return {
    job: 'Triage the backlog',
    inputs: 'open backlog cards',
    allowed: ['Read', 'Grep'],
    forbidden: ['Edit', 'Write', 'Bash(git push *)'],
    output: 'each card labelled risk/type',
    evaluation: 'never mark risk:high as agent:ready; attach questions to ambiguous items',
    ...over,
  };
}

function fakeLoop(over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    name: 'Manager',
    projectId: 'proj-1',
    kind: 'manager',
    controlPlane: 'board',
    scheduleId: null,
    contract: fakeContract(),
    mode: 'dry-run',
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
    createdAt: Date.now(),
    ...over,
  };
}

function fakeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Demo',
    rootDir: process.env.FLEET_DATA_DIR!, // an existing dir, so a real launch's cwd guard would pass
    defaultBranch: 'main',
    autoMerge: false,
    defaultValidationCommand: null,
    wipLimit: 3,
    budgetCeilingUsd: null,
    paused: false,
    createdAt: Date.now(),
    editingEnabled: false,
    commitAuthorName: null,
    commitAuthorEmail: null,
    mergeMode: 'local',
    remoteName: 'origin',
    pushEnabled: false,
    serverStartCommand: null,
    healthCheckUrl: null,
    healthCheckRegex: null,
    readinessTimeoutMs: null,
    portRangeStart: null,
    portRangeEnd: null,
    copyEnvFrom: null,
    priority: 0,
    resolveConflicts: false,
    ...over,
  } as Project;
}

function terminalRun(structuredOutput: unknown): Run {
  return {
    id: 'judge-run-1',
    sessionId: 'judge-run-1',
    status: 'completed',
    structuredOutput,
    resultText: null,
    cwd: process.env.FLEET_DATA_DIR!,
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'plan',
  } as unknown as Run;
}

// ── Task 05.2 ────────────────────────────────────────────────────────────────

describe('buildEvalPrompt', () => {
  it('embeds the evaluation criterion, the loop kind, and the intended actions', async () => {
    const { buildEvalPrompt } = await import('../src/loopEval.js');
    const intended = [
      { kind: 'classify' as const, itemId: 'card-7', detail: { risk: 'high', agentReady: true } },
      { kind: 'questions' as const, itemId: 'card-9', detail: ['which API?'] },
    ];
    const prompt = buildEvalPrompt(fakeLoop(), intended);
    // contract.evaluation is the grading rubric — it MUST appear verbatim
    expect(prompt).toContain('never mark risk:high as agent:ready');
    // loop kind shapes the checklist
    expect(prompt).toContain('manager');
    // every intended action is rendered (id + kind)
    expect(prompt).toContain('card-7');
    expect(prompt).toContain('classify');
    expect(prompt).toContain('card-9');
    expect(prompt).toContain('questions');
    // explicit instruction to use the json schema fields
    expect(prompt).toMatch(/clean/);
  });

  it('handles an empty intended-action list without throwing', async () => {
    const { buildEvalPrompt } = await import('../src/loopEval.js');
    const prompt = buildEvalPrompt(fakeLoop(), []);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('(no intended actions)');
  });
});

// ── Task 05.3 ────────────────────────────────────────────────────────────────

describe('gradeLoopRun', () => {
  it('maps a valid structuredOutput to LoopEvalResult and passes the json schema + read-only mode to launch', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun, LOOP_EVAL_JSON_SCHEMA, buildEvalPrompt } = await import('../src/loopEval.js');

    const run = terminalRun({ clean: true, score: 88, notes: 'all verdicts evidence-backed' });
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);

    const loop = fakeLoop();
    const intended = [{ kind: 'classify' as const, itemId: 'card-7', detail: { risk: 'low' } }];
    const project = fakeProject();
    const res = await gradeLoopRun(loop, intended, project);

    expect(res).toEqual({ clean: true, score: 88, notes: 'all verdicts evidence-backed' });

    // launch was called once with the eval schema, read-only plan mode, project cwd, and our prompt
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const arg = launchSpy.mock.calls[0][0] as any;
    expect(arg.jsonSchema).toBe(LOOP_EVAL_JSON_SCHEMA);
    expect(arg.permissionMode).toBe('plan');
    expect(arg.cwd).toBe(project.rootDir);
    expect(arg.interactive).toBe(false);
    expect(arg.prompt).toBe(buildEvalPrompt(loop, intended));

    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });

  it('clamps an out-of-range score and coerces a non-clean verdict', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const run = terminalRun({ clean: false, score: 250, notes: 'marked risk:high agent:ready' });
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);

    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res.clean).toBe(false);
    expect(res.score).toBe(100); // clamped
    expect(res.notes).toContain('risk:high');

    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });
});

// ── Task 05.4 ────────────────────────────────────────────────────────────────

describe('gradeLoopRun — safety (never clean on uncertainty)', () => {
  it('returns clean:false when launch throws (e.g. concurrency cap)', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const launchSpy = vi.spyOn(registry, 'launch').mockImplementation(() => {
      throw Object.assign(new Error('Max concurrent runs reached (4)'), { statusCode: 429 });
    });
    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res.clean).toBe(false);
    expect(res.score).toBe(0);
    expect(res.notes).toContain('loopEval failed');
    expect(res.notes).toContain('Max concurrent');
    launchSpy.mockRestore();
  });

  it('returns clean:false when the judge run did not complete (failed)', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const run = { id: 'jr2', status: 'failed', structuredOutput: null } as unknown as Run;
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);
    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res).toEqual({ clean: false, score: 0, notes: 'loopEval judge did not complete (status: failed)' });
    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });

  it('returns clean:false when a completed run has no/invalid structuredOutput', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const run = { id: 'jr3', status: 'completed', structuredOutput: { score: 'oops' } } as unknown as Run;
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);
    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res.clean).toBe(false);
    expect(res.score).toBe(0);
    expect(res.notes).toContain('no valid structured verdict');
    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });
});
