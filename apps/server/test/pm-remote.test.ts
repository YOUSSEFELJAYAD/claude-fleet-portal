import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

// ── DB isolation ────────────────────────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pm-remote-'));

// src modules (lazily imported in beforeAll so the env var above wins).
let pm: any;
let disallowedToolsForProject: (project: any) => string[];
let registry: any;
let projectsRepo: any;
let kanbanRepo: any;

// temp dirs to clean up at the very end.
const tmpDirs: string[] = [];

// The real registry.launch saved so we can fully restore it; a non-spawning default catches any
// deferred ticks (the merge path itself never calls launch, but a tickSoon could fire async).
let realLaunch: any;
let launchSeq = 0;

// ── fake-gh on PATH ─────────────────────────────────────────────────────────
let ORIG_PATH = '';
let fakeGhDir = '';
let ghArgLog = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function mkTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `fleet-pm-remote-${label}-`));
  tmpDirs.push(d);
  return d;
}

/** A bare repo to serve as the "remote" (no network — a local bare repo IS a valid git remote). */
function mkBare(): string {
  const dir = mkTmp('bare');
  git(dir, 'init', '--bare', '-b', 'master');
  return dir;
}

/** A working repo on `master` (one commit) wired to `bare` as `origin` and pushed, with the
 *  worktrees dir gitignored+committed (so the main worktree stays clean once a worktree exists). */
function mkRootWired(bare: string): string {
  const dir = mkTmp('root');
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  // gitignore the agent worktrees dir up front (mirrors ensureWorktreeIgnored / pm.test.ts).
  writeFileSync(join(dir, '.gitignore'), '.claude/worktrees/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-u', 'origin', 'master'); // origin/master now exists + EQUAL to local
  return dir;
}

/** A second clone of `bare`, used to advance the remote `master` independently of `root`. */
function mkProducer(bare: string): string {
  const dir = mkTmp('producer');
  git('/', 'clone', bare, dir);
  git(dir, 'config', 'user.email', 'producer@local');
  git(dir, 'config', 'user.name', 'producer');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * Build a finished worktree + branch for a card simulating a completed build (mirrors pm.test.ts):
 *   git worktree add .claude/worktrees/task-<id> -b worktree-task-<id>
 * then commit a change on that branch inside the worktree.
 */
function makeFinishedWorktree(rootDir: string, cardId: string, mutate: (wtDir: string) => void) {
  const wtName = `task-${cardId}`;
  const branch = `worktree-${wtName}`;
  const wtRel = join('.claude', 'worktrees', wtName);
  const wtDir = join(rootDir, wtRel);
  git(rootDir, 'worktree', 'add', wtRel, '-b', branch);
  git(wtDir, 'config', 'user.email', 'test@local');
  git(wtDir, 'config', 'user.name', 'test');
  mutate(wtDir);
  git(wtDir, 'add', '-A');
  git(wtDir, 'commit', '-m', `work for ${cardId}`);
  return { wtName, wtDir, branch };
}

/**
 * Install a fake `gh` first on PATH. gh.ts resolves `gh` off process.env.PATH at call time and
 * passes NO custom env, so a prepended dir shadows the real gh. Logs each argv (JSON line) to
 * GH_ARG_LOG so we can assert `pr create`/`pr view` were invoked with the right args.
 */
function installFakeGh(): void {
  fakeGhDir = mkTmp('fakegh');
  ghArgLog = join(mkTmp('arglog'), 'gh-args.log');
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@")" >> "$GH_ARG_LOG" 2>/dev/null || true
case "$1 $2" in
  "--version ")     echo "gh version 0.0.0-fake"; exit 0 ;;
  "auth status")    echo "github.com: Logged in to github.com account fake-user"; exit 0 ;;
  "pr create")      echo "https://github.com/acme/widgets/pull/77"; exit 0 ;;
  "pr view")
    if [ "$3" = "no-pr" ]; then echo "no pull requests found" 1>&2; exit 1; fi
    echo '{"state":"'"\${GH_PR_STATE:-OPEN}"'","url":"https://github.com/acme/widgets/pull/77"}'; exit 0 ;;
  "pr merge")       exit 0 ;;
  *) echo "fake-gh: unhandled $*" 1>&2; exit 1 ;;
esac
`;
  const p = join(fakeGhDir, 'gh');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  process.env.GH_ARG_LOG = ghArgLog;
  ORIG_PATH = process.env.PATH ?? '';
  process.env.PATH = `${fakeGhDir}${delimiter}${ORIG_PATH}`;
}

/** Every recorded fake-gh argv (one array per invocation). */
function ghCalls(): string[][] {
  try {
    return readFileSync(ghArgLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function resetGhCalls(): void {
  try {
    writeFileSync(ghArgLog, '');
  } catch {
    /* ignore */
  }
}

// ── project / card seeding (PR mode) ────────────────────────────────────────
function makeProject(rootDir: string, patch: Record<string, any> = {}): any {
  return projectsRepo.createProject({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    rootDir,
    defaultBranch: 'master',
    autoMerge: false,
    wipLimit: 3,
    ...patch,
  });
}

function makeCard(projectId: string, patch: Record<string, any> = {}): any {
  const card = kanbanRepo.createTask({
    projectId,
    title: patch.title ?? 'card',
    description: patch.description ?? '',
    acceptanceCriteria: patch.acceptanceCriteria ?? '',
    column: patch.column,
  });
  const post: any = {};
  for (const k of ['column', 'executionPhase', 'worktreeName']) {
    if (k in patch && patch[k] !== undefined) post[k] = patch[k];
  }
  if (Object.keys(post).length) return kanbanRepo.updateTask(card.id, post);
  return card;
}

beforeAll(async () => {
  installFakeGh();
  ({ pm, disallowedToolsForProject } = await import('../src/pm.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  realLaunch = registry.launch;
  registry.launch = (req: any) => ({ id: `bg-${++launchSeq}`, projectId: req?.projectId ?? null, status: 'running' });
});

afterAll(() => {
  if (realLaunch) registry.launch = realLaunch;
  if (ORIG_PATH) process.env.PATH = ORIG_PATH;
  delete process.env.GH_ARG_LOG;
  delete process.env.GH_PR_STATE;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ════════════════════════════════════════════════════════════════════════════
// disallowedToolsForProject — §3.4 push relaxation (pure unit, no git)
// ════════════════════════════════════════════════════════════════════════════
describe('disallowedToolsForProject() — push relaxation (§3.4)', () => {
  it('pushEnabled=false → denies both git push and git remote', () => {
    const deny = disallowedToolsForProject({ pushEnabled: false } as any);
    expect(deny).toContain('Bash(git push *)');
    expect(deny).toContain('Bash(git remote *)');
  });

  it('pushEnabled=true → relaxes (drops BOTH push and remote denies)', () => {
    const deny = disallowedToolsForProject({ pushEnabled: true } as any);
    expect(deny).not.toContain('Bash(git push *)');
    expect(deny).not.toContain('Bash(git remote *)');
    expect(deny.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// doMerge — PR mode (push + gh pr create), parked in Review (NOT merged locally)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.approve() → doMerge — PR mode (v2 #2)', () => {
  it('pushes the branch to the bare remote, opens a PR, parks in Review (open) — main NOT merged locally', async () => {
    resetGhCalls();
    const bare = mkBare();
    const root = mkRootWired(bare);
    const project = makeProject(root, { mergeMode: 'pr', pushEnabled: true, remoteName: 'origin' });
    const card = makeCard(project.id, { title: 'ship via PR', column: 'Review' });
    const { wtName, branch } = makeFinishedWorktree(root, card.id, (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'shipped\n');
    });
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const preHead = git(root, 'rev-parse', 'HEAD');
    await pm.approve(card.id);

    const parked = kanbanRepo.getTask(card.id);
    // parked in Review with the PR badge — NOT Done, NOT merging (so the safety tick never re-drives).
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('idle');
    expect(parked!.executionPhase).not.toBe('merging');
    expect(parked!.prState).toBe('open');
    expect(parked!.prUrl).toBe('https://github.com/acme/widgets/pull/77');
    expect(parked!.mergeSha).toBeFalsy(); // PR mode never records a local merge sha

    // the task branch was PUSHED to the bare remote.
    const lsRemote = git(root, 'ls-remote', bare, branch);
    expect(lsRemote).toContain(branch);

    // gh pr create was invoked with --base master --head <branch>.
    const calls = ghCalls();
    const prCreate = calls.find((c) => c[0] === 'pr' && c[1] === 'create');
    expect(prCreate).toBeTruthy();
    expect(prCreate).toContain('--base');
    expect(prCreate![prCreate!.indexOf('--base') + 1]).toBe('master');
    expect(prCreate).toContain('--head');
    expect(prCreate![prCreate!.indexOf('--head') + 1]).toBe(branch);

    // main was NOT locally merged — HEAD unchanged, feature.txt not tracked on master.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(preHead);
    expect(git(root, 'ls-files')).not.toContain('feature.txt');

    // RE-APPROVE guard: a card with an open PR is no longer approvable (a second approve would
    // re-run `gh pr create` and FAIL because the PR already exists). prState is the discriminator.
    resetGhCalls();
    await pm.approve(card.id);
    const reparked = kanbanRepo.getTask(card.id);
    expect(reparked!.column).toBe('Review');
    expect(reparked!.executionPhase).toBe('idle'); // NOT flipped to failed/merging
    expect(reparked!.prState).toBe('open');
    expect(ghCalls().some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(false); // no second pr create
  });

  it('a DIVERGED default branch parks WITHOUT force-push (FF-only invariant, risk #3)', async () => {
    resetGhCalls();
    const bare = mkBare();
    const root = mkRootWired(bare); // origin/master == local master == C0
    // Advance the REMOTE master to C1 via an independent producer clone.
    const producer = mkProducer(bare);
    writeFileSync(join(producer, 'remote-change.txt'), 'C1\n');
    git(producer, 'add', '-A');
    git(producer, 'commit', '-m', 'C1 on remote');
    git(producer, 'push', 'origin', 'master');
    const remoteTipC1 = git(producer, 'rev-parse', 'HEAD');
    // Advance LOCAL master to C2 (a different commit off C0) → local and remote DIVERGE.
    writeFileSync(join(root, 'local-change.txt'), 'C2\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'C2 local');
    const localTipC2 = git(root, 'rev-parse', 'HEAD');

    const project = makeProject(root, { mergeMode: 'pr', pushEnabled: true, remoteName: 'origin' });
    const card = makeCard(project.id, { title: 'diverged', column: 'Review' });
    const { wtName, branch } = makeFinishedWorktree(root, card.id, (wt) => {
      writeFileSync(join(wt, 'feat.txt'), 'x\n');
    });
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    await pm.approve(card.id);

    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('conflicts');
    expect(parked!.executionPhase).not.toBe('merging');
    expect(parked!.lastError).toContain('diverged');
    expect(parked!.prState).toBeFalsy(); // no PR opened
    expect(parked!.prUrl).toBeFalsy();

    // NO force-push: the remote master tip is unchanged (still C1), and the task branch was NOT pushed.
    expect(git(producer, 'ls-remote', bare, 'master')).toContain(remoteTipC1);
    expect(git(root, 'ls-remote', bare, branch)).toBe('');
    // local master is byte-for-byte untouched (still C2).
    expect(git(root, 'rev-parse', 'master')).toBe(localTipC2);
    // no gh pr create happened.
    expect(ghCalls().some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// doMerge — local mode still merges --no-ff (PR wiring did not regress v1)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.approve() → doMerge — local mode unchanged', () => {
  it('mergeMode=local (default) merges --no-ff into master → Done (no push, no gh)', async () => {
    resetGhCalls();
    const bare = mkBare();
    const root = mkRootWired(bare);
    const project = makeProject(root, { mergeMode: 'local' });
    const card = makeCard(project.id, { title: 'local merge', column: 'Review' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => {
      writeFileSync(join(wt, 'localfile.txt'), 'local\n');
    });
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const preHead = git(root, 'rev-parse', 'HEAD');
    await pm.approve(card.id);

    const done = kanbanRepo.getTask(card.id);
    expect(done!.column).toBe('Done');
    expect(done!.executionPhase).toBe('idle');
    expect(done!.mergeSha).toBeTruthy();
    expect(done!.prState).toBeFalsy(); // local mode never touches PR fields

    // master advanced via a --no-ff merge commit (2 parents) and the file landed.
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(preHead);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(done!.mergeSha);
    expect(git(root, 'ls-files')).toContain('localfile.txt');
    const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD');
    expect(parents.trim().split(/\s+/).length).toBe(3);

    // local mode never invokes gh.
    expect(ghCalls().some((c) => c[0] === 'pr')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// refreshPr — gh pr view → update pr_state; merged → Done + cleanup
// ════════════════════════════════════════════════════════════════════════════
describe('pm.refreshPr() — PR state sync (v2 #2)', () => {
  it('PR still open → updates pr_state/pr_url, card stays in Review', async () => {
    resetGhCalls();
    delete process.env.GH_PR_STATE; // fake gh defaults to OPEN
    const bare = mkBare();
    const root = mkRootWired(bare);
    const project = makeProject(root, { mergeMode: 'pr', pushEnabled: true });
    const card = makeCard(project.id, { title: 'open pr', column: 'Review', worktreeName: 'task-doesntmatter' });
    kanbanRepo.updateTask(card.id, { prState: 'open', prUrl: 'old' });

    await pm.refreshPr(card.id);

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('Review');
    expect(fresh!.prState).toBe('open');
    expect(fresh!.prUrl).toBe('https://github.com/acme/widgets/pull/77');
    // gh pr view was called with the card's branch.
    const view = ghCalls().find((c) => c[0] === 'pr' && c[1] === 'view');
    expect(view).toBeTruthy();
    expect(view![2]).toBe('worktree-task-doesntmatter');
  });

  it('PR merged → card flips to Done and the worktree is cleaned up', async () => {
    resetGhCalls();
    const bare = mkBare();
    const root = mkRootWired(bare);
    const project = makeProject(root, { mergeMode: 'pr', pushEnabled: true });
    const card = makeCard(project.id, { title: 'merged pr', column: 'Review' });
    // a REAL worktree so cleanupWorktree has something to remove.
    const { wtName, branch } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'm.txt'), 'm\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName, prState: 'open', prUrl: 'pr' });

    process.env.GH_PR_STATE = 'MERGED'; // fake gh now reports the PR merged
    try {
      await pm.refreshPr(card.id);
    } finally {
      delete process.env.GH_PR_STATE;
    }

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('Done');
    expect(fresh!.executionPhase).toBe('idle');
    expect(fresh!.prState).toBe('merged');
    // worktree torn down (branch -d → -D fallback in cleanupWorktree handles the locally-unmerged branch).
    expect(git(root, 'worktree', 'list')).not.toContain(wtName);
    expect(git(root, 'branch', '--list', branch)).toBe('');
  });
});
