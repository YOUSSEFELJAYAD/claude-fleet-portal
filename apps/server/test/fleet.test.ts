import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── DB isolation ────────────────────────────────────────────────────────────
// Must happen BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-fleet-'));

// src modules (lazily imported in beforeAll so the env var above wins).
let fleet: any;
let registry: any;
let repo: any;
let projectsRepo: any;
let kanbanRepo: any;

// temp git repos to clean up at the very end.
const repoDirs: string[] = [];

// The real registry.launch saved so we can restore it in afterAll (we never want a real spawn).
let realLaunch: any;

beforeAll(async () => {
  fleet = await import('../src/fleet.js');
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  // Defensive: never let any deferred path actually spawn claude.
  realLaunch = registry.launch;
  registry.launch = () => {
    throw new Error('registry.launch must not be called in fleet.test');
  };
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

// ── git fixture helper ──────────────────────────────────────────────────────
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-repo-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

// ── seeding helpers ─────────────────────────────────────────────────────────
function makeProject(patch: Partial<any> = {}): any {
  const { paused, ...createPatch } = patch;
  const p = projectsRepo.createProject({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    rootDir: makeRepo('p'),
    defaultBranch: 'master',
    wipLimit: 10,
    ...createPatch,
  });
  if (paused) return projectsRepo.updateProject(p.id, { paused: true });
  return p;
}

/** A Ready card for a project (so the project "demands" the pool). */
function makeReadyCard(projectId: string): any {
  return kanbanRepo.createTask({ projectId, title: 'card', column: 'Ready' });
}

let runSeq = 0;
const baseRun = (projectId: string | null, overrides: Partial<any> = {}): any => ({
  id: `run-${++runSeq}`,
  sessionId: `run-${runSeq}`,
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
  startedAt: Date.now(),
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
  lastActivity: Date.now(),
  ...overrides,
});

/** Persist a live PM run (projectId set, campaignId null, non-terminal) for `projectId`. */
function seedLiveRun(projectId: string, overrides: Partial<any> = {}): any {
  const r = baseRun(projectId, overrides);
  repo.upsertRun(r);
  return r;
}

/** Wipe all rows so each test starts clean (registry.listRuns reads the DB; repo is source of truth). */
function resetAll() {
  for (const r of repo.listRuns()) repo.deleteRun(r.id);
  for (const p of projectsRepo.listProjects()) {
    for (const c of kanbanRepo.listTasks(p.id)) kanbanRepo.deleteTask(c.id);
    projectsRepo.deleteProject(p.id);
  }
  // reset config to defaults
  fleet.fleetRepo.set({ ...fleet.DEFAULT_FLEET_CONFIG });
}

beforeEach(() => {
  resetAll();
});

// ════════════════════════════════════════════════════════════════════════════
// fleetRepo / DEFAULT_FLEET_CONFIG merge
// ════════════════════════════════════════════════════════════════════════════
describe('fleetRepo — single-row config merged over DEFAULT_FLEET_CONFIG', () => {
  it('returns DEFAULT_FLEET_CONFIG when nothing is stored (after a fresh wipe writes defaults)', () => {
    const cfg = fleet.fleetRepo.get();
    expect(cfg.reserveSlotsForNonPm).toBe(fleet.DEFAULT_FLEET_CONFIG.reserveSlotsForNonPm);
    expect(cfg.fleetSpendCeilingUsd).toBe(fleet.DEFAULT_FLEET_CONFIG.fleetSpendCeilingUsd);
  });

  it('merges a partial stored config over the defaults', () => {
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 5 } as any);
    const cfg = fleet.fleetRepo.get();
    expect(cfg.reserveSlotsForNonPm).toBe(5);
    // fleetSpendCeilingUsd absent from the stored partial → falls back to the default (null).
    expect(cfg.fleetSpendCeilingUsd).toBe(fleet.DEFAULT_FLEET_CONFIG.fleetSpendCeilingUsd);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateFleetConfig — clamp + 400-on-invalid (mirrors config.ts validateConfig)
// ════════════════════════════════════════════════════════════════════════════
describe('validateFleetConfig — validate + clamp', () => {
  it('fills missing keys from defaults', () => {
    const v = fleet.validateFleetConfig({});
    expect(v).toEqual(fleet.DEFAULT_FLEET_CONFIG);
  });

  it('accepts a null spend ceiling and a non-negative reserve', () => {
    const v = fleet.validateFleetConfig({ reserveSlotsForNonPm: 3, fleetSpendCeilingUsd: null });
    expect(v).toEqual({ reserveSlotsForNonPm: 3, fleetSpendCeilingUsd: null });
  });

  it('accepts a non-negative numeric spend ceiling', () => {
    const v = fleet.validateFleetConfig({ fleetSpendCeilingUsd: 12.5 });
    expect(v.fleetSpendCeilingUsd).toBe(12.5);
  });

  it('rejects a negative reserve', () => {
    expect(() => fleet.validateFleetConfig({ reserveSlotsForNonPm: -1 })).toThrow();
  });

  it('rejects a non-integer reserve', () => {
    expect(() => fleet.validateFleetConfig({ reserveSlotsForNonPm: 1.5 })).toThrow();
  });

  it('rejects a negative spend ceiling', () => {
    expect(() => fleet.validateFleetConfig({ fleetSpendCeilingUsd: -3 })).toThrow();
  });

  it('rejects a non-finite spend ceiling', () => {
    expect(() => fleet.validateFleetConfig({ fleetSpendCeilingUsd: Number.POSITIVE_INFINITY })).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fair-share quota math (the load-bearing piece) — observed via fleetStatus().quota
// ════════════════════════════════════════════════════════════════════════════
describe('fair-share quota math — two projects, priorities, a small global cap', () => {
  it('splits the pool evenly between two equal-priority demanding projects', () => {
    registry.config.maxConcurrentRuns = 6;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    const b = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    makeReadyCard(b.id);

    const st = fleet.fleetStatus();
    expect(st.pool).toBe(6);
    const qa = st.projects.find((p: any) => p.projectId === a.id)!.quota;
    const qb = st.projects.find((p: any) => p.projectId === b.id)!.quota;
    expect(qa).toBe(3);
    expect(qb).toBe(3);
    expect(qa + qb).toBe(6); // apportionment sums to the pool exactly
  });

  it('weights the pool by (priority + 1): priority 3 vs priority 0 over pool 8 → 6 / 2', () => {
    // weights: hi = 3+1 = 4, lo = 0+1 = 1 → total 5. pool 8.
    // hi exact = 8*4/5 = 6.4 → floor 6; lo exact = 8*1/5 = 1.6 → floor 1 (with floor-1 guarantee).
    // assigned 7, leftover 1 → goes to the largest remainder (lo .6 > hi .4) → lo 2. Final 6 / 2.
    registry.config.maxConcurrentRuns = 8;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const hi = makeProject({ priority: 3 });
    const lo = makeProject({ priority: 0 });
    makeReadyCard(hi.id);
    makeReadyCard(lo.id);

    const st = fleet.fleetStatus();
    expect(st.pool).toBe(8);
    const qhi = st.projects.find((p: any) => p.projectId === hi.id)!.quota;
    const qlo = st.projects.find((p: any) => p.projectId === lo.id)!.quota;
    expect(qhi).toBe(6);
    expect(qlo).toBe(2);
    expect(qhi + qlo).toBe(8);
  });

  it('guarantees a floor of 1 slot to a low-priority demander when pool >= #demanders', () => {
    // pool 2, weights hi=10+1=11, lo=0+1=1 → total 12. lo exact = 2/12 = .166 → floor 0, bumped to 1.
    // hi floor = floor(2*11/12)=floor(1.83)=1, but assigned would be 2 → leftover 0. Final hi 1 / lo 1.
    registry.config.maxConcurrentRuns = 2;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const hi = makeProject({ priority: 10 });
    const lo = makeProject({ priority: 0 });
    makeReadyCard(hi.id);
    makeReadyCard(lo.id);

    const st = fleet.fleetStatus();
    expect(st.pool).toBe(2);
    const qhi = st.projects.find((p: any) => p.projectId === hi.id)!.quota;
    const qlo = st.projects.find((p: any) => p.projectId === lo.id)!.quota;
    expect(qlo).toBe(1); // not starved
    expect(qhi).toBe(1);
    expect(qhi + qlo).toBe(2);
  });

  it('never starves a demander when bumped floors over-commit the pool (pool == #demanders, skewed weights)', () => {
    // pool 3, 3 demanders. weights: A=10+1=11, B=C=0+1=1 → total 13.
    // exact: A=33/13=2.54→floor 2; B,C=3/13=0.23→floor 0, each bumped to 1 (floor guarantee).
    // assigned 4 > pool 3 → leftover -1. The trim MUST come from A (above the floor), NOT from a
    // floored-to-1 B/C — else a demander is starved to 0 despite pool >= #demanders. Final 1/1/1.
    registry.config.maxConcurrentRuns = 3;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 10 });
    const b = makeProject({ priority: 0 });
    const c = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    makeReadyCard(b.id);
    makeReadyCard(c.id);

    const st = fleet.fleetStatus();
    expect(st.pool).toBe(3);
    const q = (id: string) => st.projects.find((p: any) => p.projectId === id)!.quota;
    expect(q(a.id)).toBeGreaterThanOrEqual(1);
    expect(q(b.id)).toBeGreaterThanOrEqual(1); // NOT starved by the over-commit trim
    expect(q(c.id)).toBeGreaterThanOrEqual(1); // NOT starved by the over-commit trim
    expect(q(a.id) + q(b.id) + q(c.id)).toBe(3); // apportionment still sums to the pool
  });

  it('a non-demanding (no Ready cards, no live runs) project gets quota 0', () => {
    registry.config.maxConcurrentRuns = 4;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const active = makeProject({ priority: 0 });
    const idle = makeProject({ priority: 5 }); // high priority but NO demand
    makeReadyCard(active.id);

    const st = fleet.fleetStatus();
    expect(st.projects.find((p: any) => p.projectId === active.id)!.quota).toBe(4);
    expect(st.projects.find((p: any) => p.projectId === idle.id)!.quota).toBe(0);
    expect(st.projects.find((p: any) => p.projectId === idle.id)!.demanding).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// tryAdmit — admits under quota, denies over quota
// ════════════════════════════════════════════════════════════════════════════
describe('tryAdmit — admission under / over fair-share quota', () => {
  it('admits a demanding project that is under its quota', () => {
    registry.config.maxConcurrentRuns = 6;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    const b = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    makeReadyCard(b.id);
    // quota of each is 3; a has 0 live PM runs → admit.
    expect(fleet.tryAdmit(a.id)).toBe(true);
  });

  it('denies a project that is AT its fair-share quota', () => {
    registry.config.maxConcurrentRuns = 6;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    const b = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    makeReadyCard(b.id);
    // a quota is 3; seed 3 live PM runs for a → at quota → deny.
    seedLiveRun(a.id);
    seedLiveRun(a.id);
    seedLiveRun(a.id);
    expect(fleet.tryAdmit(a.id)).toBe(false);
    // b is still under its own quota (0 live) → admit.
    expect(fleet.tryAdmit(b.id)).toBe(true);
  });

  it('campaign-worker runs (campaignId set) do NOT count against a project PM quota', () => {
    registry.config.maxConcurrentRuns = 2;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    // a sole demander → quota 2. Seed 2 CAMPAIGN runs (campaignId set): they escape the PM count.
    seedLiveRun(a.id, { campaignId: 'camp-1' });
    seedLiveRun(a.id, { campaignId: 'camp-2' });
    // PM-live count for a is still 0 → under quota → admit.
    expect(fleet.tryAdmit(a.id)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reserveSlotsForNonPm — slots withheld from the PM pool
// ════════════════════════════════════════════════════════════════════════════
describe('reserveSlotsForNonPm — slots withheld from the PM pool', () => {
  it('shrinks the PM pool by the reserve, lowering quotas', () => {
    registry.config.maxConcurrentRuns = 8;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 4, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    makeReadyCard(a.id);

    const st = fleet.fleetStatus();
    expect(st.pool).toBe(4); // 8 - 4 reserved
    expect(st.projects.find((p: any) => p.projectId === a.id)!.quota).toBe(4);
  });

  it('denies admission once the reserve consumes the whole concurrency cap (pool 0)', () => {
    registry.config.maxConcurrentRuns = 2;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 2, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    expect(fleet.fleetStatus().pool).toBe(0);
    expect(fleet.tryAdmit(a.id)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// fleet spend ceiling — daily window, repo.spendSince(startOfToday)
// ════════════════════════════════════════════════════════════════════════════
describe('fleet spend ceiling — denies when daily spend is at/over the ceiling', () => {
  it('admits when daily spend is under the ceiling', () => {
    registry.config.maxConcurrentRuns = 6;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: 50 });
    const a = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    // a completed run today that spent $10 (well under $50).
    repo.upsertRun(baseRun(a.id, { status: 'completed', endedAt: Date.now(), costUsd: 10 }));
    expect(fleet.tryAdmit(a.id)).toBe(true);
    expect(fleet.fleetStatus().spendExceeded).toBe(false);
  });

  it('denies every project once daily fleet spend reaches the ceiling', () => {
    registry.config.maxConcurrentRuns = 6;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: 20 });
    const a = makeProject({ priority: 0 });
    const b = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    makeReadyCard(b.id);
    // two completed runs today summing to $25 ≥ $20 ceiling.
    repo.upsertRun(baseRun(a.id, { status: 'completed', endedAt: Date.now(), costUsd: 15 }));
    repo.upsertRun(baseRun(b.id, { status: 'completed', endedAt: Date.now(), costUsd: 10 }));
    expect(fleet.tryAdmit(a.id)).toBe(false);
    expect(fleet.tryAdmit(b.id)).toBe(false);
    const st = fleet.fleetStatus();
    expect(st.spendTodayUsd).toBeGreaterThanOrEqual(20);
    expect(st.spendExceeded).toBe(true);
  });

  it('a null ceiling never gates on spend', () => {
    registry.config.maxConcurrentRuns = 6;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 0, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    repo.upsertRun(baseRun(a.id, { status: 'completed', endedAt: Date.now(), costUsd: 10_000 }));
    expect(fleet.tryAdmit(a.id)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Routes — on a LOCAL Fastify instance (NOT buildServer); register ONLY fleet routes
// ════════════════════════════════════════════════════════════════════════════
describe('fleet routes — GET/PUT /api/fleet/config + GET /api/fleet/status', () => {
  let app: any;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    app = Fastify();
    fleet.registerFleetRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/fleet/config returns the merged config', async () => {
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 1, fleetSpendCeilingUsd: 99 });
    const res = await app.inject({ method: 'GET', url: '/api/fleet/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reserveSlotsForNonPm).toBe(1);
    expect(body.fleetSpendCeilingUsd).toBe(99);
  });

  it('PUT /api/fleet/config validates + clamps + persists', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/fleet/config',
      payload: { reserveSlotsForNonPm: 3, fleetSpendCeilingUsd: 42 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reserveSlotsForNonPm).toBe(3);
    expect(res.json().fleetSpendCeilingUsd).toBe(42);
    // persisted
    expect(fleet.fleetRepo.get().reserveSlotsForNonPm).toBe(3);
  });

  it('PUT /api/fleet/config rejects an invalid value with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/fleet/config',
      payload: { reserveSlotsForNonPm: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('GET /api/fleet/status returns a live allocation snapshot', async () => {
    registry.config.maxConcurrentRuns = 5;
    fleet.fleetRepo.set({ reserveSlotsForNonPm: 1, fleetSpendCeilingUsd: null });
    const a = makeProject({ priority: 0 });
    makeReadyCard(a.id);
    const res = await app.inject({ method: 'GET', url: '/api/fleet/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxConcurrentRuns).toBe(5);
    expect(body.pool).toBe(4); // 5 - 1 reserved
    expect(Array.isArray(body.projects)).toBe(true);
    const row = body.projects.find((p: any) => p.projectId === a.id);
    expect(row).toBeTruthy();
    expect(row.quota).toBe(4);
    expect(row.demanding).toBe(true);
  });
});
