/**
 * Fleet-level cross-project scheduler (v2 spec §4 #7) — ADMISSION ONLY (no preemption).
 *
 * A scheduler ABOVE the per-project PmEngine (pm.ts). The PM's per-project gate (WIP limit,
 * project budget ceiling, pause) decides whether a project WANTS to launch a card; this module
 * decides whether the FLEET as a whole will admit one more PM run right now, so the single global
 * concurrency pool (registry.config.maxConcurrentRuns) is fair-shared across projects by priority
 * and the daily fleet spend stays under a ceiling.
 *
 * The integration point is one boolean gate, `tryAdmit(projectId)`, that the PM launch path calls
 * just before `registry.launch(...)`. It is admission-only: a project already over its fair-share
 * quota is simply not admitted (its card stays Ready and is retried on the next tick) — running runs
 * are NEVER preempted/killed.
 *
 * ── Counting model ──────────────────────────────────────────────────────────────
 * "PM-live runs" are non-terminal runs that belong to a project's PM build/fix path: they carry a
 * `projectId` and `campaignId === null` (campaigns own runs WITH a campaignId — pm.ts partition).
 * Campaign workers (#4) carry a `campaignId`, so they escape this count BY DESIGN — they are
 * balanced via `reserveSlotsForNonPm` (slots held back from the PM pool). See spec §8 risk #7.
 *
 * ── Fair-share quota ─────────────────────────────────────────────────────────────
 * pool = max(0, maxConcurrentRuns - reserveSlotsForNonPm)  ← slots available to PM runs.
 * A project is "demanding" if it currently wants the pool: it has ≥1 live PM run OR ≥1 Ready card,
 * and is not paused. Each demanding project gets weight (priority + 1). Quotas are apportioned
 * over `pool` by weight using largest-remainder (Hamilton) apportionment so they sum to exactly
 * `pool` and are fully deterministic, with a floor of 1 per demanding project when pool ≥ #demanding
 * (so a low-priority project is never starved to a 0 quota while higher-priority work runs).
 *
 * Self-contained: owns the single-row `fleet_config` JSON table (scheduler.ts single-row pattern)
 * and exposes `fleetRepo` (get merged over DEFAULT_FLEET_CONFIG), `tryAdmit`, `fleetStatus`, and
 * `registerFleetRoutes(app)`. It only READS pm/registry/projects/kanban helpers.
 */
import type { FastifyInstance } from 'fastify';
import type { FleetConfig, FleetProjectStatus, FleetStatus, Project } from '@fleet/shared';
import db, { repo } from './db.js';
import { registry } from './registry.js';
import { projectsRepo } from './projects.js';
import { kanbanRepo } from './kanban.js';

// ── defaults ──────────────────────────────────────────────────────────────────
/** v2 §4 #7 defaults. reserveSlotsForNonPm defaults to 0 (NOT 2): the reserve is a soft hold-back of
 *  PM slots so campaign workers (#4) aren't fully crowded out — but campaigns are an opt-in advanced
 *  feature, so a non-zero default would silently tax single-project PM throughput (e.g. 8→6) for the
 *  common no-campaign case AND widen the deadlock surface (a non-zero default reserve colliding with a
 *  lowered global maxConcurrentRuns). Default 0 = full PM pool; users running campaigns raise it. No
 *  fleet spend ceiling unless configured (null = no fleet-wide cap). PM-pool = maxConcurrentRuns -
 *  reserveSlotsForNonPm. */
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  reserveSlotsForNonPm: 0,
  fleetSpendCeilingUsd: null,
};

// ── single-row config table (scheduler.ts single-row pattern) ───────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS fleet_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
`);

const getConfigStmt = db.prepare('SELECT data FROM fleet_config WHERE id = 1');
const setConfigStmt = db.prepare(
  'INSERT INTO fleet_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = ?',
);

// ── validation / clamp (mirrors config.ts validateConfig: clamp + DEFAULT merge) ──
/**
 * Validate & clamp an incoming FleetConfig before it governs admission. Missing keys fall back to
 * DEFAULT_FLEET_CONFIG (so a partial PUT never leaves a field undefined); a present-but-invalid
 * value throws a 400. Unknown keys are ignored. `fleetSpendCeilingUsd` accepts null (= no ceiling)
 * or a finite non-negative number. `reserveSlotsForNonPm` is a non-negative integer (0..100).
 */
export function validateFleetConfig(input: unknown): FleetConfig {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('fleet config must be an object'), { statusCode: 400 });
  }
  const i = input as Record<string, unknown>;
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

  let reserveSlotsForNonPm = DEFAULT_FLEET_CONFIG.reserveSlotsForNonPm;
  if (i.reserveSlotsForNonPm !== undefined) {
    const v = i.reserveSlotsForNonPm;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('reserveSlotsForNonPm must be a finite number');
    if (!Number.isInteger(v)) throw bad('reserveSlotsForNonPm must be an integer');
    if (v < 0) throw bad('reserveSlotsForNonPm must be >= 0');
    if (v > 100) throw bad('reserveSlotsForNonPm must be <= 100');
    reserveSlotsForNonPm = v;
  }

  let fleetSpendCeilingUsd = DEFAULT_FLEET_CONFIG.fleetSpendCeilingUsd;
  if (i.fleetSpendCeilingUsd !== undefined) {
    const v = i.fleetSpendCeilingUsd;
    if (v === null) {
      fleetSpendCeilingUsd = null;
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw bad('fleetSpendCeilingUsd must be a non-negative number or null');
    } else if (v < 0) {
      throw bad('fleetSpendCeilingUsd must be >= 0');
    } else {
      fleetSpendCeilingUsd = v;
    }
  }

  // Cross-config invariant (deadlock guard, H9 class): the PM pool is
  // `max(0, maxConcurrentRuns - reserveSlotsForNonPm)`. If the reserve swallows the entire global
  // concurrency pool, the PM pool is 0 and EVERY card stays Ready forever with no surfaced error.
  // Reject it here (validateFleetConfig can read registry.config) rather than silently deadlocking.
  // tryAdmit still floors the pool at 0 so a config written straight via fleetRepo.set (bypassing
  // this validator) degrades to "admit nothing" instead of going negative.
  const maxRuns = registry.config.maxConcurrentRuns;
  if (reserveSlotsForNonPm >= maxRuns) {
    throw bad(
      `reserveSlotsForNonPm (${reserveSlotsForNonPm}) must be < maxConcurrentRuns (${maxRuns}); ` +
        'otherwise the PM scheduler pool is 0 and every card stalls in Ready. ' +
        'Lower the reserve or raise maxConcurrentRuns.',
    );
  }

  return { reserveSlotsForNonPm, fleetSpendCeilingUsd };
}

/**
 * Mirror of the validateFleetConfig cross-check for the OTHER write path (the DC §10 residual):
 * lowering the GLOBAL maxConcurrentRuns (PUT /api/config) at/below the existing fleet reserve
 * zeroes the PM pool just as surely as raising the reserve does. config.ts can't read fleet
 * state (config↔registry↔fleet import cycle), so the /api/config route calls this with the
 * post-clamp cap before applying. Throws 400; direct repo.setConfig writes remain covered only
 * by the loud fleetStatus.deadlocked signal.
 */
export function assertCapAboveReserve(nextMaxConcurrentRuns: number): void {
  const reserve = fleetRepo.get().reserveSlotsForNonPm;
  if (nextMaxConcurrentRuns <= reserve) {
    throw Object.assign(
      new Error(
        `maxConcurrentRuns (${nextMaxConcurrentRuns}) must be > reserveSlotsForNonPm (${reserve}); ` +
          'otherwise the PM scheduler pool is 0 and every card stalls in Ready. ' +
          'Lower the fleet reserve first (PUT /api/fleet/config) or keep a higher cap.',
      ),
      { statusCode: 400 },
    );
  }
}

export const fleetRepo = {
  /** The stored fleet config merged over DEFAULT_FLEET_CONFIG (so a missing/partial row is whole). */
  get(): FleetConfig {
    const row = getConfigStmt.get() as { data: string } | undefined;
    if (!row) return { ...DEFAULT_FLEET_CONFIG };
    try {
      return { ...DEFAULT_FLEET_CONFIG, ...(JSON.parse(row.data) as Partial<FleetConfig>) };
    } catch {
      return { ...DEFAULT_FLEET_CONFIG };
    }
  },
  /** Persist a (validated) fleet config. */
  set(cfg: FleetConfig): void {
    const json = JSON.stringify(cfg);
    setConfigStmt.run(json, json);
  },
};

// ── time window ─────────────────────────────────────────────────────────────────
/** Local midnight (matches registry.spend()'s daily window — v2 §4 #7 daily-spend decision). */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── counting ─────────────────────────────────────────────────────────────────────
const TERMINAL = new Set(['completed', 'failed', 'killed']);

/**
 * Count of non-terminal PM runs for a project: runs with this projectId and campaignId === null
 * (campaigns own campaignId-bearing runs — pm.ts partition). Campaign workers escape this count by
 * design and are accounted for only via reserveSlotsForNonPm (spec §8 #7).
 */
function pmLiveCountFor(projectId: string): number {
  let n = 0;
  for (const r of registry.listRuns()) {
    if (r.projectId === projectId && r.campaignId == null && !TERMINAL.has(r.status)) n++;
  }
  return n;
}

/** Map of projectId → live PM run count, over every run the registry currently knows. */
function pmLiveCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of registry.listRuns()) {
    if (r.projectId != null && r.campaignId == null && !TERMINAL.has(r.status)) {
      m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1);
    }
  }
  return m;
}

/** Map of projectId → cumulative spend (USD) across EVERY run scoped to it (PM + campaign, live +
 *  terminal). Mirrors pm.ts's private projectSpend(): one pass over registry.listRuns() — surfaced
 *  read-only on the /fleet status snapshot. */
function projectSpendCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of registry.listRuns()) {
    if (r.projectId != null) m.set(r.projectId, (m.get(r.projectId) ?? 0) + (r.costUsd || 0));
  }
  return m;
}

// ── fair-share apportionment ───────────────────────────────────────────────────
interface DemandRow {
  project: Project;
  weight: number; // priority + 1
  live: number; // current live PM runs
  ready: number; // Ready cards
}

/** Projects that currently want the PM pool: not paused AND (≥1 live PM run OR ≥1 Ready card). */
function demandingProjects(liveCounts: Map<string, number>): DemandRow[] {
  const rows: DemandRow[] = [];
  for (const project of projectsRepo.listProjects()) {
    if (project.paused) continue;
    const live = liveCounts.get(project.id) ?? 0;
    const ready = kanbanRepo.readyTasks(project.id).length;
    if (live + ready <= 0) continue;
    rows.push({ project, weight: Math.max(1, (project.priority ?? 0) + 1), live, ready });
  }
  return rows;
}

/**
 * Largest-remainder (Hamilton) apportionment of `pool` slots across demanding projects by weight.
 * Deterministic: ties in the fractional remainder are broken by priority DESC, then project id ASC.
 * When pool ≥ #demanding, every demanding project is floored to at least 1 slot (no starvation),
 * and the remaining slots are apportioned by weight. Returns projectId → quota.
 */
function computeQuotas(rows: DemandRow[], pool: number): Map<string, number> {
  const quotas = new Map<string, number>();
  if (rows.length === 0 || pool <= 0) {
    for (const r of rows) quotas.set(r.project.id, 0);
    return quotas;
  }

  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const guaranteeFloor = pool >= rows.length; // enough slots to give every demander at least 1

  // base = floor; track fractional remainder for largest-remainder distribution.
  const base = new Map<string, number>();
  const remainder: Array<{ id: string; frac: number; priority: number }> = [];
  let assigned = 0;
  for (const r of rows) {
    const exact = (pool * r.weight) / totalWeight;
    let floorVal = Math.floor(exact);
    if (guaranteeFloor && floorVal < 1) floorVal = 1; // floor of 1 so a demander isn't starved
    base.set(r.project.id, floorVal);
    assigned += floorVal;
    remainder.push({ id: r.project.id, frac: exact - Math.floor(exact), priority: r.project.priority ?? 0 });
  }

  // If the guaranteed floors over-committed the pool (pool barely ≥ #demanders but weights skew),
  // trim from the lowest-priority / smallest-remainder projects until we fit.
  let leftover = pool - assigned;
  if (leftover < 0) {
    // Trim the over-allocated projects to fit, but NEVER below the guaranteed floor: when
    // guaranteeFloor (pool >= #demanders) every demander must keep >= 1, so we only trim projects
    // above 1 (the sum of 1s = #demanders <= pool, so this always converges). Without this guard a
    // floored-to-1 project could be trimmed to 0 — starvation, contradicting the no-starve guarantee.
    const minFloor = guaranteeFloor ? 1 : 0;
    const trimOrder = [...remainder].sort(
      (a, b) => a.frac - b.frac || a.priority - b.priority || (a.id < b.id ? -1 : 1),
    );
    // Trim largest-allocation-first among the eligible so we don't get stuck unable to fit; iterate
    // until we fit (a project may be trimmed more than once while it stays above the floor).
    while (leftover < 0) {
      let trimmed = false;
      for (const t of trimOrder) {
        if (leftover >= 0) break;
        const cur = base.get(t.id)!;
        if (cur > minFloor) {
          base.set(t.id, cur - 1);
          leftover++;
          trimmed = true;
        }
      }
      if (!trimmed) break; // nothing left to trim above the floor (shouldn't happen when guaranteeFloor)
    }
  } else if (leftover > 0) {
    // distribute leftover slots by largest fractional remainder (ties: priority DESC, id ASC).
    const order = [...remainder].sort(
      (a, b) => b.frac - a.frac || b.priority - a.priority || (a.id < b.id ? -1 : 1),
    );
    let idx = 0;
    while (leftover > 0 && order.length > 0) {
      const t = order[idx % order.length];
      base.set(t.id, base.get(t.id)! + 1);
      leftover--;
      idx++;
    }
  }

  for (const r of rows) quotas.set(r.project.id, base.get(r.project.id) ?? 0);
  return quotas;
}

// ── admission gate ────────────────────────────────────────────────────────────
/**
 * Admission gate the PM launch path calls before launching a card's PM run for `projectId`.
 * Admits iff:
 *   1. the project is under its fair-share quota (live PM runs < quota), AND
 *   2. the daily fleet spend is under fleetSpendCeilingUsd (null ceiling ⇒ no spend gate).
 * Admission-only: a denial leaves the card Ready for retry — nothing is preempted. Never throws.
 */
export function tryAdmit(projectId: string): boolean {
  try {
    const cfg = fleetRepo.get();

    // spend gate first (cheapest, fleet-wide): daily window, repo.spendSince(startOfToday).
    if (cfg.fleetSpendCeilingUsd != null) {
      const todaySpend = spendToday();
      if (todaySpend >= cfg.fleetSpendCeilingUsd) return false;
    }

    const maxConcurrent = registry.config?.maxConcurrentRuns ?? 0;
    const pool = Math.max(0, maxConcurrent - cfg.reserveSlotsForNonPm);
    if (pool <= 0) return false; // no PM slots at all

    const liveCounts = pmLiveCounts();
    const rows = demandingProjects(liveCounts);

    // The admitting project must itself be demanding (it's about to launch). If it isn't already in
    // the demand set (e.g. its Ready card was just consumed), include it with its current weight so
    // it gets a fair quota slice rather than a 0 quota.
    if (!rows.some((r) => r.project.id === projectId)) {
      const project = projectsRepo.getProject(projectId);
      if (!project) return false;
      if (project.paused) return false;
      rows.push({
        project,
        weight: Math.max(1, (project.priority ?? 0) + 1),
        live: liveCounts.get(projectId) ?? 0,
        ready: 0,
      });
    }

    const quotas = computeQuotas(rows, pool);
    const quota = quotas.get(projectId) ?? 0;
    const live = pmLiveCountFor(projectId);
    return live < quota;
  } catch {
    // a scheduler fault must never wedge the PM launch path; fail OPEN is unsafe (would bypass the
    // ceiling), so fail CLOSED — the card stays Ready and is retried on the next tick.
    return false;
  }
}

/** Daily fleet spend (USD) — repo.spendSince(startOfToday) semantics, matching the Guardrails window
 *  (registry.spend() uses the same `repo.spendSince(startOfToday())`). */
function spendToday(): number {
  return repo.spendSince(startOfToday());
}

// ── status snapshot ─────────────────────────────────────────────────────────────
// FleetStatus / FleetProjectStatus moved to @fleet/shared so the web client imports the same
// contract instead of redeclaring it (it had drifted out of typecheck coverage — DC §10).
// `deadlocked` semantics: pool 0 (reserve >= maxConcurrentRuns) while ≥1 project demands it.
// Both PUT paths now reject that state (validateFleetConfig here; assertCapAboveReserve for
// /api/config), so the flag remains the loud backstop for direct repo writes only.

/** Live allocation snapshot for GET /api/fleet/status and the /fleet UI page. */
export function fleetStatus(): FleetStatus {
  const cfg = fleetRepo.get();
  const maxConcurrentRuns = registry.config?.maxConcurrentRuns ?? 0;
  const pool = Math.max(0, maxConcurrentRuns - cfg.reserveSlotsForNonPm);

  const liveCounts = pmLiveCounts();
  const rows = demandingProjects(liveCounts);
  const quotas = computeQuotas(rows, pool);
  const demandById = new Map(rows.map((r) => [r.project.id, r]));
  const spendByProject = projectSpendCounts();

  let pmLiveTotal = 0;
  for (const v of liveCounts.values()) pmLiveTotal += v;

  const spend = spendToday();

  const projects: FleetProjectStatus[] = projectsRepo.listProjects().map((p) => {
    const d = demandById.get(p.id);
    const live = liveCounts.get(p.id) ?? 0;
    const ready = kanbanRepo.readyTasks(p.id).length;
    return {
      projectId: p.id,
      name: p.name,
      priority: p.priority ?? 0,
      paused: !!p.paused,
      weight: d ? d.weight : 0,
      liveRuns: live,
      readyCards: ready,
      quota: quotas.get(p.id) ?? 0,
      demanding: !!d,
      wipLimit: p.wipLimit,
      inProgress: kanbanRepo.inProgressCount(p.id),
      projectSpend: spendByProject.get(p.id) ?? 0,
    };
  });

  return {
    config: cfg,
    maxConcurrentRuns,
    pool,
    pmLiveTotal,
    spendTodayUsd: spend,
    spendCeilingUsd: cfg.fleetSpendCeilingUsd,
    spendExceeded: cfg.fleetSpendCeilingUsd != null && spend >= cfg.fleetSpendCeilingUsd,
    // pool 0 + at least one demanding project = silent stall; make it explicit for the UI.
    deadlocked: pool <= 0 && rows.length > 0,
    projects,
  };
}

// ── routes ──────────────────────────────────────────────────────────────────────
export function registerFleetRoutes(app: FastifyInstance) {
  // Current fleet config (merged over defaults).
  app.get('/api/fleet/config', async () => fleetRepo.get());

  // Update fleet config (validate + clamp like config.ts validateConfig). A partial PUT merges
  // over the defaults; an invalid value → 400.
  app.put('/api/fleet/config', async (req, reply) => {
    try {
      const valid = validateFleetConfig((req.body as unknown) ?? {});
      fleetRepo.set(valid);
      return valid;
    } catch (e: any) {
      reply.code(e?.statusCode ?? 400);
      return { error: e?.message ?? 'invalid fleet config' };
    }
  });

  // Live allocation snapshot.
  app.get('/api/fleet/status', async () => fleetStatus());
}
