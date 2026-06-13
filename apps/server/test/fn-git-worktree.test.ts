/**
 * Real test for git.ts createWorktree + cleanupWorktree — builds an ACTUAL repo and
 * adds/removes a real linked worktree under .claude/worktrees (no mocks). Verifies the
 * reuse path (idempotent re-create) and that teardown removes the worktree + branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-wt-'));

let git: typeof import('../src/git.js');
let root: string;
const dirs: string[] = [];
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

beforeAll(async () => {
  git = await import('../src/git.js');
  root = mkdtempSync(join(tmpdir(), 'fleet-wt-root-'));
  dirs.push(root);
  sh(root, 'init', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@fleet.local');
  sh(root, 'config', 'user.name', 'Fleet Test');
  writeFileSync(join(root, 'f.txt'), 'x\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-m', 'init');
});
afterAll(() => {
  for (const d of [...dirs, process.env.FLEET_DATA_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('createWorktree / cleanupWorktree', () => {
  const name = 'task-abc';
  const branch = 'fleet/task-abc';

  it('creates a real linked worktree on a new branch', async () => {
    const r = await git.createWorktree(root, name, branch);
    expect(r.ok).toBe(true);
    expect(r.dir).toBe(join(root, '.claude', 'worktrees', name));
    expect(existsSync(r.dir)).toBe(true);
    expect(sh(root, 'worktree', 'list', '--porcelain')).toContain(r.dir);
    expect(sh(root, 'branch', '--list', branch)).toContain(branch);
  });

  it('reuses the existing worktree on a second create (idempotent)', async () => {
    const r = await git.createWorktree(root, name, branch);
    expect(r.ok).toBe(true);
    expect(r.dir).toBe(join(root, '.claude', 'worktrees', name));
  });

  it('tears the worktree + branch down, and is idempotent', async () => {
    await git.cleanupWorktree(root, name, branch);
    expect(existsSync(join(root, '.claude', 'worktrees', name))).toBe(false);
    expect(sh(root, 'worktree', 'list', '--porcelain')).not.toContain(join(root, '.claude', 'worktrees', name));
    expect(sh(root, 'branch', '--list', branch)).toBe('');
    // second teardown with nothing left is a harmless no-op
    await expect(git.cleanupWorktree(root, name, branch)).resolves.toBeUndefined();
  });
});
