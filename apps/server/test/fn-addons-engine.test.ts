/**
 * Real tests for the addons.ts engine add-on public API used by registry.ts:
 *   getEngineBin / engineLaunchConfig / isEngineEnabled / resetAddonRuntimeForDataWipe.
 * Importing addons pulls db → isolated tmp DB. No engine is actually spawned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-engine-'));

let addons: typeof import('../src/addons.js');
beforeAll(async () => { addons = await import('../src/addons.js'); });

describe('engineLaunchConfig', () => {
  it('returns the codex config shape', () => {
    const cfg = addons.engineLaunchConfig('codex') as any;
    expect(cfg).toHaveProperty('defaultModel');
    expect(cfg).toHaveProperty('sandbox');
  });
  it('returns the opencode config shape', () => {
    const cfg = addons.engineLaunchConfig('opencode') as any;
    expect(cfg).toHaveProperty('defaultModel');
    expect(cfg).toHaveProperty('skipPermissions');
  });
  it('throws for a non-engine id', () => {
    expect(() => addons.engineLaunchConfig('claude' as any)).toThrow();
  });
});

describe('isEngineEnabled', () => {
  it('defaults to false and is false for non-engines', () => {
    expect(addons.isEngineEnabled('codex')).toBe(false);
    expect(addons.isEngineEnabled('opencode')).toBe(false);
    expect(addons.isEngineEnabled('claude' as any)).toBe(false);
  });
});

describe('getEngineBin', () => {
  it('is null for a non-engine id', async () => {
    expect(await addons.getEngineBin('claude' as any)).toBeNull();
  });
  it('resolves to a string path or null for a real engine (depends on install)', async () => {
    const bin = await addons.getEngineBin('codex');
    expect(bin === null || typeof bin === 'string').toBe(true);
  });
});

describe('resetAddonRuntimeForDataWipe', () => {
  it('clears runtime caches without throwing', async () => {
    await expect(addons.resetAddonRuntimeForDataWipe()).resolves.toBeUndefined();
  });
});
