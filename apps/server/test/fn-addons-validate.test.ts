/**
 * Real tests for addons.ts config validators (the gate before an addon's settings
 * govern real launch flags / outbound ports). Importing addons pulls db → isolated tmp DB.
 *   validateCompressionConfig — proxy port/budget/booleans
 *   validateEngineConfig      — codex/opencode defaultModel + per-engine knobs
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-addons-'));

let addons: typeof import('../src/addons.js');
beforeAll(async () => { addons = await import('../src/addons.js'); });

const status = (fn: () => unknown): number | undefined => {
  try { fn(); return undefined; } catch (e: any) { return e?.statusCode; }
};

describe('validateCompressionConfig', () => {
  it('rejects non-objects', () => {
    expect(status(() => addons.validateCompressionConfig(null))).toBe(400);
    expect(status(() => addons.validateCompressionConfig(7))).toBe(400);
  });

  it('enforces the proxy port range and refuses the portal ports', () => {
    expect(status(() => addons.validateCompressionConfig({ port: 80 }))).toBe(400);      // < 1024
    expect(status(() => addons.validateCompressionConfig({ port: 70000 }))).toBe(400);   // > 65535
    expect(status(() => addons.validateCompressionConfig({ port: 1234.5 }))).toBe(400);  // non-integer
    expect(status(() => addons.validateCompressionConfig({ port: 4319 }))).toBe(400);    // == server PORT
    expect(status(() => addons.validateCompressionConfig({ port: 4318 }))).toBe(400);    // == web PORT
    expect(addons.validateCompressionConfig({ port: 9876 }).port).toBe(9876);
  });

  it('type-checks the boolean knobs', () => {
    expect(status(() => addons.validateCompressionConfig({ optimize: 'yes' }))).toBe(400);
    expect(addons.validateCompressionConfig({ optimize: false }).optimize).toBe(false);
  });

  it('accepts a null or positive daily budget, rejects <= 0', () => {
    expect(addons.validateCompressionConfig({ dailyBudgetUsd: null }).dailyBudgetUsd).toBeNull();
    expect(addons.validateCompressionConfig({ dailyBudgetUsd: 3 }).dailyBudgetUsd).toBe(3);
    expect(status(() => addons.validateCompressionConfig({ dailyBudgetUsd: 0 }))).toBe(400);
    expect(status(() => addons.validateCompressionConfig({ dailyBudgetUsd: -5 }))).toBe(400);
  });
});

describe('validateEngineConfig', () => {
  it('rejects an unknown engine id', () => {
    expect(status(() => addons.validateEngineConfig('nope', {}))).toBe(400);
  });

  it('codex: validates sandbox enum and defaultModel hygiene', () => {
    expect(addons.validateEngineConfig('codex', { sandbox: 'read-only' }))
      .toMatchObject({ sandbox: 'read-only' });
    expect(status(() => addons.validateEngineConfig('codex', { sandbox: 'wide-open' }))).toBe(400);
    expect(status(() => addons.validateEngineConfig('codex', { defaultModel: '-flag' }))).toBe(400);
    expect(status(() => addons.validateEngineConfig('codex', { defaultModel: 'x'.repeat(129) }))).toBe(400);
    expect(addons.validateEngineConfig('codex', { defaultModel: '  gpt-5  ' }))
      .toMatchObject({ defaultModel: 'gpt-5' });
    expect(addons.validateEngineConfig('codex', { defaultModel: '   ' }))
      .toMatchObject({ defaultModel: null }); // blank → null
  });

  it('opencode: validates skipPermissions boolean', () => {
    expect(addons.validateEngineConfig('opencode', { skipPermissions: true }))
      .toMatchObject({ skipPermissions: true });
    expect(status(() => addons.validateEngineConfig('opencode', { skipPermissions: 'sure' }))).toBe(400);
  });
});
