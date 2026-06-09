import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js, which reads
// FLEET_DATA_DIR at module-load) is imported. Static imports above are env-agnostic;
// src is pulled in lazily in beforeAll.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-fileview-'));

// ── git fixture repo (a separate temp dir from FLEET_DATA_DIR) ──────────────────
let repoDir: string;
let app: any;
let PORT: number;
let pid: string; // project id for the fixture repo (created via the POST route)

const H = () => ({ host: `127.0.0.1:${PORT}` });
const enc = encodeURIComponent;

/** Run git in the fixture repo, throwing on failure. gpgsign disabled so a signing
 *  global config can never break commits in CI. */
function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(async () => {
  // 1) Build the fixture git repo on disk.
  repoDir = mkdtempSync(join(tmpdir(), 'fleet-fixture-repo-'));
  git(['init', '-b', 'master']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'commit.gpgsign', 'false']);

  // A small text file.
  writeFileSync(join(repoDir, 'hello.txt'), 'hello world\nsecond line\n');
  // A markdown file (classifier → 'markdown', proves the text path).
  writeFileSync(join(repoDir, 'README.md'), '# Title\n\nbody\n');
  // A filename with spaces.
  writeFileSync(join(repoDir, 'file with spaces.txt'), 'spaced content\n');
  // A binary file: NON-image extension with a NUL byte in the first 8KB so the
  // binary-sniff classifies it 'binary' (image exts take the raw-bytes branch instead).
  writeFileSync(join(repoDir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x10]));
  // A large file: > 512KB FILE_BYTE_CAP, pure ASCII (no NUL) so it's text-but-truncated.
  const big = 'A'.repeat(600 * 1024); // 600KB > 512KB cap
  writeFileSync(join(repoDir, 'big.txt'), big);

  git(['add', '-A']);
  git([
    '-c', 'user.name=Test User',
    '-c', 'user.email=test@example.com',
    'commit', '-m', 'initial commit',
  ]);
  // A second commit on master so the log has > 1 entry.
  writeFileSync(join(repoDir, 'hello.txt'), 'hello world\nsecond line\nthird line\n');
  git(['add', '-A']);
  git([
    '-c', 'user.name=Test User',
    '-c', 'user.email=test@example.com',
    'commit', '-m', 'second commit',
  ]);

  // A feature branch with an extra commit (used for branch-mode diff master...feature).
  git(['checkout', '-b', 'feature']);
  writeFileSync(join(repoDir, 'feature.txt'), 'a brand new feature file\n');
  git(['add', '-A']);
  git([
    '-c', 'user.name=Test User',
    '-c', 'user.email=test@example.com',
    'commit', '-m', 'add feature file',
  ]);
  // Return to master so HEAD log / files reflect the default branch.
  git(['checkout', 'master']);

  // A symlink whose target EXISTS and is OUTSIDE the repo (realpath-escape case). The
  // target must exist or safePath walks up to an existing ancestor inside the repo and
  // wrongly passes containment — so point it at a real outside dir (tmpdir()).
  symlinkSync(tmpdir(), join(repoDir, 'escape'));

  // 2) Bring up the server via inject (never listen / never bind a port).
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();

  // 3) Create the project via the POST route (W4 "via route inject"). This runs
  //    detectDefaultBranch → 'master' (matching git init -b master) and validates the
  //    repo is a git work tree — both required for branch-mode diff base correctness.
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: H(),
    payload: { name: 'fixture', rootDir: repoDir },
  });
  expect(created.statusCode).toBe(200);
  const proj = created.json();
  pid = proj.id;
  expect(proj.defaultBranch).toBe('master'); // base for the proposed-merge diff
});

afterAll(async () => {
  await app?.close();
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  if (process.env.FLEET_DATA_DIR) rmSync(process.env.FLEET_DATA_DIR, { recursive: true, force: true });
});

// ── path-traversal / absolute / symlink-escape guard (realpath-containment) ─────
describe('W4 — path guard on the file param → 400 (realpath-containment)', () => {
  it('rejects an absolute path with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('/etc/passwd')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });

  it('rejects a "../" traversal escape with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('../../etc/passwd')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });

  it('rejects a symlink that escapes the repo root with 400', async () => {
    // `escape` -> tmpdir() (exists, outside the repo): realpath resolves outside root.
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('escape/some-outside-file')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });

  it('rejects a path containing a NUL byte with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('hello.txt\0.png')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });
});

// ── file tree (ls-tree) — incl. a filename with spaces ──────────────────────────
describe('W4 — file tree lists committed files; filename with spaces handled', () => {
  it('lists the root tree of committed files', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/files`, headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('tree');
    expect(body.error).toBeUndefined();
    const names = body.entries.map((e: any) => e.path);
    expect(names).toContain('hello.txt');
    expect(names).toContain('README.md');
    expect(names).toContain('data.bin');
    expect(names).toContain('big.txt');
    // every entry is a blob with the expected shape
    const hello = body.entries.find((e: any) => e.path === 'hello.txt');
    expect(hello.type).toBe('blob');
    expect(typeof hello.oid).toBe('string');
  });

  it('handles a committed filename that contains spaces', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/files`, headers: H() });
    const body = res.json();
    const spaced = body.entries.find((e: any) => e.path === 'file with spaces.txt');
    expect(spaced).toBeDefined();
    expect(spaced.type).toBe('blob');
    expect(spaced.name).toBe('file with spaces.txt');
  });

  it('reads the content of a file whose name contains spaces', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('file with spaces.txt')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('file');
    expect(body.content).toBe('spaced content\n');
  });
});

// ── blob: text content / binary descriptor / large-truncated ────────────────────
describe('W4 — show file: text content, binary descriptor, large truncated', () => {
  it('returns the content of a text file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('hello.txt')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('file');
    expect(body.type).toBe('code');
    expect(body.content).toBe('hello world\nsecond line\nthird line\n');
    expect(body.truncated).toBe(false);
  });

  it('classifies a markdown file as markdown and returns its content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('README.md')}`,
      headers: H(),
    });
    const body = res.json();
    expect(body.type).toBe('markdown');
    expect(body.content).toContain('# Title');
  });

  it('returns a BINARY DESCRIPTOR (not raw bytes) for a non-image binary file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('data.bin')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    // JSON descriptor, not the raw binary stream.
    expect(String(res.headers['content-type'])).toContain('application/json');
    const body = res.json();
    expect(body.kind).toBe('file');
    expect(body.type).toBe('binary');
    expect(body.content).toBeUndefined(); // descriptor only — no raw bytes
    expect(body.isImage).toBe(false);
    expect(typeof body.size).toBe('number');
  });

  it('byte-bounds / truncates a large text file (> 512KB cap)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('big.txt')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('file');
    expect(body.type).toBe('too-large');
    expect(body.truncated).toBe(true);
    expect(body.size).toBeGreaterThan(512 * 1024); // real (uncapped) size reported
    expect(body.content.length).toBeLessThanOrEqual(512 * 1024); // content bounded to the cap
  });
});

// ── changed-files diff against a ref + git log ──────────────────────────────────
describe('W4 — branch diff against a ref returns a unified diff; log returns commits', () => {
  it('returns a unified diff for master...feature (proposed-merge diff)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/diff?branch=feature`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(body.binary).toBe(false);
    expect(body.truncated).toBe(false);
    // The feature branch added feature.txt → the diff is a unified patch introducing it.
    expect(body.diff).toContain('diff --git');
    expect(body.diff).toContain('feature.txt');
    expect(body.diff).toContain('+a brand new feature file');
  });

  it('scopes the branch diff to a single path when path is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/diff?branch=feature&path=${enc('feature.txt')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(body.diff).toContain('feature.txt');
    expect(body.diff).toContain('+a brand new feature file');
  });

  it('returns the commit log for the default branch', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/git/log`, headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.entries)).toBe(true);
    // master has exactly 2 commits; the feature commit is NOT on master.
    expect(body.entries.length).toBe(2);
    const subjects = body.entries.map((e: any) => e.subject);
    expect(subjects).toContain('initial commit');
    expect(subjects).toContain('second commit');
    expect(subjects).not.toContain('add feature file');
    expect(typeof body.entries[0].hash).toBe('string');
    expect(body.entries[0].hash.length).toBe(40);
  });

  it('scopes the log to a branch when branch is supplied (includes the feature commit)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/log?branch=feature`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(body.entries.length).toBe(3);
    expect(body.entries.map((e: any) => e.subject)).toContain('add feature file');
  });
});

// ── working-tree status + working-tree diff (the non-branch diff mode) ───────────
describe('W4 — working-tree status and single-file working-tree diff', () => {
  it('git/status reports the untracked `escape` symlink as ?? (porcelain v2 parse)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/git/status`, headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.entries)).toBe(true);
    // All tracked files are committed; the only working-tree change is the untracked
    // `escape` symlink → exercises the '?' (untracked) branch of the porcelain-v2 parser.
    const escape = body.entries.find((e: any) => e.path === 'escape');
    expect(escape).toBeDefined();
    expect(escape.code).toBe('??');
    expect(escape.origPath).toBeNull();
  });

  it('git/diff in working-tree mode requires a path (400 when absent)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/git/diff`, headers: H() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('path is required for a working-tree diff');
  });
});

// ── commit drill-down (git show by hash) ────────────────────────────────────────
describe('W4 — git show by hash returns the commit patch', () => {
  it('returns the patch + metadata for a real commit hash', async () => {
    const logRes = await app.inject({ method: 'GET', url: `/api/projects/${pid}/git/log`, headers: H() });
    const hash = logRes.json().entries[0].hash;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/show?hash=${hash}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(body.text).toContain('commit ' + hash);
  });

  it('rejects an invalid (non-hex) commit hash with an error-in-body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/show?hash=${enc('not-a-hash')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200); // failure policy: 200 + error in body
    expect(res.json().error).toBe('invalid commit hash');
  });
});

// ── failure policy: git failure → 200 with error-in-body (NOT a 500 crash) ──────
describe('W4 — git failure returns 200 with error in body (no 500 crash)', () => {
  it('a bad rev on /files returns 200 with kind:error', async () => {
    // `nope` passes isSafeRef (no leading '-', no whitespace) so it reaches git and FAILS.
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('hello.txt')}&rev=nope`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('error');
    expect(body.error).toBeTruthy();
  });

  it('a nonexistent path at a valid rev returns 200 with kind:error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('does/not/exist.txt')}&rev=HEAD`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('error');
    expect(body.error).toBeTruthy();
  });

  it('a bad branch diff returns 200 with error in body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/diff?branch=nonexistentbranch`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.diff).toBe('');
    expect(body.error).toBeTruthy();
  });

  it('a bad branch on /git/log returns 200 with error in body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/log?branch=nonexistentbranch`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
    expect(body.error).toBeTruthy();
  });

  it('an UNSAFE rev (leading dash flag-injection) is a 400, not a git failure', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/files?path=${enc('hello.txt')}&rev=${enc('--output=x')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid rev');
  });

  it('an UNSAFE branch (leading dash) on /git/diff is a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${pid}/git/diff?branch=${enc('-n9')}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid branch');
  });
});

// ── project scoping: routes 404 for an unknown project ──────────────────────────
describe('W4 — routes are project-scoped (404 for unknown project)', () => {
  it('returns 404 for /files on an unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/does-not-exist/files`, headers: H() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project not found');
  });
});
