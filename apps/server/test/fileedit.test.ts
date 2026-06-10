import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js, which reads FLEET_DATA_DIR at
// module-load) is imported. Static imports above are env-agnostic; src is pulled in lazily in beforeAll.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-fileedit-'));

const enc = encodeURIComponent;

/** Run git in a repo dir, throwing on failure. gpgsign disabled so a signing global can't break commits. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Build a fresh fixture git repo on disk with an ambient identity + one committed file, and an active
 * task worktree under .claude/worktrees/ to exercise the 409 reject. Returns the repo dir.
 */
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-fixture-${label}-`));
  git(['init', '-b', 'main'], dir);
  // The AMBIENT identity (what an un-overridden commit should attribute to).
  git(['config', 'user.email', 'ambient@example.com'], dir);
  git(['config', 'user.name', 'Ambient Human'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  // Gitignore the worktrees dir, exactly as the production attach path (git.ts ensureWorktreeIgnored /
  // initRepo) does — so an active task worktree under .claude/worktrees/ never shows as untracked and
  // the "working tree is clean after a pathspec-scoped commit" assertions are meaningful.
  writeFileSync(join(dir, '.gitignore'), '.claude/worktrees/\n');
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'existing.txt'), 'original content\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);

  // An active task worktree under .claude/worktrees/ (the edit-surface hole the route must close).
  git(['worktree', 'add', '-b', 'wt-branch', join(dir, '.claude', 'worktrees', 'task-1')], dir);
  return dir;
}

/** The current blob oid of a working-tree file (what GET /files/edit returns as the baseline). */
function oidOf(dir: string, rel: string): string {
  return git(['hash-object', '--', rel], dir).trim();
}

let app: any; // Fastify instance registering ONLY registerFileeditRoutes (no buildServer)
let editPid: string; // project with editing ON
let noEditPid: string; // project with editing OFF
let authorPid: string; // project with a configured commit author override
let editRepo: string;
let noEditRepo: string;
let authorRepo: string;
let projectsRepo: any;

beforeAll(async () => {
  editRepo = makeRepo('edit');
  noEditRepo = makeRepo('noedit');
  authorRepo = makeRepo('author');

  // Pull src lazily AFTER FLEET_DATA_DIR is set.
  const { default: Fastify } = await import('fastify');
  const { registerFileeditRoutes } = await import('../src/fileedit.js');
  ({ projectsRepo } = await import('../src/projects.js'));

  // A LOCAL Fastify app registering ONLY our routes (no buildServer, no host-allowlist hook).
  app = Fastify();
  registerFileeditRoutes(app);
  await app.ready();

  // Create projects directly via the repo (deterministic; no route dependency on projects.ts).
  editPid = projectsRepo.createProject({ name: 'edit', rootDir: editRepo, editingEnabled: true }).id;
  noEditPid = projectsRepo.createProject({ name: 'noedit', rootDir: noEditRepo, editingEnabled: false }).id;
  authorPid = projectsRepo.createProject({
    name: 'author',
    rootDir: authorRepo,
    editingEnabled: true,
    commitAuthorName: 'Configured Bot',
    commitAuthorEmail: 'bot@configured.example',
  }).id;
});

afterAll(async () => {
  await app?.close();
  for (const d of [editRepo, noEditRepo, authorRepo]) if (d) rmSync(d, { recursive: true, force: true });
  if (process.env.FLEET_DATA_DIR) rmSync(process.env.FLEET_DATA_DIR, { recursive: true, force: true });
});

// ── GET /files/edit — working-tree bytes + oid + editable ────────────────────────
describe('GET /files/edit reads working-tree bytes with oid + editable flag', () => {
  it('returns content, the working-tree oid, and editable:true for a text file when editing is ON', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${editPid}/files/edit?path=${enc('hello.txt')}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('hello world\n');
    expect(body.oid).toBe(oidOf(editRepo, 'hello.txt'));
    expect(body.editable).toBe(true);
    expect(body.binary).toBe(false);
    expect(body.tooLarge).toBe(false);
  });

  it('returns editable:false when editing is OFF for the project', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${noEditPid}/files/edit?path=${enc('hello.txt')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().editable).toBe(false);
  });

  it('returns oid:null + content:"" + exists:false for a not-yet-created path', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${editPid}/files/edit?path=${enc('brand/new.txt')}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.oid).toBeNull();
    expect(body.content).toBe('');
    expect(body.exists).toBe(false);
  });

  it('rejects a traversal path with 400', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${editPid}/files/edit?path=${enc('../../etc/passwd')}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });

  it('rejects a path under .claude/worktrees with 409', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${editPid}/files/edit?path=${enc('.claude/worktrees/task-1/hello.txt')}`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('404s for an unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/nope/files/edit?path=${enc('hello.txt')}` });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /files/commit — gating, guards ──────────────────────────────────────────
describe('POST /files/commit gating + path guards', () => {
  it('403 when editing is disabled for the project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${noEditPid}/files/commit`,
      payload: { path: 'hello.txt', content: 'x', message: 'edit' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 on a traversal path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: '../../escape.txt', content: 'x', message: 'edit' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid path');
  });

  it('409 on a path under .claude/worktrees', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: '.claude/worktrees/task-1/x.txt', content: 'x', message: 'edit' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 when message is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'hello.txt', content: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when content is missing for a write (non-delete)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'hello.txt', message: 'edit' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── CRUD: create / update / delete commits ───────────────────────────────────────
describe('POST /files/commit performs atomic CRUD commits (ambient author)', () => {
  it('CREATE: a brand-new file (no baseOid) commits + ADDs the file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'docs/new-file.md', content: '# New\n', message: 'add new file' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sha).toBe('string');
    expect(body.sha.length).toBe(40);
    // The file is on disk + tracked, and the commit subject + ambient author are recorded.
    expect(existsSync(join(editRepo, 'docs', 'new-file.md'))).toBe(true);
    expect(git(['log', '-1', '--format=%s'], editRepo).trim()).toBe('add new file');
    expect(git(['log', '-1', '--format=%an <%ae>'], editRepo).trim()).toBe('Ambient Human <ambient@example.com>');
    // Pathspec-scoped commit ⇒ the working tree is clean (no stray dirty state).
    expect(git(['status', '--porcelain'], editRepo).trim()).toBe('');
  });

  it('UPDATE: an existing file with the correct baseOid commits the new content', async () => {
    const baseOid = oidOf(editRepo, 'src/existing.txt');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'src/existing.txt', content: 'updated content\n', message: 'update existing', baseOid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(git(['show', 'HEAD:src/existing.txt'], editRepo)).toBe('updated content\n');
    expect(git(['log', '-1', '--format=%s'], editRepo).trim()).toBe('update existing');
    expect(git(['status', '--porcelain'], editRepo).trim()).toBe('');
  });

  it('DELETE: an existing file is git-rm-ed and committed', async () => {
    // hello.txt exists from the initial commit; delete requires no content.
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'hello.txt', delete: true, message: 'remove hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(existsSync(join(editRepo, 'hello.txt'))).toBe(false);
    // No longer tracked at HEAD.
    let tracked = true;
    try {
      git(['cat-file', '-e', 'HEAD:hello.txt'], editRepo);
    } catch {
      tracked = false;
    }
    expect(tracked).toBe(false);
    expect(git(['status', '--porcelain'], editRepo).trim()).toBe('');
  });

  it('DELETE: a tracked file WITH uncommitted modifications still deletes (git rm -f)', async () => {
    // Seed a tracked file, then dirty it on disk — plain `git rm` refuses this state.
    await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'mod-then-delete.txt', content: 'v1\n', message: 'seed' },
    });
    writeFileSync(join(editRepo, 'mod-then-delete.txt'), 'v2 uncommitted\n');
    const baseOid = oidOf(editRepo, 'mod-then-delete.txt');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'mod-then-delete.txt', delete: true, message: 'rm modified', baseOid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(existsSync(join(editRepo, 'mod-then-delete.txt'))).toBe(false);
    expect(git(['status', '--porcelain'], editRepo).trim()).toBe('');
  });

  it('DELETE: an UNTRACKED file is unlinked and reports ok (no phantom commit)', async () => {
    writeFileSync(join(editRepo, 'never-tracked.txt'), 'scratch\n');
    const headBefore = git(['rev-parse', 'HEAD'], editRepo).trim();
    const baseOid = oidOf(editRepo, 'never-tracked.txt');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'never-tracked.txt', delete: true, message: 'rm untracked', baseOid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(existsSync(join(editRepo, 'never-tracked.txt'))).toBe(false);
    // Nothing was tracked → no commit happened; HEAD is unchanged and the tree stays clean.
    expect(git(['rev-parse', 'HEAD'], editRepo).trim()).toBe(headBefore);
    expect(git(['status', '--porcelain'], editRepo).trim()).toBe('');
  });
});

// ── stale-oid + delete-of-missing → 409 ──────────────────────────────────────────
describe('POST /files/commit optimistic-concurrency + existence guards', () => {
  it('409 on a stale baseOid (file changed since read)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'src/existing.txt', content: 'racing change\n', message: 'stale', baseOid: 'f'.repeat(40) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/stale/i);
  });

  it('409 on a write over an existing file with NO baseOid (unguarded overwrite)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'src/existing.txt', content: 'no base oid\n', message: 'no base' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('409 on delete of a non-existent path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${editPid}/files/commit`,
      payload: { path: 'does/not/exist.txt', delete: true, message: 'rm missing' },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ── configured author override ───────────────────────────────────────────────────
describe('POST /files/commit honors a configured commit-author override', () => {
  it('commits as the project commitAuthorName/Email when both are set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${authorPid}/files/commit`,
      payload: { path: 'configured.txt', content: 'made by the bot\n', message: 'configured author commit' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(git(['log', '-1', '--format=%an <%ae>'], authorRepo).trim()).toBe('Configured Bot <bot@configured.example>');
  });
});

// ── commit-failure rollback: the main tree must stay CLEAN ────────────────────────
// A failed commit must never leave the main worktree dirty (a dirty tree makes the PM merge refuse —
// git.ts mergeBranch's clean-check). A brand-new path is the tricky case: reset+checkout can't delete
// a file with no HEAD version, so the rollback must unlink the leftover.
describe('POST /files/commit rolls back cleanly when the commit itself fails', () => {
  it('CREATE whose commit fails leaves NO untracked leftover (clean tree)', async () => {
    const repo = makeRepo('hookfail');
    // A pre-commit hook that always fails → `git commit` returns non-zero deterministically.
    const hookDir = join(repo, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const pid = projectsRepo.createProject({ name: 'hookfail', rootDir: repo, editingEnabled: true }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/files/commit`,
      payload: { path: 'brand-new.txt', content: 'should be rolled back\n', message: 'will fail the hook' },
    });
    // The commit failed → error surfaced (ok:false in body), and NOTHING was committed…
    expect(res.json().ok).toBe(false);
    // …and CRITICALLY the working tree is clean — no `?? brand-new.txt` leftover that would wedge merges.
    expect(git(['status', '--porcelain'], repo).trim()).toBe('');
    expect(existsSync(join(repo, 'brand-new.txt'))).toBe(false);
  });
});
