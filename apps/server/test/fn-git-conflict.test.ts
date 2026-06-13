/**
 * Real tests for git.ts conflict helpers. These build an ACTUAL git repo with an
 * ACTUAL merge conflict (no mocks) and assert the probes report it, then that
 * mergeAbort cleans it up. scrubCredentials is a pure string redactor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-gitconflict-'));

let git: typeof import('../src/git.js');
const dirs: string[] = [];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Create a repo whose `feature` branch conflicts with `main` on file.txt. */
function makeConflictedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-gitconflict-repo-'));
  dirs.push(dir);
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@fleet.local');
  sh(dir, 'config', 'user.name', 'Fleet Test');
  writeFileSync(join(dir, 'file.txt'), 'base\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'base');
  sh(dir, 'checkout', '-b', 'feature');
  writeFileSync(join(dir, 'file.txt'), 'feature-change\n');
  sh(dir, 'commit', '-am', 'feature');
  sh(dir, 'checkout', 'main');
  writeFileSync(join(dir, 'file.txt'), 'main-change\n');
  sh(dir, 'commit', '-am', 'main');
  // Start a merge that WILL conflict; tolerate the non-zero exit.
  try { sh(dir, 'merge', 'feature'); } catch { /* expected conflict */ }
  return dir;
}

beforeAll(async () => { git = await import('../src/git.js'); });
afterAll(() => {
  for (const d of [...dirs, process.env.FLEET_DATA_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('scrubCredentials — redact userinfo in URLs', () => {
  it('redacts user:pass and bare-token userinfo', () => {
    expect(git.scrubCredentials('https://user:pass@github.com/o/r.git')).toBe('https://***@github.com/o/r.git');
    expect(git.scrubCredentials('https://ghp_TOKEN@github.com/o/r')).toBe('https://***@github.com/o/r');
  });
  it('preserves host + path and leaves credential-free strings untouched', () => {
    expect(git.scrubCredentials('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(git.scrubCredentials('fatal: could not read from origin')).toBe('fatal: could not read from origin');
  });
  it('is a no-op on empty input and on scp-style ssh remotes (no scheme)', () => {
    expect(git.scrubCredentials('')).toBe('');
    expect(git.scrubCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});

describe('conflict probes on a clean repo', () => {
  let clean: string;
  beforeAll(() => {
    clean = mkdtempSync(join(tmpdir(), 'fleet-gitclean-'));
    dirs.push(clean);
    sh(clean, 'init', '-b', 'main');
    sh(clean, 'config', 'user.email', 'test@fleet.local');
    sh(clean, 'config', 'user.name', 'Fleet Test');
    writeFileSync(join(clean, 'a.txt'), 'hi\n');
    sh(clean, 'add', '.');
    sh(clean, 'commit', '-m', 'init');
  });
  it('reports no merge, no conflicts, no markers', async () => {
    expect(await git.isMergeInProgress(clean)).toBe(false);
    expect(await git.conflictedFiles(clean)).toEqual([]);
    expect(await git.hasConflictMarkers(clean)).toBe(false);
  });
});

describe('conflict probes on a genuinely conflicted repo', () => {
  let repo: string;
  beforeAll(() => { repo = makeConflictedRepo(); });

  it('isMergeInProgress → true (MERGE_HEAD set)', async () => {
    expect(await git.isMergeInProgress(repo)).toBe(true);
  });
  it('conflictedFiles → includes the unmerged path', async () => {
    expect(await git.conflictedFiles(repo)).toContain('file.txt');
  });
  it('hasConflictMarkers → true (leftover <<<<<<< on disk)', async () => {
    expect(await git.hasConflictMarkers(repo)).toBe(true);
  });
  it('mergeAbort → clears the merge and all conflict state (idempotent)', async () => {
    await git.mergeAbort(repo);
    expect(await git.isMergeInProgress(repo)).toBe(false);
    expect(await git.conflictedFiles(repo)).toEqual([]);
    expect(await git.hasConflictMarkers(repo)).toBe(false);
    // second abort with nothing in progress is a harmless no-op
    await expect(git.mergeAbort(repo)).resolves.toBeUndefined();
  });
});
