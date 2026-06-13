import { describe, it, expect } from 'vitest';
import {
  RISK_LABELS,
  TYPE_LABELS,
  ROUTING,
  type RiskLevel,
  type WorkType,
} from '@fleet/shared';
import type { LoopKind, LoopMode, ControlPlaneKind, MergePosture } from '@fleet/shared';
import type {
  LoopContract,
  RiskRule,
  TriageVerdict,
  LoopEvalResult,
  ReviewVerdict,
} from '@fleet/shared';
import type { Loop, CreateLoopRequest } from '@fleet/shared';
import type { ExecutionPhase } from '@fleet/shared';

describe('loop risk/type label constants', () => {
  it('RISK_LABELS maps each RiskLevel to its risk:* label', () => {
    expect(RISK_LABELS.low).toBe('risk:low');
    expect(RISK_LABELS.medium).toBe('risk:medium');
    expect(RISK_LABELS.high).toBe('risk:high');
    const level: RiskLevel = 'high';
    expect(RISK_LABELS[level]).toBe('risk:high');
  });

  it('TYPE_LABELS maps each WorkType to its type:* label', () => {
    expect(TYPE_LABELS.bug).toBe('type:bug');
    expect(TYPE_LABELS.feature).toBe('type:feature');
    expect(TYPE_LABELS.docs).toBe('type:docs');
    expect(TYPE_LABELS.test).toBe('type:test');
    expect(TYPE_LABELS.refactor).toBe('type:refactor');
    expect(TYPE_LABELS.chore).toBe('type:chore');
    const t: WorkType = 'bug';
    expect(TYPE_LABELS[t]).toBe('type:bug');
  });

  it('ROUTING carries the agent:ready / needs:human vocabulary', () => {
    expect(ROUTING.ready).toBe('agent:ready');
    expect(ROUTING.needsHuman).toBe('needs:human');
  });
});

describe('loop enum unions', () => {
  it('accepts every documented union member', () => {
    const kinds: LoopKind[] = ['manager', 'worker'];
    const modes: LoopMode[] = ['dry-run', 'apply'];
    const planes: ControlPlaneKind[] = ['board', 'github'];
    const postures: MergePosture[] = ['human-gate', 'auto-low-risk'];
    expect(kinds).toHaveLength(2);
    expect(modes).toEqual(['dry-run', 'apply']);
    expect(planes).toEqual(['board', 'github']);
    expect(postures).toEqual(['human-gate', 'auto-low-risk']);
  });
});

describe('loop contract / verdict / eval shapes', () => {
  it('LoopContract carries the six pre-flight fields', () => {
    const c: LoopContract = {
      job: 'Triage the backlog',
      inputs: 'Backlog cards + repo context',
      allowed: ['Read', 'Grep'],
      forbidden: ['Edit', 'Write'],
      output: 'risk/type labels + an Agent Assessment',
      evaluation: 'no risk:high marked agent:ready; every verdict evidence-backed',
    };
    expect(Object.keys(c).sort()).toEqual(
      ['allowed', 'evaluation', 'forbidden', 'inputs', 'job', 'output'],
    );
    expect(c.allowed).toContain('Read');
  });

  it('RiskRule forces a glob match to a RiskLevel', () => {
    const rule: RiskRule = { glob: '**/migrations/**', forceRisk: 'high' };
    expect(rule.forceRisk).toBe('high');
  });

  it('TriageVerdict is the per-item manager output (questions optional)', () => {
    const v: TriageVerdict = {
      risk: 'low',
      type: 'docs',
      agentReady: true,
      reason: 'doc-only typo fix; no code paths touched',
    };
    expect(v.agentReady).toBe(true);
    expect(v.questions).toBeUndefined();
    const escalated: TriageVerdict = {
      risk: 'high',
      type: 'feature',
      agentReady: false,
      reason: 'touches auth',
      questions: ['Which auth flow?'],
    };
    expect(escalated.questions).toEqual(['Which auth flow?']);
  });

  it('LoopEvalResult + ReviewVerdict carry their gate fields', () => {
    const evalResult: LoopEvalResult = { clean: false, score: 0.4, notes: 'marked risky work ready' };
    expect(evalResult.clean).toBe(false);
    expect(evalResult.score).toBeCloseTo(0.4);
    const review: ReviewVerdict = { pass: true, findings: 'no blocking issues' };
    expect(review.pass).toBe(true);
  });
});

describe('Loop entity + create request', () => {
  it('a Loop value compiles with the full camelCase column mirror', () => {
    const loop: Loop = {
      id: 'lp_1',
      name: 'Backlog triage',
      projectId: 'proj_1',
      kind: 'manager',
      controlPlane: 'board',
      scheduleId: null,
      contract: {
        job: 'triage',
        inputs: 'backlog',
        allowed: ['Read'],
        forbidden: ['Edit'],
        output: 'labels',
        evaluation: 'evidence-backed verdicts',
      },
      mode: 'dry-run',
      consecutiveGoodRuns: 0,
      escalationThreshold: 3,
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      riskRubric: [{ glob: '**/auth/**', forceRisk: 'high' }],
      routableCeiling: 'low',
      enabled: true,
      lastRunId: null,
      lastEval: null,
      lastError: null,
      createdAt: Date.now(),
    };
    expect(loop.kind).toBe('manager');
    expect(loop.mode).toBe('dry-run');
    expect(loop.riskRubric[0].forceRisk).toBe('high');
    expect(loop.lastEval).toBeNull();
  });

  it('CreateLoopRequest requires name/projectId/kind/contract; the rest default server-side', () => {
    const req: CreateLoopRequest = {
      name: 'Worker',
      projectId: 'proj_1',
      kind: 'worker',
      contract: {
        job: 'build',
        inputs: 'ready cards',
        allowed: ['Read', 'Edit', 'Write'],
        forbidden: ['Bash(git push *)'],
        output: 'a PR, never merged',
        evaluation: 'diff within agent:ready+risk:low; review passes',
      },
    };
    expect(req.controlPlane).toBeUndefined();
    expect(req.escalationThreshold).toBeUndefined();
    expect(req.kind).toBe('worker');
  });
});

describe('ExecutionPhase loop additions', () => {
  it('accepts the existing phases plus inspecting + reviewing', () => {
    const phases: ExecutionPhase[] = [
      'idle',
      'building',
      'validating',
      'merging',
      'conflicts',
      'paused-budget',
      'failed',
      'resolving',
      'inspecting', // NEW: dry-run loop reporting intended actions
      'reviewing',  // NEW: maker/checker Reviewer judging the diff
    ];
    expect(phases).toContain('inspecting');
    expect(phases).toContain('reviewing');
    expect(phases).toHaveLength(10);
  });
});
