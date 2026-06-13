import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cpghw-'));

const calls: any[] = [];
vi.mock('../src/gh.js', () => ({
  ghExec: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
  resolveRemote: vi.fn(async () => ({ url: 'https://github.com/acme/widgets.git', resolves: true })),
  ghLabelAdd: vi.fn(async (_root: string, n: number, label: string) => { calls.push(['add', n, label]); return { ok: true }; }),
  ghLabelRemove: vi.fn(async (_root: string, n: number, label: string) => { calls.push(['remove', n, label]); return { ok: true }; }),
  ghIssueComment: vi.fn(async (_root: string, n: number, body: string) => { calls.push(['comment', n, body]); return { ok: true }; }),
}));

let cp: typeof import('../src/controlplane.js');
const project: any = { id: 'p1', rootDir: '/tmp/proj', remoteName: 'origin' };
const loop: any = { id: 'l1', projectId: 'p1', kind: 'manager', controlPlane: 'github', mode: 'apply', routableCeiling: 'low' };

beforeAll(async () => {
  cp = await import('../src/controlplane.js');
});

describe('github adapter writes (mocked gh verbs)', () => {
  it('classify(agentReady) adds risk/type + agent:ready, removes needs:human', async () => {
    calls.length = 0;
    const adapter = cp.githubControlPlane(loop, project);
    await adapter.classify('42', { risk: 'low', type: 'bug', agentReady: true, reason: 'simple' });
    expect(calls).toContainEqual(['add', 42, 'risk:low']);
    expect(calls).toContainEqual(['add', 42, 'type:bug']);
    expect(calls).toContainEqual(['add', 42, 'agent:ready']);
    expect(calls).toContainEqual(['remove', 42, 'needs:human']);
  });

  it('classify(!agentReady) adds risk/type + needs:human, removes agent:ready', async () => {
    calls.length = 0;
    const adapter = cp.githubControlPlane(loop, project);
    await adapter.classify('9', { risk: 'high', type: 'feature', agentReady: false, reason: 'risky' });
    expect(calls).toContainEqual(['add', 9, 'risk:high']);
    expect(calls).toContainEqual(['add', 9, 'type:feature']);
    expect(calls).toContainEqual(['add', 9, 'needs:human']);
    expect(calls).toContainEqual(['remove', 9, 'agent:ready']);
  });

  it('postAssessment posts a comment', async () => {
    calls.length = 0;
    const adapter = cp.githubControlPlane(loop, project);
    await adapter.postAssessment('42', '## Agent Assessment\nRisk: low');
    expect(calls).toContainEqual(['comment', 42, '## Agent Assessment\nRisk: low']);
  });

  it('attachQuestions posts a question comment and adds needs:human', async () => {
    calls.length = 0;
    const adapter = cp.githubControlPlane(loop, project);
    await adapter.attachQuestions('42', ['Which DB?', 'Auth impact?']);
    const comment = calls.find((c) => c[0] === 'comment');
    expect(comment[1]).toBe(42);
    expect(comment[2]).toContain('Which DB?');
    expect(comment[2]).toContain('Auth impact?');
    expect(calls).toContainEqual(['add', 42, 'needs:human']);
  });
});

describe('controlPlaneFor github branch', () => {
  it('apply-mode github loop performs real writes (intended stays empty)', async () => {
    calls.length = 0;
    const { cp: adapter, intended } = cp.controlPlaneFor({ ...loop, mode: 'apply' }, project);
    await adapter.classify('42', { risk: 'low', type: 'bug', agentReady: true, reason: 'ok' });
    expect(calls).toContainEqual(['add', 42, 'risk:low']);
    expect(intended).toEqual([]);
  });

  it('dry-run github loop intercepts writes into intended[] and performs NO gh writes', async () => {
    calls.length = 0;
    const { cp: adapter, intended } = cp.controlPlaneFor({ ...loop, mode: 'dry-run' }, project);
    await adapter.classify('42', { risk: 'low', type: 'bug', agentReady: true, reason: 'ok' });
    expect(calls).toEqual([]); // no real gh verb called
    expect(intended.find((a) => a.kind === 'classify' && a.itemId === '42')).toBeTruthy();
  });
});
