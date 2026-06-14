/**
 * Catalog-validity tests for the create-loop template presets (components/loopTemplates.ts).
 *
 * Every preset must be something the server's POST /api/loops would ACCEPT — otherwise a user
 * who picks a template and clicks Create hits a 400. These assertions mirror the server's
 * validateContract (apps/server/src/loops.ts) + the create-route field rules exactly, so a
 * preset that would be rejected fails here instead of in production.
 */
import { describe, it, expect } from 'vitest';
import { LOOP_TEMPLATES, applyTemplate, CUSTOM_TEMPLATE_ID } from '../components/loopTemplates';

const RISK = new Set(['low', 'medium', 'high']);
const POSTURE = new Set(['human-gate', 'auto-low-risk']);
const KIND = new Set(['manager', 'worker']);
const CP = new Set(['board', 'github']);
const REVIEW = /^(always|off|threshold:\d+)$/;

/** Returns an error string when the draft would be rejected by the server, else null. */
function invalidReason(t: (typeof LOOP_TEMPLATES)[number]): string | null {
  const d = t.draft;
  const c = d.contract;
  if (!c.job?.trim()) return 'contract.job empty';
  if (!c.inputs?.trim()) return 'contract.inputs empty';
  if (!c.output?.trim()) return 'contract.output empty';
  if (!c.evaluation?.trim()) return 'contract.evaluation empty';
  if (!Array.isArray(c.allowed)) return 'allowed not array';
  if (!Array.isArray(c.forbidden)) return 'forbidden not array';
  if (d.mergePosture === 'auto-low-risk' && d.reviewPolicy === 'off') return 'auto-low-risk + review off';
  if (!Number.isInteger(d.escalationThreshold) || d.escalationThreshold < 1) return 'escalationThreshold < 1';
  if (!POSTURE.has(d.mergePosture)) return 'bad mergePosture';
  if (!RISK.has(d.routableCeiling)) return 'bad routableCeiling';
  if (!REVIEW.test(d.reviewPolicy)) return 'bad reviewPolicy';
  if (!KIND.has(t.kind)) return 'bad kind';
  if (!CP.has(t.controlPlane)) return 'bad controlPlane';
  for (const r of d.riskRubric) {
    if (!r.glob?.trim()) return 'risk rule with empty glob';
    if (!RISK.has(r.forceRisk)) return 'bad risk rule forceRisk';
  }
  return null;
}

describe('loop template catalog', () => {
  it('ships a non-empty catalog with unique ids', () => {
    expect(LOOP_TEMPLATES.length).toBeGreaterThan(1);
    const ids = LOOP_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the blank Custom template, and it is actually blank', () => {
    const custom = LOOP_TEMPLATES.find((t) => t.id === CUSTOM_TEMPLATE_ID);
    expect(custom).toBeTruthy();
    expect(custom!.draft.contract.evaluation).toBe('');
    expect(custom!.draft.contract.job).toBe('');
    expect(custom!.draft.riskRubric).toEqual([]);
  });

  it.each(LOOP_TEMPLATES.filter((t) => t.id !== CUSTOM_TEMPLATE_ID).map((t) => [t.label, t] as const))(
    'preset "%s" is accepted by the server contract rules',
    (_label, t) => {
      expect(invalidReason(t)).toBeNull();
    },
  );

  it('every non-custom template has a name suggestion and a "what makes it run" hint', () => {
    for (const t of LOOP_TEMPLATES) {
      if (t.id === CUSTOM_TEMPLATE_ID) continue;
      expect(t.nameSuggestion.trim()).not.toBe('');
      expect(t.hint.trim()).not.toBe('');
    }
  });

  it('covers both kinds and both control planes (the "all possible cases" ask)', () => {
    const kinds = new Set(LOOP_TEMPLATES.filter((t) => t.id !== CUSTOM_TEMPLATE_ID).map((t) => t.kind));
    const cps = new Set(LOOP_TEMPLATES.filter((t) => t.id !== CUSTOM_TEMPLATE_ID).map((t) => t.controlPlane));
    expect(kinds).toEqual(new Set(['manager', 'worker']));
    expect(cps).toEqual(new Set(['board', 'github']));
  });

  it('has at least one auto-low-risk worker preset (and it carries a real review)', () => {
    const auto = LOOP_TEMPLATES.filter((t) => t.draft.mergePosture === 'auto-low-risk');
    expect(auto.length).toBeGreaterThan(0);
    for (const t of auto) expect(t.draft.reviewPolicy).not.toBe('off');
  });
});

describe('applyTemplate', () => {
  const tmpl = LOOP_TEMPLATES.find((t) => t.id !== CUSTOM_TEMPLATE_ID)!;

  it('overrides an empty name with the suggestion', () => {
    const r = applyTemplate(tmpl, '');
    expect(r.name).toBe(tmpl.nameSuggestion);
    expect(r.kind).toBe(tmpl.kind);
    expect(r.controlPlane).toBe(tmpl.controlPlane);
    expect(r.draft).toEqual(tmpl.draft);
  });

  it('preserves a name the user already typed', () => {
    const r = applyTemplate(tmpl, 'my custom name');
    expect(r.name).toBeUndefined();
  });
});
