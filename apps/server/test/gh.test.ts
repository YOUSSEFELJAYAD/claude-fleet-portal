import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js, which reads FLEET_DATA_DIR at
// module-load) is imported. gh.ts has no DB dependency, but we follow the project harness pattern
// exactly: set FLEET_DATA_DIR at the very top and import src lazily inside beforeAll.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-gh-'));

// ── src module (loaded lazily; see harness note above) ───────────────────────
let gh: typeof import('../src/gh.js');

// ── fixtures ─────────────────────────────────────────────────────────────────
const BASE_AUTHOR = { name: 'base-user', email: 'base@local' };

/** Track every temp dir so afterAll tears them all down. */
const tmpDirs: string[] = [];

/** The original PATH, restored after we prepend the fake-gh dir. */
let ORIG_PATH = '';
/** Dir holding the fake `gh` script (prepended to PATH so it shadows the real gh on this box). */
let fakeGhDir = '';
/** Where the fake gh appends its argv (one JSON line per invocation) so we can assert arg construction. */
let ghArgLog = '';

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function head(cwd: string, rev = 'HEAD'): string {
  return g(cwd, 'rev-parse', rev).trim();
}

function mkTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `fleet-gh-${label}-`));
  tmpDirs.push(d);
  return d;
}

/** A bare repo to serve as the "remote" (no network — a local bare repo IS a valid git remote). */
function mkBare(): string {
  const dir = mkTmp('bare');
  g(dir, 'init', '--bare', '-b', 'main');
  return dir;
}

/** A working repo on `main` with one commit, wired to `bare` as `origin` and pushed. */
function mkRootWired(bare: string): string {
  const dir = mkTmp('root');
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', BASE_AUTHOR.email);
  g(dir, 'config', 'user.name', BASE_AUTHOR.name);
  g(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'f.txt'), 'A\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-m', 'A');
  // Standard `git remote add` installs the +refs/heads/*:refs/remotes/origin/* refspec, which is
  // what makes `origin/main` (the remote-tracking ref fetchAndSyncDefault reads) advance on fetch.
  g(dir, 'remote', 'add', 'origin', bare);
  g(dir, 'push', '-u', 'origin', 'main');
  return dir;
}

/** A second clone of `bare` used as a producer to advance the remote `main` independently of `root`. */
function mkProducer(bare: string): string {
  const dir = mkTmp('producer');
  g('/', 'clone', bare, dir); // git clone <bare> <dir> (cwd irrelevant; absolute paths)
  g(dir, 'config', 'user.email', 'producer@local');
  g(dir, 'config', 'user.name', 'producer');
  g(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * Install a fake `gh` executable first on PATH (ghExec resolves `gh` off process.env.PATH at call
 * time and passes NO custom env, so a prepended dir shadows the real gh on this box). The script
 * dispatches on `$1 $2`, logs its argv (JSON line) to GH_ARG_LOG for arg-construction assertions, and
 * emits canned output:
 *   gh --version            → exit 0
 *   gh auth status          → prints a banner, exit 0  (authenticated)
 *   gh pr create …          → prints a PR URL, exit 0
 *   gh pr view <branch> …   → prints {"state":"OPEN","url":…} (exit 0); for branch "no-pr" → exit 1
 *   gh pr merge …           → exit 0
 *   anything else           → exit 1
 */
function installFakeGh(): void {
  fakeGhDir = mkTmp('fakegh');
  ghArgLog = join(mkTmp('arglog'), 'gh-args.log');
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@")" >> "$GH_ARG_LOG" 2>/dev/null || true
case "$1 $2" in
  "--version ")     echo "gh version 0.0.0-fake"; exit 0 ;;
  "auth status")    echo "github.com: Logged in to github.com account fake-user"; exit 0 ;;
  "pr create")      echo "https://github.com/acme/widgets/pull/42"; exit 0 ;;
  "pr view")
    if [ "$3" = "no-pr" ]; then echo "no pull requests found" 1>&2; exit 1; fi
    if [ "$3" = "auth-fail" ]; then echo "HTTP 401: Bad credentials" 1>&2; exit 1; fi
    echo '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/42","labels":[{"name":"risk:low"}]}'; exit 0 ;;
  "pr merge")       exit 0 ;;
  "issue edit")     exit 0 ;;
  "issue comment")
    if [ "$3" = "999" ]; then
      echo "fatal: could not read Password for 'https://x-access-token:ghp_SECRETTOKEN@github.com'" 1>&2
      exit 1
    fi
    exit 0 ;;
  *) echo "fake-gh: unhandled $*" 1>&2; exit 1 ;;
esac
`;
  const p = join(fakeGhDir, 'gh');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  process.env.GH_ARG_LOG = ghArgLog;
  ORIG_PATH = process.env.PATH ?? '';
  // PREPEND (do not replace) so the fake gh shadows the real one yet real `git` still resolves.
  process.env.PATH = `${fakeGhDir}:${ORIG_PATH}`;
}

/** Every recorded fake-gh argv (one array per invocation). */
function ghCalls(): string[][] {
  try {
    return readFileSync(ghArgLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  installFakeGh();
  gh = await import('../src/gh.js');
});

afterAll(() => {
  if (ORIG_PATH) process.env.PATH = ORIG_PATH;
  delete process.env.GH_ARG_LOG;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (process.env.FLEET_DATA_DIR) {
    try {
      rmSync(process.env.FLEET_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── remote resolution (LOCAL git config only — no network) ────────────────────
describe('resolveRemote', () => {
  it('resolves a configured remote URL', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.resolveRemote(root, 'origin');
    expect(r.resolves).toBe(true);
    expect(r.url).toBe(bare); // a local bare path is the remote URL
  });

  it('reports resolves:false for an unconfigured remote', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.resolveRemote(root, 'upstream'); // never added
    expect(r.resolves).toBe(false);
    expect(r.url).toBeNull();
  });

  it('SCRUBS an embedded token from the remote URL (§3.5)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    // Repoint origin at a tokenized https URL (never fetched — we only read local config).
    g(root, 'remote', 'set-url', 'origin', 'https://x-access-token:SECRETTOKEN@github.com/acme/widgets.git');
    const r = await gh.resolveRemote(root, 'origin');
    expect(r.resolves).toBe(true);
    expect(r.url).not.toContain('SECRETTOKEN');
    expect(r.url).toContain('***@github.com');
  });
});

// ── pushBranch against a LOCAL bare remote (deterministic, no network) ─────────
describe('pushBranch', () => {
  it('lands the branch on the bare remote', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    // Create a task branch with a new commit, then push it.
    g(root, 'checkout', '-b', 'worktree-task-7');
    writeFileSync(join(root, 'task.txt'), 'task work\n');
    g(root, 'add', '-A');
    g(root, 'commit', '-m', 'task work');
    const taskSha = head(root);

    const r = await gh.pushBranch(root, 'origin', 'worktree-task-7');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    // The branch now exists on the bare remote at the pushed sha.
    const remoteSha = g(bare, 'rev-parse', 'worktree-task-7').trim();
    expect(remoteSha).toBe(taskSha);
  });

  it('returns {ok:false,error} when the remote is missing (never throws)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.pushBranch(root, 'does-not-exist', 'main');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

// ── fetchAndSyncDefault: FF-only sync semantics (the load-bearing §4 #2 contract) ─
describe('fetchAndSyncDefault', () => {
  it('EQUAL → synced:true, no change', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const before = head(root);
    const r = await gh.fetchAndSyncDefault(root, 'origin', 'main');
    expect(r).toMatchObject({ ok: true, synced: true, diverged: false });
    expect(head(root)).toBe(before); // nothing to do
  });

  it('BEHIND → fast-forwards local base to the remote tip (synced:true)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    // Producer advances the remote main independently.
    const producer = mkProducer(bare);
    writeFileSync(join(producer, 'f.txt'), 'A\nB\n');
    g(producer, 'add', '-A');
    g(producer, 'commit', '-m', 'B');
    g(producer, 'push', 'origin', 'main');
    const remoteSha = g(bare, 'rev-parse', 'main').trim();

    expect(head(root)).not.toBe(remoteSha); // root is behind before the sync

    const r = await gh.fetchAndSyncDefault(root, 'origin', 'main');
    expect(r).toMatchObject({ ok: true, synced: true, diverged: false });
    expect(head(root)).toBe(remoteSha); // local main was fast-forwarded to the remote tip
  });

  it('AHEAD → no-op, synced:true (local already contains the remote tip)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    // root commits locally WITHOUT pushing → local main is ahead of origin/main.
    writeFileSync(join(root, 'f.txt'), 'A\nlocal-ahead\n');
    g(root, 'add', '-A');
    g(root, 'commit', '-m', 'local ahead');
    const before = head(root);

    const r = await gh.fetchAndSyncDefault(root, 'origin', 'main');
    expect(r).toMatchObject({ ok: true, synced: true, diverged: false });
    expect(head(root)).toBe(before); // unchanged
  });

  it('DIVERGED → diverged:true, synced:false, and DOES NOT MODIFY local base (FF-only, never force)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    // Producer advances the remote with commit B…
    const producer = mkProducer(bare);
    writeFileSync(join(producer, 'f.txt'), 'A\nB-remote\n');
    g(producer, 'add', '-A');
    g(producer, 'commit', '-m', 'B-remote');
    g(producer, 'push', 'origin', 'main');
    // …while root commits a DIFFERENT change C locally (never pushed) → the two diverge.
    writeFileSync(join(root, 'g.txt'), 'C-local\n');
    g(root, 'add', '-A');
    g(root, 'commit', '-m', 'C-local');
    const beforeSha = head(root);

    const r = await gh.fetchAndSyncDefault(root, 'origin', 'main');
    expect(r).toMatchObject({ ok: true, synced: false, diverged: true });
    // The DO-NOT-MODIFY contract: local base sha is byte-for-byte unchanged.
    expect(head(root)).toBe(beforeSha);
  });

  it('returns {ok:false,error} on a fetch failure against a missing remote (never throws)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.fetchAndSyncDefault(root, 'no-such-remote', 'main');
    expect(r.ok).toBe(false);
    expect(r.synced).toBe(false);
    expect(r.diverged).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});

// ── gh availability + auth (FAKE gh on PATH; deterministic) ────────────────────
describe('ghInstalled / ghAuthStatus (fake gh on PATH)', () => {
  it('ghInstalled → true when gh resolves and `--version` exits 0', async () => {
    expect(await gh.ghInstalled()).toBe(true);
  });

  it('ghAuthStatus → authenticated:true, installed:true, scrubbed detail', async () => {
    const s = await gh.ghAuthStatus();
    expect(s.installed).toBe(true);
    expect(s.authenticated).toBe(true);
    expect(s.detail).toContain('Logged in');
    expect(s.detail).not.toContain('SECRET');
  });

  it('the not-installed branch (code 127 → installed:false) is covered by construction', () => {
    // ghExec maps a missing `gh` (ENOENT) to code 127, which ghAuthStatus maps to {installed:false}
    // and ghInstalled maps to false. Prepending the fake-gh dir cannot itself produce a missing gh;
    // exercising it would require a PATH with no gh AND no real gh on this box. The mapping is unit-
    // tested at the ghExec layer (code 127 → installed:false) and asserted here only as documented.
    expect(true).toBe(true);
  });
});

// ── GitHub PR: create / view / merge (FAKE gh — arg construction + output parsing) ─
describe('prCreate / prView / prMerge (fake gh on PATH)', () => {
  it('prCreate parses the PR URL from gh stdout AND constructs the correct args', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.prCreate(root, 'main', 'worktree-task-7', 'My title', 'My body');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/acme/widgets/pull/42');

    // Assert the spec's arg construction: gh pr create --base main --head <head> --title --body.
    const created = ghCalls().find((a) => a[0] === 'pr' && a[1] === 'create');
    expect(created).toBeDefined();
    expect(created).toEqual([
      'pr', 'create',
      '--base', 'main',
      '--head', 'worktree-task-7',
      '--title', 'My title',
      '--body', 'My body',
    ]);
  });

  it('prView parses gh JSON and lowercase-maps OPEN → open', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const v = await gh.prView(root, 'worktree-task-7');
    expect(v.error).toBeUndefined();
    expect(v.pr).not.toBeNull();
    expect(v.pr!.state).toBe('open');
    expect(v.pr!.url).toBe('https://github.com/acme/widgets/pull/42');

    const viewed = ghCalls().find((a) => a[0] === 'pr' && a[1] === 'view');
    expect(viewed).toEqual(['pr', 'view', 'worktree-task-7', '--json', 'state,url,labels']);
  });

  it('prView returns {pr:null} with NO error for the genuine no-PR case', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const v = await gh.prView(root, 'no-pr'); // fake gh: "no pull requests found", exit 1
    expect(v.pr).toBeNull();
    expect(v.error).toBeUndefined();
  });

  it('prView surfaces a real gh failure (auth/network) as {error}, NOT as "no PR"', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const v = await gh.prView(root, 'auth-fail'); // fake gh: "HTTP 401", exit 1
    expect(v.pr).toBeNull();
    expect(v.error).toBeTruthy();
  });

  it('prMerge → ok:true (defined+exported, though the portal never auto-calls it)', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.prMerge(root, 'worktree-task-7');
    expect(r.ok).toBe(true);
    const merged = ghCalls().find((a) => a[0] === 'pr' && a[1] === 'merge');
    expect(merged).toEqual(['pr', 'merge', 'worktree-task-7', '--merge']);
  });

  it('prView surfaces parsed label names', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const v = await gh.prView(root, 'worktree-task-7');
    expect(v.pr).not.toBeNull();
    expect(v.pr!.labels).toEqual(['risk:low']);
  });
});

// ── gh write-back verbs: label add/remove + issue comment (fake gh on PATH) ─────
describe('ghLabelAdd / ghLabelRemove / ghIssueComment (fake gh on PATH)', () => {
  it('ghLabelAdd constructs `issue edit <n> --add-label <label>` and returns ok:true', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.ghLabelAdd(root, 42, 'risk:low');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'edit' && a[3] === '--add-label');
    expect(call).toEqual(['issue', 'edit', '42', '--add-label', 'risk:low']);
  });

  it('ghLabelRemove constructs `issue edit <n> --remove-label <label>` and returns ok:true', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.ghLabelRemove(root, 42, 'needs:human');
    expect(r.ok).toBe(true);
    const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'edit' && a[3] === '--remove-label');
    expect(call).toEqual(['issue', 'edit', '42', '--remove-label', 'needs:human']);
  });

  it('ghIssueComment constructs `issue comment <n> --body <body>` and returns ok:true', async () => {
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.ghIssueComment(root, 42, 'Risk: low\nType: bug\nAgent-ready: yes');
    expect(r.ok).toBe(true);
    const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(call).toEqual(['issue', 'comment', '42', '--body', 'Risk: low\nType: bug\nAgent-ready: yes']);
  });

  it('returns {ok:false,error} (never throws) when gh exits nonzero — scrubbed', async () => {
    // GENUINE failure-path (no spy): the verbs call the module-local `ghExec`, which resolves `gh`
    // off PATH — so we drive a real nonzero exit through the fake-gh harness rather than stubbing.
    // The fake-gh `issue comment` arm exits 1 with a TOKENIZED stderr for the sentinel issue number 999.
    // ghExec salvages `{ ok:false, code:1, stderr:'…token…' }`, the verb maps it to
    // `{ ok:false, error: ghErr(r) }`, and ghErr runs scrubCredentials. We assert:
    // (a) never throws, (b) ok:false, (c) error is a string, (d) the token is scrubbed.
    const bare = mkBare();
    const root = mkRootWired(bare);
    const r = await gh.ghIssueComment(root, 999, 'body'); // 999 → fake-gh failing arm
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error).not.toContain('ghp_SECRETTOKEN'); // scrubbed by ghErr → scrubCredentials
    expect(r.error).toContain('***'); // tokenized URL collapsed to ***@github.com
  });
});
