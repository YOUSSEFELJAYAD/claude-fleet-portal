/**
 * Real test for envboot.ts (§31) — loads the managed data/.env into process.env BEFORE config.ts
 * freezes env. We point FLEET_DATA_DIR at a temp dir, drop a real .env there, then import envboot
 * and assert the keys landed in process.env and MANAGED_ENV_PATH resolved to <dataDir>/.env.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-envboot-'));
process.env.FLEET_DATA_DIR = dataDir;
// a key that doesn't already exist in the environment
const KEY = 'FLEET_ENVBOOT_PROBE_XYZ';
delete process.env[KEY];
writeFileSync(join(dataDir, '.env'), `${KEY}=loaded-from-managed-env\n# a comment\nEMPTY=\n`);

let envboot: typeof import('../src/envboot.js');
beforeAll(async () => { envboot = await import('../src/envboot.js'); });
afterAll(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('envboot', () => {
  it('loads the managed .env into process.env at import time', () => {
    expect(process.env[KEY]).toBe('loaded-from-managed-env');
  });

  it('resolves MANAGED_ENV_PATH to <FLEET_DATA_DIR>/.env', () => {
    expect(envboot.MANAGED_ENV_PATH).toBe(join(dataDir, '.env'));
  });
});
