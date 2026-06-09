import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── DB isolation ────────────────────────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load). Vitest isolates test
// FILES, so this gets a fresh DB independent of pm.test.ts / fleet.test.ts — critical here: the
// permissive-config CONTROL case depends on a lone demander getting a non-zero fair-share quota, which
// a DB polluted with leftover Ready cards from other tests could silently break.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pmfleet-'));

// src modules (lazily imported in beforeAll so the env var above wins).
let pm: any;
let registry: any;
let repo: any;
let projectsRepo: any;
let kanbanRepo: any;
let fleet: any; // src/fleet.js — fleetRepo + DEFAULT_FLEET_CONFIG

const repoDirs: string[] = [];

// A global non-spawning default (mirrors pm.test.ts): deferred async ticks may fire AFTER a test's
// local stub is restored — this default catches them so they NEVER spawn claude / bind a port.
let realLaunch: any;
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
  fleet = await import('../src/fleet.js');
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

// ── git fixture helpers (subset of pm.test.ts) ───────────────────────────────
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
  if (paused) return projectsRepo.updateProject(p.id, { paused: true });
  return p;
}

function makeCard(projectId: string, patch: Partial<any> = {}): any {
  return kanbanRepo.createTask({
    projectId,
    title: patch.title ?? 'card',
    column: patch.column ?? 'Ready',
    priority: patch.priority,
  });
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

/** Wipe every run / card / project so each test is a genuinely isolated demand set (mirrors
 *  fleet.test.ts resetAll). Without this the STARVED card carries over and CONTROL would see TWO
 *  demanders — the test would still pass (floor-of-1), but the "sole demander → quota 2" reasoning
 *  the case asserts would be false, and a future 3rd demander could flip pool<#demanders and flake it. */
function resetState() {
  for (const r of repo.listRuns()) repo.deleteRun(r.id);
  for (const p of projectsRepo.listProjects()) {
    for (const c of kanbanRepo.listTasks(p.id)) kanbanRepo.deleteTask(c.id);
    projectsRepo.deleteProject(p.id);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// v2 §4 #7 — launchBuild → tryAdmit WIRING (the fleet admission gate inside the PM
// launch path). The two cases are IDENTICAL except the single `fleetRepo.set(...)`
// line, so the fleet config is provably the only cause of the difference:
//
//   STARVED   reserveSlotsForNonPm == maxConcurrentRuns → PM pool 0 → tryAdmit() denies
//             (fleet.ts:271, BEFORE any demand math) → launchBuild returns 'capped' →
//             tick() leaves the card Ready, no registry.launch.
//   CONTROL   default permissive config → pool 2, sole demander → quota 2 → tryAdmit()
//             admits → launchBuild launches → card → InProgress/building.
//
// registry.config.maxConcurrentRuns is set EXPLICITLY (mirrors fleet.test.ts) so the
// result never rides on an ambient default. stubLaunch ⇒ nothing spawns.
// ════════════════════════════════════════════════════════════════════════════
describe('pm.launchBuild → tryAdmit wiring (v2 §4 #7)', () => {
  it('STARVED fleet (reserve == maxConcurrentRuns ⇒ PM pool 0): a Ready card STAYS Ready, nothing launches', async () => {
    resetState(); // isolated demand set: this project is the only demander.
    registry.config.maxConcurrentRuns = 4;
    // reserve the ENTIRE concurrency cap for non-PM work → PM pool = max(0, 4-4) = 0 → tryAdmit denies.
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 4, fleetSpendCeilingUsd: null });

    const root = makeRepo('starved');
    const project = makeProject(root, { wipLimit: 5 }); // WIP/budget are wide open: ONLY the fleet gate can deny.
    const card = makeCard(project.id, { title: 'starved', column: 'Ready' });

    const stub = stubLaunch((req) => baseRun('should-not-launch', req.projectId));
    try {
      await pm.tick(project.id);
      // tryAdmit denied → launchBuild returned 'capped' (like a 429) → loop broke, card untouched.
      expect(stub.calls.length).toBe(0); // NO spawn
      const fresh = kanbanRepo.getTask(card.id);
      expect(fresh!.column).toBe('Ready'); // still Ready (retried on the next tick)
      expect(fresh!.executionPhase).toBe('idle'); // never entered building
      expect(fresh!.runId).toBeNull();
    } finally {
      stub.restore();
    }
  });

  it('CONTROL — default permissive fleet config: a lone Ready card IS admitted (launches → InProgress/building)', async () => {
    resetState(); // isolated: a SOLE demander, so its quota is the whole pool (2), not a floor-of-1.
    registry.config.maxConcurrentRuns = 4;
    // ONLY difference from the starved case: the default permissive config (pool = 4 - 2 = 2 > 0).
    fleet.fleetRepo.set({ ...fleet.DEFAULT_FLEET_CONFIG });

    const root = makeRepo('control');
    const project = makeProject(root, { wipLimit: 5 });
    const card = makeCard(project.id, { title: 'lone', column: 'Ready' });

    const stub = stubLaunch((req) => baseRun('admitted-run', req.projectId));
    try {
      await pm.tick(project.id);
      // sole demander → quota 2 → under quota → admitted → exactly one launch.
      expect(stub.calls.length).toBe(1);
      const moved = kanbanRepo.getTask(card.id);
      expect(moved!.column).toBe('InProgress');
      expect(moved!.executionPhase).toBe('building');
      expect(moved!.runId).toBe('admitted-run');
      expect(moved!.worktreeName).toBe(`task-${card.id}`);
    } finally {
      stub.restore();
    }
  });
});
