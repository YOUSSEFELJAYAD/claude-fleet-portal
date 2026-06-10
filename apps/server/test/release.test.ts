import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-rel-'));

let app: any;
let PORT: number;
let release: typeof import('../src/release.js');

const H = () => ({ host: `127.0.0.1:${PORT}` });

/** Does the checkout running these tests have an `origin` remote? (repo-state dependent) */
function hasOrigin(): boolean {
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function fakeFetch(payload: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  release = await import('../src/release.js');
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  release.__setFetcherForTests(null);
  delete process.env.FLEET_GITHUB_REPO;
});

describe('parseRepoSlug — owner/repo from any GitHub remote form', () => {
  it.each([
    ['https://github.com/acme/portal.git', 'acme/portal'],
    ['https://github.com/acme/portal', 'acme/portal'],
    ['https://github.com/acme/portal/', 'acme/portal'],
    ['git@github.com:acme/portal.git', 'acme/portal'],
    ['ssh://git@github.com/acme/portal.git', 'acme/portal'],
    ['git@github.com:acme/my.dotted-repo.git', 'acme/my.dotted-repo'],
  ])('%s → %s', (url, slug) => {
    expect(release.parseRepoSlug(url)).toBe(slug);
  });

  it('non-GitHub remotes → null', () => {
    expect(release.parseRepoSlug('https://gitlab.com/acme/portal.git')).toBeNull();
    expect(release.parseRepoSlug('/local/bare/repo.git')).toBeNull();
  });
});

describe('compareVersions — loose semver', () => {
  it('orders numerically, tolerates v-prefix and prerelease suffixes', () => {
    expect(release.compareVersions('v0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(release.compareVersions('0.1.0', 'v0.2.0')).toBeLessThan(0);
    expect(release.compareVersions('v1.10.0', 'v1.9.9')).toBeGreaterThan(0); // not string order
    expect(release.compareVersions('1.2.0', 'v1.2.0')).toBe(0);
    expect(release.compareVersions('v1.2.0-beta.1', '1.2.0')).toBe(0); // prerelease tail ignored
    expect(release.compareVersions('1.2', '1.2.0')).toBe(0); // short forms pad with zeros
  });
});

describe('GET /api/release/status', () => {
  it('reports updateAvailable when the latest GitHub release is newer than package.json', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    release.__setFetcherForTests(
      fakeFetch([
        { tag_name: 'v9.9.9', name: 'Big one', body: '## new stuff', html_url: 'https://github.com/acme/portal/releases/v9.9.9', published_at: '2026-06-01T00:00:00Z', prerelease: false },
      ]),
    );
    const res = await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.repo).toBe('acme/portal');
    expect(s.latest.tag).toBe('v9.9.9');
    expect(s.updateAvailable).toBe(true);
    expect(typeof s.currentVersion).toBe('string');
    expect(s.error).toBeNull();
  });

  it('prefers the newest STABLE release over a newer prerelease', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    release.__setFetcherForTests(
      fakeFetch([
        { tag_name: 'v9.0.0-rc1', prerelease: true, html_url: 'x' },
        { tag_name: 'v8.0.0', prerelease: false, html_url: 'x' },
      ]),
    );
    const res = await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(res.json().latest.tag).toBe('v8.0.0');
  });

  it('an up-to-date (or older) release → updateAvailable false', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    release.__setFetcherForTests(fakeFetch([{ tag_name: 'v0.0.1', prerelease: false, html_url: 'x' }]));
    const res = await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(res.json().updateAvailable).toBe(false);
  });

  it('a failed GitHub check degrades into status.error — never a 5xx', async () => {
    process.env.FLEET_GITHUB_REPO = 'acme/portal';
    release.__setFetcherForTests(async () => {
      throw new Error('network down');
    });
    const res = await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.error).toContain('network down');
    expect(s.updateAvailable).toBe(false);
  });

  it.skipIf(hasOrigin())('no FLEET_GITHUB_REPO and no origin remote → repo null, quiet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/release/status?force=1', headers: H() });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.repo).toBeNull();
    expect(s.latest).toBeNull();
    expect(s.updateAvailable).toBe(false);
    expect(s.canSelfUpdate).toBe(false);
  });
});

describe('POST /api/release/update', () => {
  it.skipIf(hasOrigin())('without a git origin remote → 400 with a clear note (no git mutation attempted)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/release/update', headers: H() });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.note).toMatch(/origin/);
    expect(body.steps).toEqual([]); // nothing was run
  });
});
