/**
 * Real tests for fleet.ts assertCapAboveReserve — the deadlock guard the PUT /api/config
 * path calls before lowering maxConcurrentRuns. Lowering the global cap at/below the fleet
 * reserve zeroes the PM scheduler pool (every card stalls in Ready forever), so it must throw.
 * Drives the real DB-backed fleetRepo (isolated tmp DB).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cap-'));

let fleet: typeof import('../src/fleet.js');
beforeAll(async () => { fleet = await import('../src/fleet.js'); });
afterEach(() => { fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null }); });

const status = (fn: () => unknown): number | undefined => {
  try { fn(); return undefined; } catch (e: any) { return e?.statusCode; }
};

describe('assertCapAboveReserve', () => {
  it('throws 400 when the next cap is at or below the reserve', () => {
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 2, fleetSpendCeilingUsd: null });
    expect(status(() => fleet.assertCapAboveReserve(2))).toBe(400); // == reserve → pool 0
    expect(status(() => fleet.assertCapAboveReserve(1))).toBe(400); // < reserve
    expect(status(() => fleet.assertCapAboveReserve(0))).toBe(400);
  });

  it('does not throw when the next cap leaves at least one PM slot', () => {
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 2, fleetSpendCeilingUsd: null });
    expect(() => fleet.assertCapAboveReserve(3)).not.toThrow();
    expect(() => fleet.assertCapAboveReserve(8)).not.toThrow();
  });

  it('with the default reserve of 0, only a cap of 0 is rejected', () => {
    // default DEFAULT_FLEET_CONFIG.reserveSlotsForNonPm === 0
    expect(status(() => fleet.assertCapAboveReserve(0))).toBe(400);
    expect(() => fleet.assertCapAboveReserve(1)).not.toThrow();
  });
});

describe('validateFleetConfig — clamp + DEFAULT merge + cross-config invariant', () => {
  it('rejects non-objects and out-of-range reserve', () => {
    expect(status(() => fleet.validateFleetConfig(null))).toBe(400);
    expect(status(() => fleet.validateFleetConfig({ reserveSlotsForNonPm: -1 }))).toBe(400);
    expect(status(() => fleet.validateFleetConfig({ reserveSlotsForNonPm: 1.5 }))).toBe(400);
    expect(status(() => fleet.validateFleetConfig({ reserveSlotsForNonPm: 101 }))).toBe(400);
  });

  it('accepts a null spend ceiling and a finite non-negative number', () => {
    expect(fleet.validateFleetConfig({ fleetSpendCeilingUsd: null }).fleetSpendCeilingUsd).toBeNull();
    expect(fleet.validateFleetConfig({ fleetSpendCeilingUsd: 25 }).fleetSpendCeilingUsd).toBe(25);
    expect(status(() => fleet.validateFleetConfig({ fleetSpendCeilingUsd: -1 }))).toBe(400);
  });

  it('fills missing keys from DEFAULT_FLEET_CONFIG', () => {
    expect(fleet.validateFleetConfig({})).toEqual(fleet.DEFAULT_FLEET_CONFIG);
  });

  it('rejects a reserve that would swallow the whole concurrency pool (deadlock)', () => {
    // registry default maxConcurrentRuns is 8 → reserve >= 8 zeroes the PM pool
    expect(status(() => fleet.validateFleetConfig({ reserveSlotsForNonPm: 100 }))).toBe(400);
  });
});
