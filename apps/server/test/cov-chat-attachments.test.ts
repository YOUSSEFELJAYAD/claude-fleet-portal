import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-attach-'));

// Fix 07 — dir attachments are now containment-checked against the session's server-trusted
// workspace root before reaching --add-dir, so the session cwd must be a REAL directory that
// contains the attached folder; an in-root `src/` resolves and survives as its absolute path.
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-test-chat-ws-')));
mkdirSync(join(workspace, 'src'));
writeFileSync(join(workspace, 'src', 'x.ts'), 'x');

vi.mock('../src/registry.js', () => ({
  registry: {
    launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
    resume: vi.fn(async (id: string) => ({ id: 'run-resume', sessionId: 's', status: 'running' })),
    launchEngine: vi.fn(async (req: any) => ({ id: 'run-engine', ...req })),
    sendInput: vi.fn(),
  },
}));

// Fix 03 — claude turns now route through chatLive.ensureLive first. These cases pin the
// resumable/one-shot fallback (launch/resume) that carries attachments → --add-dir, so force the
// budget-exhausted signal (live:false) to keep exercising that path.
vi.mock('../src/chatLive.js', () => ({
  chatLive: {
    ensureLive: vi.fn(async () => ({ live: false, runId: null })),
    touch: vi.fn(),
    isLive: vi.fn(() => false),
    liveRunId: vi.fn(() => null),
    init: vi.fn(),
  },
}));

describe('startTurn with attachments', () => {
  it('appends file path-references to the prompt and passes dirs as addDirs', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: workspace });
    const t = await startTurn(s.id, 'review this', [
      { path: 'src/x.ts', kind: 'file' },
      { path: 'src', kind: 'dir' },
    ]);
    const launchArg = (registry.launch as any).mock.calls.at(-1)[0];
    expect(launchArg.prompt).toContain('review this');
    expect(launchArg.prompt).toContain('src/x.ts'); // file → path reference in the prompt
    // Fix 07 — the in-root dir survives containment as its RESOLVED ABSOLUTE path.
    expect(launchArg.addDirs).toContain(join(workspace, 'src'));
    // persisted on the user message
    expect(t.userMessage.attachments).toEqual([
      { path: 'src/x.ts', kind: 'file' },
      { path: 'src', kind: 'dir' },
    ]);
  });

  it('a turn with no attachments persists none and adds no addDirs', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: '/tmp/b' });
    const t = await startTurn(s.id, 'plain');
    const launchArg = (registry.launch as any).mock.calls.at(-1)[0];
    expect(launchArg.addDirs).toBeUndefined();
    expect(t.userMessage.attachments).toBeUndefined();
  });
});
