/**
 * F-LEARN — Skill auto-learning loop tests.
 *
 * Pattern (mirrors memory.test.ts): isolate DB + all output dirs via env BEFORE any
 * src import, drive the REAL production path by firing fake runs through the registry's
 * terminal subscribers, and inspect the files/rows that result. A fake distiller binary
 * stands in for `claude -p`, so the suite is hermetic — no model, no network.
 *
 * Covers:
 *   - pure helpers: slugify, taskSignature, isComplex, shouldLearn, parseSkill
 *   - GET /api/learner default config; PUT validation
 *   - disabled by default → complex run writes nothing
 *   - enabled → complex run writes SKILL.md (+ provenance) + RAG copy + ok row
 *   - non-complex / campaign / PM runs write nothing
 *   - dedup: same task twice → one skill
 *   - distillAndWrite (injected runner): SKIP + unparseable → no file, recorded
 *   - DELETE removes the dir + RAG copy + row
 *   - POST /api/learner/distill/:runId on unknown run → 404
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Isolate DB + skill/RAG output dirs BEFORE any src module imports ───────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-learner-'));
process.env.FLEET_DATA_DIR = dataDir;
const SKILLS_DIR = join(dataDir, 'skills');
const RAG_DIR = join(dataDir, 'rag-learned');
process.env.LEARNER_SKILLS_DIR = SKILLS_DIR;
process.env.LEARNER_RAG_DIR = RAG_DIR;

// Fake distiller: consume stdin, emit a deterministic SKILL.md. (Used by the autonomous path.)
const fakeBin = join(dataDir, 'fake-distiller.sh');
writeFileSync(
  fakeBin,
  `#!/bin/sh
cat >/dev/null
cat <<'EOF'
---
name: Fake Learned Skill
description: Use when verifying the auto-learning loop — emits a deterministic skill.
---

# Fake Learned Skill

## When to use
When a complex run completes during the learner test.

## Steps
1. Do the thing.
2. Verify the thing.
EOF
`,
  { mode: 0o755 },
);
process.env.LEARNER_CLAUDE_BIN = fakeBin;
process.env.CLAUDE_BIN = fakeBin; // harmless: our tests drive via terminalSubs, not real run-exec

let app: any;
let PORT: number;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H() });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const post = (url: string, body: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(50);
  }
}

async function okCount(): Promise<number> {
  const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
  return skills.filter((s) => s.status === 'ok').length;
}

/** A completed, operator-launched, complex run (10-min duration + 5 subagents + $1). */
function fakeRun(overrides: Record<string, unknown> = {}): any {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    sessionId: id,
    task: `complex task ${id}`,
    cwd: dataDir,
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    workflowsEnabled: false,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'completed',
    startedAt: now - 600_000,
    endedAt: now,
    tokensIn: 1000,
    tokensOut: 500,
    costUsd: 1.0,
    exitCode: 0,
    killReason: null,
    error: null,
    budgetUsd: null,
    permissionMode: 'default',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: 'Completed a complex multi-step task successfully.',
    structuredOutput: null,
    subagentCount: 5,
    liveSubagents: 0,
    maxDepth: 3,
    lastActivity: now,
    ...overrides,
  };
}

async function fireTerminal(run: any): Promise<void> {
  const { registry } = await import('../src/registry.js');
  for (const cb of (registry as any).terminalSubs) {
    try {
      cb(run);
    } catch {
      /* ignore */
    }
  }
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('pure helpers', () => {
  it('slugify / taskSignature / isComplex / shouldLearn / parseSkill', async () => {
    const L = await import('../src/learner.js');
    expect(L.slugify('Fake Learned Skill!')).toBe('fake-learned-skill');
    expect(L.slugify('   ')).toBe('skill');
    expect(L.taskSignature('Do  X')).toBe(L.taskSignature('do x')); // normalized

    const cfg = { enabled: true, minCostUsd: 0.5, minSubagents: 3, minDepth: 2, minDurationMs: 300_000, maxPerDay: 10 };
    expect(L.isComplex(fakeRun(), cfg)).toBe(true);
    expect(L.isComplex(fakeRun({ costUsd: 0.01, subagentCount: 0, maxDepth: 0, startedAt: Date.now(), endedAt: Date.now() }), cfg)).toBe(false);

    expect(L.shouldLearn(fakeRun(), cfg)).toBe(true);
    expect(L.shouldLearn(fakeRun({ status: 'failed' }), cfg)).toBe(false);
    expect(L.shouldLearn(fakeRun({ campaignId: 'c1' }), cfg)).toBe(false);
    expect(L.shouldLearn(fakeRun({ projectId: 'p1' }), cfg)).toBe(false);
    expect(L.shouldLearn(fakeRun(), { ...cfg, enabled: false })).toBe(false);

    const parsed = L.parseSkill('---\nname: My Skill\ndescription: Use when X.\n---\n\n# Title\n\nBody.');
    expect(parsed).toMatchObject({ name: 'My Skill', description: 'Use when X.' });
    expect(L.parseSkill('SKIP')).toBe('skip');
    expect(L.parseSkill('no frontmatter here')).toBeNull();
    expect(L.parseSkill('---\nname: X\n---\n\n')).toBeNull(); // missing description + body
  });
});

describe('GET /api/learner', () => {
  it('returns default config (disabled)', async () => {
    const body = JSON.parse((await get('/api/learner')).payload);
    expect(body.enabled).toBe(false);
    expect(body.minCostUsd).toBeGreaterThan(0);
    expect(body.maxPerDay).toBeGreaterThanOrEqual(1);
  });
});

describe('PUT /api/learner validation', () => {
  it('rejects non-boolean enabled', async () => {
    const res = await put('/api/learner', { enabled: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/boolean/i);
  });
  it('rejects negative minCostUsd', async () => {
    const res = await put('/api/learner', { minCostUsd: -1 });
    expect(res.statusCode).toBe(400);
  });
  it('rejects maxPerDay < 1', async () => {
    const res = await put('/api/learner', { maxPerDay: 0 });
    expect(res.statusCode).toBe(400);
  });
  it('accepts a valid update', async () => {
    const res = await put('/api/learner', { minSubagents: 2 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).minSubagents).toBe(2);
  });
});

describe('disabled by default — complex run writes nothing', () => {
  it('no skill is created while disabled', async () => {
    await put('/api/learner', { enabled: false });
    const before = await okCount();
    await fireTerminal(fakeRun());
    await sleep(400);
    expect(await okCount()).toBe(before);
    expect(existsSync(join(SKILLS_DIR, 'learned-fake-learned-skill'))).toBe(false);
  });
});

describe('enabled — complex run distills a skill', () => {
  it('writes SKILL.md with provenance + a RAG copy + an ok row', async () => {
    await put('/api/learner', { enabled: true });
    const before = await okCount();

    await fireTerminal(fakeRun());

    const skillMd = join(SKILLS_DIR, 'learned-fake-learned-skill', 'SKILL.md');
    await waitFor(() => existsSync(skillMd), 6000);

    const md = readFileSync(skillMd, 'utf8');
    expect(md).toContain('name: fake-learned-skill');
    expect(md).toContain('learned: true');
    expect(md).toContain('source_run:');
    expect(md).toContain('# Fake Learned Skill');

    // RAG copy dropped into the personal-rag notes dir.
    expect(existsSync(join(RAG_DIR, 'learned-fake-learned-skill.md'))).toBe(true);

    // Listed via the API as an ok outcome.
    await waitFor(async () => (await okCount()) === before + 1, 3000);
    const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    const top = skills[0];
    expect(top.status).toBe('ok');
    expect(top.name).toBe('fake-learned-skill');
    expect(top.ragPath).toBeTruthy();
    expect(typeof top.sourceCostUsd).toBe('number');
  });
});

describe('gating — non-qualifying runs write nothing', () => {
  it('a non-complex run is skipped', async () => {
    await put('/api/learner', { enabled: true });
    const before = await okCount();
    await fireTerminal(fakeRun({ costUsd: 0.001, subagentCount: 0, maxDepth: 0, startedAt: Date.now() - 1000, endedAt: Date.now() }));
    await sleep(400);
    expect(await okCount()).toBe(before);
  });
  it('campaign and PM runs are skipped', async () => {
    await put('/api/learner', { enabled: true });
    const before = await okCount();
    await fireTerminal(fakeRun({ campaignId: 'camp-1' }));
    await fireTerminal(fakeRun({ projectId: 'proj-1' }));
    await sleep(400);
    expect(await okCount()).toBe(before);
  });
});

describe('dedup — same task distills once', () => {
  it('firing the same task twice yields exactly one new skill', async () => {
    await put('/api/learner', { enabled: true });
    const before = await okCount();
    const task = `dedupe-target-${randomUUID()}`;

    await fireTerminal(fakeRun({ task }));
    await waitFor(async () => (await okCount()) === before + 1, 6000);

    await fireTerminal(fakeRun({ task })); // identical task → deduped
    await sleep(500);
    expect(await okCount()).toBe(before + 1);
  });
});

describe('distillAndWrite — injected runner edge cases', () => {
  it('SKIP output writes no file and records skipped', async () => {
    const L = await import('../src/learner.js');
    const res = await L.distillAndWrite(fakeRun(), async () => 'SKIP', { force: true });
    expect(res.status).toBe('skipped');
    expect(res.skillPath).toBeUndefined();
  });
  it('unparseable output records failed', async () => {
    const L = await import('../src/learner.js');
    const res = await L.distillAndWrite(fakeRun(), async () => 'garbage, not a skill', { force: true });
    expect(res.status).toBe('failed');
  });
  it('valid output writes a skill (force bypasses dedup)', async () => {
    const L = await import('../src/learner.js');
    const unique = randomUUID().slice(0, 8);
    const md = `---\nname: Injected ${unique}\ndescription: Use when testing the injected runner path.\n---\n\n# Injected\n\nBody here.`;
    const res = await L.distillAndWrite(fakeRun(), async () => md, { force: true });
    expect(res.status).toBe('ok');
    expect(existsSync(res.skillPath!)).toBe(true);
    expect(readFileSync(res.skillPath!, 'utf8')).toContain('learned: true');
  });
});

describe('DELETE /api/learner/skills/:id', () => {
  it('removes the SKILL.md dir, RAG copy, and row', async () => {
    const L = await import('../src/learner.js');
    const unique = randomUUID().slice(0, 8);
    const md = `---\nname: Deletable ${unique}\ndescription: Use when testing delete.\n---\n\n# Deletable\n\nBody.`;
    const res = await L.distillAndWrite(fakeRun(), async () => md, { force: true });
    expect(res.status).toBe('ok');
    const dir = join(SKILLS_DIR, `learned-deletable-${unique}`);
    expect(existsSync(dir)).toBe(true);

    const delRes = await del(`/api/learner/skills/${res.id}`);
    expect(delRes.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(res.ragPath!)).toBe(false);

    const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    expect(skills.find((s) => s.id === res.id)).toBeUndefined();
  });

  it('returns 404 for an unknown id', async () => {
    const res = await del('/api/learner/skills/does-not-exist');
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/learner/distill/:runId', () => {
  it('returns 404 for an unknown run', async () => {
    const res = await post('/api/learner/distill/unknown-run-id');
    expect(res.statusCode).toBe(404);
  });
});
