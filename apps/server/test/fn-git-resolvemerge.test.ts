/**
 * Real tests for startResolveMerge() in git.ts (v2 #9). These build ACTUAL git
 * repos (no mocks) and drive the real function, which STARTS an integration merge
 * of baseBranch INTO the worktree's checked-out branch and — on conflict — LEAVES
 * the conflict markers + MERGE_HEAD in place (does NOT abort, does NOT commit) so a
 * resolve agent can edit. We assert both the returned descriptor AND the on-disk /
 * index merge state via the same probes pm.ts relies on (isMergeInProgress /
 * hasConflictMarkers). Harness mirrors fn-git-conflict.test.ts: FLEET_DATA_DIR is
 * set BEFORE importing src/git.js so the DB layer is isolated to a temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-resolvemerge-'));

let git: typeof import('../src/git.js');
const dirs: string[] = [];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Fresh repo on `main` with a committed file.txt='base', git identity configured. */
function makeBaseRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-resolvemerge-repo-'));
  dirs.push(dir);
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@fleet.local');
  sh(dir, 'config', 'user.name', 'Fleet Test');
  writeFileSync(join(dir, 'file.txt'), 'base\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'base');
  return dir;
}

beforeAll(async () => { git = await import('../src/git.js'); });
afterAll(() => {
  for (const d of [...dirs, process.env.FLEET_DATA_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('startResolveMerge — CONFLICT leaves markers + MERGE_HEAD (no abort)', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeBaseRepo();
    // branch off base, change file.txt='task', commit
    sh(repo, 'checkout', '-b', 'task-conflict');
    writeFileSync(join(repo, 'file.txt'), 'task\n');
    sh(repo, 'commit', '-am', 'task edit');
    // back on main, change the SAME line differently → guaranteed textual conflict
    sh(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'file.txt'), 'main\n');
    sh(repo, 'commit', '-am', 'main edit');
    // resolve agent runs on the task branch
    sh(repo, 'checkout', 'task-conflict');
  });

  it('returns {conflict:true, conflicts:["file.txt"]}', async () => {
    const r = await git.startResolveMerge(repo, 'main');
    expect(r.conflict).toBe(true);
    expect(r.conflicts).toEqual(['file.txt']);
  });

  it('LEAVES the merge half-done: MERGE_HEAD set + conflict markers on disk (NOT aborted)', async () => {
    // These reflect state AFTER the call above (same repo, sequential it() blocks).
    expect(await git.isMergeInProgress(repo)).toBe(true);
    expect(await git.hasConflictMarkers(repo)).toBe(true);
  });
});

describe('startResolveMerge — ALREADY-INTEGRATED base is a no-op', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeBaseRepo();
    // task = main + one task-only commit (a.txt); main is an ANCESTOR of task's HEAD
    sh(repo, 'checkout', '-b', 'task-ahead');
    writeFileSync(join(repo, 'a.txt'), 'task-only\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'task-only commit');
    // stay on task-ahead; main has NOT advanced past the merge base
  });

  it('returns {conflict:false, conflicts:[]} and starts no merge', async () => {
    const r = await git.startResolveMerge(repo, 'main');
    expect(r).toEqual({ conflict: false, conflicts: [] });
    // nothing was started — no MERGE_HEAD, no markers
    expect(await git.isMergeInProgress(repo)).toBe(false);
    expect(await git.hasConflictMarkers(repo)).toBe(false);
  });
});

describe('startResolveMerge — CLEAN merge auto-commits (no markers left)', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeBaseRepo();
    // task branch edits a.txt
    sh(repo, 'checkout', '-b', 'task-clean');
    writeFileSync(join(repo, 'a.txt'), 'task-a\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'task touches a.txt');
    // main advances by editing a DIFFERENT file (b.txt) → mergeable with no textual conflict
    sh(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'b.txt'), 'main-b\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'main touches b.txt');
    // resolve agent runs on the task branch
    sh(repo, 'checkout', 'task-clean');
  });

  it('returns {conflict:false, conflicts:[]} and auto-commits (no merge left in progress)', async () => {
    const r = await git.startResolveMerge(repo, 'main');
    expect(r).toEqual({ conflict: false, conflicts: [] });
    // clean merge auto-commits → no in-progress merge, no markers
    expect(await git.isMergeInProgress(repo)).toBe(false);
    expect(await git.hasConflictMarkers(repo)).toBe(false);
    // and main's change is now present on the task branch (the merge actually happened)
    expect(sh(repo, 'cat-file', '-e', 'HEAD:b.txt') === '').toBe(true);
  });
});
