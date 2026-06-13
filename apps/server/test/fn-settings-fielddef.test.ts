/**
 * Real tests for settings.ts fieldDef — the registry lookup the PUT route uses to
 * find (and gate) a setting by key. Importing settings pulls the full config/registry
 * graph, so the DB is isolated to a tmp dir first.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-settings-'));

let settings: typeof import('../src/settings.js');
beforeAll(async () => { settings = await import('../src/settings.js'); });

describe('fieldDef', () => {
  it('returns the matching field def for a known key', () => {
    const f = settings.fieldDef('GITHUB_TOKEN');
    expect(f).toBeDefined();
    expect(f!.key).toBe('GITHUB_TOKEN');
    expect(f!.secret).toBe(true);
    expect(f!.source).toBe('env');
  });

  it('returns a live portal-config field', () => {
    const f = settings.fieldDef('maxConcurrentRuns');
    expect(f).toBeDefined();
    expect(f!.applyTiming).toBe('live');
    expect(f!.editable).toBe(true);
  });

  it('returns undefined for an unknown key', () => {
    expect(settings.fieldDef('___not_a_real_setting___')).toBeUndefined();
  });

  it('every field returned by buildSettings resolves back via fieldDef', () => {
    for (const s of settings.buildSettings()) {
      expect(settings.fieldDef(s.key)?.key).toBe(s.key);
    }
  });
});
