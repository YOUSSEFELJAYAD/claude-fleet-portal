/**
 * GitHub triggers (F1 — autonomy front door).
 *
 * Polls GitHub via the `gh` CLI every 120s for new issues / PRs matching each
 * enabled trigger. On a new item:
 *   - action 'card'  → creates a Kanban card in the project's Ready column.
 *   - action 'run'   → launches a Claude run via registry.launch, applying the
 *                      named template's profile fields (mirrors campaigns.launchWorker).
 *
 * Cap-blocked launches (429 / 409 daily-cap) are NOT marked seen so they retry
 * on the next tick. All other errors store last_error on the trigger row and
 * never throw out of the tick. Seen IDs are capped at 500 (FIFO).
 *
 * Routes:
 *   GET    /api/triggers
 *   POST   /api/triggers
 *   PUT    /api/triggers/:id
 *   DELETE /api/triggers/:id
 *   POST   /api/triggers/:id/poll   (manual tick — used by tests + UX)
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import db from './db.js';
import { repo } from './db.js';
import { registry } from './registry.js';
import { kanbanRepo } from './kanban.js';
import { projectsRepo } from './projects.js';
import { ghExec } from './gh.js';
import type { LaunchRequest } from '@fleet/shared';

// ── schema (idempotent) ───────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue-label', 'pr-opened')),
  config TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL CHECK (action IN ('card', 'run')),
  project_id TEXT,
  template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT '{"seen":[]}',
  last_error TEXT,
  created_at INTEGER NOT NULL
);
`);

// Idempotent migration: add last_error column if not present (older DBs).
try {
  db.exec('ALTER TABLE triggers ADD COLUMN last_error TEXT');
} catch (e: any) {
  if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
}

// ── shapes ─────────────────────────────────────────────────────────────────────

interface TriggerRow {
  id: string;
  repo: string;
  kind: string;
  config: string;
  action: string;
  project_id: string | null;
  template: string | null;
  enabled: number;
  state: string;
  last_error: string | null;
  created_at: number;
}

export interface TriggerView {
  id: string;
  repo: string;
  kind: 'issue-label' | 'pr-opened';
  config: Record<string, unknown>;
  action: 'card' | 'run';
  projectId: string | null;
  template: string | null;
  enabled: boolean;
  state: { seen: number[] };
  lastError: string | null;
  createdAt: number;
}

// ── statements ────────────────────────────────────────────────────────────────
const insertStmt = db.prepare(`
INSERT INTO triggers (id, repo, kind, config, action, project_id, template, enabled, state, last_error, created_at)
VALUES (@id, @repo, @kind, @config, @action, @project_id, @template, @enabled, @state, @last_error, @created_at)
`);
const listStmt = db.prepare('SELECT * FROM triggers ORDER BY created_at DESC');
const getStmt = db.prepare('SELECT * FROM triggers WHERE id = ?');
const updateStmt = db.prepare(`
UPDATE triggers SET
  repo=@repo, kind=@kind, config=@config, action=@action, project_id=@project_id,
  template=@template, enabled=@enabled, state=@state, last_error=@last_error
WHERE id=@id
`);
// Narrow tick-state persist: ONLY state + last_error — never overwrites repo/kind/config/action/
// project_id/template/enabled from a stale pre-await snapshot (mirrors scheduler.ts updateFiredStmt).
const updateTickStateStmt = db.prepare(
  'UPDATE triggers SET state=@state, last_error=@last_error WHERE id=@id',
);
const deleteStmt = db.prepare('DELETE FROM triggers WHERE id = ?');
const enabledListStmt = db.prepare('SELECT * FROM triggers WHERE enabled = 1');

// ── row <-> domain mapper ─────────────────────────────────────────────────────

function rowToView(row: TriggerRow): TriggerView {
  let config: Record<string, unknown> = {};
  let state: { seen: number[] } = { seen: [] };
  try {
    config = JSON.parse(row.config);
  } catch {
    /* ignore */
  }
  try {
    state = JSON.parse(row.state);
    if (!Array.isArray(state.seen)) state.seen = [];
  } catch {
    state = { seen: [] };
  }
  return {
    id: row.id,
    repo: row.repo,
    kind: row.kind as TriggerView['kind'],
    config,
    action: row.action as TriggerView['action'],
    projectId: row.project_id ?? null,
    template: row.template ?? null,
    enabled: !!row.enabled,
    state,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
  };
}

// ── seen list helpers ─────────────────────────────────────────────────────────

// Cap raised to 2000 to reduce re-fire risk from FIFO eviction (was 500).
// Residual: if 2000+ newer items are processed AND an old-but-still-open item
// re-enters the 20-newest page, it will re-fire. Fully closing it requires a
// per-trigger high-water mark or `since=` query — deferred to v2.
const MAX_SEEN = 2000;

function addToSeen(seen: number[], id: number, latestPage?: number[]): number[] {
  if (seen.includes(id)) return seen;
  const next = [...seen, id];
  if (next.length <= MAX_SEEN) return next;
  // Smarter eviction: drop oldest ids that are NOT present in the latest fetched page,
  // so still-open items that would re-fire are kept even after the cap is hit.
  const pageSet = new Set(latestPage ?? []);
  const evictable = next.filter((n) => !pageSet.has(n));
  const keep = next.filter((n) => pageSet.has(n));
  // Remove oldest evictable entries until we're at MAX_SEEN
  const excess = next.length - MAX_SEEN;
  return [...evictable.slice(excess), ...keep];
}

// ── template profile application (mirrors campaigns.launchWorker / scheduler.ts) ─

function applyTemplateProfile(lr: LaunchRequest, templateName: string): LaunchRequest {
  const tpl = repo.getTemplateByName(templateName);
  if (!tpl) return lr;
  // Template wins for model/effort when the base request has no explicit user choice.
  // Triggers have no user-supplied model field — the base LaunchRequest is built WITHOUT
  // model/effort so the template's values always apply (mirrors campaigns.launchWorker
  // precedence: `campaign.model || t.model`).
  return {
    ...lr,
    model: tpl.model || lr.model,
    effort: (tpl.effort as LaunchRequest['effort']) || lr.effort,
    permissionMode: tpl.permissionMode || lr.permissionMode,
    allowedTools: tpl.allowedTools.length ? tpl.allowedTools : (lr.allowedTools ?? []),
    skills: tpl.skills.length ? tpl.skills : (lr.skills ?? []),
    budgetUsd: tpl.budgetUsd ?? lr.budgetUsd,
    appendSystemPrompt: tpl.systemPrompt
      ? lr.appendSystemPrompt
        ? `${lr.appendSystemPrompt}\n\n${tpl.systemPrompt}`
        : tpl.systemPrompt
      : lr.appendSystemPrompt,
  };
}

// ── gh API polling helpers ────────────────────────────────────────────────────

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
}

async function fetchIssuesWithLabel(ghRepo: string, label: string): Promise<GhIssue[] | null> {
  // Use a valid cwd (process.cwd() is fine — gh reads auth from ~/.config/gh)
  const r = await ghExec(process.cwd(), [
    'api', `repos/${ghRepo}/issues`,
    '--method', 'GET',
    '-f', `labels=${label}`,
    '-f', 'state=open',
    '-f', 'per_page=20',
  ]);
  if (!r.ok) return null;
  try {
    const items = JSON.parse(r.stdout);
    if (!Array.isArray(items)) return null;
    return items as GhIssue[];
  } catch {
    return null;
  }
}

async function fetchOpenPRs(ghRepo: string): Promise<GhIssue[] | null> {
  const r = await ghExec(process.cwd(), [
    'api', `repos/${ghRepo}/pulls`,
    '-f', 'state=open',
    '-f', 'per_page=20',
  ]);
  if (!r.ok) return null;
  try {
    const items = JSON.parse(r.stdout);
    if (!Array.isArray(items)) return null;
    return items as GhIssue[];
  } catch {
    return null;
  }
}

// ── in-flight guard (finding #1) ──────────────────────────────────────────────
// Per-trigger Set of in-flight trigger ids. Guards both the background poller
// (startTriggerPoller) AND the manual POST /:id/poll route against concurrent
// ticks on the same trigger id (mirrors addons.ts:838 watchTick pattern).
const inFlightTriggers = new Set<string>();

// ── single trigger tick ───────────────────────────────────────────────────────

/**
 * Process one enabled trigger. Polls gh, processes new items, and persists state.
 * Never throws. Returns the updated view.
 */
async function tickTrigger(row: TriggerRow): Promise<void> {
  // In-flight guard: skip if this trigger is already being processed (concurrent
  // background poll + manual poll, or overlapping background intervals).
  if (inFlightTriggers.has(row.id)) return;
  inFlightTriggers.add(row.id);

  try {
    await _doTickTrigger(row);
  } finally {
    inFlightTriggers.delete(row.id);
  }
}

async function _doTickTrigger(row: TriggerRow): Promise<void> {
  const view = rowToView(row);
  let items: GhIssue[] | null = null;

  if (view.kind === 'issue-label') {
    const label = String(view.config.label ?? '').trim();
    if (!label) {
      // Misconfigured — store error and skip (narrow persist: state + last_error only)
      updateTickStateStmt.run({ id: row.id, state: row.state, last_error: 'issue-label trigger requires a non-empty label' });
      return;
    }
    items = await fetchIssuesWithLabel(view.repo, label);
  } else {
    // pr-opened
    items = await fetchOpenPRs(view.repo);
  }

  if (items === null) {
    updateTickStateStmt.run({ id: row.id, state: row.state, last_error: `gh API call failed for ${view.repo}` });
    return;
  }

  // RE-READ enabled after the gh await (finding #2): abort launching phase if the
  // trigger was disabled mid-flight (a PUT /api/triggers/:id landing during the
  // gh call would otherwise be silently reverted by the stale-row persist).
  const freshRow = getStmt.get(row.id) as TriggerRow | undefined;
  if (!freshRow || !freshRow.enabled) {
    // Trigger was deleted or disabled while we were waiting for gh; bail without persisting.
    return;
  }
  // Re-parse seen from the freshRow so we don't clobber any concurrent update to seen.
  let freshSeen: number[] = [];
  try {
    const parsed = JSON.parse(freshRow.state);
    if (Array.isArray(parsed?.seen)) freshSeen = parsed.seen;
  } catch { /* fallback to empty */ }

  // page of item numbers for smarter eviction
  const pageNums = items.map((i) => i.number);

  // Filter to items not yet seen (use freshSeen to avoid re-processing items added
  // by a concurrent tick that completed while we were awaiting gh).
  const newItems = items.filter((item) => !freshSeen.includes(item.number));
  if (newItems.length === 0) {
    // Nothing new — clear any stale error (narrow persist)
    if (freshRow.last_error) {
      updateTickStateStmt.run({ id: row.id, state: freshRow.state, last_error: null });
    }
    return;
  }

  // Process each new item
  let seen = [...freshSeen];
  let lastError: string | null = null;

  for (const item of newItems) {
    const title = `#${item.number} ${item.title}`;
    const bodyText = item.body ?? '';
    const url = item.html_url;

    if (view.action === 'card') {
      if (!view.projectId) {
        lastError = 'action card requires project_id';
        continue;
      }
      // Verify project exists
      const project = projectsRepo.getProject(view.projectId);
      if (!project) {
        lastError = `project ${view.projectId} not found`;
        continue;
      }
      try {
        kanbanRepo.createTask({
          projectId: view.projectId,
          title,
          description: `${bodyText}\n\nsource: ${url}`.trim(),
          column: 'Ready',
        });
        seen = addToSeen(seen, item.number, pageNums);
      } catch (e: any) {
        lastError = e?.message ?? 'failed to create card';
      }
    } else {
      // action === 'run'
      if (!view.projectId) {
        lastError = 'action run requires project_id to resolve cwd';
        continue;
      }
      const project = projectsRepo.getProject(view.projectId);
      if (!project) {
        lastError = `project ${view.projectId} not found`;
        continue;
      }
      const prompt = `${title}\n\n${bodyText}\n\n${url}`.trim();
      // Build base LaunchRequest with fallback model/effort. The template is applied next
      // and its model/effort WIN (finding #3: `tpl.model || lr.model` in applyTemplateProfile).
      // So these defaults only apply when no template is configured or the template omits the field.
      let lr: LaunchRequest = {
        prompt,
        cwd: project.rootDir,
        model: 'claude-opus-4-8',
        effort: 'high',
        permissionMode: 'default',
        projectId: view.projectId,
        interactive: false,
      };
      if (view.template) {
        lr = applyTemplateProfile(lr, view.template);
      }
      try {
        registry.launch(lr);
        seen = addToSeen(seen, item.number, pageNums);
      } catch (e: any) {
        // Cap-blocked (429 concurrency or 409 daily-cap): do NOT mark seen — retry next tick.
        if (e?.statusCode === 429 || e?.code === 'daily-cap') {
          // leave this item unseen — it will be retried next tick
          break; // stop processing further items too; the cap is still blocking
        }
        // Permanent failure
        lastError = e?.message ?? 'launch failed';
        // Still mark seen to avoid re-attempting a permanently-failed item forever
        seen = addToSeen(seen, item.number, pageNums);
      }
    }
  }

  // Persist ONLY state + last_error — never overwrite repo/kind/config/action/project_id/
  // template/enabled from the pre-await snapshot (finding #2, mirrors scheduler.ts updateFiredStmt).
  const newState = JSON.stringify({ seen });
  updateTickStateStmt.run({ id: row.id, state: newState, last_error: lastError });
}

// ── poller (every 120s, unref'd) ──────────────────────────────────────────────

// Guard pollAllTriggers against overlapping itself (probes can outlive the 120s interval
// when gh calls are slow). Mirrors addons.ts:838 watchTick boolean pattern but for the
// whole poll sweep; per-trigger overlap is handled by inFlightTriggers above.
let pollAllInFlight = false;

export async function pollAllTriggers(): Promise<void> {
  if (pollAllInFlight) return;
  pollAllInFlight = true;
  try {
    const rows = enabledListStmt.all() as TriggerRow[];
    for (const row of rows) {
      try {
        await tickTrigger(row);
      } catch {
        /* one trigger failing must not block others */
      }
    }
  } finally {
    pollAllInFlight = false;
  }
}

// ── validation helpers ────────────────────────────────────────────────────────

// Each segment must match [\w.-]+ AND must not be '.' or '..' (finding #5 — path traversal guard).
const REPO_SEGMENT_RE = /^[\w.-]+$/;
function isValidRepo(s: string): boolean {
  const slash = s.indexOf('/');
  if (slash <= 0 || slash !== s.lastIndexOf('/')) return false; // must have exactly one '/'
  const owner = s.slice(0, slash);
  const name = s.slice(slash + 1);
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return false;
  return REPO_SEGMENT_RE.test(owner) && REPO_SEGMENT_RE.test(name);
}

function validateTriggerBody(body: any, isCreate: boolean): { error: string } | {
  repo: string;
  kind: 'issue-label' | 'pr-opened';
  config: Record<string, unknown>;
  action: 'card' | 'run';
  projectId: string | null;
  template: string | null;
  enabled: boolean;
} {
  // repo
  const repoStr = typeof body.repo === 'string' ? body.repo.trim() : '';
  if (isCreate && !repoStr) return { error: 'repo is required' };
  if (repoStr && !isValidRepo(repoStr)) return { error: 'repo must match owner/name (letters, digits, hyphens, dots) and must not contain path traversal (..)' };

  // kind
  const kind = body.kind;
  if (isCreate && kind === undefined) return { error: 'kind is required' };
  if (kind !== undefined && kind !== 'issue-label' && kind !== 'pr-opened') {
    return { error: 'kind must be one of issue-label, pr-opened' };
  }

  // action
  const action = body.action;
  if (isCreate && action === undefined) return { error: 'action is required' };
  if (action !== undefined && action !== 'card' && action !== 'run') {
    return { error: 'action must be one of card, run' };
  }

  // config
  let config: Record<string, unknown> = {};
  if (body.config !== undefined) {
    if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
      return { error: 'config must be an object' };
    }
    config = body.config;
  }

  // label required for issue-label
  const resolvedKind = kind ?? '';
  if (resolvedKind === 'issue-label') {
    const label = String(config.label ?? '').trim();
    if (!label) return { error: 'config.label is required for issue-label triggers' };
  }

  // project_id
  let projectId: string | null = null;
  if (body.project_id !== undefined && body.project_id !== null) {
    if (typeof body.project_id !== 'string') return { error: 'project_id must be a string or null' };
    projectId = body.project_id;
  } else if (body.projectId !== undefined && body.projectId !== null) {
    // accept camelCase too
    if (typeof body.projectId !== 'string') return { error: 'projectId must be a string or null' };
    projectId = body.projectId;
  }

  // action 'card' requires project_id
  if (action === 'card' && !projectId) {
    return { error: 'project_id is required for action card' };
  }

  // project must exist if given
  if (projectId) {
    const project = projectsRepo.getProject(projectId);
    if (!project) return { error: `project ${projectId} not found` };
  }

  // template
  let template: string | null = null;
  if (body.template !== undefined && body.template !== null && body.template !== '') {
    if (typeof body.template !== 'string') return { error: 'template must be a string or null' };
    template = body.template;
  }

  // enabled
  const enabled = body.enabled === undefined ? true : !!body.enabled;

  return {
    repo: repoStr,
    kind: (kind ?? 'issue-label') as 'issue-label' | 'pr-opened',
    config,
    action: (action ?? 'card') as 'card' | 'run',
    projectId,
    template,
    enabled,
  };
}

// ── routes ────────────────────────────────────────────────────────────────────

export function registerTriggersRoutes(app: FastifyInstance) {
  // List all triggers
  app.get('/api/triggers', async () => {
    return (listStmt.all() as TriggerRow[]).map(rowToView);
  });

  // Create a trigger
  app.post('/api/triggers', async (req, reply) => {
    const body = (req.body as any) ?? {};
    const v = validateTriggerBody(body, true);
    if ('error' in v) {
      reply.code(400);
      return { error: v.error };
    }
    const now = Date.now();
    const id = randomUUID();
    const config = body.config && typeof body.config === 'object' ? body.config : {};
    insertStmt.run({
      id,
      repo: v.repo,
      kind: v.kind,
      config: JSON.stringify(config),
      action: v.action,
      project_id: v.projectId,
      template: v.template,
      enabled: v.enabled ? 1 : 0,
      state: JSON.stringify({ seen: [] }),
      last_error: null,
      created_at: now,
    });
    reply.code(201);
    return rowToView(getStmt.get(id) as TriggerRow);
  });

  // Update a trigger (partial patch)
  app.put('/api/triggers/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const existing = getStmt.get(id) as TriggerRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = (req.body as any) ?? {};
    const v = validateTriggerBody(body, false);
    if ('error' in v) {
      reply.code(400);
      return { error: v.error };
    }

    // Merge with existing values (only provided fields change)
    const existingView = rowToView(existing);
    const newRepo = v.repo || existingView.repo;
    const newKind = (body.kind !== undefined ? v.kind : existingView.kind) as 'issue-label' | 'pr-opened';
    const newConfig = body.config !== undefined ? (body.config ?? {}) : existingView.config;
    const newAction = (body.action !== undefined ? v.action : existingView.action) as 'card' | 'run';
    const newProjectId = body.project_id !== undefined || body.projectId !== undefined
      ? v.projectId
      : existingView.projectId;
    const newTemplate = body.template !== undefined ? v.template : existingView.template;
    const newEnabled = body.enabled !== undefined ? v.enabled : existingView.enabled;

    // Re-validate label for issue-label after merge
    if (newKind === 'issue-label') {
      const label = String((newConfig as any).label ?? '').trim();
      if (!label) {
        reply.code(400);
        return { error: 'config.label is required for issue-label triggers' };
      }
    }
    // Re-validate project_id for action card after merge
    if (newAction === 'card' && !newProjectId) {
      reply.code(400);
      return { error: 'project_id is required for action card' };
    }

    updateStmt.run({
      id,
      repo: newRepo,
      kind: newKind,
      config: JSON.stringify(newConfig),
      action: newAction,
      project_id: newProjectId,
      template: newTemplate,
      enabled: newEnabled ? 1 : 0,
      state: existing.state,
      last_error: existing.last_error,
    });
    return rowToView(getStmt.get(id) as TriggerRow);
  });

  // Delete a trigger
  app.delete('/api/triggers/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const existing = getStmt.get(id) as TriggerRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    deleteStmt.run(id);
    return { ok: true };
  });

  // Manual poll (useful for tests + UX "poll now" button)
  app.post('/api/triggers/:id/poll', async (req, reply) => {
    const id = (req.params as any).id as string;
    const existing = getStmt.get(id) as TriggerRow | undefined;
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    await tickTrigger(existing);
    return rowToView(getStmt.get(id) as TriggerRow);
  });
}

// ── background poller startup ─────────────────────────────────────────────────

/** Start the 120s polling interval. Unref'd so it never keeps the process alive. */
export function startTriggerPoller(): ReturnType<typeof setInterval> {
  const t = setInterval(() => {
    pollAllTriggers().catch(() => {
      /* never throw out of the interval */
    });
  }, 120_000);
  t.unref();
  return t;
}
