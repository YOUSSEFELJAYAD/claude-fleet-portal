/**
 * cov-adddir-safepath (Fix 07) — @-folder attachment paths must be containment-checked against the
 * session's server-trusted workspace root BEFORE they flow into --add-dir. A crafted /turn body must
 * not be able to grant the agent arbitrary host dirs (`/`, `~/.ssh`, `../escape`, absolute `/etc`).
 *
 * Tests the `containDirs(root, paths)` helper exported from chat.ts directly:
 *   - a path INSIDE the workspace resolves to its absolute path and is KEPT.
 *   - a `..`-escape, an absolute `/etc`, and a symlink that escapes the root are DROPPED.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containDirs } from '../src/chat.js';

let root: string;     // the trusted workspace root (realpath-normalized)
let outside: string;  // a sibling dir OUTSIDE the root

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-contain-root-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-contain-outside-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'a');
  mkdirSync(join(root, 'docs'));
  // an in-repo symlink that points OUT of the root (symlink-escape attempt)
  symlinkSync(outside, join(root, 'escape-link'));
});

describe('containDirs', () => {
  it('keeps a path inside the workspace, resolved to its absolute path', async () => {
    const kept = await containDirs(root, ['src']);
    expect(kept).toEqual([join(root, 'src')]);
  });

  it('keeps multiple in-root paths, each resolved absolute', async () => {
    const kept = await containDirs(root, ['src', 'docs']);
    expect(kept).toEqual([join(root, 'src'), join(root, 'docs')]);
  });

  it('drops a `..` traversal that escapes the root', async () => {
    expect(await containDirs(root, ['../escape'])).toEqual([]);
  });

  it('drops an absolute path outside the root (e.g. /etc)', async () => {
    expect(await containDirs(root, ['/etc'])).toEqual([]);
    expect(await containDirs(root, [outside])).toEqual([]);
  });

  it('drops a symlink that escapes the root (realpath-containment)', async () => {
    expect(await containDirs(root, ['escape-link'])).toEqual([]);
  });

  it('keeps the safe ones and drops the unsafe ones from a mixed list', async () => {
    const kept = await containDirs(root, ['src', '../escape', '/etc', 'docs', 'escape-link']);
    expect(kept).toEqual([join(root, 'src'), join(root, 'docs')]);
  });
});
