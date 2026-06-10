/**
 * Release page + GitHub-based update check (DC.md §15).
 *
 * The portal compares its LOCAL version (repo-root package.json) against the newest release
 * of its GitHub repo and exposes:
 *   GET  /api/release/status  — current version/sha, repo slug, latest release, updateAvailable
 *   GET  /api/release/list    — recent releases (the /releases changelog page)
 *   POST /api/release/update  — self-update: clean-tree check → fetch → pull --ff-only → pnpm install
 *
 * The repo slug resolves from FLEET_GITHUB_REPO (override) or the `origin` remote. Without
 * either, the endpoints degrade gracefully (repo:null, no error spam) — the page explains how
 * to enable checks. GitHub responses are cached (TTL below); a background timer refreshes the
 * cache so the sidebar badge works without anyone visiting the page. Never throws to callers.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ReleaseInfo, ReleaseStatus, SelfUpdateResult, SelfUpdateStep } from '@fleet/shared';
import { REPO_ROOT } from './config.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 10 * 60_000;
const BACKGROUND_CHECK_MS = 6 * 60 * 60_000;
const GH_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

// ── pure helpers (exported for tests) ───────────────────────────────────────────

/** `owner/repo` from a GitHub remote URL (https/ssh/git, with or without .git); null otherwise. */
export function parseRepoSlug(remoteUrl: string): string | null {
  const m = remoteUrl
    .trim()
    .match(/^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Loose semver compare ('v' prefix tolerated): negative a<b, 0 equal, positive a>b. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.trim().replace(/^v/i, '').split('-')[0].split('.').map((p) => Number(p));
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b); // non-numeric → string order
    if (x !== y) return x - y;
  }
  return 0;
}

// ── local state ─────────────────────────────────────────────────────────────────

function currentVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function currentSha(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function originRemote(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], { timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function resolveRepoSlug(): Promise<{ slug: string | null; hasOrigin: boolean }> {
  const remote = await originRemote();
  const override = process.env.FLEET_GITHUB_REPO?.trim();
  if (override) return { slug: override, hasOrigin: !!remote };
  return { slug: remote ? parseRepoSlug(remote) : null, hasOrigin: !!remote };
}

// ── GitHub fetch (injectable for tests) ─────────────────────────────────────────

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
export function __setFetcherForTests(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init));
  cache = null;
}

// PRIVATE repos are invisible to unauthenticated API calls (404), so auth resolves from
// GITHUB_TOKEN, falling back to the gh CLI's stored token — the portal already relies on
// an authenticated `gh` for PR mode, so this is the same trust surface. Cached briefly
// (account switches via `gh auth switch` should take effect without a server restart).
let ghTokenCache: { token: string | null; at: number } | null = null;
async function resolveGhToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (ghTokenCache && Date.now() - ghTokenCache.at < CACHE_TTL_MS) return ghTokenCache.token;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10000 });
    ghTokenCache = { token: stdout.trim() || null, at: Date.now() };
  } catch {
    ghTokenCache = { token: null, at: Date.now() };
  }
  return ghTokenCache.token;
}

async function ghHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'claude-fleet-portal',
  };
  const token = await resolveGhToken();
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function toReleaseInfo(r: any): ReleaseInfo {
  return {
    tag: String(r?.tag_name ?? ''),
    name: String(r?.name ?? r?.tag_name ?? ''),
    body: String(r?.body ?? ''),
    url: String(r?.html_url ?? ''),
    publishedAt: r?.published_at ?? null,
    prerelease: !!r?.prerelease,
  };
}

async function fetchReleases(slug: string): Promise<ReleaseInfo[]> {
  const res = await fetcher(`https://api.github.com/repos/${slug}/releases?per_page=20`, {
    headers: await ghHeaders(),
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  if (res.status === 404) return []; // repo exists but has no releases (or repo not found) → empty, not an error
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body.map(toReleaseInfo).filter((r) => r.tag) : [];
}

// ── cached status ───────────────────────────────────────────────────────────────

let cache: { releases: ReleaseInfo[]; checkedAt: number; error: string | null; slug: string } | null = null;

async function checkNow(slug: string): Promise<void> {
  try {
    const releases = await fetchReleases(slug);
    cache = { releases, checkedAt: Date.now(), error: null, slug };
  } catch (e: any) {
    // keep last-known releases (if any) so a flaky network doesn't blank the page
    cache = { releases: cache?.slug === slug ? cache.releases : [], checkedAt: Date.now(), error: e?.message ?? String(e), slug };
  }
}

async function getStatus(force: boolean): Promise<ReleaseStatus> {
  const version = currentVersion();
  const [sha, { slug, hasOrigin }] = await Promise.all([currentSha(), resolveRepoSlug()]);
  if (!slug) {
    return {
      currentVersion: version,
      currentSha: sha,
      repo: null,
      latest: null,
      updateAvailable: false,
      canSelfUpdate: hasOrigin,
      checkedAt: null,
      error: null,
    };
  }
  if (force || !cache || cache.slug !== slug || Date.now() - cache.checkedAt > CACHE_TTL_MS) {
    await checkNow(slug);
  }
  const stable = cache!.releases.filter((r) => !r.prerelease);
  const latest = stable[0] ?? cache!.releases[0] ?? null;
  return {
    currentVersion: version,
    currentSha: sha,
    repo: slug,
    latest,
    updateAvailable: !!latest && compareVersions(latest.tag, version) > 0,
    canSelfUpdate: hasOrigin,
    checkedAt: cache!.checkedAt,
    error: cache!.error,
  };
}

// ── self-update ─────────────────────────────────────────────────────────────────

async function runStep(steps: SelfUpdateStep[], step: string, cmd: string, args: string[], timeout: number): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: REPO_ROOT, timeout, maxBuffer: 8 * 1024 * 1024 });
    steps.push({ step, ok: true, output: (stdout + (stderr ? `\n${stderr}` : '')).trim().slice(-4000) });
    return true;
  } catch (e: any) {
    const out = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join('\n').trim().slice(-4000);
    steps.push({ step, ok: false, output: out || 'failed' });
    return false;
  }
}

async function selfUpdate(): Promise<{ code: number; result: SelfUpdateResult }> {
  const steps: SelfUpdateStep[] = [];
  const remote = await originRemote();
  if (!remote) {
    return {
      code: 400,
      result: { ok: false, steps, note: 'No git `origin` remote configured — push this repo to GitHub first, then update from here.' },
    };
  }
  // never pull over local work — the user decides what to do with a dirty tree
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { timeout: 15000 });
    if (stdout.trim()) {
      return {
        code: 409,
        result: {
          ok: false,
          steps,
          note: `Working tree has uncommitted changes — commit or stash before updating:\n${stdout.trim().slice(0, 1500)}`,
        },
      };
    }
  } catch (e: any) {
    return { code: 500, result: { ok: false, steps, note: `could not inspect working tree: ${e?.message ?? e}` } };
  }

  let branch = 'main';
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'symbolic-ref', '--short', 'HEAD'], { timeout: 10000 });
    branch = stdout.trim() || 'main';
  } catch {
    return { code: 409, result: { ok: false, steps, note: 'detached HEAD — check out a branch before updating' } };
  }

  const ok =
    (await runStep(steps, 'git fetch origin --tags', 'git', ['-C', REPO_ROOT, 'fetch', 'origin', '--tags'], 60_000)) &&
    (await runStep(steps, `git pull --ff-only origin ${branch}`, 'git', ['-C', REPO_ROOT, 'pull', '--ff-only', 'origin', branch], 60_000)) &&
    (await runStep(steps, 'pnpm install', 'pnpm', ['install'], INSTALL_TIMEOUT_MS));

  cache = null; // version may have changed — recompute on next status read
  return {
    code: ok ? 200 : 500,
    result: {
      ok,
      steps,
      note: ok
        ? 'Updated. Dev watchers (tsx/next) reload automatically; a production deployment needs `pnpm build` and a server restart.'
        : 'Update stopped at the first failing step — nothing after it was run.',
    },
  };
}

// ── routes ──────────────────────────────────────────────────────────────────────

export function registerReleaseRoutes(app: FastifyInstance) {
  app.get('/api/release/status', async (req) => getStatus((req.query as any)?.force === '1'));

  app.get('/api/release/list', async () => {
    const { slug } = await resolveRepoSlug();
    if (!slug) return { repo: null, releases: [] };
    if (!cache || cache.slug !== slug || Date.now() - cache.checkedAt > CACHE_TTL_MS) await checkNow(slug);
    return { repo: slug, releases: cache!.releases, error: cache!.error };
  });

  app.post('/api/release/update', async (_req, reply) => {
    const { code, result } = await selfUpdate();
    reply.code(code);
    return result;
  });

  // background refresh so the sidebar badge is meaningful without visiting /releases.
  // best-effort: a failed check lands in cache.error, never crashes the server.
  const kick = () => {
    void resolveRepoSlug().then(({ slug }) => (slug ? checkNow(slug) : undefined)).catch(() => {});
  };
  const first = setTimeout(kick, 10_000);
  first.unref();
  const interval = setInterval(kick, BACKGROUND_CHECK_MS);
  interval.unref();
}
