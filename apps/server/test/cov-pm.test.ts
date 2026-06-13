import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── DB isolation ────────────────────────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-covpm-'));

let pm: any;
let registry: any;
let repo: any;
let projectsRepo: any;
let kanbanRepo: any;
let campaigns: any;

const repoDirs: string[] = [];

// A non-spawning default for registry.launch so deferred ticks (tickSoon) never spawn claude.
let realLaunch: any;
let launchSeq = 0;

beforeAll(async () => {
  ({ pm } = await import('../src/pm.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  ({ campaigns } = await import('../src/campaigns.js'));
  realLaunch = registry.launch;
  registry.launch = (req: any) => baseRun(`bg-${++launchSeq}`, req?.projectId ?? null);
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

// ── git fixture helpers ──────────────────────────────────────────────────────
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-covpm-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Add a committed worktree+branch for a card (task-<id>/worktree-task-<id>) with one change. */
function makeWorktree(rootDir: string, cardId: string, mutate: (wt: string) => void) {
  const wtName = `task-${cardId}`;
  const branch = `worktree-${wtName}`;
  const wtRel = join('.claude', 'worktrees', wtName);
  const wtDir = join(rootDir, wtRel);
  // mirror ensureWorktreeIgnored so the main worktree stays clean.
  writeFileSync(join(rootDir, '.gitignore'), '.claude/worktrees/\n');
  git(rootDir, 'add', '--', '.gitignore');
  git(rootDir, 'commit', '-m', 'ignore worktrees');
  git(rootDir, 'worktree', 'add', wtRel, '-b', branch);
  git(wtDir, 'config', 'user.email', 'test@local');
  git(wtDir, 'config', 'user.name', 'test');
  mutate(wtDir);
  git(wtDir, 'add', '-A');
  git(wtDir, 'commit', '-m', `work ${cardId}`);
  return { wtName, wtDir, branch };
}

// ── seeding helpers ────────────────────────────────────────────────────────────
function makeProject(rootDir: string, patch: Record<string, any> = {}): any {
  const { paused, ...rest } = patch;
  const p = projectsRepo.createProject({
    name: `cp-${Math.random().toString(36).slice(2, 8)}`,
    rootDir,
    defaultBranch: 'master',
    autoMerge: false,
    wipLimit: 3,
    ...rest,
  });
  if (paused) return projectsRepo.updateProject(p.id, { paused: true });
  return p;
}

function makeCard(projectId: string, patch: Record<string, any> = {}): any {
  const card = kanbanRepo.createTask({
    projectId,
    title: patch.title ?? 'card',
    description: patch.description ?? '',
    acceptanceCriteria: patch.acceptanceCriteria ?? '',
    validationCommand: patch.validationCommand ?? null,
    maxAttempts: patch.maxAttempts,
    maxResolveAttempts: patch.maxResolveAttempts,
    column: patch.column,
    mode: patch.mode,
  });
  const post: any = {};
  for (const k of [
    'column',
    'executionPhase',
    'worktreeName',
    'runId',
    'campaignId',
    'attemptCount',
    'maxAttempts',
    'lastError',
    'lastDiffHash',
    'validationOutput',
    'prState',
    'prUrl',
  ]) {
    if (k in patch && patch[k] !== undefined) post[k] = patch[k];
  }
  if (Object.keys(post).length) return kanbanRepo.updateTask(card.id, post);
  return card;
}

const baseRun = (id: string, projectId: string | null, overrides: Record<string, any> = {}): any => ({
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

/** A minimal Campaign-shaped object for the synchronous handleCampaignTerminal decision helper. */
const campaignObj = (id: string, projectId: string | null, status: string): any => ({
  id,
  objective: 'o',
  cwd: '/tmp',
  status,
  orchestratorTemplate: 'orch',
  workerTemplate: 'worker',
  synthesizerTemplate: null,
  orchestratorRunId: null,
  synthesizerRunId: null,
  maxParallel: 1,
  autoSynthesize: false,
  budgetPerWorkerUsd: null,
  model: 'claude-haiku-4-5',
  startedAt: 1,
  endedAt: 2,
  costUsd: 0,
  projectId,
  disallowedTools: null,
  permissionMode: null,
});

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
// handleCampaignTerminal — synchronous partition/routing decision helper (v2 #4)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.handleCampaignTerminal() — partition + killed/terminal routing', () => {
  it('a standalone campaign (projectId null) is ignored — not ours', () => {
    // No card exists for it; the early return is the only correct behavior (no throw).
    expect(() => pm.handleCampaignTerminal(campaignObj('standalone-1', null, 'completed'))).not.toThrow();
  });

  it('a campaign with a projectId but NO owning card → ignored (getTaskByCampaignId null)', () => {
    const root = makeRepo('camp-nocard');
    const project = makeProject(root);
    expect(() => pm.handleCampaignTerminal(campaignObj('orphan-camp', project.id, 'completed'))).not.toThrow();
  });

  it('a killed campaign whose card is still InProgress → card Blocked/failed (campaign stopped)', () => {
    const root = makeRepo('camp-killed-ip');
    const project = makeProject(root, { paused: true });
    const cid = 'killed-camp-ip';
    const card = makeCard(project.id, { title: 'cm', mode: 'campaign', column: 'InProgress', campaignId: cid });

    pm.handleCampaignTerminal(campaignObj(cid, project.id, 'killed'));

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('failed');
    expect(fresh.lastError).toBe('campaign stopped');
  });

  it('a killed campaign whose card is already terminal (Done) → left alone (H2 guard)', () => {
    const root = makeRepo('camp-killed-done');
    const project = makeProject(root, { paused: true });
    const cid = 'killed-camp-done';
    // Done is in PM_DONE_COLUMNS → the terminal guard returns before the killed branch.
    const card = makeCard(project.id, { title: 'cm', mode: 'campaign', column: 'Done', campaignId: cid });

    pm.handleCampaignTerminal(campaignObj(cid, project.id, 'killed'));

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Done'); // untouched
    expect(fresh.executionPhase).toBe('idle');
  });

  it('a killed campaign whose card is Backlog → terminal guard returns; card untouched', () => {
    const root = makeRepo('camp-killed-backlog');
    const project = makeProject(root, { paused: true });
    const cid = 'killed-camp-backlog';
    const card = makeCard(project.id, { title: 'cm', mode: 'campaign', column: 'Backlog', campaignId: cid });

    pm.handleCampaignTerminal(campaignObj(cid, project.id, 'killed'));

    expect(kanbanRepo.getTask(card.id).column).toBe('Backlog'); // guarded out
  });

  it('a COMPLETED campaign whose worktree is missing → ensure-committed fails → card Blocked/failed', async () => {
    const root = makeRepo('camp-complete-nowt');
    const project = makeProject(root, { paused: true });
    const cid = 'complete-camp-nowt';
    // worktreeName points at a directory that does NOT exist → onCardCampaignDone's ensureCommitted throws.
    const card = makeCard(project.id, {
      title: 'cm',
      mode: 'campaign',
      column: 'InProgress',
      executionPhase: 'building',
      campaignId: cid,
      worktreeName: 'task-ghost-nowt',
    });

    pm.handleCampaignTerminal(campaignObj(cid, project.id, 'completed'));
    // onCardCampaignDone is async (void'd); poll until it parks the card.
    const deadline = Date.now() + 4000;
    let fresh = kanbanRepo.getTask(card.id);
    while (fresh.column === 'InProgress' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      fresh = kanbanRepo.getTask(card.id);
    }
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('failed');
    expect(fresh.lastError).toContain('ensure-committed failed');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// onCardRunDone — killed-run branches (budget auto-kill vs user stop) (SPEC §5.3)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.onCardRunDone() — killed run branches', () => {
  it('budget auto-kill of an InProgress card → Blocked/paused-budget with budget message', async () => {
    const root = makeRepo('killed-budget');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'k', column: 'InProgress', executionPhase: 'building' });
    const run = baseRun('kb', project.id, { status: 'killed', killReason: 'budget', endedAt: 2 });

    await pm.onCardRunDone(card.id, run);

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('paused-budget');
    expect(fresh.lastError).toContain('per-run budget reached');
  });

  it('user stop of an InProgress card → Blocked/failed (run stopped)', async () => {
    const root = makeRepo('killed-stop');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'k', column: 'InProgress', executionPhase: 'building' });
    const run = baseRun('ks', project.id, { status: 'killed', killReason: 'user', endedAt: 2 });

    await pm.onCardRunDone(card.id, run);

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('failed');
    expect(fresh.lastError).toBe('run stopped');
  });

  it('a killed run whose card was already moved OUT of InProgress (Review) → left wherever the canceller put it', async () => {
    const root = makeRepo('killed-review');
    const project = makeProject(root, { paused: true });
    // not InProgress → the killed branch leaves the card alone.
    const card = makeCard(project.id, { title: 'k', column: 'Review', executionPhase: 'idle' });
    const run = baseRun('kr', project.id, { status: 'killed', killReason: 'user', endedAt: 2 });

    await pm.onCardRunDone(card.id, run);

    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Review'); // untouched by the killed branch
    expect(fresh.executionPhase).toBe('idle');
  });

  it('onCardRunDone is a no-op when the card already sits terminal (H2 ordering)', async () => {
    const root = makeRepo('done-noop');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'k', column: 'Canceled', executionPhase: 'idle', lastError: 'x' });
    const run = baseRun('kn', project.id, { status: 'completed', endedAt: 2 });

    await pm.onCardRunDone(card.id, run);

    expect(kanbanRepo.getTask(card.id).column).toBe('Canceled'); // untouched
  });
});

// ════════════════════════════════════════════════════════════════════════════
// rework — no-progress guard, max-attempts give-up, relaunch (SPEC §5.6 + §10)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.rework() — no-progress guard + attempt cap + relaunch', () => {
  it('identical diff-vs-base hash twice (no progress) → Blocked/failed, no fix launched', async () => {
    const root = makeRepo('rew-noprog');
    const project = makeProject(root, { paused: true });
    const cid = 'cidnp';
    const card = makeCard(project.id, {
      title: 'stuck',
      column: 'InProgress',
      executionPhase: 'validating',
      maxAttempts: 5,
      attemptCount: 1,
    });
    const { wtName, wtDir } = makeWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'f.txt'), 'same\n'));
    // compute the REAL diff hash the engine would store, then seed it as lastDiffHash → identical → stuck.
    const realHash = await pm.diffHash(wtDir, 'master');
    expect(realHash).toBeTruthy(); // diffHash/hashString actually produced a value
    kanbanRepo.updateTask(card.id, { worktreeName: wtName, lastDiffHash: realHash });

    const stub = stubLaunch(() => baseRun('should-not-launch', project.id));
    try {
      await pm.rework(card.id, project, 'val out');
      expect(stub.calls.filter((c) => c.worktree === wtName).length).toBe(0); // no relaunch
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('failed');
    expect(fresh.lastError).toContain('no-progress');
    void cid;
  });

  it('reaching max_attempts → give up: Blocked/failed, persists validation output + diff hash', async () => {
    const root = makeRepo('rew-max');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, {
      title: 'exhausted',
      column: 'InProgress',
      executionPhase: 'validating',
      maxAttempts: 2,
      attemptCount: 1, // nextAttempt = 2 == maxAttempts → give up
    });
    const { wtName } = makeWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'g.txt'), 'g\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch(() => baseRun('should-not-launch', project.id));
    try {
      await pm.rework(card.id, project, 'final failure output');
      expect(stub.calls.filter((c) => c.worktree === wtName).length).toBe(0);
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('failed');
    expect(fresh.attemptCount).toBe(2);
    expect(fresh.validationOutput).toBe('final failure output');
    expect(fresh.lastError).toContain('giving up');
    expect(fresh.lastDiffHash).toBeTruthy(); // diff hash persisted for the next-run no-progress compare
  });

  it('under the cap with a NEW diff → relaunch a fix run, bump attempt, persist evidence', async () => {
    const root = makeRepo('rew-relaunch');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, {
      title: 'fixable',
      column: 'InProgress',
      executionPhase: 'validating',
      maxAttempts: 5,
      attemptCount: 1,
      lastDiffHash: 'old-hash-that-wont-match',
    });
    const { wtName } = makeWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'h.txt'), 'h\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch((req) => baseRun('fix-run', req.projectId));
    try {
      await pm.rework(card.id, project, 'still failing');
      const mine = stub.calls.filter((c) => c.worktree === wtName);
      expect(mine.length).toBe(1); // a fix run launched
      expect(mine[0].prompt).toContain('FAILED validation'); // fixPrompt threaded the validation output
      expect(mine[0].campaignId).toBeNull();
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.attemptCount).toBe(2);
    expect(fresh.validationOutput).toBe('still failing');
    expect(fresh.lastDiffHash).not.toBe('old-hash-that-wont-match'); // refreshed to the new tree's hash
    expect(fresh.runId).toBe('fix-run');
  });

  it('rework is a no-op when a human moved the card terminal during the validate await (H2)', async () => {
    const root = makeRepo('rew-h2');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'gone', column: 'Done', executionPhase: 'idle' });
    const stub = stubLaunch(() => baseRun('x', project.id));
    try {
      await pm.rework(card.id, project, 'out');
      expect(stub.calls.length).toBe(0);
    } finally {
      stub.restore();
    }
    expect(kanbanRepo.getTask(card.id).column).toBe('Done');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// launchFix — 429/cap returns the card to Ready (so the tick re-picks it)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.launchFix() — cap handling on a fix relaunch', () => {
  it('429 on the fix launch → card returned to Ready/idle (NOT Blocked) so the tick re-picks it', () => {
    const root = makeRepo('fix-429');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, {
      title: 'fixme',
      column: 'InProgress',
      executionPhase: 'building',
      worktreeName: 'task-keep-429',
      lastError: 'prev failure context',
    });
    const stub = stubLaunch(() => {
      throw Object.assign(new Error('Max concurrent runs reached'), { statusCode: 429 });
    });
    try {
      pm.requestChanges(card.id); // route → launchFix → 429 branch
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Ready'); // capped → back to Ready
    expect(fresh.executionPhase).toBe('idle');
  });

  it('a non-cap fix launch error → Blocked/failed (fix launch failed)', () => {
    const root = makeRepo('fix-err');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, {
      title: 'fixme',
      column: 'InProgress',
      executionPhase: 'building',
      worktreeName: 'task-keep-err',
    });
    const stub = stubLaunch(() => {
      throw new Error('bad cwd');
    });
    try {
      pm.requestChanges(card.id);
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Blocked');
    expect(fresh.executionPhase).toBe('failed');
    expect(fresh.lastError).toContain('fix launch failed');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// refreshPr — error surface + open/closed reflect (no merge) (v2 #2)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.refreshPr() — guards and non-merged reflect', () => {
  it('a terminal (Done) card → refreshPr is a no-op', async () => {
    const root = makeRepo('refresh-done');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'd', column: 'Done', worktreeName: 'task-x', prState: 'open' });
    await pm.refreshPr(card.id);
    expect(kanbanRepo.getTask(card.id).prState).toBe('open'); // untouched (returned before prView)
  });

  it('a card with NO worktree → refreshPr returns early (nothing to inspect)', async () => {
    const root = makeRepo('refresh-nowt');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'n', column: 'Review', worktreeName: null, prState: 'open' });
    await pm.refreshPr(card.id);
    expect(kanbanRepo.getTask(card.id).prState).toBe('open');
  });

  it('a missing card id → no-op (no throw)', async () => {
    await expect(pm.refreshPr('no-such-card')).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// withProjectLock — public delegate to the per-project merge mutex (v2 #1)
// ════════════════════════════════════════════════════════════════════════════
describe('pm.withProjectLock() — serialized critical section', () => {
  it('runs fn and returns its value; concurrent sections on the SAME project never overlap', async () => {
    const root = makeRepo('lock');
    const project = makeProject(root, { paused: true });
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const section = (n: number) =>
      pm.withProjectLock(project.id, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        order.push(n);
        active--;
        return n * 10;
      });
    const results = await Promise.all([section(1), section(2), section(3)]);
    expect(results).toEqual([10, 20, 30]); // each fn's return value flows back
    expect(maxActive).toBe(1); // strict serialization — never two sections at once
    expect(order).toEqual([1, 2, 3]); // FIFO order preserved
  });

  it('a throwing section never wedges the chain — the next section still runs', async () => {
    const root = makeRepo('lock-throw');
    const project = makeProject(root, { paused: true });
    await expect(
      pm.withProjectLock(project.id, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // the chain recovered: a following section runs and returns normally.
    const v = await pm.withProjectLock(project.id, async () => 'ok-after-throw');
    expect(v).toBe('ok-after-throw');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// cancel — campaign-mode card kills the whole campaign (v2 #4) + worktree teardown
// ════════════════════════════════════════════════════════════════════════════
describe('pm.cancel() — campaign-mode card', () => {
  it('a campaign-mode card cancels the CAMPAIGN (not a run) and marks the card Canceled first (H2)', () => {
    const root = makeRepo('cancel-camp');
    const project = makeProject(root, { paused: true });
    const cid = 'cancel-campaign-id';
    const card = makeCard(project.id, {
      title: 'cm',
      mode: 'campaign',
      column: 'InProgress',
      executionPhase: 'building',
      campaignId: cid,
      worktreeName: null, // no real worktree → skip the cleanup spawn
    });

    let killedId: string | undefined;
    let columnAtKill: string | undefined;
    const realKill = campaigns.kill.bind(campaigns);
    campaigns.kill = (id: string) => {
      killedId = id;
      columnAtKill = kanbanRepo.getTask(card.id)?.column;
    };
    try {
      pm.cancel(card.id);
    } finally {
      campaigns.kill = realKill;
    }
    expect(killedId).toBe(cid); // the campaign (not a run) was killed
    expect(columnAtKill).toBe('Canceled'); // DB terminal written BEFORE the kill (H2 ordering)
    expect(kanbanRepo.getTask(card.id).column).toBe('Canceled');
    expect(kanbanRepo.getTask(card.id).lastError).toBe('canceled by user');
  });

  it('cancel on a missing card is a no-op', () => {
    expect(() => pm.cancel('no-such-card')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reconcileResolving — boot abort of a (no real merge) resolving card → Review/conflicts
// ════════════════════════════════════════════════════════════════════════════
describe('pm.reconcile() — mid-resolve zombie with no live merge', () => {
  it('a phase=resolving card with a clean worktree (mergeAbort is a harmless no-op) → Review/conflicts', async () => {
    const root = makeRepo('reconcile-res-clean');
    const project = makeProject(root, { paused: true });
    const card = makeCard(project.id, { title: 'res', column: 'InProgress', executionPhase: 'resolving' });
    // a committed worktree with NO in-progress merge → mergeAbort throws-or-noops, caught best-effort.
    const { wtName } = makeWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'r.txt'), 'r\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });

    const stub = stubLaunch((req) => baseRun(`r-${req.projectId}`, req.projectId));
    try {
      await pm.reconcile();
    } finally {
      stub.restore();
    }
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh.column).toBe('Review');
    expect(fresh.executionPhase).toBe('conflicts');
    expect(fresh.lastError).toContain('reconciled on boot');
  });
});
