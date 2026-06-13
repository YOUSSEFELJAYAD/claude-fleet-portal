import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-covfileview-'));

let repoDir: string;
let app: any;
let PORT: number;
let pid: string;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const enc = encodeURIComponent;

/** A 1x1 transparent PNG (real, decodable image bytes for the raw-bytes branch). */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(msg: string) {
  git(['add', '-A']);
  git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', msg]);
}

beforeAll(async () => {
  // 1) Build the fixture git repo.
  repoDir = mkdtempSync(join(tmpdir(), 'fleet-covfv-repo-'));
  git(['init', '-b', 'master']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'commit.gpgsign', 'false']);

  // A tracked text file (used for working-tree diff after we modify it post-commit).
  writeFileSync(join(repoDir, 'tracked.txt'), 'line one\nline two\n');

  // A SUBDIRECTORY with a file → objType 'tree' branch on /files (lines 154-156).
  mkdirSync(join(repoDir, 'subdir'));
  writeFileSync(join(repoDir, 'subdir', 'nested.txt'), 'nested content\n');

  // A real PNG image → raw-bytes serving branch (lines 163-170).
  writeFileSync(join(repoDir, 'pixel.png'), PNG_1x1);

  commit('initial commit');

  // 2) Bring up the server via inject.
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();

  // 3) Register the fixture as a project (resolves defaultBranch = master server-side).
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: H(),
    payload: { name: 'covfv', rootDir: repoDir },
  });
  expect(created.statusCode).toBe(200);
  pid = created.json().id;

  // 4) AFTER project registration: modify a tracked file so a working-tree diff exists
  //    (drives changedDiff on /git/diff working-tree mode — line 281). We do NOT commit it.
  writeFileSync(join(repoDir, 'tracked.txt'), 'line one CHANGED\nline two\nline three\n');
});

afterAll(async () => {
  await app?.close();
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  if (process.env.FLEET_DATA_DIR) rmSync(process.env.FLEET_DATA_DIR, { recursive: true, force: true });
});

// ── /files: directory path → kind:'tree' (objType === 'tree') — lines 154-156 ─────
describe('cov — /files on a subdirectory path lists that subtree (objType tree)', () => {
  it('lists the entries inside subdir/ with kind:tree, path scoped to subdir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('subdir')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('tree');
    expect(body.path).toBe('subdir');
    expect(body.error).toBeUndefined();
    const names = body.entries.map((e: any) => e.path);
    // ls-tree of subdir returns the nested file under its full path.
    expect(names.some((n: string) => n.endsWith('nested.txt'))).toBe(true);
  });
});

// ── /files: image blob served as RAW BYTES with Content-Type — lines 163-170 ───────
describe('cov — /files on an image blob streams raw bytes with an image Content-Type', () => {
  it('serves the PNG as image/png raw bytes (NOT a JSON descriptor)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('pixel.png')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    // Raw image stream: image/png content-type + no-store cache header.
    expect(String(res.headers['content-type'])).toBe('image/png');
    expect(String(res.headers['cache-control'])).toBe('no-store');
    // The payload is the literal PNG bytes (starts with the PNG magic number).
    expect(res.rawPayload.length).toBe(PNG_1x1.length);
    expect(res.rawPayload.equals(PNG_1x1)).toBe(true);
    // PNG signature bytes.
    expect(res.rawPayload[0]).toBe(0x89);
    expect(res.rawPayload[1]).toBe(0x50); // 'P'
  });
});

// ── /files: image read FAILURE → JSON error-in-body — lines 171-181 ───────────────
describe('cov — /files image read failure returns a binary error descriptor', () => {
  it('a valid image extension at a bad rev returns kind:error (no 500)', async () => {
    // The image raw-bytes branch is gated by a prior `cat-file -t <rev>:<path>`: for a
    // nonexistent rev cat-file fails and the route returns kind:error BEFORE reaching the
    // image `git show` (the catch at lines 173-181). Reaching that catch needs cat-file to
    // SUCCEED yet the raw `git show` of the SAME object to FAIL — only possible under
    // object-store corruption, not reproducible in a clean harness. We assert the route
    // still degrades to kind:error (no crash) on the bad-rev path.
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('pixel.png')}&rev=nosuchrev`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // cat-file gates first → kind:error (not the image catch), but the route must not 500.
    expect(body.kind).toBe('error');
    expect(body.error).toBeTruthy();
  });
});

// ── /git/status: project not found → 404 — lines 210-212 ──────────────────────────
describe('cov — /git/status 404 for an unknown project', () => {
  it('returns 404 project not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/ghost/git/status`,
      headers: H(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project not found');
  });

  it('returns the changed working-tree entries for a real project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/status`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    // tracked.txt was modified after commit → appears as a working-tree change.
    expect(body.entries.some((e: any) => e.path === 'tracked.txt')).toBe(true);
  });
});

// ── /git/diff: project not found (228-230) + invalid path (241-243) + WT diff (281) ─
describe('cov — /git/diff 404, invalid path 400, and working-tree diff', () => {
  it('returns 404 for an unknown project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/ghost/git/diff?path=${enc('tracked.txt')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project not found');
  });

  it('rejects a traversal path with 400 invalid path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/diff?path=${enc('../../etc/passwd')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });

  it('returns a working-tree unified diff for a modified tracked file (no branch)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/diff?path=${enc('tracked.txt')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(body.binary).toBe(false);
    // The uncommitted edit shows as additions/removals against HEAD.
    expect(body.diff).toContain('diff --git');
    expect(body.diff).toContain('+line one CHANGED');
    expect(body.diff).toContain('+line three');
    expect(typeof body.truncated).toBe('boolean');
  });
});

// ── /git/log: project not found (292-294) + invalid branch (298-300) ──────────────
describe('cov — /git/log 404 for unknown project and 400 for unsafe branch', () => {
  it('returns 404 for an unknown project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/ghost/git/log`,
      headers: H(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project not found');
  });

  it('rejects an unsafe (leading-dash flag-injection) branch with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/log?branch=${enc('--all')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid branch');
  });
});

// ── /git/show: project not found → 404 — lines 313-315 ────────────────────────────
describe('cov — /git/show 404 for unknown project', () => {
  it('returns 404 project not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/ghost/git/show?hash=abc`,
      headers: H(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project not found');
  });
});

// ── capDiffLocal truncation: line-cap (96-98) and byte-cap (100-102) ──────────────
// Driven through the branch-mode diff path. We build a branch with a huge change so the
// resulting `git diff master...branch` exceeds DIFF_LINE_CAP (600 lines) → truncation marker.
describe('cov — capDiffLocal truncates an oversized branch diff (line + byte caps)', () => {
  let bigPid: string;
  let bigRepo: string;

  beforeAll(async () => {
    bigRepo = mkdtempSync(join(tmpdir(), 'fleet-covfv-bigrepo-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: bigRepo, encoding: 'utf8' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'Test User']);
    g(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(bigRepo, 'seed.txt'), 'seed\n');
    g(['add', '-A']);
    g(['-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-m', 'seed']);
    g(['checkout', '-b', 'huge']);
    // 5000 NEW lines, each LONG (~200 chars), so the diff blows past BOTH caps:
    //  - >600 lines (DIFF_LINE_CAP) → line-cap branch fires first (slice to 600 lines).
    //  - the surviving 600 lines * ~200 chars (~120KB) still exceed DIFF_BYTE_CAP (64KB)
    //    → the byte-cap branch ALSO fires. Both 96-98 and 100-102 are exercised.
    const pad = 'x'.repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(`new line number ${i} ${pad}`);
    writeFileSync(join(bigRepo, 'huge.txt'), lines.join('\n') + '\n');
    g(['add', '-A']);
    g(['-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-m', 'huge add']);
    g(['checkout', 'master']);

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'bigfv', rootDir: bigRepo },
    });
    expect(created.statusCode).toBe(200);
    bigPid = created.json().id;
  });

  afterAll(() => {
    if (bigRepo) rmSync(bigRepo, { recursive: true, force: true });
  });

  it('caps the proposed-merge diff and appends the truncation marker', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${bigPid}/git/diff?branch=huge`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(body.binary).toBe(false);
    // Both caps fire: truncated true + the literal truncation marker appended.
    expect(body.truncated).toBe(true);
    expect(body.diff).toContain('... [diff truncated]');
    // Body is bounded: at most ~600 lines + the marker line.
    expect(body.diff.split('\n').length).toBeLessThanOrEqual(602);
    // And the byte length is at or under the byte cap (+ marker).
    expect(Buffer.byteLength(body.diff, 'utf8')).toBeLessThanOrEqual(64 * 1024 + 64);
  });
});
