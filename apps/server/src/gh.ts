/**
 * Remote git + GitHub PR layer (SPEC v2 §4 item #2 / §11.2).
 *
 * Two responsibilities, kept OUT of git.ts so the local merge engine stays
 * provider-agnostic:
 *   - REMOTE git over `git` (push / fetch+FF-sync / remote resolution) — reuses
 *     {@link gitExec} from git.ts (which hardcodes the `git` binary).
 *   - GitHub PR over the `gh` CLI (auth status, `pr create`, `pr view`,
 *     `pr merge`) — runs through a local {@link ghExec} that mirrors gitExec's
 *     salvage/never-throw contract for the `gh` binary.
 *
 * EVERY function NEVER throws: like gitExec/ghExec, expected failures (a missing
 * binary, a failed push, no PR for a branch, a diverged base) surface as DATA on
 * the result object, never an unhandled rejection. The caller (pm.ts merge gate,
 * the git-health route, the refresh-pr route) reads the result and decides.
 *
 * CREDENTIAL SCRUBBING (SPEC §3.5 / risk #1): any stderr/stdout that becomes a
 * surfaced `error` string is passed through {@link scrubCredentials} FIRST, so a
 * tokenized remote URL (`https://x-access-token:<TOKEN>@github.com/...`) can never
 * reach `lastError`, the DB, or the SSE broadcast.
 *
 * No DB dependency: `root` (a project's validated git working dir), `remote`,
 * `branch`, and `base` are threaded in by the caller, never read from a table here
 * — exactly mirroring git.ts.
 *
 * FF-ONLY INVARIANT (SPEC §4 #2 keystone (d) / risk #3): {@link fetchAndSyncDefault}
 * NEVER force-updates. On a diverged local base it returns `diverged:true` and
 * makes NO modification — the caller parks the card for a human, never resets.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gitExec, scrubCredentials, type GitExecResult } from './git.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 60_000; // network ops (fetch/push/gh) get a longer leash than local git
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024; // 16MB, matching gitExec

// ── gh exec wrapper (mirrors gitExec — never throws, salvages exit code) ───────

export interface GhExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Normalized exit code: real exit code on a clean run / nonzero exit; 127 for ENOENT
   * (gh missing); 124 for timeout / maxBuffer kill; -1 for any other spawn error. */
  code: number;
}

/**
 * Run the `gh` CLI with an argument ARRAY (never a shell string — no interpolation/injection) in
 * `cwd` and return a salvaged result. Mirrors {@link gitExec}: on a nonzero exit / timeout / missing
 * binary the underlying promise rejects, and we recover whatever stdout/stderr gh emitted (gh prints
 * useful diagnostics on a nonzero exit). NEVER throws.
 *
 * `gh` is resolved off the inherited `process.env.PATH` (we deliberately do NOT pass a custom env —
 * Node's executable lookup against a per-call `options.env.PATH` is platform-flaky; tests prepend a
 * fake-gh dir to `process.env.PATH` instead).
 */
export async function ghExec(cwd: string, args: string[]): Promise<GhExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      timeout: DEFAULT_TIMEOUT,
      maxBuffer: DEFAULT_MAX_BUFFER,
      encoding: 'utf8',
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (e: any) {
    const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
    let code: number;
    if (typeof e?.code === 'number') {
      code = e.code; // real nonzero gh exit code
    } else if (e?.code === 'ENOENT') {
      code = 127; // gh binary not found
    } else if (e?.killed || e?.code === 'ETIMEDOUT' || e?.signal) {
      code = 124; // timeout / maxBuffer overflow kill
    } else {
      code = -1; // any other spawn failure
    }
    return { ok: false, stdout, stderr: stderr || (e?.message ?? ''), code };
  }
}

// ── gh availability + auth ─────────────────────────────────────────────────────

/**
 * Is the `gh` CLI installed / on PATH? `gh --version` exits 0 when present; a missing binary yields
 * code 127 from {@link ghExec}. Used by the git-health route to tell the UI whether PR mode is
 * available at all. Never throws.
 */
export async function ghInstalled(): Promise<boolean> {
  const r = await ghExec(process.cwd(), ['--version']);
  return r.ok && r.code === 0;
}

export interface GhAuthStatus {
  /** gh is on PATH AND `gh auth status` exited 0 (a usable authenticated context). */
  authenticated: boolean;
  /** gh is on PATH at all (false → `gh` missing; distinguishes "not installed" from "not logged in"). */
  installed: boolean;
  /** Scrubbed human-readable detail from gh (its status banner or the failure reason); never raw token text. */
  detail: string;
}

/**
 * Authentication status via `gh auth status`. Exit 0 == authenticated (the robust contract: gh has
 * historically printed the banner to stdout in 2.x and stderr in older versions, so we key off the
 * EXIT CODE, not the stream, and merge both streams for the scrubbed detail). A missing binary
 * (code 127) reports `{ installed:false }`. Never throws.
 */
export async function ghAuthStatus(): Promise<GhAuthStatus> {
  const r = await ghExec(process.cwd(), ['auth', 'status']);
  if (r.code === 127) {
    return { authenticated: false, installed: false, detail: 'gh CLI not installed' };
  }
  const detail = scrubCredentials([r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join('\n').trim());
  return {
    authenticated: r.ok && r.code === 0,
    installed: true,
    detail: detail || (r.ok ? 'authenticated' : 'not authenticated'),
  };
}

// ── remote resolution ──────────────────────────────────────────────────────────

export interface ResolveRemoteResult {
  /** The configured fetch URL for `remote`, or null when the remote is not configured. SCRUBBED. */
  url: string | null;
  /** Whether `remote` is configured in `root` (i.e. `git remote get-url` succeeded). */
  resolves: boolean;
}

/**
 * Resolve a remote's URL via `git remote get-url <remote>` (does NOT hit the network — local config
 * only; this is the "remote resolves" half of the git-health check). Returns `{ url:null,
 * resolves:false }` when the remote is unconfigured. The URL is scrubbed in case it embeds a token
 * (`https://x-access-token:TOKEN@…`). Never throws.
 */
export async function resolveRemote(root: string, remote: string): Promise<ResolveRemoteResult> {
  const r = await gitExec(root, ['-C', root, 'remote', 'get-url', remote]);
  if (!r.ok) return { url: null, resolves: false };
  const url = scrubCredentials(r.stdout.trim());
  return { url: url || null, resolves: !!url };
}

// ── push ────────────────────────────────────────────────────────────────────────

export interface PushResult {
  ok: boolean;
  /** Scrubbed error string on failure; absent on success. */
  error?: string;
}

/**
 * Push `branch` to `remote` (`git push <remote> <branch>`), setting the upstream so a later
 * `gh pr create --head <branch>` resolves the head ref. NETWORK op (longer timeout via ghExec's
 * sibling DEFAULT_TIMEOUT applies only to gh; git push uses gitExec's own default — see note). Any
 * surfaced stderr is scrubbed (§3.5: a push failure often echoes the tokenized remote URL).
 *
 * Returns `{ ok:false, error }` on any push failure (rejected non-FF, auth error, missing remote) —
 * the caller (pm.ts PR-mode gate) parks the card; we never force-push.
 */
export async function pushBranch(root: string, remote: string, branch: string): Promise<PushResult> {
  // Longer network timeout: pass through gitExec's opts (it accepts {timeout}).
  const r = await gitExec(root, ['-C', root, 'push', '--set-upstream', remote, branch], {
    timeout: DEFAULT_TIMEOUT,
  });
  if (!r.ok) return { ok: false, error: ghErr(r) };
  return { ok: true };
}

// ── fetch + FF-only sync of the default branch ──────────────────────────────────

export interface FetchSyncResult {
  ok: boolean;
  /** Local `base` now contains (or equals) the remote tip (equal / behind→FF'd / ahead). */
  synced: boolean;
  /** Local `base` and `<remote>/<base>` diverged — NO modification was made (FF-only, never force). */
  diverged: boolean;
  /** Scrubbed error string when the fetch/FF failed for a reason OTHER than divergence. */
  error?: string;
}

/**
 * Fetch `remote` then fast-forward the LOCAL `base` to the remote tip — FF-ONLY (SPEC §4 #2 keystone
 * (d) / risk #3). The portal always has `base` checked out in `root` (the merge engine merges task
 * branches INTO root's current branch), so the FF is `git merge --ff-only <remote>/<base>` rather
 * than `git fetch <remote> base:base` (which git refuses when `base` is the checked-out branch).
 *
 * Four relations between local `base` and `<remote>/<base>`, decided by two `merge-base --is-ancestor`
 * probes:
 *   - EQUAL    → nothing to do; `synced:true`.
 *   - BEHIND   (local is ancestor of remote) → `merge --ff-only`; `synced:true`.
 *   - AHEAD    (remote is ancestor of local) → already contains the remote tip; `synced:true`, no-op.
 *   - DIVERGED (neither is ancestor of the other) → `diverged:true`, NO modification, `synced:false`.
 *     The caller parks the card for a human; we NEVER force-update a diverged base.
 *
 * `synced` therefore means "local base now contains the remote tip" (true unless diverged). All
 * stderr is scrubbed. Never throws.
 */
export async function fetchAndSyncDefault(root: string, remote: string, base: string): Promise<FetchSyncResult> {
  const fetch = await gitExec(root, ['-C', root, 'fetch', remote, base], { timeout: DEFAULT_TIMEOUT });
  if (!fetch.ok) return { ok: false, synced: false, diverged: false, error: ghErr(fetch) };

  const remoteRef = `${remote}/${base}`;

  // Resolve both tips. If the remote-tracking ref is absent (fresh clone / never fetched this base),
  // there is nothing to sync against — treat as a clean no-op rather than an error.
  const localTip = await gitExec(root, ['-C', root, 'rev-parse', '--verify', base]);
  if (!localTip.ok) return { ok: false, synced: false, diverged: false, error: ghErr(localTip) };
  const remoteTip = await gitExec(root, ['-C', root, 'rev-parse', '--verify', remoteRef]);
  if (!remoteTip.ok) {
    // No remote-tracking branch to compare against → nothing fetched to integrate.
    return { ok: true, synced: false, diverged: false };
  }

  const local = localTip.stdout.trim();
  const remoteSha = remoteTip.stdout.trim();
  if (local === remoteSha) return { ok: true, synced: true, diverged: false }; // EQUAL

  // local is ancestor of remote? (exit 0 = yes → we are BEHIND and can FF)
  const localIsAncestor = await gitExec(root, ['-C', root, 'merge-base', '--is-ancestor', base, remoteRef]);
  // remote is ancestor of local? (exit 0 = yes → we are AHEAD)
  const remoteIsAncestor = await gitExec(root, ['-C', root, 'merge-base', '--is-ancestor', remoteRef, base]);

  if (localIsAncestor.code === 0) {
    // BEHIND → fast-forward the checked-out base to the remote tip.
    const ff = await gitExec(root, ['-C', root, 'merge', '--ff-only', remoteRef]);
    if (!ff.ok) return { ok: false, synced: false, diverged: false, error: ghErr(ff) };
    return { ok: true, synced: true, diverged: false };
  }
  if (remoteIsAncestor.code === 0) {
    // AHEAD → local already contains the remote tip; nothing to do.
    return { ok: true, synced: true, diverged: false };
  }
  // Neither is an ancestor of the other → DIVERGED. FF-only: do NOT modify, park for a human.
  return { ok: true, synced: false, diverged: true };
}

// ── GitHub PR: create / view / merge ─────────────────────────────────────────────

export interface PrCreateResult {
  ok: boolean;
  /** The created PR's URL (gh prints it to stdout). Absent on failure. */
  url?: string;
  /** Scrubbed error string on failure. */
  error?: string;
}

/**
 * Open a GitHub PR via `gh pr create --base <base> --head <head> --title <title> --body <body>`.
 * gh prints the new PR's URL to stdout on success. PR base = `project.defaultBranch` and head =
 * the deterministic `worktree-task-<id>` branch (the caller supplies both; SPEC §4 #2 decisions).
 *
 * The portal opens the PR and STOPS — a human merges it on GitHub (locked decision §10.1: no
 * `gh pr merge --auto`). Any stderr is scrubbed. Never throws.
 */
export async function prCreate(
  root: string,
  base: string,
  head: string,
  title: string,
  body: string,
): Promise<PrCreateResult> {
  const r = await ghExec(root, [
    'pr', 'create',
    '--base', base,
    '--head', head,
    '--title', title,
    '--body', body,
  ]);
  if (!r.ok) return { ok: false, error: ghErr(r) };
  // gh prints the PR URL on stdout (last non-empty line is the URL).
  const url = firstUrl(r.stdout);
  return { ok: true, url };
}

export interface PrView {
  /** Normalized lowercase PR state (gh emits UPPERCASE; we map to the shared KanbanTask.prState union). */
  state: 'open' | 'merged' | 'closed';
  /** The PR's URL. */
  url: string;
}

/**
 * View the PR for `branch` via `gh pr view <branch> --json state,url`. Discriminates the
 * GENUINE no-PR case (`{ pr: null }` — gh exits 1 printing "no pull requests found") from real
 * failures (`{ error }` — auth expiry, network, missing gh binary), so a stale badge isn't
 * silently mistaken for "no PR yet".
 *
 * gh's `state` field is UPPERCASE (`OPEN` / `MERGED` / `CLOSED`); we lowercase-map it to the shared
 * `KanbanTask.prState` union (`'open' | 'merged' | 'closed'`). An unrecognized state falls back to
 * `'open'`. Never throws.
 */
export async function prView(root: string, branch: string): Promise<{ pr: PrView | null; error?: string }> {
  const r = await ghExec(root, ['pr', 'view', branch, '--json', 'state,url']);
  if (!r.ok) {
    if (r.code === 1 && /no pull requests found/i.test(r.stderr + r.stdout)) return { pr: null };
    return { pr: null, error: ghErr(r) };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { pr: null, error: 'gh pr view returned unparseable JSON' };
  }
  if (!parsed || typeof parsed !== 'object') return { pr: null, error: 'gh pr view returned an unexpected shape' };
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  const state = normalizePrState(parsed.state);
  return { pr: { state, url } };
}

export interface PrMergeResult {
  ok: boolean;
  /** Scrubbed error string on failure. */
  error?: string;
}

/**
 * Merge a PR via `gh pr merge <branch> --merge` (default merge-commit strategy).
 *
 * DEFINED + EXPORTED for completeness, but the portal does NOT auto-call this (locked decision
 * §10.1: the portal opens the PR and a HUMAN merges it on GitHub). Provided so an operator tool / a
 * future opt-in can reuse the same scrubbed, never-throw wrapper. Any stderr is scrubbed.
 */
export async function prMerge(root: string, branch: string): Promise<PrMergeResult> {
  const r = await ghExec(root, ['pr', 'merge', branch, '--merge']);
  if (!r.ok) return { ok: false, error: ghErr(r) };
  return { ok: true };
}

// ── internal helpers ─────────────────────────────────────────────────────────────

/** Map gh's UPPERCASE PR state to the shared lowercase union; unknown → 'open' (safest default). */
function normalizePrState(raw: unknown): 'open' | 'merged' | 'closed' {
  const s = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

/** First http(s) URL in a blob of gh stdout, or undefined. gh prints the PR URL on its own line. */
function firstUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/\S+/);
  return m ? m[0] : undefined;
}

/**
 * Compose a stable, CREDENTIAL-SCRUBBED error string from a failed git/gh result (stderr-first, like
 * git.ts's internal `gitErr`, but with §3.5 scrubbing applied before the string is ever surfaced).
 * Accepts either a GitExecResult or a GhExecResult (structurally identical).
 */
function ghErr(r: GitExecResult | GhExecResult): string {
  if (r.code === 127) return 'gh/git binary not found';
  if (r.code === 124) return 'command timed out';
  const raw = r.stderr.trim() || r.stdout.trim() || `command failed (exit ${r.code})`;
  return scrubCredentials(raw);
}
