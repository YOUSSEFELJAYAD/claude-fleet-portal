/**
 * Engine degradation invariant (spec §3 D8, §12): an engine (codex/opencode) chat session
 * presents a uniform "resume" UX but is honestly one-shot. This test pins two facts:
 *   1. registry.resume() STILL rejects an engine run with HTTP 409 (code 'engine-unsupported').
 *   2. chat.startTurn() NEVER calls registry.resume() for an engine session — every turn
 *      re-launches via registry.launchEngine() with the reconstructed buildEnginePrompt
 *      transcript (emulated resume), so the 409 path is unreachable from chat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-engine-'));

vi.mock('../src/registry.js', () => ({
  registry: {
    launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
    resume: vi.fn(async () => { throw Object.assign(new Error('Resume is not supported on engine add-on runs.'), { statusCode: 409, code: 'engine-unsupported' }); }),
    launchEngine: vi.fn(async (req: any) => ({ id: 'run-engine', sessionId: 's', status: 'running', ...req })),
  },
}));

describe('engine chat resume degradation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('re-launches via launchEngine every turn and never calls registry.resume() for an engine session', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn, chatTurns } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: '/tmp/eng', engine: 'codex', model: 'gpt-5-codex' });

    // Turn 1
    const t1 = await startTurn(s.id, 'first engine turn');
    expect(t1.runId).toBe('run-engine');
    expect((registry.launchEngine as any)).toHaveBeenCalledTimes(1);
    expect((registry.resume as any)).not.toHaveBeenCalled();

    // The mock never drives settlement; simulate it so the guard allows turn 2.
    chatTurns._resetForTest();

    // Turn 2 — even though a runId is now stored, it must NOT resume; it re-launches.
    const t2 = await startTurn(s.id, 'second engine turn');
    expect(t2.runId).toBe('run-engine');
    expect((registry.launchEngine as any)).toHaveBeenCalledTimes(2);
    expect((registry.resume as any)).not.toHaveBeenCalled();

    // The emulated-resume prompt of turn 2 carries the reconstructed transcript prefix.
    const turn2Arg = (registry.launchEngine as any).mock.calls.at(-1)[0];
    expect(turn2Arg.engine).toBe('codex');
    expect(turn2Arg.prompt).toContain('first engine turn');   // prior turn reconstructed
    expect(turn2Arg.prompt).toContain('second engine turn');  // current message
  });

  it('registry.resume() still rejects an engine run with 409 engine-unsupported (the path chat avoids)', async () => {
    const { registry } = await import('../src/registry.js');
    await expect((registry.resume as any)('any-engine-run')).rejects.toMatchObject({ statusCode: 409, code: 'engine-unsupported' });
  });
});

describe('engineSafeState — engines never go live', () => {
  it('forces live:false and demotes a "live" derived state to idle for engines', async () => {
    const { engineSafeState } = await import('../src/chat.js');
    expect(engineSafeState('codex', { state: 'live', live: true })).toEqual({ state: 'idle', live: false });
    expect(engineSafeState('opencode', { state: 'running', live: true })).toEqual({ state: 'running', live: false });
  });
  it('passes claude session state through untouched', async () => {
    const { engineSafeState } = await import('../src/chat.js');
    expect(engineSafeState('claude', { state: 'live', live: true })).toEqual({ state: 'live', live: true });
  });
});
