import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── DB isolation ────────────────────────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pm-'));

// src modules (lazily imported in beforeAll so the env var above wins).
let pm: any;
let registry: any;
let repo: any;
let projectsRepo: any;
let kanbanRepo: any;

// temp git repos to clean up at the very end.
const repoDirs: string[] = [];

// The real registry.launch saved so we can fully restore it in afterAll.
let realLaunch: any;
// A global non-spawning default: deferred async ticks (tickSoon / reconcile's tickAll) may fire AFTER
// a test's local stub is restored — this default catches them so they NEVER spawn claude / bind a port.
let launchSeq = 0;
function installDefaultLaunchStub() {
  realLaunch = registry.launch;
  registry.launch = (req: any) => baseRun(`bg-launch-${++launchSeq}`, req?.projectId ?? null);
}

beforeAll(async () => {
  ({ pm } = await import('../src/pm.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  installDefaultLaunchStub();
});

afterAll(() => {
  if (realLaunch) registry.launch = realLaunch;
  for (const d of repoDirs) {
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

// ── git fixture helpers ───────────────────────────────────────────────────────
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Create a fresh git repo on `master` with one committed file. Returns the abs root dir. */
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-repo-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  // some git versions refuse merge commits without an identity; also set commit.gpgsign off.
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Gitignore + commit `.claude/worktrees/` so the main worktree stays clean once a worktree exists.
 *  Mirrors git.ts ensureWorktreeIgnored (committed as a normal change here). Idempotent-ish: only the
 *  first call per repo commits; subsequent worktrees reuse the existing ignore. */
function ensureWorktreesGitignored(rootDir: string): void {
  const gi = join(rootDir, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(gi, 'utf8');
  } catch {
    /* no .gitignore yet */
  }
  if (existing.split(/\r?\n/).some((l: string) => l.trim() === '.claude/worktrees/')) return;
  writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
  git(rootDir, 'add', '--', '.gitignore');
  git(rootDir, 'commit', '-m', 'chore: ignore agent worktrees');
}

/**
 * Build a finished worktree + branch for a card simulating a completed build:
 *   git worktree add .claude/worktrees/task-<id> -b worktree-task-<id>
 * then commit a change on that branch inside the worktree.
 * `fileMutator` writes the change(s) inside the worktree dir.
 */
function makeFinishedWorktree(
  rootDir: string,
  cardId: string,
  fileMutator: (wtDir: string) => void,
): { wtName: string; wtDir: string; branch: string } {
  const wtName = `task-${cardId}`;
  const branch = `worktree-${wtName}`;
  const wtRel = join('.claude', 'worktrees', wtName);
  const wtDir = join(rootDir, wtRel);
  // Production launchBuild commits `.gitignore` with `.claude/worktrees/` (ensureWorktreeIgnored)
  // BEFORE the worktree is created, so the main worktree stays clean (else mergeBranch refuses on a
  // dirty tree). Replicate that here since we pre-build the worktree directly.
  ensureWorktreesGitignored(rootDir);
  git(rootDir, 'worktree', 'add', wtRel, '-b', branch);
  // worktrees inherit repo config (user.name/email) on most setups; set explicitly to be safe.
  git(wtDir, 'config', 'user.email', 'test@local');
  git(wtDir, 'config', 'user.name', 'test');
  fileMutator(wtDir);
  git(wtDir, 'add', '-A');
  git(wtDir, 'commit', '-m', `work for ${cardId}`);
  return { wtName, wtDir, branch };
}

// ── project / card seeding helpers ─────────────────────────────────────────────
function makeProject(rootDir: string, patch: Partial<any> = {}): any {
  const { paused, ...createPatch } = patch;
  const p = projectsRepo.createProject({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    rootDir,
    defaultBranch: 'master',
    autoMerge: false,
    wipLimit: 3,
    ...createPatch,
  });
  // createProject hardcodes paused:false — set it via updateProject when requested.
  if (paused) return projectsRepo.updateProject(p.id, { paused: true });
  return p;
}

function makeCard(projectId: string, patch: Partial<any> = {}): any {
  const card = kanbanRepo.createTask({
    projectId,
    title: patch.title ?? 'card',
    description: patch.description ?? '',
    acceptanceCriteria: patch.acceptanceCriteria ?? '',
    validationCommand: patch.validationCommand ?? null,
    priority: patch.priority,
    dependsOn: patch.dependsOn,
    maxAttempts: patch.maxAttempts,
    budgetUsd: patch.budgetUsd,
    column: patch.column,
  });
  // apply any post-create fields not settable through createTask (worktreeName, runId, phase, ...).
  const post: any = {};
  for (const k of [
    'column',
    'executionPhase',
    'worktreeName',
    'runId',
    'attemptCount',
    'maxAttempts',
    'lastError',
    'lastDiffHash',
    'validationOutput',
  ]) {
    if (k in patch && patch[k] !== undefined) post[k] = patch[k];
  }
  if (Object.keys(post).length) return kanbanRepo.updateTask(card.id, post);
  return card;
}

const baseRun = (id: string, projectId: string | null, overrides: Partial<any> = {}): any => ({
  id,
  sessionId: id,
  task: 't',
  cwd: '/tmp',
  model: 'claude-haiku-4-5',
  fastMode: false,
  effort: 'medium',
  workflowsEnabled: true,
  ultracode: false,
  teamId: null,
  campaignId: null,
  projectId,
  pid: null,
  status: 'running',
  startedAt: 1,
  endedAt: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  exitCode: null,
  budgetUsd: 5,
  permissionMode: 'default',
  allowedTools: null,
  skills: [],
  subagentProfile: null,
  resultText: null,
  structuredOutput: null,
  killReason: null,
  error: null,
  subagentCount: 0,
  liveSubagents: 0,
  maxDepth: 0,
  lastActivity: 1,
  ...overrides,
});

/** Stub registry.launch; returns a restore fn + the captured call list. */
function stubLaunch(impl: (req: any) => any): { calls: any[]; restore: () => void } {
  const calls: any[] = [];
  const real = registry.launch;
  registry.launch = (req: any) => {
    calls.push(req);
    return impl(req);
  };
  return { calls, restore: () => { registry.launch = real; } };
}

// ════════════════════════════════════════════════════════════════════════════
// tick(): SELECT loop — dep-block, WIP cap, budget ceiling, paused
// ════════════════════════════════════════════════════════════════════════════
describe('pm.tick() — SELECT guardrails (SPEC §5.1)', () => {
  it('moves a Ready card with unmet deps to Blocked (dep-block sentinel), then back to Ready when deps Done', async () => {
    const root = makeRepo('dep');
    // wipLimit 1 + a separate InProgress card keeps the cap full so the un-blocked card can't be
    // launched — isolating the Blocked→Ready transition deterministically.
    const project = makeProject(root, { wipLimit: 1 });
    const filler = makeCard(project.id, { title: 'filler', column: 'InProgress' });
    const dep = makeCard(project.id, { title: 'dep', column: 'Backlog' });
    const card = makeCard(project.id, { title: 'dependent', column: 'Ready', dependsOn: [dep.id] });

    // launch must NOT fire for a dep-blocked card; if it does the test should notice.
    const stub = stubLaunch(() => baseRun('should-not-happen', project.id));
    try {
      await pm.tick(project.id);
      const blocked = kanbanRepo.getTask(card.id);
      expect(blocked!.column).toBe('Blocked');
      expect(blocked!.executionPhase).toBe('idle');
      expect(blocked!.lastError).toBe('blocked: waiting on unmet dependencies');
      expect(stub.calls.length).toBe(0); // nothing launched while blocked

      // satisfy the dep → a later tick returns the card to Ready (WIP is full so it can't launch).
      kanbanRepo.updateTask(dep.id, { column: 'Done' });
      await pm.tick(project.id);
      const fresh = kanbanRepo.getTask(card.id);
      expect(fresh!.column).toBe('Ready'); // dep-block lifted; WIP cap kept it from launching
      expect(fresh!.executionPhase).toBe('idle');
      expect(fresh!.lastError).toBeNull(); // sentinel cleared
      expect(stub.calls.length).toBe(0);
      void filler;
    } finally {
      stub.restore();
    }
  });

  it('respects the WIP cap: InProgress count == wipLimit → tick launches nothing', async () => {
    const root = makeRepo('wip');
    const project = makeProject(root, { wipLimit: 2 });
    makeCard(project.id, { title: 'ip1', column: 'InProgress' });
    makeCard(project.id, { title: 'ip2', column: 'InProgress' });
    makeCard(project.id, { title: 'waiting', column: 'Ready' });

    const stub = stubLaunch(() => baseRun('wip-launch', project.id));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(0); // cap is full
      expect(kanbanRepo.inProgressCount(project.id)).toBe(2);
    } finally {
      stub.restore();
    }
  });

  it('launches a Ready card when a WIP slot is free (positive control)', async () => {
    const root = makeRepo('wip-ok');
    const project = makeProject(root, { wipLimit: 2 });
    makeCard(project.id, { title: 'ip1', column: 'InProgress' });
    const card = makeCard(project.id, { title: 'waiting', column: 'Ready' });

    const stub = stubLaunch((req) => baseRun('free-slot', req.projectId));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(1);
      const moved = kanbanRepo.getTask(card.id);
      expect(moved!.column).toBe('InProgress');
      expect(moved!.executionPhase).toBe('building');
      expect(moved!.runId).toBe('free-slot');
      expect(moved!.worktreeName).toBe(`task-${card.id}`);
    } finally {
      stub.restore();
    }
  });

  it('respects the per-project spend ceiling: projectSpend >= budgetCeilingUsd → tick launches nothing', async () => {
    const root = makeRepo('budget');
    const project = makeProject(root, { wipLimit: 5, budgetCeilingUsd: 1 });
    const card = makeCard(project.id, { title: 'expensive', column: 'Ready' });

    // seed a run scoped to this project whose cost exceeds the ceiling.
    repo.upsertRun(baseRun('spend-1', project.id, { costUsd: 5, status: 'completed', endedAt: 2 }));

    const stub = stubLaunch(() => baseRun('budget-launch', project.id));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(0); // ceiling reached → no launch
      expect(kanbanRepo.getTask(card.id)!.column).toBe('Ready'); // card untouched, stays Ready
    } finally {
      stub.restore();
    }
  });

  it('paused project → tick is a no-op (no launches, no reblock)', async () => {
    const root = makeRepo('paused');
    const project = makeProject(root, { wipLimit: 5, paused: true });
    // a Ready card with an unmet dep: a paused tick must not even reblock it.
    const dep = makeCard(project.id, { title: 'dep', column: 'Ready' });
    const card = makeCard(project.id, { title: 'ready', column: 'Ready', dependsOn: [dep.id] });

    const stub = stubLaunch(() => baseRun('paused-launch', project.id));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(0);
      // paused returns BEFORE reblockReadyCards, so the dep-unmet card stays Ready (not Blocked).
      expect(kanbanRepo.getTask(card.id)!.column).toBe('Ready');
    } finally {
      stub.restore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// tick(): 429 backoff — Ready card stays Ready, launch loop stops
// ════════════════════════════════════════════════════════════════════════════
describe('pm.tick() — 429 concurrency backoff (SPEC §5.2)', () => {
  it('on registry.launch 429 the Ready card STAYS Ready and the launch loop stops', async () => {
    const root = makeRepo('429');
    const project = makeProject(root, { wipLimit: 5 });
    // two Ready cards: priorities so the first attempted gets the 429, the second must NOT be tried.
    const first = makeCard(project.id, { title: 'first', column: 'Ready', priority: 10 });
    const second = makeCard(project.id, { title: 'second', column: 'Ready', priority: 5 });

    const stub = stubLaunch(() => {
      throw Object.assign(new Error('Max concurrent runs reached'), { statusCode: 429 });
    });
    try {
      await pm.tick(project.id);
      // 429 → 'capped' → break out of the loop. Both cards remain Ready (not Blocked/failed).
      expect(kanbanRepo.getTask(first.id)!.column).toBe('Ready');
      expect(kanbanRepo.getTask(first.id)!.executionPhase).toBe('idle');
      expect(kanbanRepo.getTask(second.id)!.column).toBe('Ready');
      // the loop stopped after the first 429 → only ONE launch attempt was made.
      expect(stub.calls.length).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it('a non-429 launch error parks the card Blocked/failed (contrast)', async () => {
    const root = makeRepo('launcherr');
    const project = makeProject(root, { wipLimit: 5 });
    const card = makeCard(project.id, { title: 'boom', column: 'Ready' });
    const stub = stubLaunch(() => {
      throw new Error('bad cwd'); // no statusCode → not a cap
    });
    try {
      await pm.tick(project.id);
      const fresh = kanbanRepo.getTask(card.id);
      expect(fresh!.column).toBe('Blocked');
      expect(fresh!.executionPhase).toBe('failed');
      expect(fresh!.lastError).toContain('launch failed');
    } finally {
      stub.restore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// approve(): the gated merge over REAL git worktrees (SPEC §6)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.approve() — gated merge (SPEC §6)', () => {
  it('merges a clean Review card --no-ff into the default branch, records mergeSha, cleans up the worktree → Done', async () => {
    const root = makeRepo('approve');
    const project = makeProject(root, { defaultBranch: 'master' });
    // create the card FIRST to get its id, then build the worktree named for it.
    const card = makeCard(project.id, { title: 'feature', column: 'Review' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'shipped\n');
    });
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const preHead = git(root, 'rev-parse', 'HEAD');
    await pm.approve(card.id);

    const done = kanbanRepo.getTask(card.id);
    expect(done!.column).toBe('Done');
    expect(done!.executionPhase).toBe('idle');
    expect(done!.mergeSha).toBeTruthy();

    // main advanced via a real merge commit, and the shipped file is present on master.
    const postHead = git(root, 'rev-parse', 'HEAD');
    expect(postHead).not.toBe(preHead);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(done!.mergeSha);
    const tracked = git(root, 'ls-files');
    expect(tracked).toContain('feature.txt');
    // worktree removed.
    const wtList = git(root, 'worktree', 'list');
    expect(wtList).not.toContain(wtName);
    // and the merge is a --no-ff merge commit (2 parents).
    const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD');
    expect(parents.trim().split(/\s+/).length).toBe(3); // <merge> <p1> <p2>
  });

  it('a card whose branch CONFLICTS with main is parked in Review with phase conflicts; main is untouched', async () => {
    const root = makeRepo('conflict');
    const project = makeProject(root, { defaultBranch: 'master' });
    const card = makeCard(project.id, { title: 'conflicting', column: 'Review' });
    // branch edits README.md...
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => {
      writeFileSync(join(wt, 'README.md'), '# from branch\n');
    });
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    // ...and main also edits README.md differently AFTER the branch forked → textual conflict.
    writeFileSync(join(root, 'README.md'), '# from main\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'main edits readme');
    const mainHead = git(root, 'rev-parse', 'HEAD');

    await pm.approve(card.id);

    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('conflicts');
    expect(parked!.lastError).toContain('conflict');
    expect(parked!.mergeSha).toBeFalsy();
    // main is byte-for-byte untouched.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(git(root, 'show', 'HEAD:README.md')).toBe('# from main');
  });

  it('mutex: approving two Review cards completes both merges without corrupting main', async () => {
    const root = makeRepo('mutex');
    const project = makeProject(root, { defaultBranch: 'master' });
    const a = makeCard(project.id, { title: 'A', column: 'Review' });
    const b = makeCard(project.id, { title: 'B', column: 'Review' });
    const wtA = makeFinishedWorktree(root, a.id, (wt) => writeFileSync(join(wt, 'a.txt'), 'A\n'));
    const wtB = makeFinishedWorktree(root, b.id, (wt) => writeFileSync(join(wt, 'b.txt'), 'B\n'));
    kanbanRepo.updateTask(a.id, { worktreeName: wtA.wtName });
    kanbanRepo.updateTask(b.id, { worktreeName: wtB.wtName });

    // fire both concurrently; the per-project mutex must serialize the two merges.
    await Promise.all([pm.approve(a.id), pm.approve(b.id)]);

    const ca = kanbanRepo.getTask(a.id);
    const cb = kanbanRepo.getTask(b.id);
    expect(ca!.column).toBe('Done');
    expect(cb!.column).toBe('Done');
    expect(ca!.mergeSha).toBeTruthy();
    expect(cb!.mergeSha).toBeTruthy();
    expect(ca!.mergeSha).not.toBe(cb!.mergeSha);
    // both files landed on master and the tree is clean (no corruption).
    const tracked = git(root, 'ls-files');
    expect(tracked).toContain('a.txt');
    expect(tracked).toContain('b.txt');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('approve() on a non-Review card is a no-op', async () => {
    const root = makeRepo('approve-noop');
    const project = makeProject(root, { defaultBranch: 'master' });
    const card = makeCard(project.id, { title: 'ready', column: 'Ready' });
    const before = git(root, 'rev-parse', 'HEAD');
    await pm.approve(card.id);
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Ready');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// requestChanges(): relaunch a fix under max_attempts; give up at the cap
// ════════════════════════════════════════════════════════════════════════════
describe('pm.requestChanges() — rework gate (SPEC §5.6)', () => {
  it('under max_attempts: relaunches a fix run in the same worktree', async () => {
    const root = makeRepo('reqchg');
    const project = makeProject(root, { defaultBranch: 'master' });
    // route already moved it to InProgress + bumped attemptCount + stashed the comment.
    const card = makeCard(project.id, {
      title: 'fixme',
      column: 'InProgress',
      attemptCount: 1,
      maxAttempts: 3,
      worktreeName: 'task-existing',
      lastError: '[human request-changes] please fix',
    });

    const stub = stubLaunch((req) => {
      // assert the fix prompt threads the reviewer comment + reuses the worktree.
      expect(req.worktree).toBe('task-existing');
      expect(req.prompt).toContain('reviewer requested changes');
      return baseRun('fix-run', req.projectId);
    });
    try {
      pm.requestChanges(card.id);
      expect(stub.calls.length).toBe(1);
      const fresh = kanbanRepo.getTask(card.id);
      expect(fresh!.column).toBe('InProgress');
      expect(fresh!.executionPhase).toBe('building');
      expect(fresh!.runId).toBe('fix-run');
    } finally {
      stub.restore();
    }
  });

  it('at max_attempts: gives up → Blocked/failed and launches nothing', async () => {
    const root = makeRepo('reqchg-max');
    const project = makeProject(root, { defaultBranch: 'master' });
    const card = makeCard(project.id, {
      title: 'exhausted',
      column: 'InProgress',
      attemptCount: 3,
      maxAttempts: 3,
      worktreeName: 'task-existing',
      lastError: '[human request-changes] still broken',
    });
    const stub = stubLaunch(() => baseRun('should-not-launch', project.id));
    try {
      pm.requestChanges(card.id);
      expect(stub.calls.length).toBe(0);
      const fresh = kanbanRepo.getTask(card.id);
      expect(fresh!.column).toBe('Blocked');
      expect(fresh!.executionPhase).toBe('failed');
      expect(fresh!.lastError).toContain('max attempts');
    } finally {
      stub.restore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// cancel() / H2: card marked terminal in the DB BEFORE the run is stopped
// ════════════════════════════════════════════════════════════════════════════
describe('pm.cancel() — H2 ordering (no orphan)', () => {
  it('marks the card Canceled in the DB BEFORE registry.stop() runs', () => {
    const root = makeRepo('cancel');
    const project = makeProject(root, { defaultBranch: 'master' });
    const card = makeCard(project.id, {
      title: 'live',
      column: 'InProgress',
      executionPhase: 'building',
      runId: 'run-to-stop',
      worktreeName: null, // avoid a real cleanupWorktree spawn
    });

    let columnAtStop: string | undefined;
    const realStop = registry.stop.bind(registry);
    registry.stop = (runId: string) => {
      if (runId === 'run-to-stop' && columnAtStop === undefined) {
        columnAtStop = kanbanRepo.getTask(card.id)?.column;
      }
    };
    try {
      pm.cancel(card.id);
    } finally {
      registry.stop = realStop;
    }

    expect(columnAtStop).toBe('Canceled'); // DB terminal BEFORE stop → onRunTerminal short-circuits
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('Canceled');
    expect(fresh!.executionPhase).toBe('idle');
    expect(fresh!.lastError).toBe('canceled by user');
  });

  it('cancel without a runId still marks the card Canceled (no stop call)', () => {
    const root = makeRepo('cancel-norun');
    const project = makeProject(root, { defaultBranch: 'master' });
    const card = makeCard(project.id, { title: 'norun', column: 'Ready' });
    let stopCalled = false;
    const realStop = registry.stop.bind(registry);
    registry.stop = () => { stopCalled = true; };
    try {
      pm.cancel(card.id);
    } finally {
      registry.stop = realStop;
    }
    expect(stopCalled).toBe(false);
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Canceled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reconcile(): boot guardrail — stuck InProgress cards return to Ready
// ════════════════════════════════════════════════════════════════════════════
describe('pm.reconcile() — boot guardrail (SPEC §5.7)', () => {
  it('returns stuck InProgress (building/validating) cards to Ready, preserving attempt history', () => {
    const root = makeRepo('reconcile');
    // Paused: reconcile() resets stuck cards UNCONDITIONALLY (it loops cards directly, not gated by
    // paused), but its trailing tickAll() then returns early on the paused project — so the post-
    // reconcile Ready state is stable regardless of async-tick timing.
    const project = makeProject(root, { defaultBranch: 'master', wipLimit: 5, paused: true });
    // a dead run row so reconcile sees the card's run as terminal.
    repo.upsertRun(baseRun('dead-run', project.id, { status: 'failed', endedAt: 2 }));
    const building = makeCard(project.id, {
      title: 'mid-build',
      column: 'InProgress',
      executionPhase: 'building',
      runId: 'dead-run',
      attemptCount: 2,
      worktreeName: 'task-keep',
    });
    const validating = makeCard(project.id, {
      title: 'mid-validate',
      column: 'InProgress',
      executionPhase: 'validating',
      runId: null, // no run → treated as dead
      attemptCount: 1,
    });

    // Stub launch as a safety net (paused project means the trailing tickAll won't launch anyway).
    const stub = stubLaunch((req) => baseRun(`relaunch-${req.projectId}`, req.projectId));
    try {
      pm.reconcile();
      const b = kanbanRepo.getTask(building.id);
      const v = kanbanRepo.getTask(validating.id);
      expect(b!.column).toBe('Ready');
      expect(b!.executionPhase).toBe('idle');
      expect(b!.runId).toBeNull(); // unbound from the dead run
      expect(b!.lastError).toContain('reconciled on boot');
      expect(b!.attemptCount).toBe(2); // attempt history preserved across reconcile
      expect(v!.column).toBe('Ready');
      expect(v!.runId).toBeNull();
      expect(v!.attemptCount).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it('a mid-merge Review zombie (phase merging, dead run) is reset to idle in Review for re-approval', () => {
    const root = makeRepo('reconcile-merge');
    const project = makeProject(root, { defaultBranch: 'master', wipLimit: 5, paused: true });
    repo.upsertRun(baseRun('dead-merge-run', project.id, { status: 'killed', endedAt: 2 }));
    const card = makeCard(project.id, {
      title: 'mid-merge',
      column: 'Review',
      executionPhase: 'merging',
      runId: 'dead-merge-run',
    });
    const stub = stubLaunch((req) => baseRun(`r-${req.projectId}`, req.projectId));
    try {
      pm.reconcile();
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('Review');
    expect(fresh!.executionPhase).toBe('idle');
    expect(fresh!.lastError).toContain('reconciled on boot');
  });
});
