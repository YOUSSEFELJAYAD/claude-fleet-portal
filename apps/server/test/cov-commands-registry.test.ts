import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/registry.js', () => ({
  registry: {
    listRuns: vi.fn(() => [{ id: 'a1', status: 'running', model: 'opus', task: 'do x', cwd: '/r' }]),
    stop: vi.fn(),
    launch: vi.fn(async () => ({ id: 'new-run' })),
  },
}));
vi.mock('../src/addons.js', () => ({
  listAddonInfos: vi.fn(async () => [{ id: 'compression', enabled: true, status: 'running' }]),
  setAddonEnabledById: vi.fn(async (id: string, en: boolean) => ({ id, enabled: en, status: en ? 'running' : 'disabled' })),
}));
vi.mock('../src/campaigns.js', () => ({ campaigns: { create: vi.fn(async () => ({ id: 'camp-1' })) } }));

import { listCommands } from '../src/commands.js';

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
