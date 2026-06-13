// apps/server/test/loop-config.test.ts
// §24/Loop — fleet-wide auto-merge risk ceiling. validateConfig is a pure function,
// so we exercise it directly (no FLEET_DATA_DIR isolation needed) — same intent as
// the PUT /api/config validation block in guardrails.test.ts.
import { describe, it, expect } from 'vitest';
import { validateConfig, DEFAULT_CONFIG } from '../src/config.js';

describe('validateConfig — loopAutoMergeCeiling', () => {
  it('defaults to null when the key is absent', () => {
    expect(DEFAULT_CONFIG.loopAutoMergeCeiling).toBeNull();
    expect(validateConfig({}).loopAutoMergeCeiling).toBeNull();
  });

  it('threads a valid RiskLevel through unchanged', () => {
    expect(validateConfig({ loopAutoMergeCeiling: 'low' }).loopAutoMergeCeiling).toBe('low');
    expect(validateConfig({ loopAutoMergeCeiling: 'medium' }).loopAutoMergeCeiling).toBe('medium');
    expect(validateConfig({ loopAutoMergeCeiling: 'high' }).loopAutoMergeCeiling).toBe('high');
  });

  it('falls back to the default (null) on an invalid value', () => {
    expect(validateConfig({ loopAutoMergeCeiling: 'extreme' }).loopAutoMergeCeiling).toBeNull();
    expect(validateConfig({ loopAutoMergeCeiling: 42 }).loopAutoMergeCeiling).toBeNull();
    expect(validateConfig({ loopAutoMergeCeiling: null }).loopAutoMergeCeiling).toBeNull();
  });

  it('round-trips a full config through validateConfig without dropping the key', () => {
    // validateConfig returns a fixed literal that drops unnamed keys, so this proves the
    // ceiling is threaded into that literal — a valid value survives and unrelated guardrail
    // keys are preserved. (registry.setConfig/getConfig route through this same function.)
    const merged = validateConfig({ ...DEFAULT_CONFIG, loopAutoMergeCeiling: 'low' });
    expect(merged.loopAutoMergeCeiling).toBe('low');
    // unrelated guardrail keys are still present (the literal was threaded, not replaced)
    expect(merged.maxConcurrentRuns).toBe(DEFAULT_CONFIG.maxConcurrentRuns);
  });
});
