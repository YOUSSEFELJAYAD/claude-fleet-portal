/**
 * cov-learner — raises REAL coverage of learner.ts uncovered LOGIC.
 *
 * Target ranges (per task): 132-151 (getLearnerConfig/updateLearnerConfig + maxPerDay
 * clamp), 237-281 (eventText for every NormalizedEvent type + buildTrajectory truncation,
 * exercised through buildPrompt by capturing the prompt the injected runner receives),
 * 327-363 (defaultRunner ENOENT/exit-code/empty-output via REAL fake binaries; isLearnedDir
 * + resolveSkillDir clobber-avoidance), 448-489 (distillAndWrite failed-runner / write-failed
 * / RAG-copy-failed branches), 615-622 (POST /api/learner/distill/:runId ok + 422).
 *
 * Hermetic: DB + skill/RAG output dirs isolated via env BEFORE any src import (the
 * fn-validation DB-isolation pattern). Routes go through buildServer().inject(); the
 * distiller subprocess is driven either by an injected Runner (deterministic) or a REAL
 * tiny shell binary that prints a fixed SKILL.md / exits non-zero — never the real model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Isolate DB + skill/RAG output dirs BEFORE any src module import ────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-covlearner-'));
process.env.FLEET_DATA_DIR = dataDir;
const SKILLS_DIR = join(dataDir, 'skills');
const RAG_DIR = join(dataDir, 'rag-learned');
process.env.LEARNER_SKILLS_DIR = SKILLS_DIR;
process.env.LEARNER_RAG_DIR = RAG_DIR;

let app: any;
let PORT: number;
let L: typeof import('../src/learner.js');
let dbmod: typeof import('../src/db.js');

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: H() });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const post = (url: string, body: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

/** A completed, operator-launched, complex run. */
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

function ev(runId: string, seq: number, type: string, payload: Record<string, unknown>): any {
  return { sessionId: runId, runId, nodeId: runId, parentNodeId: null, nodeType: 'root', seq, ts: Date.now() + seq, type, payload };
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  dbmod = await import('../src/db.js');
  L = await import('../src/learner.js');
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── 132-151: §31 settings panel — getLearnerConfig / updateLearnerConfig + maxPerDay branch ──
describe('getLearnerConfig / updateLearnerConfig (settings panel)', () => {
  it('getLearnerConfig reflects what updateLearnerConfig persists (round-trips through SQLite)', () => {
    const next = L.updateLearnerConfig({ enabled: true, minSubagents: 7, maxPerDay: 4 });
    expect(next.enabled).toBe(true);
    expect(next.minSubagents).toBe(7);
    expect(next.maxPerDay).toBe(4);

    const read = L.getLearnerConfig();
    expect(read.enabled).toBe(true);
    expect(read.minSubagents).toBe(7);
    expect(read.maxPerDay).toBe(4);
  });

  it('merges a partial patch onto the current config (untouched fields preserved)', () => {
    L.updateLearnerConfig({ minCostUsd: 2.5, minDepth: 9 });
    const merged = L.updateLearnerConfig({ minDurationMs: 123_000 });
    expect(merged.minCostUsd).toBe(2.5); // preserved from prior patch
    expect(merged.minDepth).toBe(9); // preserved
    expect(merged.minDurationMs).toBe(123_000); // updated
  });

  it('accepts maxPerDay === 1 (lower clamp boundary)', () => {
    const out = L.updateLearnerConfig({ maxPerDay: 1 });
    expect(out.maxPerDay).toBe(1);
  });

  it('throws a 400-tagged error for an invalid enabled (non-boolean)', () => {
    let caught: any;
    try { L.updateLearnerConfig({ enabled: 'nope' as any }); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.statusCode).toBe(400);
    expect(String(caught.message)).toMatch(/boolean/i);
  });

  it('throws a 400-tagged error for a fractional maxPerDay (must be an integer)', () => {
    let caught: any;
    try { L.updateLearnerConfig({ maxPerDay: 2.5 }); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.statusCode).toBe(400);
    expect(String(caught.message)).toMatch(/integer/i);
  });

  it('throws a 400-tagged error for maxPerDay < 1', () => {
    let caught: any;
    try { L.updateLearnerConfig({ maxPerDay: 0 }); } catch (e) { caught = e; }
    expect(caught.statusCode).toBe(400);
  });

  it('throws a 400-tagged error for a non-object body', () => {
    let caught: any;
    try { L.updateLearnerConfig(null as any); } catch (e) { caught = e; }
    expect(caught.statusCode).toBe(400);
    expect(String(caught.message)).toMatch(/object/i);
  });

  it('rejects a non-finite numeric field (NaN)', () => {
    let caught: any;
    try { L.updateLearnerConfig({ minCostUsd: NaN }); } catch (e) { caught = e; }
    expect(caught.statusCode).toBe(400);
  });
});

// ── 237-281: eventText (every type) + buildTrajectory, observed via the prompt the runner sees ──
describe('buildTrajectory / eventText through the distiller prompt', () => {
  it('renders every event type into the trajectory and truncates >6000 chars (head…tail)', async () => {
    const run = fakeRun({ resultText: 'FINAL_RESULT_TEXT' });
    dbmod.repo.upsertRun(run as any);

    // One of each recognized type + an ignored "init" + a tool_use without name.
    const events = [
      ev(run.id, 1, 'init', { x: 1 }), // → null (default branch / line 258-260)
      ev(run.id, 2, 'assistant_text', { text: 'PLAN_HEAD_MARKER thinking out loud' }),
      ev(run.id, 3, 'thinking', { text: 'inner reasoning' }),
      ev(run.id, 4, 'agent_message', { text: 'agent says hi' }),
      ev(run.id, 5, 'assistant_text', { text: 123 as any }), // non-string text → null
      ev(run.id, 6, 'tool_result', { text: 'R'.repeat(900) }), // sliced to 600
      ev(run.id, 7, 'tool_result', { notext: true }), // non-string → null
      ev(run.id, 8, 'result', { result: 'a result string' }),
      ev(run.id, 9, 'result', { result: 42 as any }), // non-string → null
      ev(run.id, 10, 'tool_use', { name: 'Bash', input: { command: 'ls' } }),
      ev(run.id, 11, 'tool_use', { name: '', input: undefined }), // empty name + no input → null
      // Bulk filler to exceed MAX_TRAJECTORY_CHARS (6000) and trigger head…tail truncation.
      ev(run.id, 12, 'assistant_text', { text: 'M'.repeat(4000) }),
      ev(run.id, 13, 'assistant_text', { text: 'Z'.repeat(4000) + ' TAIL_OUTCOME_MARKER' }),
    ];
    dbmod.repo.insertEvents(events as any);

    let seenPrompt = '';
    const res = await L.distillAndWrite(
      run as any,
      async (_args, prompt) => {
        seenPrompt = prompt;
        return '---\nname: Traj Skill\ndescription: Use when checking trajectory assembly.\n---\n\n# Traj\n\nBody.';
      },
      { force: true },
    );
    expect(res.status).toBe('ok');

    // Task + final result are in the prompt.
    expect(seenPrompt).toContain('FINAL_RESULT_TEXT');
    expect(seenPrompt).toContain('Trajectory (truncated):');
    // Recognized event prefixes appear.
    expect(seenPrompt).toContain('[assistant_text]');
    expect(seenPrompt).toContain('[thinking]');
    expect(seenPrompt).toContain('[agent_message]');
    expect(seenPrompt).toContain('[tool_result]');
    expect(seenPrompt).toContain('[result]');
    expect(seenPrompt).toContain('[tool_use] Bash');
    // The "init" event produced no text → no [init] line.
    expect(seenPrompt).not.toContain('[init]');
    // tool_result was tail-capped to 600 chars (not the full 900).
    expect(seenPrompt).not.toContain('R'.repeat(700));
    // Truncation: head + the ellipsis sentinel + tail, with the outcome marker retained.
    expect(seenPrompt).toContain('PLAN_HEAD_MARKER');
    expect(seenPrompt).toContain('\n…\n');
    expect(seenPrompt).toContain('TAIL_OUTCOME_MARKER');
  });

  it('a run with no events yields a prompt without a Trajectory section', async () => {
    const run = fakeRun({ resultText: '' });
    dbmod.repo.upsertRun(run as any);
    let seenPrompt = '';
    await L.distillAndWrite(
      run as any,
      async (_a, p) => { seenPrompt = p; return 'SKIP'; },
      { force: true },
    );
    expect(seenPrompt).toContain('Task:');
    expect(seenPrompt).not.toContain('Trajectory (truncated):');
    expect(seenPrompt).not.toContain('Final result:'); // empty resultText filtered out
  });
});

// ── 448-489: distillAndWrite branches — failed runner, write failure, RAG-copy failure ──
describe('distillAndWrite — failure + side-effect branches', () => {
  it('records a "failed" row when the runner rejects (and slices the error to 300 chars)', async () => {
    const run = fakeRun();
    const longMsg = 'E'.repeat(500);
    const res = await L.distillAndWrite(run as any, async () => { throw new Error(longMsg); }, { force: true });
    expect(res.status).toBe('failed');
    expect(res.error!.length).toBe(300);

    const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    const row = skills.find((s) => s.sourceRunId === run.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('failed');
    expect(row.skillPath).toBe(''); // no file written
  });

  it('records a "skipped" row when the model declines (SKIP) — no file', async () => {
    const run = fakeRun();
    const res = await L.distillAndWrite(run as any, async () => '   skip\n', { force: true });
    expect(res.status).toBe('skipped');
    expect(res.skillPath).toBeUndefined();
    const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    const row = skills.find((s) => s.sourceRunId === run.id);
    expect(row.status).toBe('skipped');
    expect(row.error).toMatch(/declined/i);
  });

  it('records a "failed" row when the distiller output is unparseable (no valid frontmatter)', async () => {
    const run = fakeRun();
    // Has a fence but no name/description → parseSkill returns null → failed branch.
    const res = await L.distillAndWrite(run as any, async () => '```\njust prose, no skill\n```', { force: true });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/unparseable/i);
    expect(res.skillPath).toBeUndefined();
    const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    const row = skills.find((s) => s.sourceRunId === run.id);
    expect(row.status).toBe('failed');
    expect(row.skillPath).toBe('');
  });

  it('records a "failed" row when the SKILL.md write throws (skills dir is a FILE, not a dir)', async () => {
    // Point the skills dir at a path that is a regular file → mkdirSync throws (ENOTDIR/EEXIST).
    const blocker = join(dataDir, 'blocker-file');
    writeFileSync(blocker, 'i am a file, not a directory');
    const prev = process.env.LEARNER_SKILLS_DIR;
    process.env.LEARNER_SKILLS_DIR = blocker; // skillsDir() now returns a file path
    try {
      const run = fakeRun();
      const md = '---\nname: WriteFail\ndescription: Use when the write path fails.\n---\n\n# WriteFail\n\nBody.';
      const res = await L.distillAndWrite(run as any, async () => md, { force: true });
      expect(res.status).toBe('failed');
      expect(res.error).toBeTruthy();

      const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
      const row = skills.find((s) => s.sourceRunId === run.id);
      expect(row.status).toBe('failed');
      expect(row.slug).toBe('writefail'); // slug recorded even though the write failed
    } finally {
      process.env.LEARNER_SKILLS_DIR = prev;
    }
  });

  it('still writes the skill (status ok) when the RAG copy fails — RAG dir points at a file', async () => {
    const ragBlocker = join(dataDir, 'rag-blocker-file');
    writeFileSync(ragBlocker, 'not a directory');
    const prev = process.env.LEARNER_RAG_DIR;
    process.env.LEARNER_RAG_DIR = ragBlocker; // ragDir() returns a file → mkdirSync throws
    try {
      const run = fakeRun();
      const md = '---\nname: RagFail\ndescription: Use when the RAG copy fails.\n---\n\n# RagFail\n\nBody.';
      const res = await L.distillAndWrite(run as any, async () => md, { force: true });
      expect(res.status).toBe('ok'); // RAG failure does NOT fail the skill
      expect(res.skillPath).toBeTruthy();
      expect(existsSync(res.skillPath!)).toBe(true);
      expect(res.ragPath).toBeNull(); // RAG copy was best-effort and failed

      const skills = JSON.parse((await get('/api/learner/skills')).payload) as any[];
      const row = skills.find((s) => s.sourceRunId === run.id);
      expect(row.status).toBe('ok');
      expect(row.ragPath).toBeNull();
    } finally {
      process.env.LEARNER_RAG_DIR = prev;
    }
  });
});

// ── 357-363: resolveSkillDir clobber-avoidance via isLearnedDir ──
describe('resolveSkillDir — never clobbers a dir we did not author', () => {
  it('re-learning the SAME slug overwrites OUR dir (learned:true) at the same path', async () => {
    const slug = `relearn-${randomUUID().slice(0, 6)}`;
    const md = (b: string) =>
      `---\nname: ${slug}\ndescription: Use when re-learning the same skill twice.\n---\n\n# ${slug}\n\n${b}`;

    const r1 = await L.distillAndWrite(fakeRun(), async () => md('first body'), { force: true });
    expect(r1.status).toBe('ok');
    const dir1 = join(SKILLS_DIR, `learned-${slug}`);
    expect(existsSync(join(dir1, 'SKILL.md'))).toBe(true);

    const r2 = await L.distillAndWrite(fakeRun(), async () => md('second body'), { force: true });
    expect(r2.status).toBe('ok');
    // Same canonical dir (we authored it → isLearnedDir true → reuse, not -<runid> suffix).
    expect(r2.skillPath).toBe(r1.skillPath);
    expect(readFileSync(r2.skillPath!, 'utf8')).toContain('second body');
  });

  it('a hand-authored (no learned:true) dir at the slug forces a run-suffixed sibling dir', async () => {
    const slug = `handmade-${randomUUID().slice(0, 6)}`;
    // Pre-create a NON-learned dir at the canonical path.
    const handDir = join(SKILLS_DIR, `learned-${slug}`);
    mkdirSync(handDir, { recursive: true });
    writeFileSync(join(handDir, 'SKILL.md'), `---\nname: ${slug}\ndescription: hand authored.\n---\n\n# x\n\nmine`);

    const run = fakeRun();
    const md = `---\nname: ${slug}\ndescription: Use when avoiding a clobber.\n---\n\n# ${slug}\n\nlearned body`;
    const res = await L.distillAndWrite(run as any, async () => md, { force: true });
    expect(res.status).toBe('ok');
    // Did NOT overwrite the hand-authored dir.
    expect(readFileSync(join(handDir, 'SKILL.md'), 'utf8')).toContain('mine');
    // Went to a -<runid-prefix> sibling instead.
    const suffixed = join(SKILLS_DIR, `learned-${slug}-${run.id.slice(0, 6)}`);
    expect(res.skillPath).toBe(join(suffixed, 'SKILL.md'));
    expect(existsSync(res.skillPath!)).toBe(true);
  });
});

// ── 556-574, 584-604: list + DELETE route (rowToSkill, deleteLearnedSkill, 404 path) ──
describe('GET /api/learner/skills + DELETE /api/learner/skills/:id', () => {
  it('lists an ok skill (rowToSkill mapping) then DELETE removes dir + RAG + row → 200', async () => {
    const unique = randomUUID().slice(0, 8);
    const md = `---\nname: Deletable ${unique}\ndescription: Use when testing delete.\n---\n\n# Deletable\n\nBody.`;
    const res = await L.distillAndWrite(fakeRun(), async () => md, { force: true });
    expect(res.status).toBe('ok');
    const dir = join(SKILLS_DIR, `learned-deletable-${unique}`);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(res.ragPath!)).toBe(true);

    // The list maps DB rows → LearnedSkill camelCase (rowToSkill).
    const listed = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    const mine = listed.find((s) => s.id === res.id);
    expect(mine).toMatchObject({ id: res.id, slug: `deletable-${unique}`, status: 'ok' });
    expect(mine.sourceRunId).toBeTruthy();
    expect(typeof mine.createdAt).toBe('number');

    const delRes = await del(`/api/learner/skills/${res.id}`);
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.payload).ok).toBe(true);
    expect(existsSync(dir)).toBe(false); // our dir removed (isLearnedDir true)
    expect(existsSync(res.ragPath!)).toBe(false); // RAG copy removed
    const after = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    expect(after.find((s) => s.id === res.id)).toBeUndefined();
  });

  it('DELETE of an unknown id → 404', async () => {
    const res = await del('/api/learner/skills/nope-not-real');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/not found/i);
  });

  it('DELETE leaves a hand-authored dir at the recorded path untouched (only removes the row)', async () => {
    // Distill ok, then overwrite the on-disk SKILL.md to strip learned:true so
    // deleteLearnedSkill's isLearnedDir guard refuses to rm the dir but still drops the row.
    const unique = randomUUID().slice(0, 8);
    const md = `---\nname: Guarded ${unique}\ndescription: Use when testing the delete guard.\n---\n\n# Guarded\n\nBody.`;
    const res = await L.distillAndWrite(fakeRun(), async () => md, { force: true });
    expect(res.status).toBe('ok');
    // Strip provenance → now looks hand-authored.
    writeFileSync(res.skillPath!, `---\nname: x\ndescription: hand authored now.\n---\n\n# x\n\nkeepme`);

    const delRes = await del(`/api/learner/skills/${res.id}`);
    expect(delRes.statusCode).toBe(200);
    // Dir survives (guard refused to remove a non-learned dir)…
    expect(existsSync(res.skillPath!)).toBe(true);
    expect(readFileSync(res.skillPath!, 'utf8')).toContain('keepme');
    // …but the row is gone.
    const after = JSON.parse((await get('/api/learner/skills')).payload) as any[];
    expect(after.find((s) => s.id === res.id)).toBeUndefined();
  });
});

// ── 327-344: defaultRunner — REAL subprocess via the registered POST route (615-622) ──
describe('POST /api/learner/distill/:runId (defaultRunner real subprocess)', () => {
  it('404 when the run does not exist', async () => {
    const res = await post('/api/learner/distill/no-such-run');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/not found/i);
  });

  it('drives the REAL claude binary (a fake shell) end-to-end → ok skill written', async () => {
    const okBin = join(dataDir, 'fake-ok-distiller.sh');
    writeFileSync(
      okBin,
      `#!/bin/sh\ncat >/dev/null\ncat <<'EOF'\n---\nname: Real Subprocess Skill\ndescription: Use when exercising the defaultRunner subprocess path.\n---\n\n# Real\n\nbody\nEOF\n`,
      { mode: 0o755 },
    );
    chmodSync(okBin, 0o755);
    const prevBin = process.env.LEARNER_CLAUDE_BIN;
    process.env.LEARNER_CLAUDE_BIN = okBin;
    try {
      const run = fakeRun({ task: `real-subproc-${randomUUID()}` });
      dbmod.repo.upsertRun(run as any);
      const res = await post(`/api/learner/distill/${run.id}`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
      expect(body.slug).toBe('real-subprocess-skill');
      expect(existsSync(body.skillPath)).toBe(true);
    } finally {
      process.env.LEARNER_CLAUDE_BIN = prevBin;
    }
  });

  it('422 when the distiller exits non-zero (real subprocess close handler → failed)', async () => {
    const failBin = join(dataDir, 'fake-fail-distiller.sh');
    writeFileSync(failBin, `#!/bin/sh\ncat >/dev/null\necho "boom on stderr" 1>&2\nexit 7\n`, { mode: 0o755 });
    chmodSync(failBin, 0o755);
    const prevBin = process.env.LEARNER_CLAUDE_BIN;
    process.env.LEARNER_CLAUDE_BIN = failBin;
    try {
      const run = fakeRun({ task: `fail-subproc-${randomUUID()}` });
      dbmod.repo.upsertRun(run as any);
      const res = await post(`/api/learner/distill/${run.id}`);
      expect(res.statusCode).toBe(422); // result.status !== 'ok'
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('failed');
      expect(String(body.error)).toMatch(/exited 7|boom/);
    } finally {
      process.env.LEARNER_CLAUDE_BIN = prevBin;
    }
  });

  it('422 when the real binary is missing (ENOENT → "claude binary not found")', async () => {
    const prevBin = process.env.LEARNER_CLAUDE_BIN;
    const prevBin2 = process.env.CLAUDE_BIN;
    process.env.LEARNER_CLAUDE_BIN = join(dataDir, 'definitely-missing-binary-xyz');
    delete process.env.CLAUDE_BIN;
    try {
      const run = fakeRun({ task: `enoent-subproc-${randomUUID()}` });
      dbmod.repo.upsertRun(run as any);
      const res = await post(`/api/learner/distill/${run.id}`);
      expect(res.statusCode).toBe(422);
      expect(String(JSON.parse(res.payload).error)).toMatch(/not found/i);
    } finally {
      process.env.LEARNER_CLAUDE_BIN = prevBin;
      if (prevBin2 !== undefined) process.env.CLAUDE_BIN = prevBin2;
    }
  });

  it('422 when the distiller returns empty output (close handler → empty-output reject)', async () => {
    const emptyBin = join(dataDir, 'fake-empty-distiller.sh');
    writeFileSync(emptyBin, `#!/bin/sh\ncat >/dev/null\nexit 0\n`, { mode: 0o755 });
    chmodSync(emptyBin, 0o755);
    const prevBin = process.env.LEARNER_CLAUDE_BIN;
    process.env.LEARNER_CLAUDE_BIN = emptyBin;
    try {
      const run = fakeRun({ task: `empty-subproc-${randomUUID()}` });
      dbmod.repo.upsertRun(run as any);
      const res = await post(`/api/learner/distill/${run.id}`);
      expect(res.statusCode).toBe(422);
      expect(String(JSON.parse(res.payload).error)).toMatch(/empty/i);
    } finally {
      process.env.LEARNER_CLAUDE_BIN = prevBin;
    }
  });
});
