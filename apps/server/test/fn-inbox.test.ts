/**
 * Real test for inbox.ts getInboxItems — derives the approval inbox from live runs that
 * are awaiting-permission / awaiting-input. With no waiting runs it must return an empty
 * list (and never throw). Importing inbox pulls registry + db → isolated tmp DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-inbox-'));

let inbox: typeof import('../src/inbox.js');
beforeAll(async () => { inbox = await import('../src/inbox.js'); });

describe('getInboxItems', () => {
  it('returns an empty array when no run is awaiting input/permission', () => {
    const items = inbox.getInboxItems();
    expect(Array.isArray(items)).toBe(true);
    expect(items).toEqual([]);
  });

  it('every returned item (if any) carries a slim run + a valid kind', () => {
    for (const item of inbox.getInboxItems()) {
      expect(['permission', 'input']).toContain(item.kind);
      expect(item.run).toHaveProperty('id');
      expect(item.run).toHaveProperty('status');
    }
  });
});
