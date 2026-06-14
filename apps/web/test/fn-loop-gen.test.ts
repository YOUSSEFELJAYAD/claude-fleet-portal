/**
 * mapGenerateResponseToForm maps the server's AI-generated loop draft onto the create form
 * (kind/controlPlane/name + the ContractDraft the ContractEditor consumes).
 */
import { describe, it, expect } from 'vitest';
import { mapGenerateResponseToForm, type GenerateLoopResponse } from '../lib/loops';

const resp: GenerateLoopResponse = {
  kind: 'worker',
  controlPlane: 'github',
  suggestedName: 'pr worker',
  contract: {
    job: 'implement agent:ready issues',
    inputs: 'agent:ready issues',
    allowed: ['*'],
    forbidden: ['Bash(git push *)'],
    output: 'a PR',
    evaluation: 'validation passes and the PR satisfies the issue',
  },
  mergePosture: 'human-gate',
  reviewPolicy: 'threshold:5',
  routableCeiling: 'medium',
  escalationThreshold: 4,
  riskRubric: [{ glob: '**/auth/**', forceRisk: 'high' }],
  warning: null,
};

describe('mapGenerateResponseToForm', () => {
  it('maps top-level fields and the suggested name', () => {
    const f = mapGenerateResponseToForm(resp);
    expect(f.kind).toBe('worker');
    expect(f.controlPlane).toBe('github');
    expect(f.name).toBe('pr worker');
  });

  it('produces a ContractDraft with every field carried over', () => {
    const { draft } = mapGenerateResponseToForm(resp);
    expect(draft.contract).toEqual(resp.contract);
    expect(draft.mergePosture).toBe('human-gate');
    expect(draft.reviewPolicy).toBe('threshold:5');
    expect(draft.routableCeiling).toBe('medium');
    expect(draft.escalationThreshold).toBe(4);
    expect(draft.riskRubric).toEqual(resp.riskRubric);
  });

  it('yields a draft the create form would accept (non-empty contract, valid review policy)', () => {
    const { draft } = mapGenerateResponseToForm(resp);
    for (const k of ['job', 'inputs', 'output', 'evaluation'] as const) {
      expect(draft.contract[k].trim()).not.toBe('');
    }
    expect(/^(always|off|threshold:\d+)$/.test(draft.reviewPolicy)).toBe(true);
    expect(draft.mergePosture === 'auto-low-risk' && draft.reviewPolicy === 'off').toBe(false);
  });
});
