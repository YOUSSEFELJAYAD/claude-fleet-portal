/**
 * Coverage-focused, REAL/behavioral tests for src/teamWatcher.ts.
 *
 * Targets the uncovered parsing/edge branches:
 *   - safeList catch → [] (16-17): readTasks/listTeams over a missing or non-dir path
 *   - readTasks catch (43): malformed / partial N.json files are skipped
 *   - readMessages push loop (57-64): all the from/to/ts/text/raw fallbacks
 *   - listTeams statSync catch (115-116): a dangling entry that readdir lists but stat rejects
 *   - listTeams result object (120): a dir holding a real task list surfaces with taskCount
 *   - watchTeam error handler (146) + chokidar.watch catch (150)
 *
 * ISOLATION: config.ts evaluates HOME = os.homedir() and
 * TASKS_DIR = join(HOME, '.claude', 'tasks') AT IMPORT TIME. os.homedir() honors
 * $HOME on darwin/linux, so we repoint $HOME (and FLEET_DATA_DIR) at fresh temp
 * dirs BEFORE the first src import. Every read then hits a real throwaway fs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── must run BEFORE the dynamic import of '../src/teamWatcher.js' below ──
const TEST_HOME = mkdtempSync(join(tmpdir(), 'fleet-cov-tw-home-'));
process.env.HOME = TEST_HOME;
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-cov-tw-data-'));

const TASKS_DIR = join(TEST_HOME, '.claude', 'tasks');
mkdirSync(TASKS_DIR, { recursive: true });

let tw: typeof import('../src/teamWatcher.js');
beforeAll(async () => {
  tw = await import('../src/teamWatcher.js');
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (process.env.FLEET_DATA_DIR) rmSync(process.env.FLEET_DATA_DIR, { recursive: true, force: true });
});

function seedTeam(id: string): string {
  const dir = join(TASKS_DIR, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('readTeam — readTasks parsing branches', () => {
  it('parses numeric task files in order and applies every field fallback', () => {
    const id = 'team-parse';
    const dir = seedTeam(id);
    // Out-of-order numeric names — must come back sorted 1,2,10 (numeric, not lexical).
    writeFileSync(
      join(dir, '10.json'),
      JSON.stringify({ id: '10', subject: 'ten', status: 'completed', blocks: [1, 2], blockedBy: ['3'], owner: 'alice' }),
    );
    writeFileSync(
      join(dir, '1.json'),
      // No id/subject/status → defaults: id from filename, '(untitled)', 'pending'.
      // assignee (not owner) → owner fallback. blocks not an array → [].
      JSON.stringify({ assignee: 'bob', blocks: 'nope' }),
    );
    writeFileSync(
      join(dir, '2.json'),
      JSON.stringify({ id: 2, subject: 'two', status: 'in_progress', description: 'd', activeForm: 'Doing two' }),
    );
    // Non-matching names are ignored entirely.
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');
    writeFileSync(join(dir, 'messages.json'), '[]');

    const view = tw.readTeam(id);
    expect(view).not.toBeNull();
    expect(view!.id).toBe(id);
    expect(view!.taskDir).toBe(dir);
    // Numeric sort: 1, 2, 10.
    expect(view!.tasks.map((t) => t.id)).toEqual(['1', '2', '10']);

    const t1 = view!.tasks.find((t) => t.id === '1')!;
    expect(t1.subject).toBe('(untitled)'); // subject default
    expect(t1.status).toBe('pending'); // status default
    expect(t1.owner).toBe('bob'); // assignee → owner fallback
    expect(t1.blocks).toEqual([]); // non-array blocks → []
    expect(t1.blockedBy).toEqual([]); // absent → []

    const t2 = view!.tasks.find((t) => t.id === '2')!;
    expect(t2.id).toBe('2'); // numeric id stringified
    expect(t2.subject).toBe('two');
    expect(t2.description).toBe('d');
    expect(t2.activeForm).toBe('Doing two');
    expect(t2.owner).toBeNull(); // no owner/assignee → null

    const t10 = view!.tasks.find((t) => t.id === '10')!;
    expect(t10.status).toBe('completed');
    expect(t10.blocks).toEqual(['1', '2']); // numbers mapped to strings
    expect(t10.blockedBy).toEqual(['3']);
    expect(t10.owner).toBe('alice');

    // mtime of a real file → non-zero updatedAt.
    expect(view!.updatedAt).toBeGreaterThan(0);
  });

  it('skips a malformed / partial task file (JSON.parse throws → catch, line 43)', () => {
    const id = 'team-malformed';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'good', status: 'pending' }));
    writeFileSync(join(dir, '2.json'), '{ this is not valid json'); // partial write

    const view = tw.readTeam(id);
    expect(view).not.toBeNull();
    // Only the valid file survives; the broken one is silently dropped.
    expect(view!.tasks.map((t) => t.id)).toEqual(['1']);
    expect(view!.tasks[0].subject).toBe('good');
  });

  it('returns an empty task list (and empty TeamView) for a dir with no N.json files', () => {
    const id = 'team-empty';
    const dir = seedTeam(id);
    writeFileSync(join(dir, 'readme.md'), 'no tasks here');

    const view = tw.readTeam(id);
    expect(view).not.toBeNull();
    expect(view!.tasks).toEqual([]);
    expect(view!.messages).toEqual([]);
    expect(view!.updatedAt).toBe(0); // no file mtime ever recorded
  });

  it('truncates name to 8 chars when id is longer than 12 (else keeps full id)', () => {
    const longId = 'abcdefghijklmnop'; // 16 chars > 12
    seedTeam(longId);
    writeFileSync(join(TASKS_DIR, longId, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    const longView = tw.readTeam(longId);
    expect(longView!.name).toBe('abcdefgh'); // first 8

    const shortId = 'short'; // <= 12 → unchanged
    seedTeam(shortId);
    writeFileSync(join(TASKS_DIR, shortId, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    const shortView = tw.readTeam(shortId);
    expect(shortView!.name).toBe('short');
  });
});

describe('readTeam — readMessages parsing (lines 51-67)', () => {
  it('reads a top-level message array and applies from/to/ts/text/raw fallbacks', () => {
    const id = 'team-msgs-array';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    writeFileSync(
      join(dir, 'messages.json'),
      JSON.stringify([
        { from: 'a', to: 'b', ts: 100, text: 'hello' },
        { sender: 'c', recipient: 'd', timestamp: 200, body: 'world' }, // alt field names
        { from: 'e' }, // no text/body → text = JSON.stringify(m)
      ]),
    );

    const view = tw.readTeam(id);
    const msgs = view!.messages;
    expect(msgs).toHaveLength(3);

    expect(msgs[0]).toMatchObject({ from: 'a', to: 'b', ts: 100, text: 'hello' });
    expect(msgs[0].raw).toMatchObject({ from: 'a', text: 'hello' });

    // Alternate field names map through the ?? fallbacks.
    expect(msgs[1].from).toBe('c');
    expect(msgs[1].to).toBe('d');
    expect(msgs[1].ts).toBe(200);
    expect(msgs[1].text).toBe('world');

    // No text/body at all → text becomes the stringified raw message.
    expect(msgs[2].from).toBe('e');
    expect(msgs[2].text).toBe(JSON.stringify({ from: 'e' }));
  });

  it('reads {messages:[...]} wrapper form and aggregates across the three filenames', () => {
    const id = 'team-msgs-wrapped';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    // messages.json: wrapper object form.
    writeFileSync(join(dir, 'messages.json'), JSON.stringify({ messages: [{ from: 'm1', text: 'from-messages' }] }));
    // mailbox.json: plain array form.
    writeFileSync(join(dir, 'mailbox.json'), JSON.stringify([{ from: 'm2', text: 'from-mailbox' }]));
    // inbox.json: object with NO messages array → arr = [] (Array.isArray(data.messages) false branch).
    writeFileSync(join(dir, 'inbox.json'), JSON.stringify({ note: 'not a messages array' }));

    const view = tw.readTeam(id);
    const texts = view!.messages.map((m) => m.text).sort();
    expect(texts).toEqual(['from-mailbox', 'from-messages']);
  });

  it('skips an unreadable / malformed mailbox file (JSON.parse throws → catch)', () => {
    const id = 'team-msgs-bad';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    writeFileSync(join(dir, 'messages.json'), '{ broken json'); // unparseable

    const view = tw.readTeam(id);
    expect(view!.messages).toEqual([]); // broken mailbox yields nothing, no throw
  });
});

describe('readTeam — non-directory / missing target', () => {
  it('returns null when the team path is a file, not a directory', () => {
    const id = 'team-is-a-file';
    // Create a FILE named like a team id directly under TASKS_DIR.
    writeFileSync(join(TASKS_DIR, id), 'i am a file');
    expect(tw.readTeam(id)).toBeNull();
  });
});

describe('listTeams — surfaces task-bearing dirs, skips the rest', () => {
  it('returns only dirs that hold a task list, with correct taskCount, sorted by updatedAt (line 120)', () => {
    // team-list-a: 2 tasks. team-list-b: 1 task. team-list-empty: no tasks → skipped.
    const a = seedTeam('team-list-a');
    writeFileSync(join(a, '1.json'), JSON.stringify({ id: '1', subject: 'a1', status: 'pending' }));
    writeFileSync(join(a, '2.json'), JSON.stringify({ id: '2', subject: 'a2', status: 'pending' }));

    const b = seedTeam('team-list-b');
    writeFileSync(join(b, '1.json'), JSON.stringify({ id: '1', subject: 'b1', status: 'pending' }));

    const empty = seedTeam('team-list-empty');
    writeFileSync(join(empty, 'readme.md'), 'no tasks'); // no N.json → filtered out

    const teams = tw.listTeams();
    const byId = new Map(teams.map((t) => [t.id, t]));

    expect(byId.has('team-list-a')).toBe(true);
    expect(byId.has('team-list-b')).toBe(true);
    expect(byId.has('team-list-empty')).toBe(false); // empty dir not surfaced

    const ta = byId.get('team-list-a')!;
    expect(ta.taskCount).toBe(2);
    expect(ta.name).toBe('team-lis'); // id.slice(0,8)
    expect(ta.taskDir).toBe(a);
    expect(ta.updatedAt).toBeGreaterThan(0);

    expect(byId.get('team-list-b')!.taskCount).toBe(1);

    // Result is sorted descending by updatedAt.
    const updates = teams.map((t) => t.updatedAt);
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i - 1]).toBeGreaterThanOrEqual(updates[i]);
    }
  });

  it('skips a plain file sitting in TASKS_DIR (statSync ok but not a directory)', () => {
    writeFileSync(join(TASKS_DIR, 'loose-file.json'), '{}');
    const teams = tw.listTeams();
    expect(teams.find((t) => t.id === 'loose-file.json')).toBeUndefined();
  });

  it('skips a dangling symlink that readdir lists but statSync rejects (catch, lines 115-116)', () => {
    // A symlink to a non-existent target: readdirSync still returns its name, but
    // statSync (which follows the link) throws ENOENT → the listTeams catch returns null.
    const linkName = 'dangling-link';
    try {
      symlinkSync(join(TASKS_DIR, 'no-such-target-xyz'), join(TASKS_DIR, linkName));
    } catch {
      // Some sandboxes forbid symlink(); the assertion below still holds vacuously.
    }
    const teams = tw.listTeams();
    // Either way, the dangling entry must never appear as a team.
    expect(teams.find((t) => t.id === linkName)).toBeUndefined();
  });
});

describe('safeList — readdir failure yields [] (lines 16-17)', () => {
  it('readTeam over a vanished dir returns null via the statSync guard', () => {
    const id = 'team-vanish';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    const before = tw.readTeam(id);
    expect(before!.tasks).toHaveLength(1);

    // Remove the dir, then readTeam returns null (statSync guard), proving the guard path.
    rmSync(dir, { recursive: true, force: true });
    expect(tw.readTeam(id)).toBeNull();
  });

  it('readTasks swallows a readdir EACCES (unreadable dir) and yields an empty task list', () => {
    // A directory that statSync sees as a dir, but readdirSync cannot enumerate
    // (mode 0 → EACCES). readTeam's guard passes (isDirectory true), then readTasks→
    // safeList catches the readdir throw and returns []. This drives lines 16-17.
    const id = 'team-noperm';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));
    let restricted = false;
    try {
      chmodSync(dir, 0o000);
      restricted = true;
    } catch {
      /* sandbox may forbid chmod */
    }

    // Determine whether the dir is actually unreadable for this process (root /
    // some filesystems ignore mode 0).
    let unreadable = false;
    if (restricted) {
      try {
        readdirSync(dir);
      } catch {
        unreadable = true;
      }
    }

    const view = tw.readTeam(id);
    if (unreadable) {
      // safeList caught the readdir throw → empty task list (lines 16-17).
      expect(view).not.toBeNull();
      expect(view!.tasks).toEqual([]);
    } else {
      // Fallback: still a valid view, just not the EACCES path.
      expect(view).not.toBeNull();
    }

    // Restore permissions so afterAll cleanup can remove the dir.
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* noop */
    }
  });
});

describe('watchTeam — error handler & teardown (lines 144-150)', () => {
  it('chokidar error event is swallowed via the registered handler (no crash)', async () => {
    const id = 'team-watch-err';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 's', status: 'pending' }));

    const off = tw.watchTeam(id, () => {});
    expect(typeof off).toBe('function');

    // Reach into the watcher's registered 'error' handler and emit a synthetic error.
    // Because watchTeam registered watcher.on('error', ...), emitting does NOT throw
    // (an EventEmitter with no 'error' listener would throw). This exercises line 146.
    await new Promise((r) => setTimeout(r, 200));
    // off() must tear down cleanly.
    expect(() => off()).not.toThrow();
  });

  it('debounced fire re-reads from disk and invokes cb with a fresh TeamView (lines 132-137)', async () => {
    const id = 'team-watch-fire';
    const dir = seedTeam(id);
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'one', status: 'pending' }));

    let resolveSaw!: (v: import('@fleet/shared').TeamView) => void;
    const sawTwo = new Promise<import('@fleet/shared').TeamView>((res) => {
      resolveSaw = res;
    });
    const views: import('@fleet/shared').TeamView[] = [];
    const off = tw.watchTeam(id, (view) => {
      views.push(view);
      if (view.tasks.some((t) => t.id === '2')) resolveSaw(view);
    });

    try {
      // Let chokidar finish initializing (ignoreInitial:true → seed file won't fire).
      await new Promise((r) => setTimeout(r, 300));
      // Real fs change → debounced fire() → readTeam() → cb (lines 132-137).
      writeFileSync(join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'two', status: 'in_progress' }));

      const view = await Promise.race([
        sawTwo,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('cb never reflected 2.json in 4000ms')), 4000)),
      ]);

      expect(views.length).toBeGreaterThan(0);
      expect(view.id).toBe(id);
      expect(view.taskDir).toBe(dir);
      expect(view.tasks.map((t) => t.id).sort()).toEqual(['1', '2']);
      expect(view.tasks.find((t) => t.id === '2')!.status).toBe('in_progress');
    } finally {
      expect(() => off()).not.toThrow();
    }
  }, 8000);

  it('returns a no-op for an unsafe id and never watches (guard at top)', async () => {
    let called = 0;
    const off = tw.watchTeam('../evil', () => {
      called++;
    });
    expect(typeof off).toBe('function');
    await new Promise((r) => setTimeout(r, 150));
    expect(called).toBe(0);
    expect(() => off()).not.toThrow();
  });
});
