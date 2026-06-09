import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js, which reads
// FLEET_DATA_DIR at module-load) is imported. The static imports above are env-agnostic;
// every src module is pulled in lazily inside beforeAll.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-proj-'));

let app: any;
let PORT: number;

// Track every temp dir we create so afterAll can clean them all up.
const tmpDirs: string[] = [];

/** Create a temp git work tree initialized on the given branch (no commits needed:
 *  both code paths under test — `rev-parse --is-inside-work-tree` and
 *  `symbolic-ref --short HEAD` — work on an empty repo, and skipping commits avoids
 *  the user.name/user.email/commit.gpgsign failure surface entirely). */
function makeGitRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', branch], { cwd: dir });
  return dir;
}

/** A plain (non-git) temp directory under os.tmpdir() — tmpdir is not nested in a repo. */
function makeNonGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plain-'));
  tmpDirs.push(dir);
  return dir;
}

const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// W0: create-project validation — git repo (200) vs non-absolute / non-git /
// traversing paths (400). Exercises the POST route's isGitWorkTree + isAbsolute gate.
// ────────────────────────────────────────────────────────────────────────────
describe('W0 create — rootDir validation (git + absolute)', () => {
  it('creates a project on a real git repo (200)', async () => {
    const dir = makeGitRepo('main');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'good', rootDir: dir },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('good');
    expect(body.rootDir).toBe(dir);
  });

  it('rejects a non-absolute (relative) rootDir with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'rel', rootDir: 'some/relative/path' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an absolute path to a non-git directory with 400', async () => {
    const dir = makeNonGitDir(); // absolute, exists, but not a git work tree
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'plain', rootDir: dir },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an ABSOLUTE traversing rootDir that resolves to a non-git dir with 400', async () => {
    // projects.ts has no dedicated traversal guard; an absolute path *passes* the
    // path.isAbsolute() gate, so traversal segments are normalized and the result must
    // then survive the isGitWorkTree() check. Here the absolute path contains '..' and
    // resolves back into a known non-git directory → rejected by the git-repo gate (not
    // the isAbsolute branch the relative test above exercises). This is the discriminating
    // absolute→non-repo path.
    const dir = makeNonGitDir();
    const traversed = join(dir, 'sub', '..'); // absolute, contains '..', resolves to `dir`
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'trav', rootDir: traversed },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty / missing name with 400 even on a valid repo', async () => {
    const dir = makeGitRepo('main');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: '   ', rootDir: dir },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W0: detectDefaultBranch returns the repo's ACTUAL branch (NOT hardcoded 'main').
// CRITICAL: omit defaultBranch from the payload, otherwise detection never runs.
// ────────────────────────────────────────────────────────────────────────────
describe('W0 detectDefaultBranch — repo actual branch, not hardcoded main', () => {
  it("detects 'master' on a master repo (the load-bearing anti-hardcode case)", async () => {
    const dir = makeGitRepo('master');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'master-repo', rootDir: dir }, // NO defaultBranch → detection runs
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultBranch).toBe('master');
  });

  it("detects 'main' on a main repo", async () => {
    const dir = makeGitRepo('main');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'main-repo', rootDir: dir }, // NO defaultBranch → detection runs
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultBranch).toBe('main');
  });

  it('honours an explicit defaultBranch over detection when provided', async () => {
    const dir = makeGitRepo('master');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'explicit-branch', rootDir: dir, defaultBranch: 'develop' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultBranch).toBe('develop');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W0: field round-trip through SQLite. POST returns the in-memory object, so we
// re-GET to genuinely exercise projectToRow → SQLite columns → rowToProject.
// ────────────────────────────────────────────────────────────────────────────
describe('W0 round-trip — autoMerge/budgetCeiling/wipLimit/validationCommand through SQLite', () => {
  it('round-trips all policy fields (number budget) via GET after POST', async () => {
    const dir = makeGitRepo('main');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: {
        name: 'rt-number',
        rootDir: dir,
        autoMerge: true,
        budgetCeilingUsd: 12.5,
        wipLimit: 7,
        defaultValidationCommand: 'pnpm test',
      },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const got = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H() });
    expect(got.statusCode).toBe(200);
    const p = got.json();
    expect(p.autoMerge).toBe(true); // INTEGER 1 → boolean true (default is false)
    expect(p.budgetCeilingUsd).toBe(12.5); // REAL round-trip
    expect(p.wipLimit).toBe(7); // non-default int
    expect(p.defaultValidationCommand).toBe('pnpm test');
    expect(p.paused).toBe(false); // not provided → default false
  });

  it('round-trips a null budgetCeilingUsd (the `?? null` column mapping)', async () => {
    const dir = makeGitRepo('main');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'rt-null', rootDir: dir, budgetCeilingUsd: null },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const got = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H() });
    const p = got.json();
    expect(p.budgetCeilingUsd).toBeNull();
  });

  it('applies omitted-field defaults (autoMerge false, wipLimit 3, validationCommand null)', async () => {
    const dir = makeGitRepo('main');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'rt-defaults', rootDir: dir },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const got = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H() });
    const p = got.json();
    expect(p.autoMerge).toBe(false);
    expect(p.wipLimit).toBe(3);
    expect(p.budgetCeilingUsd).toBeNull();
    expect(p.defaultValidationCommand).toBeNull();
    expect(p.paused).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W0: update policy is executor-only. name and rootDir are IMMUTABLE — a PUT
// supplying them must NOT change them, yet must still apply the policy fields.
// ────────────────────────────────────────────────────────────────────────────
describe('W0 update — executor-policy only; name & rootDir immutable', () => {
  it('ignores name/rootDir in a PUT but still applies policy fields, and persists', async () => {
    const dir = makeGitRepo('main');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'original', rootDir: dir, autoMerge: false },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    // Attempt to mutate name + rootDir AND flip a real policy field in one request.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      headers: H(),
      payload: { name: 'hacked', rootDir: '/evil', autoMerge: true, wipLimit: 9, paused: true },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json();
    // Immutable fields untouched...
    expect(updated.name).toBe('original');
    expect(updated.rootDir).toBe(dir);
    // ...but the policy fields DID change (proves the route processed the body).
    expect(updated.autoMerge).toBe(true);
    expect(updated.wipLimit).toBe(9);
    expect(updated.paused).toBe(true);

    // Confirm the immutability + policy change actually persisted to SQLite.
    const got = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H() });
    const p = got.json();
    expect(p.name).toBe('original');
    expect(p.rootDir).toBe(dir);
    expect(p.autoMerge).toBe(true);
    expect(p.wipLimit).toBe(9);
    expect(p.paused).toBe(true);
  });

  it('returns 404 when updating a non-existent project', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/does-not-exist',
      headers: H(),
      payload: { autoMerge: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W0: config validation — wipLimit positive int, budgetCeiling non-negative-or-null.
// Validators are enforced on BOTH the create and update routes.
// ────────────────────────────────────────────────────────────────────────────
describe('W0 config validation — wipLimit positive int, budgetCeiling non-neg-or-null', () => {
  it('rejects invalid wipLimit on CREATE (0, -1, 1.5, "3") with 400', async () => {
    const dir = makeGitRepo('main');
    for (const wipLimit of [0, -1, 1.5, '3' as any]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: H(),
        payload: { name: 'bad-wip', rootDir: dir, wipLimit },
      });
      expect(res.statusCode, `wipLimit=${JSON.stringify(wipLimit)}`).toBe(400);
    }
  });

  it('rejects invalid budgetCeilingUsd on CREATE (-1, non-numeric string) with 400', async () => {
    // NB: NaN cannot be tested over the wire — JSON.stringify(NaN) === "null", which is a
    // VALID budget. The route correctly rejects a genuine NaN (Number.isFinite guard), but
    // it can never arrive as NaN. So we use a negative number and a non-numeric type instead.
    const dir = makeGitRepo('main');
    for (const budgetCeilingUsd of [-1, '5' as any]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: H(),
        payload: { name: 'bad-budget', rootDir: dir, budgetCeilingUsd },
      });
      expect(res.statusCode, `budgetCeilingUsd=${JSON.stringify(budgetCeilingUsd)}`).toBe(400);
    }
  });

  it('accepts budgetCeilingUsd = 0 and = null on CREATE (0 is non-negative, null allowed)', async () => {
    for (const budgetCeilingUsd of [0, null]) {
      const dir = makeGitRepo('main');
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: H(),
        payload: { name: 'ok-budget', rootDir: dir, budgetCeilingUsd },
      });
      expect(res.statusCode, `budgetCeilingUsd=${budgetCeilingUsd}`).toBe(200);
      expect(res.json().budgetCeilingUsd).toBe(budgetCeilingUsd);
    }
  });

  it('enforces the same validators on UPDATE (bad wipLimit / budget → 400, valid → 200)', async () => {
    const dir = makeGitRepo('main');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: H(),
      payload: { name: 'upd-validate', rootDir: dir },
    });
    const id = created.json().id;

    const badWip = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      headers: H(),
      payload: { wipLimit: 0 },
    });
    expect(badWip.statusCode).toBe(400);

    const badBudget = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      headers: H(),
      payload: { budgetCeilingUsd: -5 },
    });
    expect(badBudget.statusCode).toBe(400);

    const okUpdate = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      headers: H(),
      payload: { wipLimit: 2, budgetCeilingUsd: 0 },
    });
    expect(okUpdate.statusCode).toBe(200);
    expect(okUpdate.json().wipLimit).toBe(2);
    expect(okUpdate.json().budgetCeilingUsd).toBe(0);
  });
});
