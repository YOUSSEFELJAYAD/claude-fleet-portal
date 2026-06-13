/**
 * Real tests for the boot-time wiring functions:
 *   search.initSearch(db)        — creates the FTS5 index, flips searchAvailable
 *   learner.initLearner()        — subscribes to terminal runs (must not throw)
 *   projects.onProjectDeleted(cb)— cascade hook fired by deleteProject (unconditionally)
 * All run against the REAL shared SQLite handle (isolated tmp DB).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-boot-'));

let db: any;
let search: typeof import('../src/search.js');
let learner: typeof import('../src/learner.js');
let projects: typeof import('../src/projects.js');

beforeAll(async () => {
  db = (await import('../src/db.js')).default;
  search = await import('../src/search.js');
  learner = await import('../src/learner.js');
  projects = await import('../src/projects.js');
});

describe('initSearch', () => {
  it('creates the FTS5 index and reports search available (idempotent)', () => {
    expect(() => search.initSearch(db)).not.toThrow(); // CREATE ... IF NOT EXISTS → safe to re-run
    expect(search.searchAvailable).toBe(true);
    // the FTS table really exists now
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'events_fts'").get();
    expect(row?.name).toBe('events_fts');
  });
});

describe('initLearner', () => {
  it('subscribes to terminal runs without throwing', () => {
    expect(() => learner.initLearner()).not.toThrow();
  });
});

describe('onProjectDeleted', () => {
  it('fires every registered listener with the deleted id', () => {
    const got: string[] = [];
    projects.onProjectDeleted((id) => got.push(id));
    projects.projectsRepo.deleteProject('proj-deleted-1'); // no row needed; listeners fire regardless
    expect(got).toContain('proj-deleted-1');
  });

  it('a throwing listener does not block the others', () => {
    const got: string[] = [];
    projects.onProjectDeleted(() => { throw new Error('bad subscriber'); });
    projects.onProjectDeleted((id) => got.push(id));
    expect(() => projects.projectsRepo.deleteProject('proj-deleted-2')).not.toThrow();
    expect(got).toContain('proj-deleted-2');
  });
});
