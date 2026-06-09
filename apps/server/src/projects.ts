/**
 * Projects (agent-PM / Kanban feature — W0 foundation; spec
 * docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md §4 + §8).
 *
 * A project is a first-class git-repo root that scopes runs/campaigns/kanban cards
 * and carries the executor policy (auto-merge, WIP limit, budget ceiling, pause).
 * Self-contained Lane-B module: owns its `projects` table via the shared sqlite
 * handle and exposes a `projectsRepo` other modules (kanban.ts / pm.ts / git.ts /
 * fileview.ts) read from, plus `registerProjectsRoutes(app)`.
 *
 * `root_dir` is the trust anchor for fileview.ts's realpath-containment guard and is
 * git-validated at creation. It (and `name`) are therefore IMMUTABLE — the PUT route
 * only toggles the executor-policy fields.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Project, CreateProjectRequest, MergeMode, GitHealth } from '@fleet/shared';
import db from './db.js';
import { initRepo } from './git.js';
import { resolveRemote, ghAuthStatus } from './gh.js';

const execFileAsync = promisify(execFile);

// ── schema (idempotent) ───────────────────────────────────────────────────────
// CREATE-body carries every column (so a fresh DB never relies on the ALTER loop), and the
// ALTER loop below upgrades pre-existing DBs. (§3.1: projects ALTERs live HERE, not in db.ts —
// db.ts's top-level loop runs before this CREATE TABLE, so a `no such table` would crash a fresh DB.)
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_dir TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  auto_merge INTEGER NOT NULL DEFAULT 0,
  default_validation_command TEXT,
  wip_limit INTEGER NOT NULL DEFAULT 3,
  budget_ceiling_usd REAL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  editing_enabled INTEGER NOT NULL DEFAULT 0,
  commit_author_name TEXT,
  commit_author_email TEXT,
  merge_mode TEXT NOT NULL DEFAULT 'local',
  remote_name TEXT NOT NULL DEFAULT 'origin',
  push_enabled INTEGER NOT NULL DEFAULT 0,
  server_start_command TEXT,
  health_check_url TEXT,
  health_check_regex TEXT,
  readiness_timeout_ms INTEGER,
  port_range_start INTEGER,
  port_range_end INTEGER,
  copy_env_from TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  resolve_conflicts INTEGER NOT NULL DEFAULT 0
);
`);

// idempotent migrations for v2 columns added after the v1 release (§3.1). Mirrors the db.ts loop:
// swallow ONLY the idempotent "duplicate column name"; rethrow any real DDL failure so it surfaces
// here rather than later as an opaque "no such column" at stmt-prepare time. This loop is SAFE on a
// fresh DB because it runs AFTER the CREATE TABLE above (unlike db.ts's top-level loop).
for (const ddl of [
  'ALTER TABLE projects ADD COLUMN editing_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE projects ADD COLUMN commit_author_name TEXT',
  'ALTER TABLE projects ADD COLUMN commit_author_email TEXT',
  "ALTER TABLE projects ADD COLUMN merge_mode TEXT NOT NULL DEFAULT 'local'",
  "ALTER TABLE projects ADD COLUMN remote_name TEXT NOT NULL DEFAULT 'origin'",
  'ALTER TABLE projects ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE projects ADD COLUMN server_start_command TEXT',
  'ALTER TABLE projects ADD COLUMN health_check_url TEXT',
  'ALTER TABLE projects ADD COLUMN health_check_regex TEXT',
  'ALTER TABLE projects ADD COLUMN readiness_timeout_ms INTEGER',
  'ALTER TABLE projects ADD COLUMN port_range_start INTEGER',
  'ALTER TABLE projects ADD COLUMN port_range_end INTEGER',
  'ALTER TABLE projects ADD COLUMN copy_env_from TEXT',
  'ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE projects ADD COLUMN resolve_conflicts INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(ddl);
  } catch (e: any) {
    if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
  }
}

// ── row mappers (snake_case ↔ camelCase, like db.ts) ──────────────────────────
function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    rootDir: row.root_dir,
    defaultBranch: row.default_branch,
    autoMerge: !!row.auto_merge,
    defaultValidationCommand: row.default_validation_command ?? null,
    wipLimit: row.wip_limit,
    budgetCeilingUsd: row.budget_ceiling_usd ?? null,
    paused: !!row.paused,
    createdAt: row.created_at,
    // ── v2 columns ──
    editingEnabled: !!row.editing_enabled,
    commitAuthorName: row.commit_author_name ?? null,
    commitAuthorEmail: row.commit_author_email ?? null,
    mergeMode: (row.merge_mode ?? 'local') as MergeMode,
    remoteName: row.remote_name ?? 'origin',
    pushEnabled: !!row.push_enabled,
    serverStartCommand: row.server_start_command ?? null,
    healthCheckUrl: row.health_check_url ?? null,
    healthCheckRegex: row.health_check_regex ?? null,
    readinessTimeoutMs: row.readiness_timeout_ms ?? null,
    portRangeStart: row.port_range_start ?? null,
    portRangeEnd: row.port_range_end ?? null,
    copyEnvFrom: row.copy_env_from ?? null,
    priority: row.priority ?? 0,
    resolveConflicts: !!row.resolve_conflicts,
  };
}

function projectToRow(p: Project) {
  return {
    id: p.id,
    name: p.name,
    root_dir: p.rootDir,
    default_branch: p.defaultBranch,
    auto_merge: p.autoMerge ? 1 : 0,
    default_validation_command: p.defaultValidationCommand ?? null,
    wip_limit: p.wipLimit,
    budget_ceiling_usd: p.budgetCeilingUsd ?? null,
    paused: p.paused ? 1 : 0,
    created_at: p.createdAt,
    // ── v2 columns ──
    editing_enabled: p.editingEnabled ? 1 : 0,
    commit_author_name: p.commitAuthorName ?? null,
    commit_author_email: p.commitAuthorEmail ?? null,
    merge_mode: p.mergeMode,
    remote_name: p.remoteName,
    push_enabled: p.pushEnabled ? 1 : 0,
    server_start_command: p.serverStartCommand ?? null,
    health_check_url: p.healthCheckUrl ?? null,
    health_check_regex: p.healthCheckRegex ?? null,
    readiness_timeout_ms: p.readinessTimeoutMs ?? null,
    port_range_start: p.portRangeStart ?? null,
    port_range_end: p.portRangeEnd ?? null,
    copy_env_from: p.copyEnvFrom ?? null,
    priority: p.priority,
    resolve_conflicts: p.resolveConflicts ? 1 : 0,
  };
}

// ── prepared statements ───────────────────────────────────────────────────────
const insertProjectStmt = db.prepare(`
INSERT INTO projects (id, name, root_dir, default_branch, auto_merge, default_validation_command,
  wip_limit, budget_ceiling_usd, paused, created_at,
  editing_enabled, commit_author_name, commit_author_email, merge_mode, remote_name, push_enabled,
  server_start_command, health_check_url, health_check_regex, readiness_timeout_ms,
  port_range_start, port_range_end, copy_env_from, priority, resolve_conflicts)
VALUES (@id, @name, @root_dir, @default_branch, @auto_merge, @default_validation_command,
  @wip_limit, @budget_ceiling_usd, @paused, @created_at,
  @editing_enabled, @commit_author_name, @commit_author_email, @merge_mode, @remote_name, @push_enabled,
  @server_start_command, @health_check_url, @health_check_regex, @readiness_timeout_ms,
  @port_range_start, @port_range_end, @copy_env_from, @priority, @resolve_conflicts)
`);
const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
const listProjectsStmt = db.prepare('SELECT * FROM projects ORDER BY created_at DESC');
const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');
const updateProjectStmt = db.prepare(`
UPDATE projects SET
  name=@name, root_dir=@root_dir, default_branch=@default_branch, auto_merge=@auto_merge,
  default_validation_command=@default_validation_command, wip_limit=@wip_limit,
  budget_ceiling_usd=@budget_ceiling_usd, paused=@paused,
  editing_enabled=@editing_enabled, commit_author_name=@commit_author_name,
  commit_author_email=@commit_author_email, merge_mode=@merge_mode, remote_name=@remote_name,
  push_enabled=@push_enabled, server_start_command=@server_start_command,
  health_check_url=@health_check_url, health_check_regex=@health_check_regex,
  readiness_timeout_ms=@readiness_timeout_ms, port_range_start=@port_range_start,
  port_range_end=@port_range_end, copy_env_from=@copy_env_from, priority=@priority,
  resolve_conflicts=@resolve_conflicts
WHERE id=@id
`);

/**
 * Fields a project may carry through `updateProject`. NOTE the route layer further
 * restricts which of these the client can set (never `name`/`rootDir`/`createdAt`).
 */
export interface ProjectPatch {
  defaultBranch?: string;
  autoMerge?: boolean;
  defaultValidationCommand?: string | null;
  wipLimit?: number;
  budgetCeilingUsd?: number | null;
  paused?: boolean;
  // ── v2 patchable fields ──
  editingEnabled?: boolean;
  commitAuthorName?: string | null;
  commitAuthorEmail?: string | null;
  mergeMode?: MergeMode;
  remoteName?: string;
  pushEnabled?: boolean;
  serverStartCommand?: string | null;
  healthCheckUrl?: string | null;
  healthCheckRegex?: string | null;
  readinessTimeoutMs?: number | null;
  portRangeStart?: number | null;
  portRangeEnd?: number | null;
  copyEnvFrom?: string | null;
  priority?: number;
  resolveConflicts?: boolean;
}

export const projectsRepo = {
  getProject(id: string): Project | null {
    const row = getProjectStmt.get(id);
    return row ? rowToProject(row) : null;
  },

  listProjects(): Project[] {
    return (listProjectsStmt.all() as any[]).map(rowToProject);
  },

  createProject(req: CreateProjectRequest): Project {
    const project: Project = {
      id: randomUUID(),
      name: req.name,
      rootDir: req.rootDir,
      defaultBranch: req.defaultBranch ?? 'main',
      autoMerge: req.autoMerge ?? false,
      defaultValidationCommand: req.defaultValidationCommand ?? null,
      wipLimit: req.wipLimit ?? 3,
      budgetCeilingUsd: req.budgetCeilingUsd ?? null,
      paused: false,
      createdAt: Date.now(),
      // ── v2 fields: optional in the request, defaulted to the v1-equivalent behavior ──
      editingEnabled: req.editingEnabled ?? false,
      commitAuthorName: req.commitAuthorName ?? null,
      commitAuthorEmail: req.commitAuthorEmail ?? null,
      mergeMode: req.mergeMode ?? 'local',
      remoteName: req.remoteName ?? 'origin',
      pushEnabled: req.pushEnabled ?? false,
      serverStartCommand: req.serverStartCommand ?? null,
      healthCheckUrl: req.healthCheckUrl ?? null,
      healthCheckRegex: req.healthCheckRegex ?? null,
      readinessTimeoutMs: req.readinessTimeoutMs ?? null,
      portRangeStart: req.portRangeStart ?? null,
      portRangeEnd: req.portRangeEnd ?? null,
      copyEnvFrom: req.copyEnvFrom ?? null,
      priority: req.priority ?? 0,
      resolveConflicts: req.resolveConflicts ?? false,
    };
    insertProjectStmt.run(projectToRow(project));
    return project;
  },

  /** Apply a partial patch (only provided keys change) and return the updated row. */
  updateProject(id: string, patch: ProjectPatch): Project {
    const current = this.getProject(id);
    if (!current) throw new Error(`project not found: ${id}`);
    const next: Project = {
      ...current,
      defaultBranch: patch.defaultBranch ?? current.defaultBranch,
      autoMerge: patch.autoMerge ?? current.autoMerge,
      defaultValidationCommand:
        patch.defaultValidationCommand !== undefined
          ? patch.defaultValidationCommand
          : current.defaultValidationCommand,
      wipLimit: patch.wipLimit ?? current.wipLimit,
      budgetCeilingUsd:
        patch.budgetCeilingUsd !== undefined ? patch.budgetCeilingUsd : current.budgetCeilingUsd,
      paused: patch.paused ?? current.paused,
      // ── v2 fields (nullable ones use the `!== undefined` form so an explicit null clears) ──
      editingEnabled: patch.editingEnabled ?? current.editingEnabled,
      commitAuthorName:
        patch.commitAuthorName !== undefined ? patch.commitAuthorName : current.commitAuthorName,
      commitAuthorEmail:
        patch.commitAuthorEmail !== undefined ? patch.commitAuthorEmail : current.commitAuthorEmail,
      mergeMode: patch.mergeMode ?? current.mergeMode,
      remoteName: patch.remoteName ?? current.remoteName,
      pushEnabled: patch.pushEnabled ?? current.pushEnabled,
      serverStartCommand:
        patch.serverStartCommand !== undefined ? patch.serverStartCommand : current.serverStartCommand,
      healthCheckUrl:
        patch.healthCheckUrl !== undefined ? patch.healthCheckUrl : current.healthCheckUrl,
      healthCheckRegex:
        patch.healthCheckRegex !== undefined ? patch.healthCheckRegex : current.healthCheckRegex,
      readinessTimeoutMs:
        patch.readinessTimeoutMs !== undefined ? patch.readinessTimeoutMs : current.readinessTimeoutMs,
      portRangeStart:
        patch.portRangeStart !== undefined ? patch.portRangeStart : current.portRangeStart,
      portRangeEnd: patch.portRangeEnd !== undefined ? patch.portRangeEnd : current.portRangeEnd,
      copyEnvFrom: patch.copyEnvFrom !== undefined ? patch.copyEnvFrom : current.copyEnvFrom,
      priority: patch.priority ?? current.priority,
      resolveConflicts: patch.resolveConflicts ?? current.resolveConflicts,
    };
    updateProjectStmt.run(projectToRow(next));
    return next;
  },

  deleteProject(id: string): void {
    // Only the projects row is owned here; kanban_tasks/runs/campaigns belong to
    // other modules and are intentionally not cascaded from this module (spec §3).
    deleteProjectStmt.run(id);
  },
};

/** The repo's current branch (HEAD short name), e.g. 'main' or 'master'. Fallback 'main'.
 *  Used so a new project's merge target matches the repo's ACTUAL default branch (older
 *  `git init` defaults to master) instead of assuming 'main' — found by the live PM E2E. */
async function detectDefaultBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD'], { timeout: 10000 });
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

/** True iff `dir` exists on disk and is a directory (used to separate "missing dir" — a bare 400 —
 *  from "exists but not a repo" — which can offer git init). */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** True iff `dir` is an absolute path that resolves to a git work tree. */
async function isGitWorkTree(dir: string): Promise<boolean> {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      timeout: 10000,
    });
    return stdout.trim() === 'true';
  } catch {
    // ENOENT (no git / missing dir), nonzero exit (not a repo), or timeout → not valid.
    return false;
  }
}

export function registerProjectsRoutes(app: FastifyInstance) {
  // ── list ────────────────────────────────────────────────────────────────────
  app.get('/api/projects', async () => projectsRepo.listProjects());

  // ── get one ───────────────────────────────────────────────────────────────────
  app.get('/api/projects/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const project = projectsRepo.getProject(id);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return project;
  });

  // ── git/remote readiness (v2 #2) ──────────────────────────────────────────────
  // Reports whether PR mode can work for this project: does the configured remote resolve (local
  // `git remote get-url`, network-free + credential-scrubbed), is the `gh` CLI installed and
  // authenticated, and is push enabled. The UI shows a one-line readiness check. Never throws —
  // every probe is the never-throw gh.ts/git.ts variety.
  app.get('/api/projects/:id/git/health', async (req, reply) => {
    const id = (req.params as any).id as string;
    const project = projectsRepo.getProject(id);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const remote = await resolveRemote(project.rootDir, project.remoteName);
    const auth = await ghAuthStatus(); // one call → both installed + authenticated
    const health: GitHealth = {
      remoteUrl: remote.url, // scrubbed in gh.ts
      remoteResolves: remote.resolves,
      ghInstalled: auth.installed,
      ghAuthOk: auth.authenticated,
      pushEnabled: project.pushEnabled,
    };
    return health;
  });

  // ── create ──────────────────────────────────────────────────────────────────
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body as any) ?? {};
    const name = String(body.name ?? '').trim();
    if (!name) {
      reply.code(400);
      return { error: 'name must be a non-empty string' };
    }
    const rootDir = typeof body.rootDir === 'string' ? body.rootDir : '';
    if (!rootDir || !path.isAbsolute(rootDir)) {
      reply.code(400);
      return { error: 'rootDir must be an absolute path' };
    }

    // Parse defaultBranch BEFORE any git-init side effect (an invalid request must never leave a
    // repo on disk). It's also the branch threaded into initRepo when initGit is set (SPEC #10
    // decision: branch from the form, default 'main'); the actual-branch detection fallback stays
    // BELOW the work-tree gate so it reads the just-init'd repo.
    let defaultBranch = body.defaultBranch !== undefined ? String(body.defaultBranch).trim() : undefined;
    if (defaultBranch !== undefined && !defaultBranch) {
      reply.code(400);
      return { error: 'defaultBranch must be a non-empty string when provided' };
    }

    // Validate the remaining optional fields BEFORE the work-tree gate too, so an invalid request
    // (e.g. a bad wipLimit) can never trigger the initGit side effect and leave a repo on disk.
    let wipLimit: number | undefined;
    if (body.wipLimit !== undefined) {
      if (!isPositiveInt(body.wipLimit)) {
        reply.code(400);
        return { error: 'wipLimit must be a positive integer' };
      }
      wipLimit = body.wipLimit;
    }
    let budgetCeilingUsd: number | null | undefined;
    if (body.budgetCeilingUsd !== undefined) {
      if (!isNullableNonNegNumber(body.budgetCeilingUsd)) {
        reply.code(400);
        return { error: 'budgetCeilingUsd must be a non-negative number or null' };
      }
      budgetCeilingUsd = body.budgetCeilingUsd;
    }
    let defaultValidationCommand: string | null | undefined;
    if (body.defaultValidationCommand !== undefined) {
      if (body.defaultValidationCommand !== null && typeof body.defaultValidationCommand !== 'string') {
        reply.code(400);
        return { error: 'defaultValidationCommand must be a string or null' };
      }
      defaultValidationCommand = body.defaultValidationCommand;
    }

    // ── v2 optional fields (validated BEFORE the work-tree gate, same as above, so an invalid
    //    request never triggers the initGit side effect). Parsed into a partial mirror appended to
    //    createReq below. Validation errors return 400 with the offending field. ──
    const v2 = parseProjectV2Fields(body);
    if (v2.error) {
      reply.code(400);
      return { error: v2.error };
    }
    // Cross-field rule (v2 #2): PR mode requires push to be enabled. Computed against the EFFECTIVE
    // create values (parsed field, else the create-default) — checked here rather than in the shared
    // stateless parser because PUT must compute it against the current row (see the PUT route).
    {
      const f = v2.fields ?? {};
      const effMergeMode = (f.mergeMode as MergeMode | undefined) ?? 'local';
      const effPushEnabled = (f.pushEnabled as boolean | undefined) ?? false;
      if (effMergeMode === 'pr' && !effPushEnabled) {
        reply.code(400);
        return { error: "mergeMode 'pr' requires pushEnabled to be true" };
      }
    }

    // ── git work-tree gate (v2 item #10: optional git init on attach) ──────────────
    // Three outcomes for a non-work-tree, kept distinct:
    //   • missing dir / not a directory → BARE { error } 400 (no init affordance possible).
    //   • exists, initGit !== true      → { error, code:'not_a_git_repo' } 400 so the UI can offer init.
    //   • exists, initGit === true      → run initRepo then proceed; an init failure → 500.
    if (!(await isGitWorkTree(rootDir))) {
      if (!(await isDirectory(rootDir))) {
        reply.code(400);
        return { error: 'rootDir must be an existing directory' };
      }
      if (body.initGit !== true) {
        reply.code(400);
        return { error: 'rootDir must be an existing git repository', code: 'not_a_git_repo' };
      }
      const init = await initRepo(rootDir, defaultBranch ?? 'main');
      if (!init.ok) {
        reply.code(500);
        return { error: `failed to initialize git repository: ${init.error ?? 'unknown error'}` };
      }
    }

    // If no branch was given, DETECT the repo's actual current branch (main vs master vs anything)
    // instead of assuming 'main'. Runs AFTER the gate so it reads the just-init'd repo.
    if (defaultBranch === undefined) defaultBranch = await detectDefaultBranch(rootDir);

    const createReq: CreateProjectRequest = {
      name,
      rootDir,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(body.autoMerge !== undefined ? { autoMerge: !!body.autoMerge } : {}),
      ...(defaultValidationCommand !== undefined ? { defaultValidationCommand } : {}),
      ...(wipLimit !== undefined ? { wipLimit } : {}),
      ...(budgetCeilingUsd !== undefined ? { budgetCeilingUsd } : {}),
      ...v2.fields,
    };
    const project = projectsRepo.createProject(createReq);
    return project;
  });

  // ── update (executor policy only; name/rootDir are immutable) ─────────────────
  app.put('/api/projects/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!projectsRepo.getProject(id)) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const body = (req.body as any) ?? {};
    const patch: ProjectPatch = {};

    if (body.defaultBranch !== undefined) {
      const b = String(body.defaultBranch).trim();
      if (!b) {
        reply.code(400);
        return { error: 'defaultBranch must be a non-empty string' };
      }
      patch.defaultBranch = b;
    }
    if (body.autoMerge !== undefined) {
      patch.autoMerge = !!body.autoMerge;
    }
    if (body.paused !== undefined) {
      patch.paused = !!body.paused;
    }
    if (body.wipLimit !== undefined) {
      if (!isPositiveInt(body.wipLimit)) {
        reply.code(400);
        return { error: 'wipLimit must be a positive integer' };
      }
      patch.wipLimit = body.wipLimit;
    }
    if (body.budgetCeilingUsd !== undefined) {
      if (!isNullableNonNegNumber(body.budgetCeilingUsd)) {
        reply.code(400);
        return { error: 'budgetCeilingUsd must be a non-negative number or null' };
      }
      patch.budgetCeilingUsd = body.budgetCeilingUsd;
    }
    if (body.defaultValidationCommand !== undefined) {
      if (body.defaultValidationCommand !== null && typeof body.defaultValidationCommand !== 'string') {
        reply.code(400);
        return { error: 'defaultValidationCommand must be a string or null' };
      }
      patch.defaultValidationCommand = body.defaultValidationCommand;
    }

    // ── v2 patchable fields (same validators as create; only provided keys change) ──
    const v2 = parseProjectV2Fields(body);
    if (v2.error) {
      reply.code(400);
      return { error: v2.error };
    }
    Object.assign(patch, v2.fields);

    // Cross-field rule (v2 #2): PR mode requires push enabled. Computed against the EFFECTIVE row
    // (current value overlaid with this patch) so a PUT that sets only `mergeMode:'pr'` against an
    // already push-enabled project is accepted, and one that disables push out from under PR mode is
    // rejected.
    const current = projectsRepo.getProject(id)!;
    const effMergeMode = (patch.mergeMode as MergeMode | undefined) ?? current.mergeMode;
    const effPushEnabled = patch.pushEnabled !== undefined ? patch.pushEnabled : current.pushEnabled;
    if (effMergeMode === 'pr' && !effPushEnabled) {
      reply.code(400);
      return { error: "mergeMode 'pr' requires pushEnabled to be true" };
    }

    return projectsRepo.updateProject(id, patch);
  });

  // ── delete ──────────────────────────────────────────────────────────────────
  app.delete('/api/projects/:id', async (req) => {
    const id = (req.params as any).id as string;
    projectsRepo.deleteProject(id);
    return { ok: true };
  });
}

// ── numeric validators ────────────────────────────────────────────────────────
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isNullableNonNegNumber(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}
function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isNullableNonNegInt(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Parse + validate the v2 project fields (shared by create + PUT). Returns either a partial of
 * provided, validated fields (camelCase — identical key/type shape for CreateProjectRequest AND
 * ProjectPatch) or an error string. Only keys PRESENT on the body are emitted, so unset fields keep
 * their create-default / current value. The route layer maps the partial straight onto its
 * createReq / patch object. Defaults for omitted keys are applied in projectsRepo.createProject.
 */
function parseProjectV2Fields(body: any): { fields: Record<string, unknown>; error?: undefined } | { error: string; fields?: undefined } {
  const f: Record<string, unknown> = {};

  // #1 — editing surface
  if (body.editingEnabled !== undefined) f.editingEnabled = !!body.editingEnabled;
  if (body.commitAuthorName !== undefined) {
    if (!isNullableString(body.commitAuthorName)) return { error: 'commitAuthorName must be a string or null' };
    f.commitAuthorName = body.commitAuthorName;
  }
  if (body.commitAuthorEmail !== undefined) {
    if (!isNullableString(body.commitAuthorEmail)) return { error: 'commitAuthorEmail must be a string or null' };
    f.commitAuthorEmail = body.commitAuthorEmail;
  }

  // #2 — remote git
  if (body.mergeMode !== undefined) {
    if (body.mergeMode !== 'local' && body.mergeMode !== 'pr') return { error: "mergeMode must be 'local' or 'pr'" };
    f.mergeMode = body.mergeMode;
  }
  if (body.remoteName !== undefined) {
    if (typeof body.remoteName !== 'string' || !body.remoteName.trim()) {
      return { error: 'remoteName must be a non-empty string' };
    }
    f.remoteName = body.remoteName;
  }
  if (body.pushEnabled !== undefined) f.pushEnabled = !!body.pushEnabled;

  // #5 — server-validation config
  if (body.serverStartCommand !== undefined) {
    if (!isNullableString(body.serverStartCommand)) return { error: 'serverStartCommand must be a string or null' };
    f.serverStartCommand = body.serverStartCommand;
  }
  if (body.healthCheckUrl !== undefined) {
    if (!isNullableString(body.healthCheckUrl)) return { error: 'healthCheckUrl must be a string or null' };
    f.healthCheckUrl = body.healthCheckUrl;
  }
  if (body.healthCheckRegex !== undefined) {
    if (!isNullableString(body.healthCheckRegex)) return { error: 'healthCheckRegex must be a string or null' };
    f.healthCheckRegex = body.healthCheckRegex;
  }
  if (body.readinessTimeoutMs !== undefined) {
    if (!isNullableNonNegInt(body.readinessTimeoutMs)) return { error: 'readinessTimeoutMs must be a non-negative integer or null' };
    f.readinessTimeoutMs = body.readinessTimeoutMs;
  }
  if (body.portRangeStart !== undefined) {
    if (!isNullableNonNegInt(body.portRangeStart)) return { error: 'portRangeStart must be a non-negative integer or null' };
    f.portRangeStart = body.portRangeStart;
  }
  if (body.portRangeEnd !== undefined) {
    if (!isNullableNonNegInt(body.portRangeEnd)) return { error: 'portRangeEnd must be a non-negative integer or null' };
    f.portRangeEnd = body.portRangeEnd;
  }
  if (body.copyEnvFrom !== undefined) {
    if (!isNullableString(body.copyEnvFrom)) return { error: 'copyEnvFrom must be a string or null' };
    f.copyEnvFrom = body.copyEnvFrom;
  }

  // #7 — fleet scheduler priority
  if (body.priority !== undefined) {
    if (!isNonNegInt(body.priority)) return { error: 'priority must be a non-negative integer' };
    f.priority = body.priority;
  }

  // #9 — conflict resolution
  if (body.resolveConflicts !== undefined) f.resolveConflicts = !!body.resolveConflicts;

  return { fields: f };
}
