import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Web has no test runner (apps/web/package.json: only dev/build/start/typecheck).
// These are structural guards run from the server's vitest project — they assert the
// web files exist and carry the load-bearing strings, then `pnpm --filter @fleet/web build`
// (Task 09.6) proves they actually compile.
const WEB = join(process.cwd(), '..', 'web');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

describe('web loops — lib/loops.ts', () => {
  it('exists and exports loopsApi with the loop-engineering routes', () => {
    expect(existsSync(join(WEB, 'lib/loops.ts'))).toBe(true);
    const src = read('lib/loops.ts');
    expect(src).toMatch(/export const loopsApi/);
    // routes from spec §16
    expect(src).toContain("'/api/loops'");
    expect(src).toContain('/promote');
    expect(src).toContain('/demote');
    expect(src).toContain('/fire');
    expect(src).toContain('/comments');
  });

  it('mirrors the loop literal vocabulary locally (no cross-package import of unpublished types)', () => {
    const src = read('lib/loops.ts');
    expect(src).toContain("'manager'");
    expect(src).toContain("'worker'");
    expect(src).toContain("'board'");
    expect(src).toContain("'github'");
    expect(src).toContain("'dry-run'");
    expect(src).toContain("'apply'");
    expect(src).toContain("'human-gate'");
    expect(src).toContain("'auto-low-risk'");
  });
});

describe('web loops — ContractEditor', () => {
  it('exists and gates SAVE on an empty evaluation field', () => {
    const p = join(process.cwd(), '..', 'web', 'components/ContractEditor.tsx');
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).toMatch(/export function ContractEditor/);
    // the six contract fields
    for (const f of ['job', 'inputs', 'allowed', 'forbidden', 'output', 'evaluation']) {
      expect(src).toContain(f);
    }
    // SAVE disabled while evaluation is empty (spec §3 / §17)
    expect(src).toMatch(/evaluation\.trim\(\)/);
    // posture / policy / ceiling / rubric controls
    expect(src).toContain('mergePosture');
    expect(src).toContain('reviewPolicy');
    expect(src).toContain('routableCeiling');
    expect(src).toContain('riskRubric');
  });

  it('save button is structurally gated: disabled prop includes evalEmpty which is true when evaluation is empty', () => {
    // NOTE: No React test renderer is configured in the server vitest setup, so we verify
    // the behavior via source analysis rather than mount/render. A full render-based test
    // (e.g. using @testing-library/react) would need a dedicated web test harness.
    const src = read('components/ContractEditor.tsx');
    // The Btn that saves must reference disabled={saving || evalEmpty}
    expect(src).toMatch(/disabled=\{saving \|\| evalEmpty\}/);
    // evalEmpty is derived from evaluation.trim() being falsy
    expect(src).toMatch(/evalEmpty\s*=\s*!c\.evaluation\.trim\(\)/);
    // When evalEmpty is true, the save control is disabled — verified structurally above.
    // When evalEmpty is false (non-empty evaluation), the button is enabled (saving permitting).
  });

  it('resyncs allowedRaw and forbiddenRaw when parent resets draft via useEffect', () => {
    const src = read('components/ContractEditor.tsx');
    // useEffect hooks that resync local raw state when draft contract arrays change (e.g. after create reset)
    expect(src).toMatch(/useEffect\(\s*\(\s*\)\s*=>\s*\{\s*setAllowedRaw\(fromList\(draft\.contract\.allowed\)\)/);
    expect(src).toMatch(/useEffect\(\s*\(\s*\)\s*=>\s*\{\s*setForbiddenRaw\(fromList\(draft\.contract\.forbidden\)\)/);
    // both depend on their respective contract array
    expect(src).toContain('[draft.contract.allowed]');
    expect(src).toContain('[draft.contract.forbidden]');
  });
});

describe('web loops — list page', () => {
  it('exists, default-exports a page, and renders the three badge dimensions + toggle', () => {
    const p = join(process.cwd(), '..', 'web', 'app/loops/page.tsx');
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).toMatch(/export default function LoopsPage/);
    expect(src).toContain("'use client'");
    // badges: kind + control-plane + mode (with N/threshold counter), enabled toggle
    expect(src).toContain('kind');
    expect(src).toContain('controlPlane');
    expect(src).toContain('consecutiveGoodRuns');
    expect(src).toContain('escalationThreshold');
    expect(src).toContain('<Toggle');
    // uses the editor + api helper
    expect(src).toContain('ContractEditor');
    expect(src).toContain('loopsApi');
  });
});

describe('web loops — detail page', () => {
  it('exists and wires promote/demote/fire, judge assessment (lastEval), and recent fires (lastRunId)', () => {
    const p = join(process.cwd(), '..', 'web', 'app/loops/[id]/page.tsx');
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).toMatch(/export default function LoopDetailPage/);
    expect(src).toContain('loopsApi.promote');
    expect(src).toContain('loopsApi.demote');
    expect(src).toContain('loopsApi.fire');
    // judge assessment: loop's own lastEval surfaced prominently (not a per-card comment thread)
    expect(src).toContain('lastEval');
    expect(src).toContain('judge assessment');
    // dry-run intended-action log
    expect(src).toContain('lastRunId');
    // aliveRef unmount guard
    expect(src).toContain('aliveRef');
    expect(src).toMatch(/aliveRef\.current/);
    // comments fetch and panel removed — the per-card comment thread was incorrect here
    expect(src).not.toContain('loopsApi.comments');
    expect(src).not.toContain('setComments');
  });
});

describe('web loops — nav entry', () => {
  it('Shell.tsx NAV array carries a /loops entry', () => {
    const src = readFileSync(join(process.cwd(), '..', 'web', 'components/Shell.tsx'), 'utf8');
    expect(src).toContain("href: '/loops'");
    expect(src).toContain("label: 'Loops'");
  });
});
