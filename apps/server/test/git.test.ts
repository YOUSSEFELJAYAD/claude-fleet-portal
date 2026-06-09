import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js) is imported.
// git.ts itself has no DB dependency, but we follow the project harness pattern exactly:
// set FLEET_DATA_DIR at the very top and import src lazily inside beforeAll.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-git-'));

// ── src module (loaded lazily; see harness note above) ───────────────────────
let git: typeof import('../src/git.js');

beforeAll(async () => {
  git = await import('../src/git.js');
});

// ── fixtures ─────────────────────────────────────────────────────────────────
// A non-fleet-pm base identity so commits authored by the engine (fleet-pm) are
// distinguishable from the repo's own history.
const BASE_AUTHOR = { name: 'base-user', email: 'base@local' };

/** Track every temp dir so afterEach can tear them all down. */
const tmpDirs: string[] = [];

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Create a temp git repo on `master` with one initial commit (file `a.txt`). */
function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-git-repo-'));
  tmpDirs.push(dir);
  g(dir, 'init', '-b', 'master');
  g(dir, 'config', 'user.email', BASE_AUTHOR.email);
  g(dir, 'config', 'user.name', BASE_AUTHOR.name);
  writeFileSync(join(dir, 'a.txt'), 'a\nb\nc\n');
  g(dir, 'add', 'a.txt');
  g(dir, 'commit', '-m', 'init');
  return dir;
}

/** Short HEAD sha of `cwd`'s current branch. */
function head(cwd: string): string {
  return g(cwd, 'rev-parse', 'HEAD').trim();
}

/** Author "name <email>" of a commit (default HEAD). */
function authorOf(cwd: string, rev = 'HEAD'): string {
  return g(cwd, 'log', '-1', '--format=%an <%ae>', rev).trim();
}

/** Number of parents of a commit (default HEAD): rev-list --parents words minus 1. */
function parentCount(cwd: string, rev = 'HEAD'): number {
  const out = g(cwd, 'rev-list', '--parents', '-n', '1', rev).trim().split(/\s+/);
  return out.length - 1;
}

/**
 * Add a worktree under `.claude/worktrees/<name>` checked out to a fresh branch off HEAD.
 * Mirrors the real engine flow by first gitignoring `.claude/worktrees/` (the startup guardrail
 * ensureWorktreeIgnored does this) so the main worktree stays clean — otherwise the nested
 * worktree dir surfaces as `?? .claude/` and mergeBranch would (correctly) refuse.
 */
function addWorktree(root: string, name: string, branch: string): string {
  if (!existsSync(join(root, '.gitignore'))) {
    writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\n');
    g(root, 'add', '.gitignore');
    g(root, 'commit', '-m', 'chore: ignore worktrees');
  }
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
  const wt = join(root, '.claude', 'worktrees', name);
  g(root, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  // Give the worktree the fleet-pm identity off by default — the engine passes -c flags,
  // but configure a base author so any *non*-engine commit is still attributable.
  g(wt, 'config', 'user.email', BASE_AUTHOR.email);
  g(wt, 'config', 'user.name', BASE_AUTHOR.name);
  return wt;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── safePath: realpath-containment guard (SPEC §7) ────────────────────────────
describe('safePath — realpath-containment guard', () => {
  it('accepts a normal in-root relative path', async () => {
    const root = mkRepo();
    const abs = await git.safePath(root, 'a.txt');
    expect(abs).toBe(join(root, 'a.txt'));
  });

  it('accepts a nested in-root path that does not yet exist on disk', async () => {
    const root = mkRepo();
    // abs need not exist (e.g. a path only in an old rev) — guard resolves nearest ancestor.
    const abs = await git.safePath(root, 'sub/dir/new.txt');
    expect(abs).toBe(join(root, 'sub', 'dir', 'new.txt'));
  });

  it('rejects a traversal escape (../)', async () => {
    const root = mkRepo();
    expect(await git.safePath(root, '../escape')).toBeNull();
    expect(await git.safePath(root, '../../etc/passwd')).toBeNull();
  });

  it('rejects an absolute path', async () => {
    const root = mkRepo();
    expect(await git.safePath(root, '/etc/passwd')).toBeNull();
    expect(await git.safePath(root, join(root, 'a.txt'))).toBeNull(); // absolute even though in-root
  });

  it('rejects a NUL byte in the relative path', async () => {
    const root = mkRepo();
    expect(await git.safePath(root, 'a\0b')).toBeNull();
  });

  it('rejects a symlink whose target escapes the root', async () => {
    const root = mkRepo();
    const outside = mkdtempSync(join(tmpdir(), 'fleet-git-outside-'));
    tmpDirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret\n');
    // in-root symlink -> outside dir; a lexical check would pass, realpath must reject.
    symlinkSync(outside, join(root, 'link'));
    expect(await git.safePath(root, 'link/secret.txt')).toBeNull();
    expect(await git.safePath(root, 'link')).toBeNull();
  });

  it('accepts a symlink that stays inside the root', async () => {
    const root = mkRepo();
    mkdirSync(join(root, 'realdir'));
    writeFileSync(join(root, 'realdir', 'inside.txt'), 'x\n');
    symlinkSync(join(root, 'realdir'), join(root, 'innerlink'));
    expect(await git.safePath(root, 'innerlink/inside.txt')).toBe(join(root, 'innerlink', 'inside.txt'));
  });
});

// ── ensureWorktreeIgnored (SPEC §6 / §10) ─────────────────────────────────────
describe('ensureWorktreeIgnored', () => {
  it('appends .claude/worktrees/ and commits ONLY .gitignore as fleet-pm, leaving main clean', async () => {
    const root = mkRepo();
    const before = head(root);

    await git.ensureWorktreeIgnored(root);

    // .gitignore now contains the rule.
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toMatch(/(^|\n)\.claude\/worktrees\/\n?/);

    // A new commit exists, authored by fleet-pm, touching ONLY .gitignore.
    const after = head(root);
    expect(after).not.toBe(before);
    expect(authorOf(root)).toBe(`${git.FLEET_PM_AUTHOR.name} <${git.FLEET_PM_AUTHOR.email}>`);
    const changed = g(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean);
    expect(changed).toEqual(['.gitignore']);

    // Main worktree is clean (this is the invariant mergeBranch depends on).
    expect(g(root, 'status', '--porcelain').trim()).toBe('');
  });

  it('is idempotent: no second commit and no duplicate rule when already present', async () => {
    const root = mkRepo();
    await git.ensureWorktreeIgnored(root);
    const afterFirst = head(root);

    await git.ensureWorktreeIgnored(root);
    expect(head(root)).toBe(afterFirst); // no phantom commit

    const occurrences = readFileSync(join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter((l) => l === '.claude/worktrees').length;
    expect(occurrences).toBe(1);
  });

  it('recognizes an equivalent pre-existing rule (.claude/worktrees) without re-committing', async () => {
    const root = mkRepo();
    // Pre-seed an equivalent rule (no trailing slash) and commit it ourselves.
    writeFileSync(join(root, '.gitignore'), '.claude/worktrees\n');
    g(root, 'add', '.gitignore');
    g(root, 'commit', '-m', 'pre-ignore');
    const before = head(root);

    await git.ensureWorktreeIgnored(root);
    expect(head(root)).toBe(before); // detected as present → no new commit
  });
});

// ── ensureCommitted (SPEC §6.1) ───────────────────────────────────────────────
describe('ensureCommitted', () => {
  it('commits uncommitted worktree changes as fleet-pm and returns the new HEAD sha', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-ec', 'task-ec');
    const before = head(wt);

    writeFileSync(join(wt, 'a.txt'), 'a\nb\nc\nNEW\n');
    writeFileSync(join(wt, 'brand.txt'), 'fresh\n'); // also an untracked add

    const res = await git.ensureCommitted(wt);

    const after = head(wt);
    expect(after).not.toBe(before);
    expect(res.sha).toBe(after);
    expect(authorOf(wt)).toBe(`${git.FLEET_PM_AUTHOR.name} <${git.FLEET_PM_AUTHOR.email}>`);
    expect(g(wt, 'status', '--porcelain').trim()).toBe(''); // worktree now clean
    // Both the modified and the untracked file were captured.
    const changed = g(wt, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean).sort();
    expect(changed).toEqual(['a.txt', 'brand.txt']);
  });

  it('is a no-op (no phantom commit) when the tree is already clean', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-clean', 'task-clean');
    const before = head(wt);

    const res = await git.ensureCommitted(wt);

    expect(res.sha).toBe(before); // returns current HEAD
    expect(head(wt)).toBe(before); // unchanged — no commit created
  });
});

// ── conflictProbe (SPEC §6.2) — zero side effect ──────────────────────────────
describe('conflictProbe', () => {
  it('returns clean for a non-conflicting branch', async () => {
    const root = mkRepo();
    // feature touches a DIFFERENT file than base → no conflict.
    g(root, 'checkout', '-b', 'feature');
    writeFileSync(join(root, 'feature.txt'), 'feature only\n');
    g(root, 'add', 'feature.txt');
    g(root, 'commit', '-m', 'feature work');
    g(root, 'checkout', 'master');
    writeFileSync(join(root, 'b.txt'), 'base only\n');
    g(root, 'add', 'b.txt');
    g(root, 'commit', '-m', 'base work');

    const res = await git.conflictProbe(root, 'master', 'feature');
    expect(res.clean).toBe(true);
    expect(res.conflicts).toEqual([]);
  });

  it('returns clean=false with the conflicting file list, with ZERO side effects', async () => {
    const root = mkRepo();
    g(root, 'checkout', '-b', 'feature');
    writeFileSync(join(root, 'a.txt'), 'a\nFEATURE\nc\n');
    g(root, 'commit', '-am', 'feature edits a.txt');
    g(root, 'checkout', 'master');
    writeFileSync(join(root, 'a.txt'), 'a\nMASTER\nc\n');
    g(root, 'commit', '-am', 'master edits a.txt');

    const preHead = head(root);
    const preStatus = g(root, 'status', '--porcelain');
    const preFile = readFileSync(join(root, 'a.txt'), 'utf8');

    const res = await git.conflictProbe(root, 'master', 'feature');
    expect(res.clean).toBe(false);
    expect(res.conflicts).toEqual(['a.txt']);

    // Zero-side-effect: HEAD, working tree, and the file on disk are untouched.
    expect(head(root)).toBe(preHead);
    expect(g(root, 'status', '--porcelain')).toBe(preStatus);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(preFile);
    // No merge state was left behind.
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  });
});

// ── integrateAndReport (SPEC §6.4) ────────────────────────────────────────────
describe('integrateAndReport', () => {
  it('merges base into the branch when base advanced (non-conflicting), reporting conflict:false', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-int', 'task-int');
    // branch advances on its own file.
    writeFileSync(join(wt, 'a.txt'), 'a\nb\nc\nBRANCH\n');
    g(wt, 'commit', '-am', 'branch work');
    // base (master) advances a DIFFERENT file after the worktree branched.
    writeFileSync(join(root, 'newbase.txt'), 'base advance\n');
    g(root, 'add', 'newbase.txt');
    g(root, 'commit', '-m', 'base advance');
    const rootHeadBefore = head(root);

    // Sanity: branch does NOT yet contain master's tip.
    expect(() => g(wt, 'merge-base', '--is-ancestor', 'master', 'HEAD')).toThrow();

    const res = await git.integrateAndReport(wt, 'master');
    expect(res.conflict).toBe(false);

    // Branch now contains master (is-ancestor exits 0 → no throw) and the merge is fleet-pm.
    expect(() => g(wt, 'merge-base', '--is-ancestor', 'master', 'HEAD')).not.toThrow();
    expect(authorOf(wt)).toBe(`${git.FLEET_PM_AUTHOR.name} <${git.FLEET_PM_AUTHOR.email}>`);
    expect(existsSync(join(wt, 'newbase.txt'))).toBe(true); // base file pulled into the worktree
    expect(head(root)).toBe(rootHeadBefore); // root HEAD untouched (only the worktree merged)
    expect(g(wt, 'status', '--porcelain').trim()).toBe('');
  });

  it('reports conflict:true on an integration conflict and leaves the worktree clean (not wedged)', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-intc', 'task-intc');
    // branch edits a.txt line 2.
    writeFileSync(join(wt, 'a.txt'), 'a\nBRANCH\nc\n');
    g(wt, 'commit', '-am', 'branch edit');
    // base edits the SAME line differently → integration conflict.
    writeFileSync(join(root, 'a.txt'), 'a\nMASTER\nc\n');
    g(root, 'commit', '-am', 'master edit');

    const res = await git.integrateAndReport(wt, 'master');
    expect(res.conflict).toBe(true);

    // Worktree is clean (merge --abort restored it) — no conflict markers, no MERGE_HEAD.
    expect(g(wt, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('a\nBRANCH\nc\n');
    expect(existsSync(join(root, '.git', 'worktrees', 'wt-intc', 'MERGE_HEAD'))).toBe(false);
  });

  it('is a no-op (conflict:false) when the branch already contains base', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-noop', 'task-noop');
    const before = head(wt);
    // master has NOT advanced past the branch point → branch already contains master.
    const res = await git.integrateAndReport(wt, 'master');
    expect(res.conflict).toBe(false);
    expect(head(wt)).toBe(before); // nothing merged
  });
});

// ── mergeBranch (SPEC §6.5) ───────────────────────────────────────────────────
describe('mergeBranch', () => {
  it('performs merge --no-ff producing a 2-parent merge commit authored by fleet-pm', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-merge', 'task-merge');
    writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    g(wt, 'add', 'feature.txt');
    g(wt, 'commit', '-m', 'feature work');

    const pre = head(root);
    const res = await git.mergeBranch(root, 'task-merge');

    expect(res.ok).toBe(true);
    expect(res.sha).toBe(head(root));
    expect(res.sha).not.toBe(pre);
    expect(parentCount(root)).toBe(2); // --no-ff merge commit
    expect(authorOf(root)).toBe(`${git.FLEET_PM_AUTHOR.name} <${git.FLEET_PM_AUTHOR.email}>`);
    expect(existsSync(join(root, 'feature.txt'))).toBe(true); // branch content landed on main
    // Backup ref recorded for manual recovery.
    expect(g(root, 'rev-parse', 'refs/fleet-backup/task-merge').trim()).toBeTruthy();
  });

  it('REFUSES (ok:false) when the main worktree is dirty', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-dirty', 'task-dirty');
    writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    g(wt, 'add', 'feature.txt');
    g(wt, 'commit', '-m', 'feature work');

    // Dirty the MAIN worktree.
    writeFileSync(join(root, 'a.txt'), 'a\nb\nc\nDIRTY\n');
    const pre = head(root);

    const res = await git.mergeBranch(root, 'task-dirty');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/clean/i);
    expect(head(root)).toBe(pre); // no merge attempted
  });

  it('on a merge-conflict failure path restores main to its pre-merge SHA (ORIG_HEAD), clean', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-conf', 'task-conf');
    // branch edits a.txt line 2.
    writeFileSync(join(wt, 'a.txt'), 'a\nBRANCH\nc\n');
    g(wt, 'commit', '-am', 'branch edit');
    // main edits the SAME line → merge conflict on the final no-ff merge.
    writeFileSync(join(root, 'a.txt'), 'a\nMASTER\nc\n');
    g(root, 'commit', '-am', 'master edit');

    const pre = head(root);
    const res = await git.mergeBranch(root, 'task-conf');

    expect(res.ok).toBe(false);
    // Main is byte-for-byte restored to the pre-merge SHA, working tree clean, no merge state.
    expect(head(root)).toBe(pre);
    expect(g(root, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\nMASTER\nc\n');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  });
});

// ── cleanupWorktree (SPEC §6.6) ───────────────────────────────────────────────
describe('cleanupWorktree', () => {
  it('removes the worktree dir and deletes the branch (idempotent on an unmerged branch)', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-cl', 'task-cl');
    // Unmerged commit on the branch → forces the -D fallback path.
    writeFileSync(join(wt, 'x.txt'), 'x\n');
    g(wt, 'add', 'x.txt');
    g(wt, 'commit', '-m', 'unmerged');

    expect(existsSync(wt)).toBe(true);
    expect(g(root, 'branch', '--list', 'task-cl').trim()).not.toBe('');

    await git.cleanupWorktree(root, 'wt-cl', 'task-cl');

    expect(existsSync(wt)).toBe(false); // worktree dir gone
    expect(g(root, 'branch', '--list', 'task-cl').trim()).toBe(''); // branch deleted
    // worktree list no longer references it.
    expect(g(root, 'worktree', 'list')).not.toMatch(/wt-cl/);
  });

  it('never throws when the worktree/branch do not exist (best-effort idempotent)', async () => {
    const root = mkRepo();
    await expect(git.cleanupWorktree(root, 'ghost', 'ghost-branch')).resolves.toBeUndefined();
  });
});

// ── read helpers (READ-ONLY, salvage-not-throw) ───────────────────────────────
describe('read helpers — lsTree', () => {
  it('lists a directory non-recursively with dirs-first ordering and blob sizes', async () => {
    const root = mkRepo();
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'g.txt'), 'g\n');
    writeFileSync(join(root, 'z.txt'), 'zz\n');
    g(root, 'add', '-A');
    g(root, 'commit', '-m', 'tree');

    const { entries, error } = await git.lsTree(root, 'HEAD', '');
    expect(error).toBeUndefined();
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    // dir comes first
    expect(entries[0].type).toBe('tree');
    expect(byName['sub'].type).toBe('tree');
    expect(byName['sub'].size).toBeNull();
    expect(byName['a.txt'].type).toBe('blob');
    expect(byName['a.txt'].size).toBe(6); // 'a\nb\nc\n'
    expect(byName['z.txt'].size).toBe(3);

    // scoped to subdir
    const sub = await git.lsTree(root, 'HEAD', 'sub');
    expect(sub.entries.map((e) => e.name)).toEqual(['g.txt']);
  });

  it('salvages a bad ref into an error result without throwing', async () => {
    const root = mkRepo();
    const r = await git.lsTree(root, 'no-such-ref', '');
    expect(r.entries).toEqual([]);
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

describe('read helpers — showFile', () => {
  it('returns text content for a normal file', async () => {
    const root = mkRepo();
    const r = await git.showFile(root, 'HEAD', 'a.txt');
    expect(r.binary).toBe(false);
    if (!r.binary) {
      expect(r.content).toBe('a\nb\nc\n');
      expect(r.truncated).toBe(false);
      expect(r.size).toBe(6);
    }
  });

  it('flags a NUL-containing blob as binary', async () => {
    const root = mkRepo();
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42]));
    g(root, 'add', 'bin.dat');
    g(root, 'commit', '-m', 'bin');
    const r = await git.showFile(root, 'HEAD', 'bin.dat');
    expect(r.binary).toBe(true);
    if (r.binary) expect(r.isImage).toBe(false);
  });

  it('flags an image extension as binary even when text-ish', async () => {
    const root = mkRepo();
    writeFileSync(join(root, 'pic.png'), 'not really binary but .png\n');
    g(root, 'add', 'pic.png');
    g(root, 'commit', '-m', 'png');
    const r = await git.showFile(root, 'HEAD', 'pic.png');
    expect(r.binary).toBe(true);
    if (r.binary) {
      expect(r.isImage).toBe(true);
      expect(r.ext).toBe('.png');
    }
  });

  it('truncates a file over the ~512KB byte cap', async () => {
    const root = mkRepo();
    const big = 'x'.repeat(512 * 1024 + 100) + '\n'; // > FILE_BYTE_CAP, no NUL
    writeFileSync(join(root, 'big.txt'), big);
    g(root, 'add', 'big.txt');
    g(root, 'commit', '-m', 'big');
    const r = await git.showFile(root, 'HEAD', 'big.txt');
    expect(r.binary).toBe(false);
    if (!r.binary) {
      expect(r.truncated).toBe(true);
      expect(r.content.length).toBeLessThanOrEqual(512 * 1024);
      expect(r.size).toBeGreaterThan(512 * 1024); // reports the true size
    }
  });

  it('salvages a missing path at a ref into an error result without throwing', async () => {
    const root = mkRepo();
    const r = await git.showFile(root, 'HEAD', 'does-not-exist.txt');
    expect(r.binary).toBe(false);
    if (!r.binary) {
      expect(typeof r.error).toBe('string');
      expect(r.error!.length).toBeGreaterThan(0);
    }
  });
});

describe('read helpers — statusPorcelain', () => {
  it('reports modified, untracked, and renamed entries with the right codes', async () => {
    const root = mkRepo();
    // modify tracked
    writeFileSync(join(root, 'a.txt'), 'a\nb\nc\nMOD\n');
    // untracked
    writeFileSync(join(root, 'new.txt'), 'new\n');
    // a tracked file to rename
    writeFileSync(join(root, 'old.txt'), 'rename me\n');
    g(root, 'add', 'old.txt');
    g(root, 'commit', '-m', 'add old');
    g(root, 'mv', 'old.txt', 'renamed.txt');

    const { entries, error } = await git.statusPorcelain(root);
    expect(error).toBeUndefined();
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath['a.txt'].code).toContain('M');
    expect(byPath['new.txt'].code).toBe('??');
    expect(byPath['renamed.txt']).toBeTruthy();
    expect(byPath['renamed.txt'].origPath).toBe('old.txt'); // rename carries orig path
  });

  it('returns an empty list on a clean tree', async () => {
    const root = mkRepo();
    const { entries, error } = await git.statusPorcelain(root);
    expect(error).toBeUndefined();
    expect(entries).toEqual([]);
  });

  it('salvages a non-repo root into an error result without throwing', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'fleet-git-notrepo-'));
    tmpDirs.push(notRepo);
    const r = await git.statusPorcelain(notRepo); // git exits 128 → salvage branch
    expect(r.entries).toEqual([]);
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

describe('read helpers — changedDiff', () => {
  it('returns a unified diff for a modified file', async () => {
    const root = mkRepo();
    writeFileSync(join(root, 'a.txt'), 'a\nB-CHANGED\nc\n');
    const r = await git.changedDiff(root, 'a.txt');
    expect(r.binary).toBe(false);
    expect(r.diff).toMatch(/^---/m);
    expect(r.diff).toMatch(/\+B-CHANGED/);
    expect(r.error).toBeUndefined();
  });

  it('short-circuits to binary:true for a binary file change', async () => {
    const root = mkRepo();
    writeFileSync(join(root, 'b.bin'), Buffer.from([0x00, 0x01]));
    g(root, 'add', 'b.bin');
    g(root, 'commit', '-m', 'add bin');
    writeFileSync(join(root, 'b.bin'), Buffer.from([0x00, 0x02, 0x03]));
    const r = await git.changedDiff(root, 'b.bin');
    expect(r.binary).toBe(true);
    expect(r.diff).toBe('');
  });

  it('truncates an oversized diff with a marker', async () => {
    const root = mkRepo();
    // 700 lines (> DIFF_LINE_CAP of 600) added.
    const big = Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n') + '\n';
    writeFileSync(join(root, 'a.txt'), big);
    const r = await git.changedDiff(root, 'a.txt');
    expect(r.truncated).toBe(true);
    expect(r.diff).toMatch(/\[diff truncated\]/);
  });

  it('salvages a non-repo root into an error result without throwing', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'fleet-git-notrepo-'));
    tmpDirs.push(notRepo);
    const r = await git.changedDiff(notRepo, 'x.txt'); // git fails → salvage branch
    expect(r.diff).toBe('');
    expect(r.binary).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

describe('read helpers — gitLog', () => {
  it('returns structured commit entries newest-first with parsed fields', async () => {
    const root = mkRepo();
    writeFileSync(join(root, 'a.txt'), 'a\nb\nc\nsecond\n');
    g(root, 'commit', '-am', 'second commit');

    const { entries, error } = await git.gitLog(root, { max: 10 });
    expect(error).toBeUndefined();
    expect(entries.length).toBe(2);
    expect(entries[0].subject).toBe('second commit');
    expect(entries[1].subject).toBe('init');
    expect(entries[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(entries[0].author).toBe(BASE_AUTHOR.name);
    expect(entries[0].time).toBeGreaterThan(0);
    expect(entries[0].isMerge).toBe(false);
  });

  it('flags merge commits with isMerge=true', async () => {
    const root = mkRepo();
    const wt = addWorktree(root, 'wt-log', 'task-log');
    writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    g(wt, 'add', 'feature.txt');
    g(wt, 'commit', '-m', 'feature');
    const res = await git.mergeBranch(root, 'task-log');
    expect(res.ok).toBe(true);

    const { entries } = await git.gitLog(root, { max: 10 });
    expect(entries[0].isMerge).toBe(true); // the merge commit
  });

  it('salvages a bad branch ref into an error result without throwing', async () => {
    const root = mkRepo();
    const r = await git.gitLog(root, { branch: 'no-such-branch' });
    expect(r.entries).toEqual([]);
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

describe('read helpers — gitShow', () => {
  it('returns the patch text for a valid commit hash', async () => {
    const root = mkRepo();
    const sha = head(root);
    const r = await git.gitShow(root, sha);
    expect(r.error).toBeUndefined();
    expect(r.text).toMatch(/init/); // subject
    expect(r.text).toMatch(/\+a/); // patch body for a.txt
  });

  it('rejects a non-hex/short hash without invoking git', async () => {
    const root = mkRepo();
    const r = await git.gitShow(root, 'not-a-hash; rm -rf /');
    expect(r.error).toBe('invalid commit hash');
    expect(r.text).toBe('');
  });

  it('salvages a well-formed-but-nonexistent hash into an error result without throwing', async () => {
    const root = mkRepo();
    const r = await git.gitShow(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
    expect(r.text).toBe('');
  });
});

// ── gitExec wrapper salvage (never throws) ────────────────────────────────────
describe('gitExec — never throws, salvages exit code', () => {
  it('returns ok:false with a nonzero code for a failing command instead of throwing', async () => {
    const root = mkRepo();
    const r = await git.gitExec(root, ['rev-parse', 'definitely-not-a-ref']);
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe(0);
    expect(typeof r.stderr).toBe('string');
  });

  it('returns ok:true with stdout for a succeeding command', async () => {
    const root = mkRepo();
    const r = await git.gitExec(root, ['rev-parse', 'HEAD']);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(head(root));
  });
});
