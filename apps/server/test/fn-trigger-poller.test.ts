/**
 * Real tests for startTriggerPoller() in triggers.ts — the 120s background poll loop.
 *
 * What runs FOR REAL: the interval body, pollAllTriggers(), tickTrigger(), the real
 * `gh` subprocess spawn, and every SQLite write — all against an isolated DB
 * (FLEET_DATA_DIR set before import, the isolation pattern from fn-validation.test.ts).
 * The only fakes are the *clock* (vi.useFakeTimers, so we don't wait a real 120s) and
 * the `gh` binary (a PATH shim, the pattern from triggers.test.ts) so the poll is
 * deterministic + offline.
 *
 * We do NOT spy on pollAllTriggers and assert the spy — the interval body calls the
 * module-internal binding (an export spy wouldn't even intercept it), and asserting a
 * spy you wired up is a tautology. Instead we observe a REAL side-effect: a tick of the
 * timer mutates a seeded trigger row's `last_error` in the DB.
 *
 * Clock note: triggers.ts polls gh via a REAL async subprocess (execFile), which does
 * NOT resolve while fake timers are installed. So each test uses fake timers ONLY to
 * fire the 120s interval callback, then restores real timers and polls the DB on the
 * real event loop until the spawned `gh` resolves. That keeps the 120s boundary
 * deterministic without faking the function under test's actual work.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Isolate the DB BEFORE importing triggers (it opens the DB at module load). ──
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-trigpoll-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

const tmpDirs: string[] = [DATA_DIR];
let ORIG_PATH = '';

let T: typeof import('../src/triggers.js');
let db: import('better-sqlite3').Database;

const POLL_FAIL_ERR = 'gh API call failed for owner/poller-repo';

/**
 * Install a fake `gh` whose every `gh api ...` call exits non-zero. That makes
 * triggers.ts `fetchIssuesWithLabel` return null, so a tick on a seeded trigger
 * writes a deterministic `last_error` (POLL_FAIL_ERR) — a real, observable DB
 * mutation we can assert was produced by the timer body. Shimming gh also keeps
 * the test offline (no real GitHub auth / network).
 */
function installFakeGh(): void {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-test-trigpoll-fakegh-'));
  tmpDirs.push(dir);
  const script = `#!/usr/bin/env bash\n# Fake gh: every api call fails → triggers.ts sees a failed poll.\necho "fake-gh: forced failure: $*" >&2\nexit 1\n`;
  const p = join(dir, 'gh');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  ORIG_PATH = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${ORIG_PATH}`;
}

beforeAll(async () => {
  installFakeGh();
  T = await import('../src/triggers.js');
  db = (await import('../src/db.js')).default;
});

afterAll(() => {
  if (ORIG_PATH) process.env.PATH = ORIG_PATH;
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Seed one enabled issue-label trigger directly in the DB; return its id. */
function seedTrigger(): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO triggers (id, repo, kind, config, action, project_id, template, enabled, state, last_error, created_at)
     VALUES (?, ?, 'issue-label', ?, 'card', NULL, NULL, 1, '{"seen":[]}', NULL, ?)`,
  ).run(id, 'owner/poller-repo', JSON.stringify({ label: 'agent' }), Date.now());
  return id;
}

function lastErrorOf(id: string): string | null {
  const row = db.prepare('SELECT last_error FROM triggers WHERE id = ?').get(id) as
    | { last_error: string | null }
    | undefined;
  return row ? row.last_error : null;
}

function clearError(id: string): void {
  db.prepare('UPDATE triggers SET last_error = NULL WHERE id = ?').run(id);
}

/** Poll a predicate on the REAL event loop (real setTimeout) until true or timeout. */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe('startTriggerPoller — interval handle contract', () => {
  it('returns a truthy, clearable timer handle', () => {
    const t = T.startTriggerPoller();
    try {
      // A real Node Timeout is truthy; clearInterval(t) in finally proves it is a
      // usable handle. No mock involved.
      expect(t).toBeTruthy();
    } finally {
      clearInterval(t); // stop it so it can't survive the test
    }
  });
});

describe('startTriggerPoller — the timer body drives a real poll over the DB', () => {
  it('does NOT fire before the 120s boundary, then fires exactly at it', async () => {
    const id = seedTrigger();
    clearError(id);
    expect(lastErrorOf(id)).toBeNull(); // precondition: untouched

    vi.useFakeTimers();
    let t: ReturnType<typeof setInterval> | undefined;
    try {
      t = T.startTriggerPoller();

      // Just under the period → the interval callback must NOT have run (proves 120_000ms).
      await vi.advanceTimersByTimeAsync(119_999);
      // (still on the fake clock here; no gh spawn has been scheduled yet)
      expect(lastErrorOf(id)).toBeNull();

      // Cross the boundary → the interval callback runs, invoking pollAllTriggers and
      // spawning the (real, fake-failing) gh. We stop the interval and restore the real
      // clock so that real subprocess can resolve and write last_error.
      await vi.advanceTimersByTimeAsync(1);
      clearInterval(t);
      t = undefined;
    } finally {
      if (t) clearInterval(t);
      vi.useRealTimers();
    }

    // Real event loop now: the spawned gh resolves → tick persists the failed-poll error.
    const ok = await waitFor(() => lastErrorOf(id) === POLL_FAIL_ERR);
    expect(ok).toBe(true);
    expect(lastErrorOf(id)).toBe(POLL_FAIL_ERR);
  });

  it('is a setInterval: a pending timer remains after each fire, and clearInterval removes it', async () => {
    // This property is verified WITHOUT the real gh subprocess (which can't resolve
    // under fake timers): a setInterval leaves a fresh pending timer after every fire,
    // whereas a setTimeout would self-remove after firing once. We assert that via
    // vi.getTimerCount() across several advances, then confirm clearInterval drops it.
    //
    // pollAllInFlight guard means the body's async work may be pending across these
    // fake-clock advances, but that does NOT remove the interval's own scheduled timer
    // — exactly the distinction between setInterval and setTimeout we want to prove.
    vi.useFakeTimers();
    let t: ReturnType<typeof setInterval> | undefined;
    try {
      const before = vi.getTimerCount();
      t = T.startTriggerPoller();
      // Exactly one new pending timer was scheduled by startTriggerPoller.
      expect(vi.getTimerCount()).toBe(before + 1);

      // Fire three periods. After EACH, a setInterval still has its pending timer
      // (count never drops to `before`); a one-shot setTimeout would vanish after period 1.
      for (let period = 1; period <= 3; period++) {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(vi.getTimerCount()).toBe(before + 1); // still scheduled → re-fires
      }

      // clearInterval(t) removes the recurring timer → count returns to baseline,
      // and further advances fire nothing more.
      clearInterval(t);
      t = undefined;
      expect(vi.getTimerCount()).toBe(before);
      await vi.advanceTimersByTimeAsync(120_000 * 5);
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      if (t) clearInterval(t);
      vi.useRealTimers();
    }

    // Cleanup: a fire above spawned a real gh subprocess that couldn't resolve under
    // fake timers, leaving the module's pollAllInFlight guard latched. Drain it on the
    // real clock so the next test sees a clean sweep (not an early-return no-op).
    await waitFor(() => false, 400); // best-effort settle of the orphaned subprocess
  });
});

describe('pollAllTriggers — real sweep over the isolated DB', () => {
  it('resolves without throwing and ticks enabled triggers (direct, un-faked call)', async () => {
    const id = seedTrigger();
    clearError(id);

    // Direct real call (no fake clock): reads the real enabled triggers, ticks each,
    // spawns the real fake-failing gh, and persists. Resolves to undefined, never throws.
    await expect(T.pollAllTriggers()).resolves.toBeUndefined();

    // The failed fake-gh poll wrote the deterministic error → proves the sweep ran.
    expect(lastErrorOf(id)).toBe(POLL_FAIL_ERR);
  });
});
