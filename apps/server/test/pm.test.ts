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

/**
 * Build a card worktree whose branch edits README.md one way, then advance the default branch (main)
 * editing README.md a DIFFERENT way after the branch forked → a guaranteed textual conflict on both
 * the merge-tree probe AND the integrate-base merge. Returns the worktree handle + the new main HEAD.
 * (v2 #9 fixture: the conflict-resolution path keys off exactly this state.)
 */
function makeConflictingWorktree(
  rootDir: string,
  cardId: string,
): { wtName: string; wtDir: string; branch: string; mainHead: string } {
  const wt = makeFinishedWorktree(rootDir, cardId, (dir) => {
    writeFileSync(join(dir, 'README.md'), '# from branch\n');
  });
  // main edits the SAME file differently after the fork → textual conflict.
  writeFileSync(join(rootDir, 'README.md'), '# from main\n');
  git(rootDir, 'add', '-A');
  git(rootDir, 'commit', '-m', 'main edits readme');
  return { ...wt, mainHead: git(rootDir, 'rev-parse', 'HEAD') };
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
    maxResolveAttempts: patch.maxResolveAttempts,
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
    'resolveAttemptCount',
    'maxResolveAttempts',
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

// ════════════════════════════════════════════════════════════════════════════
// v2 #9 — conflict-resolution agent integrated into the merge pipeline (SPEC §4 #9)
//
// The ACTUAL claude resolution is a PAID E2E (FLAGGED, not run here): we stub registry.launch so the
// resolve run never spawns, then SIMULATE the agent's outcome by editing (and, on success, leaving
// the engine to commit) the half-merged worktree the engine set up. All git state is asserted over
// REAL worktrees. `pm` is `any`-typed (top of file), so we drive the private resolve terminal handler
// `onResolveRunDone(cardId, run)` directly for a fully deterministic, await-able test.
// ════════════════════════════════════════════════════════════════════════════
describe('pm #9 — conflict resolution in the merge pipeline (SPEC §4 #9)', () => {
  it('resolveConflicts OFF → a conflicting card parks in Review/conflicts EXACTLY as v1 (no resolve run launched)', async () => {
    const root = makeRepo('res-off');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: false });
    const card = makeCard(project.id, { title: 'c', column: 'Review' });
    const { wtName } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const mainHead = git(root, 'rev-parse', 'HEAD');

    const stub = stubLaunch(() => baseRun('should-not-launch', project.id));
    try {
      await pm.approve(card.id);
      // no resolve agent launched into THIS card's worktree when the toggle is off (filter by
      // worktree so a stray deferred tick from an earlier test's project can't perturb the count).
      expect(stub.calls.filter((c) => c.worktree === wtName).length).toBe(0);
    } finally {
      stub.restore();
    }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('conflicts');
    expect(parked!.lastError).toContain('conflict');
    expect(parked!.resolveAttemptCount).toBe(0); // no attempt consumed
    expect(git(root, 'rev-parse', 'HEAD')).toBe(mainHead); // main untouched
  });

  it('resolveConflicts ON → launches a resolve run (UNRELAXED deny-list) into the half-merged worktree; phase resolving, attempt counted', async () => {
    const root = makeRepo('res-launch');
    // pushEnabled ON so we can prove the resolve launch IGNORES the relaxation and uses the
    // UNRELAXED deny-list (push + remote denied) — the resolve agent must NEVER push.
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true, pushEnabled: true });
    const card = makeCard(project.id, { title: 'c', column: 'Review', maxResolveAttempts: 2 });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch((req) => baseRun('resolve-run', req.projectId));
    try {
      await pm.approve(card.id);
      // exactly ONE launch targeted THIS card's worktree — the resolve run (worktree-scoped so a
      // stray deferred tick from an earlier test's project can't perturb the count).
      const mine = stub.calls.filter((c) => c.worktree === wtName);
      expect(mine.length).toBe(1);
      const req = mine[0];
      // UNRELAXED deny-list: BOTH push + remote denied even though pushEnabled is true (§3.4).
      expect(req.disallowedTools).toContain('Bash(git push *)');
      expect(req.disallowedTools).toContain('Bash(git remote *)');
      expect(req.campaignId).toBeNull();
      expect(req.worktree).toBe(wtName);
      expect(req.permissionMode).toBe('bypassPermissions');
      expect(req.prompt).toContain('IN-PROGRESS MERGE');
    } finally {
      stub.restore();
    }
    const resolving = kanbanRepo.getTask(card.id);
    expect(resolving!.executionPhase).toBe('resolving');
    expect(resolving!.resolveAttemptCount).toBe(1); // one attempt consumed
    expect(resolving!.runId).toBe('resolve-run'); // linked so the terminal routes back
    // the worktree is genuinely half-merged: MERGE_HEAD set + README.md conflicted.
    expect(() => git(wtDir, 'rev-parse', '--verify', 'MERGE_HEAD')).not.toThrow();
    expect(git(wtDir, 'diff', '--name-only', '--diff-filter=U')).toContain('README.md');
  });

  it('resolve SUCCESS → agent resolves markers, engine commits + re-validates green → merged into main → Done', async () => {
    const root = makeRepo('res-ok');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true });
    const card = makeCard(project.id, { title: 'c', column: 'Review', maxResolveAttempts: 2 });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch((req) => baseRun('resolve-run', req.projectId));
    try {
      await pm.approve(card.id); // → resolving (markers left in the worktree)
      // SIMULATE the agent: resolve the conflict marker (files only; the engine commits).
      writeFileSync(join(wtDir, 'README.md'), '# merged: from branch + from main\n');
      const resolveRun = baseRun('resolve-run', project.id, { status: 'completed', endedAt: 2 });
      // drive the resolve terminal directly (await for determinism).
      await pm.onResolveRunDone(card.id, resolveRun);
    } finally {
      stub.restore();
    }
    const done = kanbanRepo.getTask(card.id);
    expect(done!.column).toBe('Done');
    expect(done!.executionPhase).toBe('idle');
    expect(done!.mergeSha).toBeTruthy();
    // the resolved README landed on master, no markers, worktree torn down.
    expect(git(root, 'show', 'HEAD:README.md')).toContain('merged');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'worktree', 'list')).not.toContain(wtName);
  });

  it('resolve SHIP re-integrates+re-validates the CURRENT base (a disjoint advance during resolve cannot ship an unvalidated tree)', async () => {
    // The boundary the fix locks: the resolve agent runs with the merge lock RELEASED, so `main` can
    // advance meanwhile. The ship step must re-integrate the CURRENT base + RE-VALIDATE inside the lock
    // — otherwise a disjoint advance merges cleanly and ships a tree validation never saw.
    const root = makeRepo('res-stale');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true });
    // validation FAILS iff sentinel.txt is present — sentinel is the disjoint change main gains mid-resolve.
    const card = makeCard(project.id, { title: 'c', column: 'Review', validationCommand: 'test ! -f sentinel.txt' });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch((req) => baseRun('resolve-run', req.projectId));
    try {
      await pm.approve(card.id); // → resolving (README markers left)
      // SIMULATE the agent resolving the README conflict (no sentinel yet → a pre-lock check would pass).
      writeFileSync(join(wtDir, 'README.md'), '# merged: branch + main\n');
      // main ADVANCES with a DISJOINT change (a new file) AFTER the resolve started → clean to integrate
      // but it makes validation fail. The old (ship-without-re-validate) path would merge it unchecked.
      writeFileSync(join(root, 'sentinel.txt'), 'now present\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-m', 'main advances with a disjoint file');
      const masterBefore = git(root, 'rev-parse', 'master');

      const resolveRun = baseRun('resolve-run', project.id, { status: 'completed', endedAt: 2 });
      await pm.onResolveRunDone(card.id, resolveRun);

      const parked = kanbanRepo.getTask(card.id);
      // re-integrate brought sentinel.txt into the tree → re-validate FAILED → NOT merged, parked.
      expect(parked!.column).toBe('Review');
      expect(parked!.executionPhase).toBe('failed');
      expect(parked!.mergeSha).toBeFalsy();
      // master did NOT advance to a merge commit — the unvalidated tree never shipped.
      expect(git(root, 'rev-parse', 'master')).toBe(masterBefore);
      expect(() => git(root, 'show', 'master:README.md')).not.toThrow();
      expect(git(root, 'show', 'master:README.md')).not.toContain('merged'); // branch never merged in
    } finally {
      stub.restore();
    }
  });

  it('PRODUCTION ROUTING: handleRunTerminal routes a resolving-card run terminal to the resolve path (not the build pipeline) → Done', async () => {
    // The other tests call onResolveRunDone directly; THIS one drives the real terminal entrypoint
    // handleRunTerminal so the `card.executionPhase === "resolving"` routing branch is exercised
    // end-to-end. If that branch regressed, the terminal would fall through to onCardRunDone, commit
    // a marker-laden tree, and launch a FIX run — which this test would catch (card never reaches Done).
    const root = makeRepo('res-route');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true });
    const card = makeCard(project.id, { title: 'c', column: 'Review', maxResolveAttempts: 2 });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    // unique run id (the test DB is shared across tests; getTaskByRunId must resolve to THIS card).
    const rid = `resolve-route-${card.id}`;
    const stub = stubLaunch((req) => baseRun(rid, req.projectId));
    try {
      await pm.approve(card.id); // → resolving (markers left, run_id=rid)
      expect(kanbanRepo.getTask(card.id)!.executionPhase).toBe('resolving');
      expect(kanbanRepo.getTask(card.id)!.runId).toBe(rid);
      // SIMULATE the agent resolving the marker (files only; the engine commits).
      writeFileSync(join(wtDir, 'README.md'), '# merged via routing\n');
      // Fire the REAL terminal entrypoint (fire-and-forget) with the resolve run snapshot.
      const resolveRun = baseRun(rid, project.id, { status: 'completed', endedAt: 2 });
      pm.handleRunTerminal(resolveRun);
      // poll until the resolve path drives the card to Done (the void'd async settles).
      const deadline = Date.now() + 4000;
      let done = kanbanRepo.getTask(card.id);
      while (done!.column !== 'Done' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        done = kanbanRepo.getTask(card.id);
      }
      expect(done!.column).toBe('Done'); // routed through the resolve path, merged
      expect(done!.mergeSha).toBeTruthy();
      expect(git(root, 'show', 'HEAD:README.md')).toContain('merged via routing');
    } finally {
      stub.restore();
    }
  });

  it('resolve FAILURE (markers remain) → git merge --abort cleans the worktree, parks Review/conflicts, attempt counted, main untouched', async () => {
    const root = makeRepo('res-fail');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true });
    const card = makeCard(project.id, { title: 'c', column: 'Review', maxResolveAttempts: 2 });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const mainHead = git(root, 'rev-parse', 'HEAD');

    const stub = stubLaunch((req) => baseRun('resolve-run', req.projectId));
    try {
      await pm.approve(card.id); // → resolving (markers left)
      // SIMULATE a FAILED agent: leave the markers untouched.
      const resolveRun = baseRun('resolve-run', project.id, { status: 'completed', endedAt: 2 });
      await pm.onResolveRunDone(card.id, resolveRun);
    } finally {
      stub.restore();
    }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('conflicts');
    expect(parked!.resolveAttemptCount).toBe(1); // attempt was consumed
    expect(parked!.mergeSha).toBeFalsy();
    // the half-merged tree was aborted (no MERGE_HEAD, no markers left behind).
    expect(() => git(wtDir, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(wtDir, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    // main untouched.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(mainHead);
  });

  it('resolve FAILURE (re-validation fails after a clean resolution) → parks Review/failed, not merged', async () => {
    const root = makeRepo('res-valfail');
    const project = makeProject(root, {
      defaultBranch: 'master',
      resolveConflicts: true,
      defaultValidationCommand: 'test ! -f FAIL', // fails iff a FAIL file exists in the worktree
    });
    const card = makeCard(project.id, { title: 'c', column: 'Review', maxResolveAttempts: 2 });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const mainHead = git(root, 'rev-parse', 'HEAD');

    const stub = stubLaunch((req) => baseRun('resolve-run', req.projectId));
    try {
      await pm.approve(card.id);
      // agent resolves the markers cleanly BUT leaves the tree failing validation.
      writeFileSync(join(wtDir, 'README.md'), '# resolved\n');
      writeFileSync(join(wtDir, 'FAIL'), 'boom\n');
      const resolveRun = baseRun('resolve-run', project.id, { status: 'completed', endedAt: 2 });
      await pm.onResolveRunDone(card.id, resolveRun);
    } finally {
      stub.restore();
    }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('failed');
    expect(parked!.lastError).toContain('re-validation failed');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(mainHead); // not merged
  });

  it('attempt accounting: at maxResolveAttempts → a conflict parks (no resolve launched); retries are bounded', async () => {
    const root = makeRepo('res-cap');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true });
    // already at the cap → the next conflict must NOT launch another resolve.
    const card = makeCard(project.id, {
      title: 'c',
      column: 'Review',
      maxResolveAttempts: 1,
      resolveAttemptCount: 1,
    });
    const { wtName } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch(() => baseRun('should-not-launch', project.id));
    try {
      await pm.approve(card.id);
      // at the cap → no further resolve run for THIS worktree (worktree-scoped count).
      expect(stub.calls.filter((c) => c.worktree === wtName).length).toBe(0);
    } finally {
      stub.restore();
    }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review');
    expect(parked!.executionPhase).toBe('conflicts');
    expect(parked!.resolveAttemptCount).toBe(1); // not incremented past the cap
  });

  it('reconcile aborts a crash-mid-resolve worktree (real MERGE_HEAD) and parks the card Review/conflicts', async () => {
    const root = makeRepo('res-reconcile');
    const project = makeProject(root, { defaultBranch: 'master', resolveConflicts: true, paused: true });
    const card = makeCard(project.id, { title: 'c', column: 'Review' });
    const { wtName, wtDir } = makeConflictingWorktree(root, card.id);
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    // Create a REAL in-progress conflicted merge in the worktree (a crash mid-resolve), then mark the
    // card resolving — exactly the state a crash leaves behind.
    const merge = (() => {
      try {
        git(wtDir, 'merge', '--no-edit', 'master');
        return 'clean';
      } catch {
        return 'conflict';
      }
    })();
    expect(merge).toBe('conflict');
    expect(() => git(wtDir, 'rev-parse', '--verify', 'MERGE_HEAD')).not.toThrow(); // MERGE_HEAD set
    kanbanRepo.updateTask(card.id, { executionPhase: 'resolving', runId: 'dead-resolve-run' });
    repo.upsertRun(baseRun('dead-resolve-run', project.id, { status: 'killed', endedAt: 2 }));

    const stub = stubLaunch((req) => baseRun(`r-${req.projectId}`, req.projectId));
    try {
      await pm.reconcile(); // async: awaits the merge --abort of the mid-resolve worktree
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('Review');
    expect(fresh!.executionPhase).toBe('conflicts');
    expect(fresh!.lastError).toContain('reconciled on boot');
    // the worktree is clean — the in-progress merge was aborted (no MERGE_HEAD, no markers).
    expect(() => git(wtDir, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(wtDir, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  });
});
