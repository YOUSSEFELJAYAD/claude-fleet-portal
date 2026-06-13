/**
 * Behavioral coverage for src/release.ts focused on the previously-uncovered logic:
 *   - getStatus repo:null branch (no GitHub slug resolvable) — lines 165-175
 *   - currentSha / originRemote real git reads — lines 64-79
 *   - GET /api/release/list route (slug + no-slug)        — lines 264-269
 *   - POST /api/release/update / selfUpdate guard + step flow — lines 195-257, 271-274
 *
 * To make the git-dependent code deterministic we point REPO_ROOT at a throw-away git
 * repo we build in a tmpdir (config.REPO_ROOT honours FLEET_REPO_ROOT). That gives full
 * control over the `origin` remote, working-tree cleanliness, current branch / detached
 * HEAD, and package.json version — all of which selfUpdate()/getStatus() shell out for.
 *
 * FLEET_REPO_ROOT + FLEET_DATA_DIR MUST be set before importing any src module (they are
 * read at config.js import time).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── isolated REPO_ROOT (a real git repo) + DB dir, established before any import ──
const WORK = mkdtempSync(join(tmpdir(), 'fleet-cov-release-'));
const REPO = join(WORK, 'repo');
const BARE = join(WORK, 'origin.git');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
}

// Build a self-contained repo with its own local bare `origin` so `git fetch` succeeds
// offline but the remote URL is NOT a github.com URL (→ parseRepoSlug null) unless we set
// the FLEET_GITHUB_REPO override.
execFileSync('git', ['init', '-q', '-b', 'main', REPO], { stdio: 'pipe' });
git(REPO, 'config', 'user.email', 'cov@test.local');
git(REPO, 'config', 'user.name', 'cov');
git(REPO, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'fleet-cov-fixture', version: '0.0.1' }) + '\n');
writeFileSync(join(REPO, 'README.md'), 'fixture\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-q', '-m', 'initial');
const FIRST_SHA = git(REPO, 'rev-parse', 'HEAD');
execFileSync('git', ['init', '-q', '--bare', BARE], { stdio: 'pipe' });
git(REPO, 'remote', 'add', 'origin', BARE);
git(REPO, 'push', '-q', 'origin', 'main');

process.env.FLEET_REPO_ROOT = REPO;
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-cov-release-data-'));
delete process.env.FLEET_GITHUB_REPO;

let app: any;
let PORT: number;
let release: typeof import('../src/release.js');
const H = () => ({ host: `127.0.0.1:${PORT}` });

function fakeFetch(payload: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** Restore the repo to a clean `main` checkout (origin removed/divergence wiped) between tests. */
function resetRepoToCleanMain() {
  // ensure origin exists (the "no origin" test removes it; its finally restores it, but be defensive)
  try {
    git(REPO, 'remote', 'get-url', 'origin');
  } catch {
    git(REPO, 'remote', 'add', 'origin', BARE);
  }
  try {
    git(REPO, 'checkout', '-q', '-f', 'main');
  } catch {
    git(REPO, 'switch', '-q', '-C', 'main');
  }
  // wipe any local-only divergence so every test starts from the canonical first commit.
  git(REPO, 'fetch', '-q', 'origin');
  git(REPO, 'reset', '-q', '--hard', FIRST_SHA);
  git(REPO, 'clean', '-q', '-fd');
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  expect(cfg.REPO_ROOT).toBe(REPO); // sanity: our override took effect
  release = await import('../src/release.js');
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(WORK, { recursive: true, force: true });
});

afterEach(() => {
  release.__setFetcherForTests(null);
  delete process.env.FLEET_GITHUB_REPO;
  resetRepoToCleanMain();
});

// ── parseRepoSlug edge branches (line 37 null arm) ───────────────────────────────
describe('parseRepoSlug — non-GitHub / malformed remotes return null', () => {
  it('returns null for non-github hosts and bare paths, slug for github forms', () => {
    expect(release.parseRepoSlug('https://gitlab.com/a/b.git')).toBeNull();
    expect(release.parseRepoSlug('file:///srv/git/a/b.git')).toBeNull();
    expect(release.parseRepoSlug('')).toBeNull();
    expect(release.parseRepoSlug('git@github.com:owner/name.git')).toBe('owner/name');
  });
});

// ── compareVersions non-numeric arm (line 48 localeCompare) ──────────────────────
describe('compareVersions — non-numeric component falls back to string order', () => {
  it('uses localeCompare when a version segment is not a number', () => {
    // 'beta' is not a number → NaN → string comparison of the whole inputs
    expect(release.compareVersions('1.beta.0', '1.alpha.0')).toBeGreaterThan(0);
    expect(release.compareVersions('1.alpha.0', '1.beta.0')).toBeLessThan(0);
    // equal-string non-numeric inputs → localeCompare 0
    expect(release.compareVersions('1.x', '1.x')).toBe(0);
  });
});

// ── getStatus: repo:null branch + canSelfUpdate reflects hasOrigin (165-175) ─────
describe('GET /api/release/status — no resolvable GitHub slug', () => {
  it('with a non-github origin and no override → repo null but canSelfUpdate true (origin exists)', async () => {
    // origin URL is the local bare repo → parseRepoSlug(null); FLEET_GITHUB_REPO unset.
    const res = await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.repo).toBeNull(); // the 165-175 branch
    expect(s.latest).toBeNull();
    expect(s.updateAvailable).toBe(false);
    expect(s.canSelfUpdate).toBe(true); // hasOrigin true → self-update offered even without a slug
    expect(s.checkedAt).toBeNull();
    expect(s.error).toBeNull();
    // currentVersion came from OUR fixture package.json (currentVersion() success path)
    expect(s.currentVersion).toBe('0.0.1');
    // currentSha() success path: a real short sha from our repo
    expect(s.currentSha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('force=1 is honoured via the query param (req.query.force === "1")', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    let calls = 0;
    release.__setFetcherForTests(async () => {
      calls++;
      return new Response(JSON.stringify([{ tag_name: 'v0.0.1', prerelease: false, html_url: 'x' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(calls).toBe(2); // force bypasses the cache each time
  });
});

// ── GET /api/release/list (264-269) ──────────────────────────────────────────────
describe('GET /api/release/list', () => {
  it('no resolvable slug → { repo:null, releases:[] }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/release/list', headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repo: null, releases: [] });
  });

  it('with a slug → returns mapped releases (tag/name/body/url) and caches them', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    release.__setFetcherForTests(
      fakeFetch([
        {
          tag_name: 'v2.0.0',
          name: 'Two',
          body: 'notes',
          html_url: 'https://github.com/acme/portal/releases/v2.0.0',
          published_at: '2026-01-01T00:00:00Z',
          prerelease: false,
        },
        { tag_name: '', html_url: 'x' }, // filtered out (no tag)
      ]),
    );
    const res = await app.inject({ method: 'GET', url: '/api/release/list', headers: H() });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.repo).toBe('acme/portal');
    expect(b.releases).toHaveLength(1);
    expect(b.releases[0]).toMatchObject({ tag: 'v2.0.0', name: 'Two', body: 'notes' });
    expect(b.error).toBeNull();
  });

  it('a GitHub error surfaces on list as { error } without throwing', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    release.__setFetcherForTests(async () => {
      throw new Error('boom-list');
    });
    const res = await app.inject({ method: 'GET', url: '/api/release/list', headers: H() });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.repo).toBe('acme/portal');
    expect(b.error).toContain('boom-list');
    expect(b.releases).toEqual([]);
  });
});

// ── POST /api/release/update → selfUpdate() guard rails + step flow (195-257) ─────
describe('POST /api/release/update — guard rails', () => {
  it('dirty working tree → 409 with the uncommitted-changes note (no steps run)', async () => {
    writeFileSync(join(REPO, 'dirty.txt'), 'uncommitted\n'); // makes `git status --porcelain` non-empty
    const res = await app.inject({ method: 'POST', url: '/api/release/update', headers: H() });
    expect(res.statusCode).toBe(409);
    const b = res.json();
    expect(b.ok).toBe(false);
    expect(b.note).toMatch(/uncommitted changes/i);
    expect(b.note).toContain('dirty.txt');
    expect(b.steps).toEqual([]);
  });

  it('detached HEAD on a clean tree → 409 detached-HEAD note', async () => {
    const sha = git(REPO, 'rev-parse', 'HEAD');
    git(REPO, 'checkout', '-q', sha); // detach
    const res = await app.inject({ method: 'POST', url: '/api/release/update', headers: H() });
    expect(res.statusCode).toBe(409);
    const b = res.json();
    expect(b.ok).toBe(false);
    expect(b.note).toMatch(/detached HEAD/i);
    expect(b.steps).toEqual([]);
  });

  it('no origin remote → 400 with the configure-origin note', async () => {
    git(REPO, 'remote', 'remove', 'origin');
    try {
      const res = await app.inject({ method: 'POST', url: '/api/release/update', headers: H() });
      expect(res.statusCode).toBe(400);
      const b = res.json();
      expect(b.ok).toBe(false);
      expect(b.note).toMatch(/origin/);
      expect(b.steps).toEqual([]);
    } finally {
      git(REPO, 'remote', 'add', 'origin', BARE); // restore for afterEach reset + other tests
    }
  });
});

describe('POST /api/release/update — step execution (runStep success + failure)', () => {
  it('clean tree on a branch: fetch SUCCEEDS, then a non-fast-forward pull FAILS → 500, chain stops', async () => {
    // Create local divergence: a local-only commit, while origin/main advances to a different commit,
    // so `git pull --ff-only origin main` cannot fast-forward and runStep returns false.
    // 1) advance origin/main from a SECOND clone so the histories diverge.
    const other = join(WORK, 'other');
    rmSync(other, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', '-b', 'main', BARE, other], { stdio: 'pipe' });
    git(other, 'config', 'user.email', 'o@test.local');
    git(other, 'config', 'user.name', 'o');
    git(other, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(other, 'remote-change.txt'), 'from-origin\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'origin advances');
    git(other, 'push', '-q', 'origin', 'main');

    // 2) make a DIFFERENT local commit on our REPO's main → diverged, non-ff.
    writeFileSync(join(REPO, 'local-change.txt'), 'local\n');
    git(REPO, 'add', '-A');
    git(REPO, 'commit', '-q', '-m', 'local diverges');

    const res = await app.inject({ method: 'POST', url: '/api/release/update', headers: H() });
    expect(res.statusCode).toBe(500);
    const b = res.json();
    expect(b.ok).toBe(false);
    // fetch ran and succeeded (runStep ok:true), pull ran and failed (runStep ok:false), pnpm never ran.
    const fetchStep = b.steps.find((s: any) => s.step.includes('fetch'));
    const pullStep = b.steps.find((s: any) => s.step.includes('pull'));
    expect(fetchStep).toBeTruthy();
    expect(fetchStep.ok).toBe(true); // success arm of runStep (198-199)
    expect(pullStep).toBeTruthy();
    expect(pullStep.ok).toBe(false); // failure arm of runStep (200-205)
    expect(b.steps.some((s: any) => s.step.includes('pnpm'))).toBe(false); // && short-circuit
    expect(b.note).toMatch(/stopped at the first failing step/i);
  });
});
