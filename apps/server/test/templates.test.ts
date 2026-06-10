import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-tpl-'));

let app: any;
let PORT: number;
let templatesMod: typeof import('../src/templates.js');
let repo: typeof import('../src/db.js').repo;

const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  templatesMod = await import('../src/templates.js');
  repo = (await import('../src/db.js')).repo;
  const { buildServer } = await import('../src/server.js');
  app = buildServer(); // buildServer() runs seedTemplates()
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('built-in agent library — seeding', () => {
  it('seeds the full 12-profile library on a fresh DB (unique names)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates', headers: H() });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    const builtins = list.filter((t: any) => t.isBuiltin);
    expect(builtins.length).toBe(templatesMod.BUILTIN_TEMPLATES.length);
    expect(builtins.length).toBeGreaterThanOrEqual(12);
    const names = builtins.map((t: any) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['Orchestrator', 'Researcher', 'Implementer', 'Reviewer', 'Synthesizer', 'Debugger', 'Test Writer', 'Security Auditor', 'Refactorer', 'Docs Writer', 'Frontend Builder', 'Perf Optimizer']) {
      expect(names).toContain(n);
    }
  });

  it('every seed passes the same constraints the template routes enforce', () => {
    const roles = new Set(['orchestrator', 'worker', 'reviewer', 'synthesizer']);
    for (const s of templatesMod.BUILTIN_TEMPLATES) {
      expect(roles.has(s.role)).toBe(true);
      expect(Array.isArray(s.allowedTools)).toBe(true);
      expect(Array.isArray(s.skills)).toBe(true);
      expect(s.systemPrompt.length).toBeGreaterThan(100); // real working instructions, not a stub
      expect(s.budgetUsd).toBeGreaterThan(0);
    }
    // campaign fallback pools must remain non-empty per role used by tpl()
    const byRole = (r: string) => templatesMod.BUILTIN_TEMPLATES.filter((s) => s.role === r);
    expect(byRole('orchestrator').length).toBeGreaterThanOrEqual(1);
    expect(byRole('worker').length).toBeGreaterThanOrEqual(1);
    expect(byRole('synthesizer').length).toBeGreaterThanOrEqual(1);
  });

  it('seedTemplates is idempotent (no duplicates on re-run)', async () => {
    templatesMod.seedTemplates();
    templatesMod.seedTemplates();
    const list = repo.listTemplates().filter((t) => t.isBuiltin);
    expect(list.length).toBe(templatesMod.BUILTIN_TEMPLATES.length);
  });

  it('auto-upgrades a built-in whose prompt is the UNTOUCHED v1 seed, preserving id', () => {
    const reviewer = repo.getTemplateByName('Reviewer')!;
    const legacyPrompt =
      'You are a skeptical code reviewer. Hunt for genuine correctness bugs, security issues, and missed edge cases in the ' +
      'work described by your task. Default to scrutiny; report only real, triggerable issues with the exact scenario.';
    repo.upsertTemplate({ ...reviewer, systemPrompt: legacyPrompt });
    templatesMod.seedTemplates();
    const after = repo.getTemplate(reviewer.id)!;
    expect(after.systemPrompt).not.toBe(legacyPrompt); // upgraded
    expect(after.systemPrompt).toContain('WORKING METHOD');
    expect(after.id).toBe(reviewer.id);
  });

  it('NEVER clobbers a user-edited built-in prompt', () => {
    const impl = repo.getTemplateByName('Implementer')!;
    const custom = 'My own carefully tuned implementation prompt.';
    repo.upsertTemplate({ ...impl, systemPrompt: custom });
    templatesMod.seedTemplates();
    expect(repo.getTemplate(impl.id)!.systemPrompt).toBe(custom);
    // restore the seed for other tests
    const seed = templatesMod.BUILTIN_TEMPLATES.find((s) => s.name === 'Implementer')!;
    repo.upsertTemplate({ ...impl, ...seed });
  });
});

describe('GET /api/templates/:id + PUT round-trip (the detail page contract)', () => {
  it('returns a single template by id', async () => {
    const reviewer = repo.getTemplateByName('Reviewer')!;
    const res = await app.inject({ method: 'GET', url: `/api/templates/${reviewer.id}`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Reviewer');
    expect(res.json().systemPrompt).toContain('WORKING METHOD');
  });

  it('404s on an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/nope', headers: H() });
    expect(res.statusCode).toBe(404);
  });

  it('PUT updates skills/tools/prompt with validation; name + isBuiltin stay fixed', async () => {
    const dbg = repo.getTemplateByName('Debugger')!;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/templates/${dbg.id}`,
      headers: H(),
      payload: {
        skills: ['graphify'],
        allowedTools: ['Read', 'Grep'],
        systemPrompt: dbg.systemPrompt + '\nProject note: prefer vitest.',
        name: 'Renamed-Attack',
        isBuiltin: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skills).toEqual(['graphify']);
    expect(body.allowedTools).toEqual(['Read', 'Grep']);
    expect(body.systemPrompt).toContain('prefer vitest');
    expect(body.name).toBe('Debugger'); // immutable
    expect(body.isBuiltin).toBe(true); // immutable
  });

  it('PUT rejects a non-array, non-string skills payload', async () => {
    const dbg = repo.getTemplateByName('Debugger')!;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/templates/${dbg.id}`,
      headers: H(),
      payload: { skills: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});
