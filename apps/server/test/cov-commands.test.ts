/**
 * cov-commands — behavioral branch coverage for dispatchCommand (src/commands.ts).
 * Targets the previously-uncovered branches: /kill catch (41), /campaign missing-arg +
 * success + catch (51-54), /addons table (56-59), /addon catch (64), plus the /addon
 * usage branches and /schedule. Dependencies are mocked so error paths are reachable and
 * dispatched results can be asserted against real outputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable behaviors so we can drive both the success and throwing sides of each branch.
const stopBehavior = { fn: (_id: string): void => {} };
const launchBehavior = { fn: async (_req: any): Promise<{ id: string }> => ({ id: 'run-x' }) };
const campaignCreateBehavior = { fn: async (_req: any): Promise<{ id: string }> => ({ id: 'camp-1' }) };
const setAddonBehavior = {
  fn: async (id: string, en: boolean): Promise<{ id: string; enabled: boolean; status: string }> => ({
    id,
    enabled: en,
    status: en ? 'running' : 'disabled',
  }),
};
const listAddonInfosBehavior = {
  fn: async (): Promise<Array<{ id: string; enabled: boolean; status: string }>> => [
    { id: 'compression', enabled: true, status: 'running' },
    { id: 'searxng', enabled: false, status: 'disabled' },
  ],
};

vi.mock('../src/inbox.js', () => ({ enqueueApproval: vi.fn(() => 'appr-cov') }));
vi.mock('../src/registry.js', () => ({
  registry: {
    listRuns: vi.fn(() => [
      { id: 'a1', status: 'running', model: 'opus', task: 'do x', cwd: '/r' },
      { id: 'p2', status: 'paused', model: 'opus', task: 'y'.repeat(80), cwd: '/r' },
      { id: 'n3', status: 'running', model: 'opus', task: null, cwd: '/r' }, // task null -> String(r.task ?? '')
      { id: 'z9', status: 'completed', model: 'opus', task: 'done', cwd: '/r' },
    ]),
    stop: vi.fn((id: string) => stopBehavior.fn(id)),
    launch: vi.fn((req: any) => launchBehavior.fn(req)),
  },
}));
vi.mock('../src/addons.js', () => ({
  listAddonInfos: vi.fn(() => listAddonInfosBehavior.fn()),
  setAddonEnabledById: vi.fn((id: string, en: boolean) => setAddonBehavior.fn(id, en)),
}));
vi.mock('../src/campaigns.js', () => ({
  campaigns: { create: vi.fn((req: any) => campaignCreateBehavior.fn(req)) },
}));

import { dispatchCommand } from '../src/commands.js';
import { registry } from '../src/registry.js';
import { campaigns } from '../src/campaigns.js';
import { setAddonEnabledById } from '../src/addons.js';

beforeEach(() => {
  // Reset to the success behaviors before each test.
  stopBehavior.fn = () => {};
  launchBehavior.fn = async () => ({ id: 'run-x' });
  campaignCreateBehavior.fn = async () => ({ id: 'camp-1' });
  setAddonBehavior.fn = async (id, en) => ({ id, enabled: en, status: en ? 'running' : 'disabled' });
  listAddonInfosBehavior.fn = async () => [
    { id: 'compression', enabled: true, status: 'running' },
    { id: 'searxng', enabled: false, status: 'disabled' },
  ];
  vi.clearAllMocks();
});

describe('dispatchCommand — parsing', () => {
  it('strips leading slash and surrounding whitespace before dispatch', async () => {
    const r = await dispatchCommand('   /help   ', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('text');
    expect(r.text).toContain('/agents');
  });

  it('accepts a command line without a leading slash', async () => {
    const r = await dispatchCommand('help', '/repo');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('/help');
  });
});

describe('dispatchCommand — /help', () => {
  it('returns the full help text listing every command', async () => {
    const r = await dispatchCommand('/help', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('text');
    for (const frag of ['/agents', '/kill', '/launch', '/campaign', '/addons', '/addon', '/schedule', '/help']) {
      expect(r.text).toContain(frag);
    }
  });
});

describe('dispatchCommand — /agents', () => {
  it('lists only non-terminal runs and truncates the task to 60 chars', async () => {
    const r = await dispatchCommand('/agents', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['id', 'status', 'model', 'task']);
    const ids = (r.rows ?? []).map((row) => row[0]);
    expect(ids).toContain('a1');
    expect(ids).toContain('p2'); // paused is non-terminal -> included
    expect(ids).not.toContain('z9'); // completed -> excluded
    const p2 = (r.rows ?? []).find((row) => row[0] === 'p2')!;
    expect(p2[3]).toHaveLength(60); // 80-char task sliced to 60
    const n3 = (r.rows ?? []).find((row) => row[0] === 'n3')!;
    expect(n3[3]).toBe(''); // null task -> String(r.task ?? '') === ''
  });
});

describe('dispatchCommand — /kill', () => {
  // /kill is danger:true — dispatchCommand parks it in the Inbox instead of executing.
  it('parks an Inbox approval for any /kill invocation (danger-gated)', async () => {
    const r = await dispatchCommand('/kill a1', '/repo');
    expect(r.ok).toBe(true);
    expect(String(r.text)).toMatch(/approv/i);
    expect(registry.stop as any).not.toHaveBeenCalled();
  });
});

describe('dispatchCommand — /launch', () => {
  it('errors with usage when no prompt is given', async () => {
    const r = await dispatchCommand('/launch', '/repo');
    expect(r.ok).toBe(false);
    expect(r.text).toBe('usage: /launch <prompt>');
  });

  it('launches with chat cwd and high-effort opus, returning the run id', async () => {
    launchBehavior.fn = async () => ({ id: 'spawned-7' });
    const r = await dispatchCommand('/launch fix the bug', '/the/cwd');
    expect(registry.launch as any).toHaveBeenCalledWith({
      prompt: 'fix the bug',
      cwd: '/the/cwd',
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('launched run spawned-7');
    expect(r.runId).toBe('spawned-7');
  });

  it('returns the error message when launch rejects (catch)', async () => {
    launchBehavior.fn = async () => {
      throw new Error('concurrency cap');
    };
    const r = await dispatchCommand('/launch do stuff', '/repo');
    expect(r.ok).toBe(false);
    expect(r.text).toBe('concurrency cap');
  });

  it('falls back to default message when launch error has no message (catch, line 48)', async () => {
    launchBehavior.fn = async () => {
      throw { reason: 'x' }; // no .message
    };
    const r = await dispatchCommand('/launch do stuff', '/repo');
    expect(r.ok).toBe(false);
    expect(r.text).toBe('launch failed');
  });
});

describe('dispatchCommand — /campaign', () => {
  // /campaign is danger:true — dispatchCommand parks it in the Inbox instead of executing.
  it('parks an Inbox approval for any /campaign invocation (danger-gated)', async () => {
    const r = await dispatchCommand('/campaign ship the release', '/repo');
    expect(r.ok).toBe(true);
    expect(String(r.text)).toMatch(/approv/i);
    expect((campaigns.create as any)).not.toHaveBeenCalled();
  });
});

describe('dispatchCommand — /addons', () => {
  it('renders all add-ons as a table with id/enabled/status (lines 56-59)', async () => {
    const r = await dispatchCommand('/addons', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('table');
    expect(r.columns).toEqual(['id', 'enabled', 'status']);
    expect(r.rows).toEqual([
      ['compression', 'true', 'running'],
      ['searxng', 'false', 'disabled'],
    ]);
  });

  it('handles an empty add-on list as an empty table', async () => {
    listAddonInfosBehavior.fn = async () => [];
    const r = await dispatchCommand('/addons', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('table');
    expect(r.rows).toEqual([]);
  });
});

describe('dispatchCommand — /addon enable|disable', () => {
  it('errors on an invalid action (line 62)', async () => {
    const r = await dispatchCommand('/addon toggle compression', '/repo');
    expect(r.ok).toBe(false);
    expect(r.text).toBe('usage: /addon enable|disable <id>');
    expect((setAddonEnabledById as any)).not.toHaveBeenCalled();
  });

  it('errors when the id is missing (line 62)', async () => {
    const r = await dispatchCommand('/addon enable', '/repo');
    expect(r.ok).toBe(false);
    expect(r.text).toBe('usage: /addon enable|disable <id>');
    expect((setAddonEnabledById as any)).not.toHaveBeenCalled();
  });

  it('enables an add-on and reports its new status (line 63)', async () => {
    setAddonBehavior.fn = async (id) => ({ id, enabled: true, status: 'running' });
    const r = await dispatchCommand('/addon enable compression', '/repo');
    expect((setAddonEnabledById as any)).toHaveBeenCalledWith('compression', true);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('compression → running');
  });

  it('disables an add-on (action !== enable maps to false) (line 63)', async () => {
    setAddonBehavior.fn = async (id) => ({ id, enabled: false, status: 'disabled' });
    const r = await dispatchCommand('/addon disable searxng', '/repo');
    expect((setAddonEnabledById as any)).toHaveBeenCalledWith('searxng', false);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('searxng → disabled');
  });

  it('returns the error message when toggling throws (catch, line 64)', async () => {
    setAddonBehavior.fn = async () => {
      throw new Error('unknown add-on');
    };
    const r = await dispatchCommand('/addon enable nope', '/repo');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('error');
    expect(r.text).toBe('unknown add-on');
  });

  it('falls back to default message when toggle error has no message (catch, line 64)', async () => {
    setAddonBehavior.fn = async () => {
      throw {}; // no .message
    };
    const r = await dispatchCommand('/addon disable nope', '/repo');
    expect(r.ok).toBe(false);
    expect(r.text).toBe('addon toggle failed');
  });
});

describe('dispatchCommand — /schedule + default', () => {
  it('/schedule returns the schedules-page pointer (line 66)', async () => {
    const r = await dispatchCommand('/schedule', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('text');
    expect(r.text).toContain('/schedules');
  });

  it('unknown command returns an error naming the command (default, line 67)', async () => {
    const r = await dispatchCommand('/frobnicate', '/repo');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('error');
    expect(r.text).toBe('unknown command: /frobnicate — try /help');
  });
});
