import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, lsFiles } from '../src/git.js';

let repo: string; let bare: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-git-lsfiles-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'a');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'b.ts'), 'b');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  bare = mkdtempSync(join(tmpdir(), 'fleet-nonrepo-'));
});
afterAll(() => {});

describe('repoRoot', () => {
  it('returns the git toplevel for a path inside a repo', async () => {
    const root = await repoRoot(join(repo, 'src'));
    expect(root).toBeTruthy();
    // realpath-normalize both sides (macOS /tmp → /private/tmp)
    const { realpathSync } = await import('node:fs');
    expect(realpathSync(root!)).toBe(realpathSync(repo));
  });
  it('returns null outside any repo', async () => {
    expect(await repoRoot(bare)).toBeNull();
  });
});

describe('lsFiles', () => {
  it('lists tracked files relative to the repo root', async () => {
    const files = await lsFiles(repo);
    expect(files).toContain('a.txt');
    expect(files).toContain('src/b.ts');
  });
});
