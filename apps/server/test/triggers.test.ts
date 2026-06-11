/**
 * F1 — GitHub triggers test suite.
 *
 * Pattern: FAKE `gh` binary (PATH shim, like test/gh.test.ts) returning fixture
 * issues/PRs. Tests cover:
 *   - CRUD routes + validation
 *   - Poll tick: new issue → card created
 *   - Seen deduplication: second tick on same data → no new card
 *   - action 'run': launch triggered from issue
 *   - Cap-blocked launch (429): item NOT marked seen (retry semantics)
 *   - Manual poll route (/api/triggers/:id/poll)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ── Isolate DB before any src module loads ──────────────────────────────────
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-triggers-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let app: any;
let PORT: number;
let projectsRepo: any;
let kanbanRepo: any;
let triggers: any; // src/triggers.js module namespace
let registry: any;

/** Temp dirs tracked for cleanup. */
const tmpDirs: string[] = [DATA_DIR];

/** Fake `gh` binary dir + arg log (mirrors test/gh.test.ts pattern). */
let fakeGhDir = '';
let ORIG_PATH = '';

/**
 * Install a fake `gh` that:
 *   - `gh api repos/<repo>/issues --method GET -f labels=agent -f state=open -f per_page=20`
 *     → returns a JSON array of 2 issues (numbers 1, 2)
 *   - `gh api repos/<repo>/pulls -f state=open -f per_page=20`
 *     → returns a JSON array of 1 PR (number 10)
 *   - `gh api repos/cap-fail/issues ...` → returns exit 1 (simulates error)
 *   - anything else → exit 1
 */
function installFakeGh(): void {
  fakeGhDir = mkdtempSync(join(tmpdir(), 'fleet-test-triggers-fakegh-'));
  tmpDirs.push(fakeGhDir);

  // Build fixture data
  const issues = JSON.stringify([
    { number: 1, title: 'Fix login', body: 'Login is broken', html_url: 'https://github.com/owner/repo/issues/1' },
    { number: 2, title: 'Add search', body: 'We need search', html_url: 'https://github.com/owner/repo/issues/2' },
  ]);
  const pulls = JSON.stringify([
    { number: 10, title: 'Add dark mode', body: 'Dark mode PR', html_url: 'https://github.com/owner/repo/pull/10' },
  ]);

  const script = `#!/usr/bin/env bash
# Fake gh — returns fixture data for known patterns
REPO_ARG="$3"
# gh api repos/<repo>/issues --method GET -f labels=... -f state=open -f per_page=20
if [ "$1" = "api" ] && echo "$2" | grep -q "/issues"; then
  if echo "$2" | grep -q "cap-fail"; then
    echo "rate limited" >&2; exit 1
  fi
  echo '${issues.replace(/'/g, "'\\''")}'; exit 0
fi
# gh api repos/<repo>/pulls -f state=open -f per_page=20
if [ "$1" = "api" ] && echo "$2" | grep -q "/pulls"; then
  echo '${pulls.replace(/'/g, "'\\''")}'; exit 0
fi
echo "fake-gh: unhandled: $*" >&2; exit 1
`;

  const p = join(fakeGhDir, 'gh');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  ORIG_PATH = process.env.PATH ?? '';
  process.env.PATH = `${fakeGhDir}:${ORIG_PATH}`;
}

/** Helper: Host header for inject calls. */
const H = () => ({ host: `127.0.0.1:${PORT}` });

/** Make a project with a real git repo (required for rootDir on `action: run`). */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-test-triggers-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  return dir;
}

beforeAll(async () => {
  installFakeGh();

  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;

  // Stub pm so kanban cards don't trigger real launches
  const pmMod = await import('../src/pm.js');
  pmMod.pm.tick = async () => {};
  pmMod.pm.approve = async () => {};
  pmMod.pm.requestChanges = () => {};
  pmMod.pm.cancel = () => {};

  ({ projectsRepo } = await import('../src/projects.js'));
  const kanbanMod = await import('../src/kanban.js');
  ({ kanbanRepo } = kanbanMod);
  triggers = await import('../src/triggers.js');
  const regMod = await import('../src/registry.js');
  ({ registry } = regMod);

  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (ORIG_PATH) process.env.PATH = ORIG_PATH;
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── CRUD routes ───────────────────────────────────────────────────────────────

describe('CRUD — /api/triggers', () => {
  it('GET /api/triggers returns an empty array initially', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/triggers', headers: H() });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('POST /api/triggers creates an issue-label trigger', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-crud', rootDir: repoDir });

    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'card',
        project_id: project.id,
        enabled: true,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    expect(body.id).toBeTruthy();
    expect(body.repo).toBe('owner/repo');
    expect(body.kind).toBe('issue-label');
    expect(body.config.label).toBe('agent');
    expect(body.action).toBe('card');
    expect(body.projectId).toBe(project.id);
    expect(body.enabled).toBe(true);
    expect(body.state).toEqual({ seen: [] });
    expect(body.lastError).toBeNull();

    // cleanup
    await app.inject({ method: 'DELETE', url: `/api/triggers/${body.id}`, headers: H() });
  });

  it('POST /api/triggers creates a pr-opened trigger', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-pr', rootDir: repoDir });

    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'pr-opened',
        config: {},
        action: 'card',
        project_id: project.id,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    expect(body.kind).toBe('pr-opened');

    await app.inject({ method: 'DELETE', url: `/api/triggers/${body.id}`, headers: H() });
  });

  it('PUT /api/triggers/:id updates enabled flag', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-update', rootDir: repoDir });

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', config: {}, action: 'card', project_id: project.id, enabled: true },
    });
    const { id } = JSON.parse(createR.body);

    const updateR = await app.inject({
      method: 'PUT',
      url: `/api/triggers/${id}`,
      headers: H(),
      payload: { enabled: false },
    });
    expect(updateR.statusCode).toBe(200);
    expect(JSON.parse(updateR.body).enabled).toBe(false);

    await app.inject({ method: 'DELETE', url: `/api/triggers/${id}`, headers: H() });
  });

  it('DELETE /api/triggers/:id removes the trigger', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-del', rootDir: repoDir });

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', config: {}, action: 'card', project_id: project.id },
    });
    const { id } = JSON.parse(createR.body);

    const delR = await app.inject({ method: 'DELETE', url: `/api/triggers/${id}`, headers: H() });
    expect(delR.statusCode).toBe(200);
    expect(JSON.parse(delR.body).ok).toBe(true);

    const getR = await app.inject({ method: 'GET', url: '/api/triggers', headers: H() });
    const list = JSON.parse(getR.body) as any[];
    expect(list.find((t) => t.id === id)).toBeUndefined();
  });

  it('DELETE /api/triggers/:id → 404 for unknown id', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/triggers/does-not-exist', headers: H() });
    expect(r.statusCode).toBe(404);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('Validation — POST /api/triggers', () => {
  it('400 when repo is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { kind: 'pr-opened', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/repo/i);
  });

  it('400 when repo has invalid format', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'not valid/owner name', kind: 'pr-opened', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/repo/i);
  });

  it('400 when kind is invalid', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'bogus-kind', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/kind/i);
  });

  it('400 when action is invalid', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'invalid-action', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/action/i);
  });

  it('400 when issue-label has empty label', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-val-label', rootDir: repoDir });
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'issue-label', action: 'card', config: {}, project_id: project.id },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/label/i);
  });

  it('400 when action card has no project_id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/project_id/i);
  });

  it('400 when project_id does not exist', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {}, project_id: 'does-not-exist' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/project/i);
  });

  // Finding #5 — path traversal repo rejection
  it('400 when repo is "a/.." (path traversal)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: 'a/..', kind: 'pr-opened', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/repo/i);
  });

  it('400 when repo is "../b" (path traversal)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: { repo: '../b', kind: 'pr-opened', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/repo/i);
  });
});

// ── Poll tick — card creation ─────────────────────────────────────────────────

describe('poll tick — issue-label → card created', () => {
  it('processes new issues and creates Kanban cards in Ready column', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-poll', rootDir: repoDir });

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'card',
        project_id: project.id,
        enabled: true,
      },
    });
    expect(createR.statusCode).toBe(201);
    const triggerId = JSON.parse(createR.body).id;

    // Manually poll
    const pollR = await app.inject({
      method: 'POST',
      url: `/api/triggers/${triggerId}/poll`,
      headers: H(),
    });
    expect(pollR.statusCode).toBe(200);

    // Two issues (#1, #2) should be seen now
    const triggerAfter = JSON.parse(pollR.body) as { state: { seen: number[] } };
    expect(triggerAfter.state.seen).toContain(1);
    expect(triggerAfter.state.seen).toContain(2);

    // Two cards should have been created in the Ready column
    const cards = kanbanRepo.listTasks(project.id);
    const readyCards = cards.filter((c: any) => c.column === 'Ready');
    expect(readyCards.length).toBeGreaterThanOrEqual(2);

    // Cards should have the correct title format and description with source URL
    const card1 = readyCards.find((c: any) => c.title.includes('#1'));
    expect(card1).toBeDefined();
    expect(card1.title).toBe('#1 Fix login');
    expect(card1.description).toContain('source:');
    expect(card1.description).toContain('https://github.com');

    // cleanup
    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });

  it('seen deduplication: second tick creates NO additional cards', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-dedup', rootDir: repoDir });

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'card',
        project_id: project.id,
        enabled: true,
      },
    });
    const triggerId = JSON.parse(createR.body).id;

    // First poll
    await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });
    const cardsAfterFirst = kanbanRepo.listTasks(project.id).length;

    // Second poll — same data, should create nothing new
    await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });
    const cardsAfterSecond = kanbanRepo.listTasks(project.id).length;

    expect(cardsAfterSecond).toBe(cardsAfterFirst);

    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── Poll tick — pr-opened ─────────────────────────────────────────────────────

describe('poll tick — pr-opened → card created', () => {
  it('processes new PRs and creates a Kanban card', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-pr-poll', rootDir: repoDir });

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'pr-opened',
        config: {},
        action: 'card',
        project_id: project.id,
        enabled: true,
      },
    });
    const triggerId = JSON.parse(createR.body).id;

    const pollR = await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });
    expect(pollR.statusCode).toBe(200);

    const triggerAfter = JSON.parse(pollR.body) as { state: { seen: number[] } };
    expect(triggerAfter.state.seen).toContain(10);

    const cards = kanbanRepo.listTasks(project.id);
    const card = cards.find((c: any) => c.title.includes('#10'));
    expect(card).toBeDefined();
    expect(card.title).toBe('#10 Add dark mode');

    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── Cap-blocked launch: item NOT marked seen ──────────────────────────────────

describe('cap-blocked launch (429) — item NOT marked seen', () => {
  it('a 429 from registry.launch leaves the item unseen for retry', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-cap-run', rootDir: repoDir });

    // Stub registry.launch to throw 429
    const originalLaunch = registry.launch.bind(registry);
    let throwCount = 0;
    registry.launch = () => {
      throwCount++;
      const e = Object.assign(new Error('Max concurrent runs reached'), { statusCode: 429 });
      throw e;
    };

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'run',
        project_id: project.id,
        enabled: true,
      },
    });
    const triggerId = JSON.parse(createR.body).id;

    // Poll — the launch will be cap-blocked
    const pollR = await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });
    expect(pollR.statusCode).toBe(200);
    expect(throwCount).toBeGreaterThan(0);

    // The items must NOT be in seen (cap-blocked → retry on next tick)
    const triggerAfter = JSON.parse(pollR.body) as { state: { seen: number[] } };
    expect(triggerAfter.state.seen).not.toContain(1);
    expect(triggerAfter.state.seen).not.toContain(2);

    // Restore
    registry.launch = originalLaunch;

    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── action: run with template ──────────────────────────────────────────────────

describe('action run — template profile applied', () => {
  it('launches a run with correct prompt (title + body + url)', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-run', rootDir: repoDir });

    // Capture launched LaunchRequests
    const launched: any[] = [];
    const originalLaunch = registry.launch.bind(registry);
    registry.launch = (lr: any) => {
      launched.push(lr);
      // Return a mock run object to satisfy the caller
      return { id: 'fake-run-' + Math.random().toString(36).slice(2) };
    };

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'run',
        project_id: project.id,
        enabled: true,
      },
    });
    const triggerId = JSON.parse(createR.body).id;

    await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });

    // Both issues should have launched runs
    expect(launched.length).toBeGreaterThanOrEqual(2);

    // Check first launch
    const first = launched[0];
    expect(first.prompt).toContain('#1 Fix login');
    expect(first.prompt).toContain('Login is broken');
    expect(first.prompt).toContain('https://github.com');
    expect(first.cwd).toBe(repoDir);
    expect(first.projectId).toBe(project.id);

    // Restore
    registry.launch = originalLaunch;

    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── gh API error → last_error stored, never throw ─────────────────────────────

describe('gh API error handling', () => {
  it('stores last_error on gh failure, does not throw', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-err', rootDir: repoDir });

    // Create a trigger with a repo that triggers fake gh error ("cap-fail" is handled by fake gh)
    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'cap-fail/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'card',
        project_id: project.id,
        enabled: true,
      },
    });
    const triggerId = JSON.parse(createR.body).id;

    // Should not throw, should store error
    const pollR = await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });
    expect(pollR.statusCode).toBe(200);
    const triggerAfter = JSON.parse(pollR.body);
    expect(triggerAfter.lastError).toBeTruthy();

    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── Cap-blocked launch (409 daily-cap) — item NOT marked seen ─────────────────

describe('cap-blocked launch (409 daily-cap) — item NOT marked seen', () => {
  // Finding #7 (#43): the 409/daily-cap variant must behave identically to 429.
  it('a 409 daily-cap from registry.launch leaves the item unseen for retry', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-cap-daily', rootDir: repoDir });

    const originalLaunch = registry.launch.bind(registry);
    let throwCount = 0;
    registry.launch = () => {
      throwCount++;
      const e = Object.assign(new Error('Daily spend ceiling reached'), { statusCode: 409, code: 'daily-cap' });
      throw e;
    };

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'run',
        project_id: project.id,
        enabled: true,
      },
    });
    const triggerId = JSON.parse(createR.body).id;

    const pollR = await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });
    expect(pollR.statusCode).toBe(200);
    expect(throwCount).toBeGreaterThan(0);

    // Items must NOT be in seen — daily-cap is treated as transient, retry on next tick
    const triggerAfter = JSON.parse(pollR.body) as { state: { seen: number[] } };
    expect(triggerAfter.state.seen).not.toContain(1);
    expect(triggerAfter.state.seen).not.toContain(2);

    registry.launch = originalLaunch;
    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── Real template profile applied to run-action trigger ───────────────────────

describe('action run — template model/effort/appendSystemPrompt applied (finding #3/#7 #44)', () => {
  it('trigger with a haiku template launches with the haiku model and template fields', async () => {
    const repoDir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'proj-tpl-run', rootDir: repoDir });

    // Create a haiku template via the API (systemPrompt becomes appendSystemPrompt on launch).
    // Use a unique name to avoid conflicts with prior test runs sharing the same DB.
    const tplName = `haiku-test-tpl-${Date.now()}`;
    const tplR = await app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: H(),
      payload: {
        name: tplName,
        model: 'claude-haiku-4-5',
        effort: 'low',
        systemPrompt: 'You are a cost-efficient assistant.',
      },
    });
    // The POST /api/templates route returns 200 (not 201) — match the actual server behavior.
    expect(tplR.statusCode).toBe(200);
    const tpl = JSON.parse(tplR.body);
    expect(tpl.model).toBe('claude-haiku-4-5');

    // Capture launched LaunchRequests
    const launched: any[] = [];
    const originalLaunch = registry.launch.bind(registry);
    registry.launch = (lr: any) => {
      launched.push(lr);
      return { id: 'fake-run-tpl-' + Math.random().toString(36).slice(2) };
    };

    const createR = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers: H(),
      payload: {
        repo: 'owner/repo',
        kind: 'issue-label',
        config: { label: 'agent' },
        action: 'run',
        project_id: project.id,
        template: tplName,
        enabled: true,
      },
    });
    expect(createR.statusCode).toBe(201);
    const triggerId = JSON.parse(createR.body).id;

    await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/poll`, headers: H() });

    // Must have launched at least once
    expect(launched.length).toBeGreaterThanOrEqual(1);

    // The captured LaunchRequest must carry the template's model and effort
    const first = launched[0];
    expect(first.model).toBe('claude-haiku-4-5');
    expect(first.effort).toBe('low');
    // Template's appendSystemPrompt must be present
    expect(first.appendSystemPrompt).toContain('cost-efficient');

    registry.launch = originalLaunch;
    await app.inject({ method: 'DELETE', url: `/api/triggers/${triggerId}`, headers: H() });
  });
});

// ── pollAllTriggers (exported) ──────────────────────────────────────────────────

describe('pollAllTriggers — exported function', () => {
  it('processes all enabled triggers without throwing', async () => {
    // Just verify the exported function runs without error
    await expect(triggers.pollAllTriggers()).resolves.toBeUndefined();
  });
});
