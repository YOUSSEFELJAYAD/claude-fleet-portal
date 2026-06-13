import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB isolation BEFORE any src module loads.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pm-worker-'));

let pm: any;
let registry: any;
let projectsRepo: any;
let kanbanRepo: any;
let loopsRepo: any;

const repoDirs: string[] = [];
let realLaunch: any;
let launchSeq = 0;

beforeAll(async () => {
  ({ pm } = await import('../src/pm.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  ({ loopsRepo } = await import('../src/loops.js'));
  realLaunch = registry.launch;
  registry.launch = (req: any) => baseRun(`bg-${++launchSeq}`, req?.projectId ?? null);
});
afterAll(() => {
  if (realLaunch) registry.launch = realLaunch;
  for (const d of repoDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true }); } catch {}
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-repo-${label}-`));
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
function makeProject(rootDir: string, patch: Record<string, any> = {}): any {
  return projectsRepo.createProject({ name: `proj-${Math.random().toString(36).slice(2, 8)}`, rootDir, defaultBranch: 'master', autoMerge: false, wipLimit: 5, ...patch });
}
function makeCard(projectId: string, patch: Record<string, any> = {}): any {
  const c = kanbanRepo.createTask({ projectId, title: patch.title ?? 'card', description: '', acceptanceCriteria: '', column: patch.column });
  const post: any = {};
  for (const k of ['column', 'labels', 'priority']) if (k in patch && patch[k] !== undefined) post[k] = patch[k];
  return Object.keys(post).length ? kanbanRepo.updateTask(c.id, post) : c;
}
const baseRun = (id: string, projectId: string | null, overrides: Record<string, any> = {}): any => ({
  id, sessionId: id, task: 't', cwd: '/tmp', model: 'claude-haiku-4-5', fastMode: false, effort: 'medium',
  workflowsEnabled: true, ultracode: false, teamId: null, campaignId: null, projectId, pid: null,
  status: 'running', startedAt: 1, endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: 0, exitCode: null,
  budgetUsd: 5, permissionMode: 'default', allowedTools: null, skills: [], subagentProfile: null,
  resultText: null, structuredOutput: null, killReason: null, error: null, subagentCount: 0,
  liveSubagents: 0, maxDepth: 0, lastActivity: 1, ...overrides,
});
function stubLaunch(impl: (req: any) => any): { calls: any[]; restore: () => void } {
  const calls: any[] = [];
  const real = registry.launch;
  registry.launch = (req: any) => { calls.push(req); return impl(req); };
  return { calls, restore: () => { registry.launch = real; } };
}

/**
 * Stub a launch that models the REAL async terminal contract for the Reviewer run (review.ts
 * awaitTerminal): `registry.launch` returns a still-RUNNING run, and the verdict only lands later
 * via the onRunTerminal stream. For a Reviewer launch (jsonSchema present) the helper returns a
 * running run, then fires the captured awaitTerminal subscriber on the next tick with the COMPLETED
 * run that `impl` produced (its status/structuredOutput carry the verdict). Non-Reviewer launches
 * (build/fix) return `impl`'s run unchanged — those code paths read run.id at launch, not terminal.
 * This is what catches a launchReview that reads run.structuredOutput at launch time: such a launch
 * would see the running run's null structuredOutput and fail closed, never the completed verdict.
 */
function stubLaunchAsyncReview(impl: (req: any) => any): { calls: any[]; restore: () => void } {
  const calls: any[] = [];
  const realLaunch = registry.launch;
  const realOnTerminal = registry.onRunTerminal;
  const subs = new Set<(run: any) => void>();
  registry.onRunTerminal = (cb: (run: any) => void) => {
    subs.add(cb);
    return () => subs.delete(cb);
  };
  registry.launch = (req: any) => {
    calls.push(req);
    const terminalRun = impl(req);
    if (!req?.jsonSchema) return terminalRun; // build/fix launch — no terminal await
    // Reviewer launch: hand back a running run, fire terminal once awaitTerminal has subscribed.
    const running = { ...terminalRun, status: 'running', endedAt: null, structuredOutput: null };
    setTimeout(() => {
      for (const cb of [...subs]) cb(terminalRun);
    }, 0);
    return running;
  };
  return {
    calls,
    restore: () => {
      registry.launch = realLaunch;
      registry.onRunTerminal = realOnTerminal;
    },
  };
}
// Minimal worker Loop for a project (only the fields tick/gate read).
function makeWorkerLoop(projectId: string, patch: Record<string, any> = {}): any {
  return loopsRepo.create({
    name: 'w', projectId, kind: 'worker',
    contract: { job: 'build', inputs: 'cards', allowed: [], forbidden: [], output: 'pr', evaluation: 'tests pass' },
    routableCeiling: patch.routableCeiling ?? 'low',
    mergePosture: patch.mergePosture ?? 'human-gate',
    reviewPolicy: patch.reviewPolicy ?? 'always',
  });
}

describe('pm.tick() — worker-loop selection filter (SPEC §9)', () => {
  it('NO worker loop → today behavior: a bare Ready card (no labels) is launched', async () => {
    const root = makeRepo('nofilter');
    const project = makeProject(root, { wipLimit: 5 });
    const card = makeCard(project.id, { title: 'bare', column: 'Ready' }); // no labels
    const stub = stubLaunch((req) => baseRun('bare-run', req.projectId));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(1); // unfiltered: bare Ready card launches
      expect(kanbanRepo.getTask(card.id)!.column).toBe('InProgress');
    } finally { stub.restore(); }
  });

  it('worker loop present → a Ready card WITHOUT agent:ready is NOT selected', async () => {
    const root = makeRepo('filter-skip');
    const project = makeProject(root, { wipLimit: 5 });
    makeWorkerLoop(project.id, { routableCeiling: 'low' });
    const bare = makeCard(project.id, { title: 'untriaged', column: 'Ready' }); // no agent:ready
    const stub = stubLaunch((req) => baseRun('x', req.projectId));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(0); // filtered out — not agent:ready
      expect(kanbanRepo.getTask(bare.id)!.column).toBe('Ready'); // left untouched
    } finally { stub.restore(); }
  });

  it('worker loop present → agent:ready + risk<=ceiling is selected; risk>ceiling is NOT', async () => {
    const root = makeRepo('filter-pick');
    const project = makeProject(root, { wipLimit: 5 });
    makeWorkerLoop(project.id, { routableCeiling: 'low' });
    const ok = makeCard(project.id, { title: 'routable', column: 'Ready', labels: ['agent:ready', 'risk:low'], priority: 5 });
    const tooRisky = makeCard(project.id, { title: 'risky', column: 'Ready', labels: ['agent:ready', 'risk:high'], priority: 4 });
    const stub = stubLaunch((req) => baseRun(`run-${req.worktree}`, req.projectId));
    try {
      await pm.tick(project.id);
      expect(kanbanRepo.getTask(ok.id)!.column).toBe('InProgress'); // routable: launched
      expect(kanbanRepo.getTask(tooRisky.id)!.column).toBe('Ready'); // risk>ceiling: skipped
      expect(stub.calls.map((c) => c.worktree)).toContain(`task-${ok.id}`);
      expect(stub.calls.map((c) => c.worktree)).not.toContain(`task-${tooRisky.id}`);
    } finally { stub.restore(); }
  });
});

// Local worktree fixture (mirrors pm.test.ts makeFinishedWorktree) — declared inline so this file
// is self-contained.
function ensureWorktreesGitignored(rootDir: string): void {
  const gi = join(rootDir, '.gitignore');
  let existing = '';
  try { existing = require('node:fs').readFileSync(gi, 'utf8'); } catch {}
  if (existing.split(/\r?\n/).some((l: string) => l.trim() === '.claude/worktrees/')) return;
  writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
  git(rootDir, 'add', '--', '.gitignore');
  git(rootDir, 'commit', '-m', 'chore: ignore agent worktrees');
}
function makeFinishedWorktree(rootDir: string, cardId: string, mut: (wt: string) => void): { wtName: string; wtDir: string } {
  const wtName = `task-${cardId}`;
  const wtRel = join('.claude', 'worktrees', wtName);
  const wtDir = join(rootDir, wtRel);
  ensureWorktreesGitignored(rootDir);
  git(rootDir, 'worktree', 'add', wtRel, '-b', `worktree-${wtName}`);
  git(wtDir, 'config', 'user.email', 'test@local');
  git(wtDir, 'config', 'user.name', 'test');
  mut(wtDir);
  git(wtDir, 'add', '-A');
  git(wtDir, 'commit', '-m', `work for ${cardId}`);
  return { wtName, wtDir };
}

describe('pm reviewing phase (maker/checker) in validateAndGate (SPEC §9)', () => {
  it('reviewPolicy "always" + review PASS → card parks in Review (human-gate), review was launched', async () => {
    const root = makeRepo('rev-pass');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'human-gate' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName, executionPhase: 'validating' });

    let reviewReq: any = null;
    const stub = stubLaunchAsyncReview((req) => {
      reviewReq = req; // the Reviewer launch carries the json-schema
      return baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } });
    });
    try {
      // drive the shared funnel directly (validateCard passes — no validation command).
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    expect(reviewReq).toBeTruthy();
    expect(reviewReq.jsonSchema).toBeTruthy();
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review'); // human-gate → parked, never merged
    expect(parked!.executionPhase).toBe('idle');
  });

  it('review REJECT → rework: a fix run is relaunched with the findings, attempt_count bumped', async () => {
    const root = makeRepo('rev-reject');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName, attemptCount: 0, maxAttempts: 3 });

    const reqs: any[] = [];
    const stub = stubLaunchAsyncReview((req) => {
      reqs.push(req);
      // first launch = the Reviewer (json-schema, async-terminal), reject; second = the fix run.
      if (req.jsonSchema) return baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: false, findings: 'fix the null deref at f:12' } });
      return baseRun('fix-run', project.id);
    });
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    const fixReq = reqs.find((r) => !r.jsonSchema);
    expect(fixReq).toBeTruthy();
    expect(fixReq.worktree).toBe(wtName); // same worktree
    expect(fixReq.prompt).toContain('null deref at f:12'); // findings reach the fix prompt via the explicit reviewFindings thread (rework→launchFix→fixPrompt), NOT via lastError (rework clears it)
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('InProgress'); // relaunched, not parked
    expect(fresh!.executionPhase).toBe('building');
    expect(fresh!.attemptCount).toBe(1); // one attempt consumed
  });

  it('reviewPolicy "off" → no review launched; card parks in Review directly (default gate)', async () => {
    const root = makeRepo('rev-off');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'off' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const stub = stubLaunch((req) => baseRun('x', project.id, { structuredOutput: { pass: true, findings: 'n/a' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    // no json-schema (Reviewer) launch happened.
    expect(stub.calls.filter((c) => c.jsonSchema).length).toBe(0);
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Review');
  });

  it('NO worker loop → validateAndGate is byte-for-byte v1 (no review, parks in Review)', async () => {
    const root = makeRepo('rev-noloop');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'f.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const stub = stubLaunch((req) => baseRun('x', project.id));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    expect(stub.calls.filter((c) => c.jsonSchema).length).toBe(0); // no review
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Review');
  });
});

let registryGetConfig: any;
describe('pm gate — mergePosture (SPEC §11)', () => {
  it('human-gate (default) → a clean reviewed card parks in Review and main is UNTOUCHED (never merges)', async () => {
    const root = makeRepo('posture-human');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'human-gate' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:low'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const preHead = git(root, 'rev-parse', 'HEAD');
    const stub = stubLaunchAsyncReview((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review'); // human-gate parks
    expect(parked!.mergeSha).toBeFalsy(); // never merged
    expect(git(root, 'rev-parse', 'HEAD')).toBe(preHead); // main untouched
  });

  it('auto-low-risk + local mode + risk:low + global ceiling allows low → MERGED to main → Done', async () => {
    const root = makeRepo('posture-auto');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false }); // mergeMode defaults 'local'
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'auto-low-risk' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:low'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    // global ceiling: allow auto-merge up to risk:low.
    const cfg = registry.getConfig();
    registry.setConfig({ ...cfg, loopAutoMergeCeiling: 'low' });
    const stub = stubLaunchAsyncReview((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally {
      stub.restore();
      registry.setConfig(cfg);
    }
    const done = kanbanRepo.getTask(card.id);
    expect(done!.column).toBe('Done'); // auto-merged
    expect(done!.mergeSha).toBeTruthy();
    expect(git(root, 'ls-files')).toContain('feature.txt');
  });

  it('auto-low-risk but global ceiling OFF (null) → does NOT auto-merge; parks in Review', async () => {
    const root = makeRepo('posture-noceil');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'auto-low-risk' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:low'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const cfg = registry.getConfig();
    registry.setConfig({ ...cfg, loopAutoMergeCeiling: null }); // ceiling off
    const stub = stubLaunchAsyncReview((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); registry.setConfig(cfg); }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review'); // ceiling off → not auto-merged
    expect(parked!.mergeSha).toBeFalsy();
  });

  it('auto-low-risk + risk:medium (above ceiling) → parks in Review (only risk:low auto-merges)', async () => {
    const root = makeRepo('posture-medium');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'auto-low-risk' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:medium'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const cfg = registry.getConfig();
    registry.setConfig({ ...cfg, loopAutoMergeCeiling: 'low' });
    const stub = stubLaunchAsyncReview((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); registry.setConfig(cfg); }
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Review'); // risk>ceiling → not auto-merged
    void registryGetConfig;
  });
});
