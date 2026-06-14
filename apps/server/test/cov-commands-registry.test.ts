/**
 * cov-commands-registry — the EXTENDED verb set: a safe verb renders a result, a danger
 * verb parks an Inbox approval (never executes), and listCommands() exposes the full set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { enqueueSpy, stopAllSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn((_i: any) => 'appr-1'),
  stopAllSpy: vi.fn(() => 3),
}));

vi.mock('../src/inbox.js', () => ({ enqueueApproval: enqueueSpy }));

// stopAll must NOT be called when /stop-all is danger-gated.
vi.mock('../src/registry.js', () => ({
  registry: {
    listRuns: vi.fn(() => [{ id: 'a1', status: 'running', model: 'opus', task: 'do x', cwd: '/r' }]),
    stopAll: stopAllSpy,
    stop: vi.fn(),
    launch: vi.fn(async () => ({ id: 'r1' })),
    resume: vi.fn(() => ({ id: 'r1' })),
    spend: vi.fn(() => ({ todayUsd: 1.5, activeRuns: 0, totalRunsToday: 4 })),
  },
}));
vi.mock('../src/addons.js', () => ({
  listAddonInfos: vi.fn(async () => [{ id: 'compression', enabled: true, status: 'running' }]),
  setAddonEnabledById: vi.fn(async (id: string, en: boolean) => ({ id, enabled: en, status: en ? 'running' : 'disabled' })),
}));
vi.mock('../src/campaigns.js', () => ({ campaigns: { create: vi.fn(async () => ({ id: 'camp-1' })) } }));
vi.mock('../src/git.js', () => ({
  statusPorcelain: vi.fn(async () => ({ entries: [
    { code: ' M', path: 'src/a.ts', origPath: null },
    { code: '??', path: 'new.ts', origPath: null },
  ] })),
  gitLog: vi.fn(async () => ({ entries: [
    { hash: 'abc1234def', author: 'jd', time: 1700000000, subject: 'fix thing', isMerge: false },
  ] })),
}));

import { dispatchCommand, listCommands } from '../src/commands.js';

beforeEach(() => { enqueueSpy.mockClear(); stopAllSpy.mockClear(); });

describe('listCommands', () => {
  it('returns wire CommandDefs with NO run() field', () => {
    const cmds = listCommands();
    expect(cmds.length).toBeGreaterThanOrEqual(8);
    for (const c of cmds) {
      expect(typeof c.name).toBe('string');
      expect(['control', 'project', 'knowledge', 'config', 'meta']).toContain(c.group);
      expect(typeof c.usage).toBe('string');
      expect(Array.isArray(c.args)).toBe(true);
      expect((c as any).run).toBeUndefined(); // server-only fn is stripped
    }
  });
  it('the kill command declares a run-id arg sourced from running-runs', () => {
    const kill = listCommands().find((c) => c.name === 'kill')!;
    expect(kill).toBeTruthy();
    expect(kill.args[0]).toMatchObject({ name: 'run-id', required: true, type: 'run-id', source: 'running-runs' });
  });
  it('marks at least one destructive verb danger:true', () => {
    expect(listCommands().some((c) => c.danger === true)).toBe(true);
  });
});

describe('danger verbs route to the Inbox', () => {
  it('/stop-all parks an approval and does NOT execute', async () => {
    const r = await dispatchCommand('/stop-all', '/repo');
    expect(r.ok).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0]).toMatchObject({ command: 'stop-all', cwd: '/repo' });
    expect(stopAllSpy).not.toHaveBeenCalled();
    expect(String(r.text)).toMatch(/approv/i);
  });
});

describe('safe registry verbs', () => {
  it('/agents returns a table of non-terminal runs', async () => {
    const r = await dispatchCommand('/agents', '/repo');
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['id', 'status', 'model', 'task']);
  });
  it('/spend returns a text line with today\'s spend', async () => {
    const r = await dispatchCommand('/spend', '/repo');
    expect(r.kind).toBe('text');
    expect(String(r.text)).toMatch(/\$1\.50/);
    expect(String(r.text)).toMatch(/4 run/);
  });
  it('/launch with no prompt errors', async () => {
    const r = await dispatchCommand('/launch', '/repo');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('error');
  });
  it('/launch <prompt> starts a run and returns its id', async () => {
    const r = await dispatchCommand('/launch fix the build', '/work');
    expect(r.ok).toBe(true);
    expect(r.runId).toBe('r1');
  });
  it('/stop <id> stops a single run', async () => {
    const r = await dispatchCommand('/stop r1', '/repo');
    expect(r.ok).toBe(true);
  });
  it('/stop with no id errors', async () => {
    const r = await dispatchCommand('/stop', '/repo');
    expect(r.ok).toBe(false);
  });
});

describe('/git', () => {
  it('/git status renders a 2-column change table', async () => {
    const r = await dispatchCommand('/git status', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['status', 'path']);
    expect(r.rows).toEqual([[' M', 'src/a.ts'], ['??', 'new.ts']]);
  });
  it('/git log renders a commit table', async () => {
    const r = await dispatchCommand('/git log', '/repo');
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['hash', 'subject', 'author']);
    expect(r.rows![0][0]).toBe('abc1234');
  });
  it('/git with no subcommand errors', async () => {
    const r = await dispatchCommand('/git', '/repo');
    expect(r.ok).toBe(false);
  });
});
