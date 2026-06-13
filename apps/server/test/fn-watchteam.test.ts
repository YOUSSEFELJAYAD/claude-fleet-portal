/**
 * Real/behavioral tests for watchTeam(id, cb) in src/teamWatcher.ts.
 *
 * watchTeam chokidar-watches ~/.claude/tasks/<id>/ and fires cb(TeamView)
 * (debounced ~150ms) on any change, returns an unsubscribe fn, and returns a
 * no-op fn that never watches when isSafeId(id) is false.
 *
 * ISOLATION: config.ts computes HOME = os.homedir() and
 * TASKS_DIR = path.join(HOME, '.claude', 'tasks') AT IMPORT TIME. os.homedir()
 * honors $HOME on this platform, so we point $HOME (and FLEET_DATA_DIR) at fresh
 * temp dirs BEFORE any src import. TASKS_DIR then lives inside our temp HOME and
 * the watcher operates on a real, throwaway filesystem.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── must run BEFORE the dynamic import of '../src/teamWatcher.js' below ──
const TEST_HOME = mkdtempSync(join(tmpdir(), 'fleet-test-home-'));
process.env.HOME = TEST_HOME;
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-watch-'));

const TASKS_DIR = join(TEST_HOME, '.claude', 'tasks');

let tw: typeof import('../src/teamWatcher.js');
beforeAll(async () => {
  tw = await import('../src/teamWatcher.js');
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (process.env.FLEET_DATA_DIR) rmSync(process.env.FLEET_DATA_DIR, { recursive: true, force: true });
});

describe('watchTeam — real chokidar watch over a temp tasks dir', () => {
  it(
    'fires cb with a fresh TeamView when a task file is added',
    async () => {
      const id = 'team-watch-a';
      const dir = join(TASKS_DIR, id);
      mkdirSync(dir, { recursive: true });
      // Seed a valid initial task file so the dir exists before the watch starts.
      writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'x', status: 'pending' }));

      // Record every cb invocation. We resolve `sawTwo` once a fired view reflects
      // the newly-added 2.json — chokidar may emit several events as the fs settles,
      // and the first fire can snapshot the dir before the add is fully visible, so
      // we wait for the view that includes it rather than asserting on the 1st fire.
      const views: import('@fleet/shared').TeamView[] = [];
      let resolveTwo!: (v: import('@fleet/shared').TeamView) => void;
      const sawTwo = new Promise<import('@fleet/shared').TeamView>((res) => {
        resolveTwo = res;
      });
      const off = tw.watchTeam(id, (view) => {
        views.push(view);
        if (view.tasks.some((t) => t.id === '2')) resolveTwo(view);
      });
      expect(typeof off).toBe('function');

      try {
        // Give chokidar time to initialize its watch (ignoreInitial:true means the
        // seed file won't fire on its own; only changes after init do).
        await new Promise((r) => setTimeout(r, 300));

        // A real change: add a second task file. This drives a real fs event → cb.
        writeFileSync(join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'y', status: 'in_progress' }));

        const view = await Promise.race([
          sawTwo,
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('cb never reflected 2.json within 4000ms')), 4000),
          ),
        ]);

        // cb fired at least once from a real fs event.
        expect(views.length).toBeGreaterThan(0);
        // cb received a real TeamView for THIS team, rebuilt from disk by readTeam.
        expect(view.id).toBe(id);
        expect(view.taskDir).toBe(dir);
        // The view was re-read after the add, so it reflects both task files.
        expect(view.tasks.map((t) => t.id).sort()).toEqual(['1', '2']);
        const t2 = view.tasks.find((t) => t.id === '2');
        expect(t2?.subject).toBe('y');
        expect(t2?.status).toBe('in_progress');
      } finally {
        // off() must close the watcher without throwing.
        expect(() => off()).not.toThrow();
      }
    },
    8000,
  );
});

describe('watchTeam — guard: unsafe ids never watch', () => {
  it('returns a no-op fn that never calls cb for a traversal id', async () => {
    let called = 0;
    const off = tw.watchTeam('../evil', () => {
      called++;
    });
    expect(typeof off).toBe('function');

    // Even if we poke the real evil target path, the no-op watcher must stay silent.
    // (There is no watcher at all for an unsafe id.)
    await new Promise((r) => setTimeout(r, 400));
    expect(called).toBe(0);

    // The returned no-op must itself be safe to call.
    expect(() => off()).not.toThrow();
  });
});
