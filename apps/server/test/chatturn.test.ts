/**
 * Task 1.3 — turn orchestration with server-declared boundaries (chatTurn.ts).
 *
 * Real-process: a fake CLAUDE_BIN (interactive + one-shot) and a fake OPENCODE_BIN drive the
 * registry exactly as retry.test.ts / cov-processManager.test.ts do — env is set BEFORE any src
 * import so config.ts reads it. The turn orchestrator is exercised end-to-end through the real
 * registry, chatLive, parser and tree (no mocks).
 *
 * Cases:
 *  (a) claude live happy path: turn:start → turn:event(assistant_text) → turn:settled, and
 *      listTurns shows the user + assistant message under ONE turnId.
 *  (b) engine (opencode): one launchEngine, settles on the completed terminal.
 *  (c) kill→resume mid-turn keeps the SAME turnId (backing run changes underneath).
 *  (d) interrupt → turn:failed.
 *  (e) no live slot → one-shot fallback, still one turn.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Isolate BEFORE any src/ import ───────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-chatturn-'));

// Fake claude: speaks stream-json. Interactive (--input-format present) echoes each stdin user
// message as an assistant_text + result; '__HOLD__' emits assistant_text but withholds the result
// (turn stays active for the kill→resume / interrupt cases); '__BYE__' exits. One-shot emits a
// fixed assistant_text + result for the prompt after '--', then exits 0.
const fakeClaude = join(dataDir, 'fake-claude.mjs');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const argv = process.argv.slice(2);
const sidIdx = argv.indexOf('--session-id');
const resumeIdx = argv.indexOf('--resume');
const sid = sidIdx >= 0 ? argv[sidIdx + 1] : (resumeIdx >= 0 ? argv[resumeIdx + 1] : '00000000-0000-0000-0000-000000000000');
const interactive = argv.includes('--input-format');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const init = () => line({ type: 'system', subtype: 'init', session_id: sid, tools: [], mcp_servers: [], model: 'claude-haiku-4-5', cwd: process.cwd(), permissionMode: 'default', apiKeySource: 'env' });
const assistant = (t) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: { input_tokens: 1, output_tokens: 1 } } });
const result = (t) => line({ type: 'result', subtype: 'success', session_id: sid, result: t, total_cost_usd: 0, is_error: false });
if (interactive) {
  init();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c; let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      let text = ''; try { text = JSON.parse(raw)?.message?.content?.[0]?.text ?? ''; } catch {}
      if (text === '__BYE__') { process.exit(0); }
      else if (text === '__HOLD__') { assistant('held'); /* withhold result → turn stays active */ }
      else { assistant('echo: ' + text); result('echo: ' + text); }
    }
  });
} else {
  const dd = argv.indexOf('--');
  const prompt = dd >= 0 ? argv[dd + 1] : 'oneshot';
  init();
  assistant('reply: ' + prompt);
  result('reply: ' + prompt);
  // natural exit so the piped stdout fully flushes (process.exit would truncate)
}
`,
);
chmodSync(fakeClaude, 0o755);

// Fake opencode engine: emits an assistant text part + a usage step then exits 0.
const fakeOpencode = join(dataDir, 'fake-opencode.mjs');
writeFileSync(
  fakeOpencode,
  `#!/usr/bin/env node
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'text', part: { text: 'engine done' } });
line({ type: 'step_finish', part: { tokens: { input: 3, output: 2 } } });
`,
);
chmodSync(fakeOpencode, 0o755);

process.env.FLEET_DATA_DIR = dataDir;
process.env.CLAUDE_BIN = fakeClaude;
process.env.OPENCODE_BIN = fakeOpencode;
process.env.FLEET_CHAT_LIVE_MAX = '1'; // one chat slot → easy to exhaust for the one-shot case
process.env.MOCK_DELAY_MS = '0';

// ── Imports (AFTER env) ───────────────────────────────────────────────────────
let chatTurns: any, chatRepo: any, registry: any, chatLive: any, db: any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
};

beforeAll(async () => {
  ({ registry } = await import('../src/registry.js')); // creates DB + addons table
  ({ chatTurns } = await import('../src/chatTurn.js'));
  ({ chatRepo } = await import('../src/chatRepo.js'));
  ({ chatLive } = await import('../src/chatLive.js'));
  ({ default: db } = await import('../src/db.js'));
  // Enable the opencode engine add-on so launchEngine accepts it (bin comes from OPENCODE_BIN).
  db.prepare(
    `INSERT INTO addons (id, enabled, config, updated_at) VALUES ('opencode', 1, '{}', ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 1`,
  ).run(Date.now());
}, 30_000);

afterEach(() => {
  try { registry.stopAll(); } catch { /* */ }
  try { chatTurns._resetForTest(); } catch { /* */ }
  try { chatLive._resetForTest(); } catch { /* */ }
});
afterAll(() => { try { registry.stopAll(); } catch { /* */ } });

function collect(sessionId: string) {
  const frames: any[] = [];
  const unsub = chatTurns.subscribe(sessionId, (f: any) => frames.push(f));
  return { frames, unsub };
}
const assistantTexts = (frames: any[]) =>
  frames.filter((f) => f.kind === 'turn:event' && f.event?.type === 'assistant_text').map((f) => String(f.event.payload?.text ?? ''));

describe('chatTurns — server-declared turn boundaries', () => {
  it('(a) claude live happy path: turn:start → turn:event(assistant_text) → turn:settled, one turnId', async () => {
    const s = chatRepo.createSession({ cwd: dataDir });
    const { frames } = collect(s.id);

    const { turnId } = await chatTurns.startTurn(s.id, 'hello');
    expect(turnId).toBeTruthy();

    const settled = await waitFor(() => frames.some((f) => f.kind === 'turn:settled'));
    expect(settled).toBe(true);

    // first frame is turn:start carrying the user message under the turnId
    expect(frames[0].kind).toBe('turn:start');
    expect(frames[0].turn.id).toBe(turnId);
    expect(frames[0].turn.messages[0].content).toBe('hello');

    // an assistant_text turn:event arrived under the same turnId
    expect(assistantTexts(frames)).toContain('echo: hello');
    expect(frames.filter((f) => f.kind === 'turn:event').every((f) => f.turnId === turnId)).toBe(true);

    // exactly one settle, carrying a real assistant message id
    const settles = frames.filter((f) => f.kind === 'turn:settled');
    expect(settles.length).toBe(1);
    expect(settles[0].turnId).toBe(turnId);
    expect(settles[0].assistantMessageId).toBeTruthy();

    // persistence: user + assistant under ONE turnId
    const turns = chatRepo.listTurns(s.id);
    const turn = turns.find((t: any) => t.id === turnId);
    expect(turn).toBeDefined();
    const roles = turn.messages.map((m: any) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(turn.messages[1].content).toBe('echo: hello');
    expect(turn.messages.every((m: any) => m.turnId === turnId)).toBe(true);
  }, 20_000);

  it('(b) engine session: one launchEngine, settles on terminal under one turnId', async () => {
    const s = chatRepo.createSession({ cwd: dataDir, engine: 'opencode', model: 'opencode-model' });
    const { frames } = collect(s.id);

    const { turnId } = await chatTurns.startTurn(s.id, 'engine please');

    const settled = await waitFor(() => frames.some((f) => f.kind === 'turn:settled'));
    expect(settled).toBe(true);

    expect(frames[0].kind).toBe('turn:start');
    expect(assistantTexts(frames)).toContain('engine done');

    const turns = chatRepo.listTurns(s.id);
    const turn = turns.find((t: any) => t.id === turnId);
    expect(turn.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(turn.messages[1].content).toBe('engine done');
  }, 20_000);

  it('(c) kill→resume mid-turn keeps the SAME turnId across a backing-run change', async () => {
    const s = chatRepo.createSession({ cwd: dataDir });
    const { frames } = collect(s.id);

    // Start a turn that emits assistant_text then HOLDS (no result) → turn stays active.
    const { turnId, runId: runA } = await chatTurns.startTurn(s.id, '__HOLD__');
    await waitFor(() => assistantTexts(frames).includes('held'));

    // A fresh backing run B is announced (mirrors a resume minting a new run). The orchestrator
    // must re-subscribe to B and keep emitting under the ORIGINAL turnId.
    const B = await registry.launch({ prompt: '', cwd: dataDir, model: 'claude-haiku-4-5', effort: 'low', permissionMode: 'default', interactive: true, humanGate: false });
    chatLive.notifyBackingRun(s.id, B.id);
    // "stop the backing run" — A's terminal is now ignored (we moved off it).
    registry.stop(runA);

    // Drive run B to completion → the turn settles under the original turnId.
    await sleep(50);
    registry.sendInput(B.id, 'resumed');

    const settled = await waitFor(() => frames.some((f) => f.kind === 'turn:settled'));
    expect(settled).toBe(true);

    // every turn-frame carried the ORIGINAL turnId; both runs' assistant text showed up
    expect(frames.filter((f) => f.kind.startsWith('turn:')).every((f) => f.turnId === turnId || f.turn?.id === turnId)).toBe(true);
    const texts = assistantTexts(frames);
    expect(texts).toContain('held');           // from run A
    expect(texts).toContain('echo: resumed');  // from run B
    expect(frames.filter((f) => f.kind === 'turn:settled').length).toBe(1);

    // one turn, both assistant chunks persisted under it
    const turn = chatRepo.listTurns(s.id).find((t: any) => t.id === turnId);
    expect(turn.messages.filter((m: any) => m.role === 'user').length).toBe(1);
    registry.stop(B.id);
  }, 25_000);

  it('(d) interrupt: stopping the backing run mid-turn fails the turn', async () => {
    const s = chatRepo.createSession({ cwd: dataDir });
    const { frames } = collect(s.id);

    const { turnId, runId } = await chatTurns.startTurn(s.id, '__HOLD__');
    await waitFor(() => assistantTexts(frames).includes('held'));

    registry.stop(runId); // user interrupt

    const failed = await waitFor(() => frames.some((f) => f.kind === 'turn:failed'));
    expect(failed).toBe(true);
    const fail = frames.find((f) => f.kind === 'turn:failed');
    expect(fail.turnId).toBe(turnId);
    expect(chatTurns.activeTurn(s.id)).toBeNull();
  }, 20_000);

  it('(f) concurrent turn guard: rejects 409 while first is active; succeeds after settle', async () => {
    const s = chatRepo.createSession({ cwd: dataDir });
    const { frames } = collect(s.id);

    const { turnId, runId } = await chatTurns.startTurn(s.id, '__HOLD__');
    await waitFor(() => assistantTexts(frames).includes('held'));

    // Must reject with 409 while first turn is still streaming.
    await expect(chatTurns.startTurn(s.id, 'concurrent')).rejects.toMatchObject({ statusCode: 409 });

    // Interrupt the first turn; wait for it to fail.
    registry.stop(runId);
    await waitFor(() => frames.some((f: any) => f.kind === 'turn:failed'));
    expect(chatTurns.activeTurn(s.id)).toBeNull();

    // In production chatLive.init()'s onRunTerminal drops the handle automatically; simulate that.
    chatLive.evict(s.id);

    // After the first turn settles, a new turn for the same session must succeed.
    const { frames: frames2 } = collect(s.id);
    const { turnId: turnId2 } = await chatTurns.startTurn(s.id, 'after-settle');
    expect(turnId2).toBeTruthy();
    expect(turnId2).not.toBe(turnId);
    await waitFor(() => frames2.some((f: any) => f.kind === 'turn:settled'));
  }, 25_000);

  it('(e) no live slot → one-shot fallback, still one turn settled', async () => {
    // Occupy the single chat slot with a throwaway live session.
    const filler = chatRepo.createSession({ cwd: dataDir });
    await chatLive.ensureLive(filler);
    expect(chatLive.isLive(filler.id)).toBe(true);

    const s = chatRepo.createSession({ cwd: dataDir });
    const { frames } = collect(s.id);

    const { turnId, runId } = await chatTurns.startTurn(s.id, 'fallback');
    // a one-shot fresh run (not the filler's held run)
    expect(chatLive.liveRunId(s.id)).toBeNull();
    expect(runId).not.toBe(chatLive.liveRunId(filler.id));

    const settled = await waitFor(() => frames.some((f) => f.kind === 'turn:settled'));
    expect(settled).toBe(true);

    const turn = chatRepo.listTurns(s.id).find((t: any) => t.id === turnId);
    expect(turn.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(turn.messages[1].content).toBe('reply: fallback');
  }, 20_000);
});
