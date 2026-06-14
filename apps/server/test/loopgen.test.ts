/**
 * Unit tests for the PURE pieces of AI loop generation (loopGen.ts):
 *   - parseLoopGen: normalize/clamp a raw model structuredOutput into a valid loop draft
 *   - buildProjectContext: assemble a bounded context string from project + board + repo
 * The launch+awaitTerminal plumbing is a copy of trusted loopEval.ts and is not re-tested here.
 */
import { describe, it, expect } from 'vitest';
import { parseLoopGen, buildProjectContext } from '../src/loopGen.js';

describe('parseLoopGen', () => {
  const good = {
    kind: 'worker',
    controlPlane: 'github',
    suggestedName: 'pr worker',
    contract: {
      job: 'do the thing',
      inputs: 'agent:ready issues',
      allowed: ['*'],
      forbidden: ['Bash(git push *)'],
      output: 'a PR',
      evaluation: 'validation passes',
    },
    mergePosture: 'human-gate',
    reviewPolicy: 'threshold:5',
    routableCeiling: 'medium',
    escalationThreshold: 4,
    riskRubric: [{ glob: '**/auth/**', forceRisk: 'high' }],
  };

  it('passes a well-formed object through with all fields intact', () => {
    const d = parseLoopGen(good)!;
    expect(d).not.toBeNull();
    expect(d.kind).toBe('worker');
    expect(d.controlPlane).toBe('github');
    expect(d.suggestedName).toBe('pr worker');
    expect(d.contract.allowed).toEqual(['*']);
    expect(d.reviewPolicy).toBe('threshold:5');
    expect(d.routableCeiling).toBe('medium');
    expect(d.escalationThreshold).toBe(4);
    expect(d.riskRubric).toEqual([{ glob: '**/auth/**', forceRisk: 'high' }]);
  });

  it('clamps invalid enums to safe defaults', () => {
    const d = parseLoopGen({
      ...good,
      kind: 'boss',
      controlPlane: 'gitlab',
      mergePosture: 'yolo',
      routableCeiling: 'extreme',
      reviewPolicy: 'whenever',
      escalationThreshold: 0,
    })!;
    expect(d.kind).toBe('manager');
    expect(d.controlPlane).toBe('board');
    expect(d.mergePosture).toBe('human-gate');
    expect(d.routableCeiling).toBe('low');
    expect(d.reviewPolicy).toBe('always');
    expect(d.escalationThreshold).toBe(3);
  });

  it('coerces contract fields and drops malformed risk rules', () => {
    const d = parseLoopGen({
      ...good,
      contract: { job: 42, inputs: null, allowed: 'Read', forbidden: undefined, output: 'x', evaluation: 'y' },
      riskRubric: [{ glob: '', forceRisk: 'high' }, { glob: '**/x/**', forceRisk: 'nope' }, { glob: '**/ok/**', forceRisk: 'medium' }],
    })!;
    expect(typeof d.contract.job).toBe('string');
    expect(Array.isArray(d.contract.allowed)).toBe(true);
    expect(Array.isArray(d.contract.forbidden)).toBe(true);
    // only the one well-formed rule survives
    expect(d.riskRubric).toEqual([{ glob: '**/ok/**', forceRisk: 'medium' }]);
  });

  it('returns null for non-objects', () => {
    expect(parseLoopGen(null)).toBeNull();
    expect(parseLoopGen('nope')).toBeNull();
    expect(parseLoopGen(42)).toBeNull();
  });
});

describe('buildProjectContext', () => {
  const project = { name: 'acme', defaultBranch: 'main', mergeMode: 'pr', autoMerge: false, pushEnabled: true, wipLimit: 3 };

  it('includes project meta, a card title + its labels, and a detected stack file', () => {
    const cards = [{ title: 'fix login bug', column: 'Backlog', labels: ['risk:high', 'type:bug'] }];
    const ctx = buildProjectContext(project as any, cards as any, ['package.json', 'src/index.ts']);
    expect(ctx).toContain('acme');
    expect(ctx).toContain('fix login bug');
    expect(ctx).toContain('risk:high');
    expect(ctx).toContain('package.json');
  });

  it('caps the card list at 40 and notes the overflow', () => {
    const cards = Array.from({ length: 100 }, (_, i) => ({ title: `card-${i}`, column: 'Backlog', labels: [] }));
    const ctx = buildProjectContext(project as any, cards as any, []);
    expect(ctx).toContain('card-0');
    expect(ctx).toContain('card-39');
    expect(ctx).not.toContain('card-40');
    expect(ctx).toContain('60 more');
  });
});
