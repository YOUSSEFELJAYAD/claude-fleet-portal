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
import path from 'node:path';
import type { Project, CreateProjectRequest } from '@fleet/shared';
import db from './db.js';

const execFileAsync = promisify(execFile);

// ── schema (idempotent) ───────────────────────────────────────────────────────
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
  created_at INTEGER NOT NULL
);
`);

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
  };
}

// ── prepared statements ───────────────────────────────────────────────────────
const insertProjectStmt = db.prepare(`
INSERT INTO projects (id, name, root_dir, default_branch, auto_merge, default_validation_command,
  wip_limit, budget_ceiling_usd, paused, created_at)
VALUES (@id, @name, @root_dir, @default_branch, @auto_merge, @default_validation_command,
  @wip_limit, @budget_ceiling_usd, @paused, @created_at)
`);
const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
const listProjectsStmt = db.prepare('SELECT * FROM projects ORDER BY created_at DESC');
const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');
const updateProjectStmt = db.prepare(`
UPDATE projects SET
  name=@name, root_dir=@root_dir, default_branch=@default_branch, auto_merge=@auto_merge,
  default_validation_command=@default_validation_command, wip_limit=@wip_limit,
  budget_ceiling_usd=@budget_ceiling_usd, paused=@paused
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
    if (!(await isGitWorkTree(rootDir))) {
      reply.code(400);
      return { error: 'rootDir must be an existing git repository' };
    }

    // optional fields — validate when present. If no branch is given, DETECT the repo's
    // actual current branch (main vs master vs anything) instead of assuming 'main'.
    let defaultBranch = body.defaultBranch !== undefined ? String(body.defaultBranch).trim() : undefined;
    if (defaultBranch !== undefined && !defaultBranch) {
      reply.code(400);
      return { error: 'defaultBranch must be a non-empty string when provided' };
    }
    if (defaultBranch === undefined) defaultBranch = await detectDefaultBranch(rootDir);
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

    const createReq: CreateProjectRequest = {
      name,
      rootDir,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(body.autoMerge !== undefined ? { autoMerge: !!body.autoMerge } : {}),
      ...(defaultValidationCommand !== undefined ? { defaultValidationCommand } : {}),
      ...(wipLimit !== undefined ? { wipLimit } : {}),
      ...(budgetCeilingUsd !== undefined ? { budgetCeilingUsd } : {}),
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
