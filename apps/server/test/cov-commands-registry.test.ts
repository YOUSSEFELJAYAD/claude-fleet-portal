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
  researchConfig: vi.fn(() => ({ searxngUrl: 'http://s', maxResults: 5, engines: '', safeSearch: 1, language: 'en' })),
}));
vi.mock('../src/research.js', () => ({ searchWeb: vi.fn(async () => [{ title: 'T', url: 'https://x', content: 'c' }]) }));
vi.mock('../src/planboard.js', () => ({ planboardRepo: { list: vi.fn(() => [{ id: 'd1', status: 'ready', plan: [{ id: 't1', title: 'setup', prompt: 'do setup' }, { id: 't2', title: 'impl', prompt: 'do impl' }] }]) } }));
vi.mock('../src/kanban.js', () => ({ kanbanRepo: { listTasks: vi.fn(() => [{ id: 'k1', column: 'Backlog', title: 'do x' }]) } }));
vi.mock('../src/db.js', () => ({ repo: { listTemplates: vi.fn(() => [{ id: 't1', name: 'orchestrator', role: 'orchestrator' }]) } }));
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

describe('operational verbs execute directly', () => {
  it('/stop-all stops every run directly (operational, NOT inbox-gated)', async () => {
    const r = await dispatchCommand('/stop-all', '/repo');
    expect(r.ok).toBe(true);
    expect(stopAllSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(String(r.text)).toMatch(/stopped 3 run/);
  });
});

describe('danger verbs route to the Inbox', () => {
  it('/reset-data parks an approval and does NOT execute', async () => {
    const r = await dispatchCommand('/reset-data', '/repo');
    expect(r.ok).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0]).toMatchObject({ command: 'reset-data', cwd: '/repo' });
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

describe('read + project verbs', () => {
  it('/research <topic> returns a results table', async () => {
    const r = await dispatchCommand('/research vector dbs', '/repo');
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['title', 'url']);
  });
  it('/research with no topic errors', async () => {
    expect((await dispatchCommand('/research', '/repo')).ok).toBe(false);
  });
  it('/addons lists add-ons', async () => {
    const r = await dispatchCommand('/addons', '/repo');
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['id', 'enabled', 'status']);
  });
  it('/board <projectId> lists plan drafts with correct task count', async () => {
    const r = await dispatchCommand('/board p1', '/repo');
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['id', 'status', 'tasks']);
    // The mock returns a draft with plan: [{t1}, {t2}] — tasks column must show "2", not "0"
    expect(r.rows![0]).toEqual(['d1', 'ready', '2']);
  });
  it('/board with no project errors', async () => {
    expect((await dispatchCommand('/board', '/repo')).ok).toBe(false);
  });
  it('/task <projectId> lists kanban tasks', async () => {
    const r = await dispatchCommand('/task p1', '/repo');
    expect(r.kind).toBe('table');
  });
  it('/template lists templates', async () => {
    const r = await dispatchCommand('/template', '/repo');
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['id', 'name', 'role']);
  });
  it('/files points at the workspace picker (text)', async () => {
    expect((await dispatchCommand('/files', '/repo')).kind).toBe('text');
  });
  it('/search points at the search page (text)', async () => {
    expect((await dispatchCommand('/search foo', '/repo')).kind).toBe('text');
  });
  it('/memory points at the memory page (text)', async () => {
    expect((await dispatchCommand('/memory', '/repo')).kind).toBe('text');
  });
  it('/schedule points at the schedules page (text)', async () => {
    expect((await dispatchCommand('/schedule', '/repo')).kind).toBe('text');
  });
  it('/releases points at the releases page (text)', async () => {
    expect((await dispatchCommand('/releases', '/repo')).kind).toBe('text');
  });
  it('/help lists the registry verbs', async () => {
    const r = await dispatchCommand('/help', '/repo');
    expect(r.kind).toBe('text');
    expect(String(r.text)).toMatch(/\/launch/);
    expect(String(r.text)).toMatch(/\/git/);
  });
});

describe('full registry coverage', () => {
  const EXPECTED = [
    'launch','resume','sessions','stop','stop-all','agents','research','search','git','files',
    'board','task','schedule','template','memory','spend','addons','releases','help',
    'reset-data','self-update',
  ];
  it('listCommands() exposes every curated verb and strips run()', () => {
    const cmds = listCommands();
    const names = cmds.map((c) => c.name);
    for (const v of EXPECTED) expect(names).toContain(v);
    expect(names.length).toBeGreaterThanOrEqual(18);
    for (const c of cmds) expect((c as any).run).toBeUndefined();
  });
  it('every danger verb carries danger:true and resultKind ack', () => {
    const cmds = listCommands();
    for (const name of ['reset-data', 'self-update']) {
      const c = cmds.find((x) => x.name === name)!;
      expect(c.danger).toBe(true);
      expect(c.resultKind).toBe('ack');
    }
  });
  it('operational verbs are NOT danger-gated (kill/campaign/stop/stop-all execute directly)', () => {
    const cmds = listCommands();
    for (const name of ['kill', 'campaign', 'stop', 'stop-all']) {
      const c = cmds.find((x) => x.name === name)!;
      expect(c).toBeTruthy();
      expect(c.danger).not.toBe(true);
    }
  });
  it('/reset-data and /self-update both park approvals (never execute)', async () => {
    enqueueSpy.mockClear();
    await dispatchCommand('/reset-data', '/repo');
    await dispatchCommand('/self-update', '/repo');
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy.mock.calls.map((c) => c[0].command)).toEqual(['reset-data', 'self-update']);
  });
});
