/**
 * Coverage-focused REAL/behavioral tests for triggers.ts.
 *
 * Targets uncovered branches: rowToView JSON-parse catch blocks, fetchIssues/PRs
 * non-array + parse-fail paths, _doTickTrigger misconfig/card/run error branches,
 * pollAllTriggers, validateTriggerBody config/projectId edge cases, and the PUT/
 * poll route 404 + post-merge re-validation paths.
 *
 * Isolation pattern (from fn-validation.test.ts / triggers.test.ts): set
 * FLEET_DATA_DIR to a fresh mkdtemp BEFORE importing any src module, install a
 * fake `gh` on PATH, and route handlers via buildServer().inject() with a
 * 127.0.0.1:<PORT> host header. Tick paths are driven by seeding real trigger
 * rows directly via the DB and calling the real tickTrigger through the poll
 * route (or pollAllTriggers).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ── Isolate DB before any src module loads ──────────────────────────────────
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-covtrig-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

const tmpDirs: string[] = [DATA_DIR];
let ORIG_PATH = '';

let app: any;
let PORT: number;
let db: import('better-sqlite3').Database;
let projectsRepo: any;
let registry: any;
let repo: any;

const H = () => ({ host: `127.0.0.1:${PORT}` });

/**
 * Fake gh. Routes by the repo path embedded in arg #2 (`repos/<owner/name>/...`):
 *   - owner/good-issues  → 2 issues (#1, #2)
 *   - owner/good-pulls   → 1 PR (#10)
 *   - owner/badjson      → non-JSON stdout, exit 0  → JSON.parse throws → null
 *   - owner/notarray     → JSON object (not array), exit 0 → null
 *   - anything else      → exit 1 (gh failed → null)
 */
function installFakeGh(): void {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-test-covtrig-gh-'));
  tmpDirs.push(dir);
  const issues = JSON.stringify([
    { number: 1, title: 'First', body: 'body one', html_url: 'https://github.com/o/r/issues/1' },
    { number: 2, title: 'Second', body: null, html_url: 'https://github.com/o/r/issues/2' },
  ]).replace(/'/g, "'\\''");
  const pulls = JSON.stringify([
    { number: 10, title: 'PR ten', body: 'pr body', html_url: 'https://github.com/o/r/pull/10' },
  ]).replace(/'/g, "'\\''");
  const script = `#!/usr/bin/env bash
ARG2="$2"
if echo "$ARG2" | grep -q "good-issues"; then echo '${issues}'; exit 0; fi
if echo "$ARG2" | grep -q "good-pulls"; then echo '${pulls}'; exit 0; fi
if echo "$ARG2" | grep -q "badjson"; then echo 'this is not json {'; exit 0; fi
if echo "$ARG2" | grep -q "notarray"; then echo '{"object":true}'; exit 0; fi
echo "fake-gh: forced failure: $*" >&2; exit 1
`;
  const p = join(dir, 'gh');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  ORIG_PATH = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${ORIG_PATH}`;
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-test-covtrig-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  return dir;
}

/** Insert a trigger row directly. Returns the id. */
function seedTrigger(opts: {
  repo: string;
  kind?: 'issue-label' | 'pr-opened';
  config?: string; // raw TEXT (may be malformed on purpose)
  action?: 'card' | 'run';
  projectId?: string | null;
  template?: string | null;
  enabled?: number;
  state?: string; // raw TEXT (may be malformed on purpose)
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO triggers (id, repo, kind, config, action, project_id, template, enabled, state, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    opts.repo,
    opts.kind ?? 'issue-label',
    opts.config ?? JSON.stringify({ label: 'agent' }),
    opts.action ?? 'card',
    opts.projectId ?? null,
    opts.template ?? null,
    opts.enabled ?? 1,
    opts.state ?? '{"seen":[]}',
    Date.now(),
  );
  return id;
}

function getRow(id: string): any {
  return db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
}

/** Drive a real tick on a seeded trigger via the manual poll route. */
async function poll(id: string): Promise<any> {
  const r = await app.inject({ method: 'POST', url: `/api/triggers/${id}/poll`, headers: H() });
  return r;
}

beforeAll(async () => {
  installFakeGh();
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;

  // Stub pm so kanban card creation does not kick off real launches.
  const pmMod = await import('../src/pm.js');
  pmMod.pm.tick = async () => {};

  db = (await import('../src/db.js')).default;
  ({ repo } = await import('../src/db.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  await import('../src/triggers.js');
  ({ registry } = await import('../src/registry.js'));

  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (ORIG_PATH) process.env.PATH = ORIG_PATH;
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── rowToView — JSON-parse catch blocks (lines 115, 116-121) ───────────────────

describe('rowToView — malformed config/state fall back to defaults', () => {
  it('malformed config TEXT → config becomes {} (config catch, line 113-115)', async () => {
    const id = seedTrigger({ repo: 'owner/good-pulls', kind: 'pr-opened', config: '{not valid json', action: 'card' });
    // Need a real project for the card path; but here we just read it back via GET.
    const r = await app.inject({ method: 'GET', url: '/api/triggers', headers: H() });
    expect(r.statusCode).toBe(200);
    const view = (JSON.parse(r.body) as any[]).find((t) => t.id === id);
    expect(view).toBeDefined();
    expect(view.config).toEqual({}); // parse failed → default {}
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('malformed state TEXT → state becomes {seen:[]} (state catch, line 119-121)', async () => {
    const id = seedTrigger({ repo: 'owner/good-pulls', kind: 'pr-opened', action: 'card', state: 'NOPE not json' });
    const r = await app.inject({ method: 'GET', url: '/api/triggers', headers: H() });
    const view = (JSON.parse(r.body) as any[]).find((t) => t.id === id);
    expect(view.state).toEqual({ seen: [] });
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('valid state JSON but seen is not an array → coerced to [] (line 118)', async () => {
    const id = seedTrigger({ repo: 'owner/good-pulls', kind: 'pr-opened', action: 'card', state: '{"seen":"oops-a-string"}' });
    const r = await app.inject({ method: 'GET', url: '/api/triggers', headers: H() });
    const view = (JSON.parse(r.body) as any[]).find((t) => t.id === id);
    expect(view.state.seen).toEqual([]);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

// ── _doTickTrigger — misconfig + gh-null + card error branches (261-345) ───────

describe('tickTrigger — misconfigured issue-label (empty label) stores error (line 259-262)', () => {
  it('an issue-label trigger with a blank label records the requires-label error and skips gh', async () => {
    // config has no label → String(label).trim() === '' → error branch.
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', config: '{}', action: 'card' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('issue-label trigger requires a non-empty label');
    // seen stays empty — never called gh
    expect(JSON.parse(getRow(id).state).seen).toEqual([]);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

describe('tickTrigger — gh call fails → items null → last_error stored (line 270-273)', () => {
  it('a repo the fake gh exits non-zero for records the gh-failed error', async () => {
    const id = seedTrigger({ repo: 'owner/fails-here', kind: 'issue-label', action: 'card' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('gh API call failed for owner/fails-here');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('gh returns non-JSON → fetch parse-catch returns null → gh-failed error (line 207-209/270)', async () => {
    const id = seedTrigger({ repo: 'owner/badjson', kind: 'issue-label', action: 'card' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('gh API call failed for owner/badjson');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('gh returns a JSON object (not an array) → null → gh-failed error (line 205-206/270)', async () => {
    const id = seedTrigger({ repo: 'owner/notarray', kind: 'issue-label', action: 'card' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('gh API call failed for owner/notarray');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('pr-opened gh-object response also yields null (fetchOpenPRs non-array path, line 220-221)', async () => {
    const id = seedTrigger({ repo: 'owner/notarray', kind: 'pr-opened', config: '{}', action: 'card' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('gh API call failed for owner/notarray');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('pr-opened non-JSON gh stdout → fetchOpenPRs parse-catch returns null (line 222-225)', async () => {
    const id = seedTrigger({ repo: 'owner/badjson', kind: 'pr-opened', config: '{}', action: 'card' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('gh API call failed for owner/badjson');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

describe('tickTrigger — card action error branches (lines 313-334)', () => {
  it('card action with NULL project_id records "action card requires project_id" per item (line 314-316)', async () => {
    // Seed directly so we can bypass the create-route guard that would reject this.
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'card', projectId: null });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('action card requires project_id');
    // No card could be made → items stay unseen (continue, never addToSeen).
    expect(JSON.parse(getRow(id).state).seen).toEqual([]);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('card action with a NONEXISTENT project_id records "project ... not found" (line 319-323)', async () => {
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'card', projectId: 'ghost-proj' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('project ghost-proj not found');
    expect(JSON.parse(getRow(id).state).seen).toEqual([]);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('card action with a REAL project creates cards and marks both issues seen (line 324-331)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-card', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'card', projectId: project.id });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    const seen = JSON.parse(getRow(id).state).seen;
    expect(seen).toContain(1);
    expect(seen).toContain(2);
    expect(getRow(id).last_error).toBeNull();
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('second tick after all-seen clears a stale last_error and adds no cards (line 296-301)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-stale', rootDir: dir });
    // pre-seed both issue numbers AND a stale error.
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'card', projectId: project.id, state: '{"seen":[1,2]}' });
    db.prepare('UPDATE triggers SET last_error = ? WHERE id = ?').run('some old error', id);
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    // newItems empty → stale error cleared
    expect(getRow(id).last_error).toBeNull();
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

describe('tickTrigger — run action error branches (lines 337-343)', () => {
  it('run action with NULL project_id records the run-needs-project error (line 337-338)', async () => {
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: null });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('action run requires project_id to resolve cwd');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('run action with a NONEXISTENT project_id records project-not-found (line 341-343)', async () => {
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: 'ghost-run' });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    expect(getRow(id).last_error).toBe('project ghost-run not found');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('run action permanent launch failure → marks item seen AND records lastError (line 372-374)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-run-fail', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: project.id });

    const original = registry.launch;
    registry.launch = () => { throw new Error('boom permanent'); };
    try {
      const r = await poll(id);
      expect(r.statusCode).toBe(200);
      expect(getRow(id).last_error).toBe('boom permanent');
      // permanent failures ARE marked seen (no infinite retry)
      const seen = JSON.parse(getRow(id).state).seen;
      expect(seen).toContain(1);
      expect(seen).toContain(2);
    } finally {
      registry.launch = original;
    }
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('run action with a template applies the template profile to the launch (applyTemplateProfile 168-181)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-tpl', rootDir: dir });
    const tplName = `cov-tpl-${Date.now()}`;
    repo.upsertTemplate({
      id: randomUUID(),
      name: tplName,
      role: 'worker',
      description: '',
      systemPrompt: 'TEMPLATE-SYS-PROMPT',
      model: 'claude-haiku-4-5',
      fastMode: false,
      effort: 'low',
      allowedTools: ['Read'],
      skills: ['foo'],
      permissionMode: 'default',
      budgetUsd: 1.5,
      isBuiltin: false,
      createdAt: Date.now(),
    });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: project.id, template: tplName });

    const captured: any[] = [];
    const original = registry.launch;
    registry.launch = (lr: any) => { captured.push(lr); return { id: 'r' }; };
    try {
      await poll(id);
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const lr = captured[0];
      expect(lr.model).toBe('claude-haiku-4-5'); // template model wins
      expect(lr.effort).toBe('low');
      expect(lr.allowedTools).toEqual(['Read']);
      expect(lr.skills).toEqual(['foo']);
      expect(lr.budgetUsd).toBe(1.5);
      expect(lr.appendSystemPrompt).toBe('TEMPLATE-SYS-PROMPT'); // base had none → template sys
    } finally {
      registry.launch = original;
    }
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('run action with an UNKNOWN template name leaves the base request unchanged (applyTemplateProfile line 164)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-notpl', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: project.id, template: 'no-such-template-xyz' });

    const captured: any[] = [];
    const original = registry.launch;
    registry.launch = (lr: any) => { captured.push(lr); return { id: 'r' }; };
    try {
      await poll(id);
      expect(captured.length).toBeGreaterThanOrEqual(1);
      // getTemplateByName returns null → applyTemplateProfile returns lr untouched → base defaults
      expect(captured[0].model).toBe('claude-opus-4-8');
      expect(captured[0].effort).toBe('high');
    } finally {
      registry.launch = original;
    }
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

describe('tickTrigger — run action cap-blocked break (lines 367-370)', () => {
  it('a 429 from registry.launch breaks the item loop and leaves items UNSEEN', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-cap429', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: project.id });

    const original = registry.launch;
    let calls = 0;
    registry.launch = () => { calls++; const e: any = new Error('cap'); e.statusCode = 429; throw e; };
    try {
      const r = await poll(id);
      expect(r.statusCode).toBe(200);
      expect(calls).toBe(1); // break stops after the first cap-blocked item
      const seen = JSON.parse(getRow(id).state).seen;
      expect(seen).not.toContain(1);
      expect(seen).not.toContain(2);
      expect(getRow(id).last_error).toBeNull(); // cap-block is not a permanent error
    } finally {
      registry.launch = original;
    }
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('a 409 daily-cap from registry.launch also breaks without marking seen (line 367-370)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-cap409', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'run', projectId: project.id });

    const original = registry.launch;
    registry.launch = () => { const e: any = new Error('daily'); e.statusCode = 409; e.code = 'daily-cap'; throw e; };
    try {
      await poll(id);
      expect(JSON.parse(getRow(id).state).seen).toEqual([]);
    } finally {
      registry.launch = original;
    }
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

describe('tickTrigger — card creation throws → lastError captured (lines 332-334)', () => {
  it('a createTask exception records the error message and leaves the item unseen', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-cardthrow', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'card', projectId: project.id });

    const kanbanMod = await import('../src/kanban.js');
    const original = kanbanMod.kanbanRepo.createTask;
    kanbanMod.kanbanRepo.createTask = () => { throw new Error('card-create-failed'); };
    try {
      const r = await poll(id);
      expect(r.statusCode).toBe(200);
      expect(getRow(id).last_error).toBe('card-create-failed');
      expect(JSON.parse(getRow(id).state).seen).toEqual([]); // not marked seen on failure
    } finally {
      kanbanMod.kanbanRepo.createTask = original;
    }
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

describe('tickTrigger — disabled-mid-flight guard returns early (line 278-282)', () => {
  it('a disabled trigger seeded directly is not ticked (freshRow.enabled === 0 bail)', async () => {
    // enabled=0: poll route still calls tickTrigger(existing), but the post-gh
    // re-read sees enabled=0 and bails WITHOUT persisting (no error written).
    const id = seedTrigger({ repo: 'owner/good-issues', kind: 'issue-label', action: 'card', projectId: null, enabled: 0 });
    const r = await poll(id);
    expect(r.statusCode).toBe(200);
    // No card path error was written because we bailed after the gh await.
    expect(getRow(id).last_error).toBeNull();
    expect(JSON.parse(getRow(id).state).seen).toEqual([]);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

// ── pollAllTriggers (lines 392-407) ────────────────────────────────────────────

describe('pollAllTriggers — sweep over the seeded DB', () => {
  it('ticks each enabled trigger and writes its deterministic last_error, never throws', async () => {
    // Clean slate of enabled triggers, then seed one that will fail the fake gh.
    db.prepare("UPDATE triggers SET enabled = 0").run();
    const id = seedTrigger({ repo: 'owner/sweep-fail', kind: 'issue-label', action: 'card' });
    const mod = await import('../src/triggers.js');
    await expect(mod.pollAllTriggers()).resolves.toBeUndefined();
    expect(getRow(id).last_error).toBe('gh API call failed for owner/sweep-fail');
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

// ── validateTriggerBody edge cases (lines 451-475) ─────────────────────────────

describe('Validation — config + projectId edge cases', () => {
  it('400 when config is an array, not an object (line 453-455)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: [1, 2, 3], project_id: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/config must be an object/i);
  });

  it('400 when project_id is a non-string (number) (line 468-469)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {}, project_id: 12345 },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/project_id must be a string/i);
  });

  it('400 when camelCase projectId is a non-string (line 472-473)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {}, projectId: { not: 'a string' } },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/projectId must be a string/i);
  });

  it('accepts camelCase projectId (string) and resolves the project (line 471-474)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-camel', rootDir: dir });
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {}, projectId: project.id },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    expect(body.projectId).toBe(project.id);
    await app.inject({ method: 'DELETE', url: `/api/triggers/${body.id}`, headers: H() });
  });

  it('400 (create) when an issue-label trigger has no label (line 461-463)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-create-nolabel', rootDir: dir });
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'issue-label', action: 'card', config: {}, project_id: project.id },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/config.label is required/i);
  });

  it('400 (create) when action card has no project_id (line 478-479)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/project_id is required for action card/i);
  });

  it('400 when template is a non-string (line 491)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-badtpl', rootDir: dir });
    const r = await app.inject({
      method: 'POST', url: '/api/triggers', headers: H(),
      payload: { repo: 'owner/repo', kind: 'pr-opened', action: 'card', config: {}, project_id: project.id, template: 999 },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/template must be a string/i);
  });
});

// ── PUT route — 404 + merge + post-merge re-validation (lines 548-598) ──────────

describe('PUT /api/triggers/:id — merge + re-validation', () => {
  it('404 for an unknown id (line 549-552)', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/triggers/does-not-exist', headers: H(), payload: { enabled: false } });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('not found');
  });

  it('400 when validateTriggerBody rejects the patch (bad kind) (line 555-558)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-put-badkind', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/repo', kind: 'pr-opened', config: '{}', action: 'card', projectId: project.id });
    const r = await app.inject({ method: 'PUT', url: `/api/triggers/${id}`, headers: H(), payload: { kind: 'nope' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/kind/i);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('400 when the patch supplies an invalid action (validateTriggerBody action branch, line 446-448)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-put-badaction', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/repo', kind: 'pr-opened', config: '{}', action: 'card', projectId: project.id });
    const r = await app.inject({ method: 'PUT', url: `/api/triggers/${id}`, headers: H(), payload: { action: 'explode' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/action must be one of/i);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('merges repo/template/config while leaving unspecified fields intact (line 561-570)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-put-merge', rootDir: dir });
    const id = seedTrigger({ repo: 'owner/old', kind: 'pr-opened', config: '{}', action: 'card', projectId: project.id });
    const r = await app.inject({
      method: 'PUT', url: `/api/triggers/${id}`, headers: H(),
      payload: { repo: 'owner/new', template: 'tpl-x' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.repo).toBe('owner/new');     // changed
    expect(body.template).toBe('tpl-x');      // changed
    expect(body.kind).toBe('pr-opened');      // untouched
    expect(body.action).toBe('card');         // untouched
    expect(body.projectId).toBe(project.id);  // untouched
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('400 when a merged config blanks the label on an issue-label trigger (post-merge re-validation, line 573-578)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-put-label', rootDir: dir });
    // existing IS issue-label with a valid label. The patch omits `kind`, so validateTriggerBody
    // (which keys its label check off body.kind, here undefined) PASSES — but the merged config
    // is {} → the route's post-merge re-validation at line 573-578 must 400.
    const id = seedTrigger({ repo: 'owner/repo', kind: 'issue-label', config: JSON.stringify({ label: 'agent' }), action: 'card', projectId: project.id });
    const r = await app.inject({ method: 'PUT', url: `/api/triggers/${id}`, headers: H(), payload: { config: {} } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/config.label is required/i);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('400 when a merge to action card drops project_id (post-merge re-validation, line 581-584)', async () => {
    const dir = makeGitRepo();
    const project = projectsRepo.createProject({ name: 'covtrig-put-cardproj', rootDir: dir });
    // existing run-action trigger WITH a project. Patch only `project_id: null` (no action in body),
    // so validateTriggerBody's `action === 'card'` guard is skipped (action undefined) and it PASSES.
    // The merge keeps action='run'… so to hit the card post-merge guard we patch action→card too,
    // but supply project_id:null. validateTriggerBody sees action='card' && !projectId → would 400 at
    // line 478 first. Instead: existing is already CARD; patch project_id:null with NO action in body
    // → validate skips the card guard (action undefined), merge keeps action='card' + null project →
    // route post-merge guard at 581-584 fires.
    const id = seedTrigger({ repo: 'owner/repo', kind: 'pr-opened', config: '{}', action: 'card', projectId: project.id });
    const r = await app.inject({
      method: 'PUT', url: `/api/triggers/${id}`, headers: H(),
      payload: { project_id: null },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/project_id is required for action card/i);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });

  it('merge to card action with a valid project_id succeeds (newProjectId provided branch, line 566-567)', async () => {
    const dir = makeGitRepo();
    const p1 = projectsRepo.createProject({ name: 'covtrig-put-p1', rootDir: dir });
    const dir2 = makeGitRepo();
    const p2 = projectsRepo.createProject({ name: 'covtrig-put-p2', rootDir: dir2 });
    const id = seedTrigger({ repo: 'owner/repo', kind: 'pr-opened', config: '{}', action: 'card', projectId: p1.id });
    const r = await app.inject({ method: 'PUT', url: `/api/triggers/${id}`, headers: H(), payload: { project_id: p2.id } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).projectId).toBe(p2.id);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  });
});

// ── DELETE route 404 (lines 604-608) + successful delete ───────────────────────

describe('DELETE /api/triggers/:id', () => {
  it('404 for an unknown id (line 605-607)', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/triggers/no-such-trigger', headers: H() });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('not found');
  });

  it('removes an existing trigger and returns ok (line 609-610)', async () => {
    const id = seedTrigger({ repo: 'owner/repo', kind: 'pr-opened', config: '{}', action: 'card' });
    const r = await app.inject({ method: 'DELETE', url: `/api/triggers/${id}`, headers: H() });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
    expect(getRow(id)).toBeUndefined();
  });
});

// ── manual poll route 404 (lines 616-620) ──────────────────────────────────────

describe('POST /api/triggers/:id/poll — 404 for unknown id (line 617-620)', () => {
  it('returns 404 with a not-found body', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/triggers/nope-not-real/poll', headers: H() });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('not found');
  });
});

// ── startTriggerPoller — interval handle contract (lines 630-636) ──────────────

describe('startTriggerPoller — returns a clearable interval handle', () => {
  it('returns a truthy timer that clearInterval can stop', async () => {
    const mod = await import('../src/triggers.js');
    const t = mod.startTriggerPoller();
    try {
      expect(t).toBeTruthy();
    } finally {
      clearInterval(t);
    }
  });
});
