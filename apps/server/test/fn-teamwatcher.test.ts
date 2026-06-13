/**
 * Real tests for teamWatcher.ts isSafeId (H21 path-traversal guard) and the
 * readTeam guard path that depends on it. A malicious id must never escape TASKS_DIR.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-team-'));

let tw: typeof import('../src/teamWatcher.js');
beforeAll(async () => { tw = await import('../src/teamWatcher.js'); });

describe('isSafeId', () => {
  it('accepts plain single-segment ids', () => {
    for (const id of ['abc', 'team-1', 'T_123', 'a']) expect(tw.isSafeId(id)).toBe(true);
  });

  it('rejects path separators, traversal, and null bytes', () => {
    for (const id of ['a/b', 'a\\b', '..', 'a..b', '../etc', 'a\0b', '']) {
      expect(tw.isSafeId(id)).toBe(false);
    }
  });

  it('rejects non-string inputs', () => {
    for (const id of [123, null, undefined, {}, [], true]) {
      expect(tw.isSafeId(id as unknown)).toBe(false);
    }
  });
});

describe('readTeam — refuses unsafe ids before touching the filesystem', () => {
  it('returns null for traversal / separator ids', () => {
    expect(tw.readTeam('../../etc/passwd')).toBeNull();
    expect(tw.readTeam('a/b')).toBeNull();
    expect(tw.readTeam('..')).toBeNull();
  });

  it('returns null for a safe-but-nonexistent team id', () => {
    expect(tw.readTeam('definitely-not-a-real-team-xyz')).toBeNull();
  });
});

describe('listTeams — never throws, returns an array', () => {
  it('returns an array (real TASKS_DIR may be empty/absent)', () => {
    const teams = tw.listTeams();
    expect(Array.isArray(teams)).toBe(true);
  });
});
