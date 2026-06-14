import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/inbox.js', () => ({ enqueueApproval: vi.fn(() => 'appr-test') }));
vi.mock('../src/registry.js', () => ({
  registry: {
    listRuns: vi.fn(() => [
      { id: 'a1', status: 'running', model: 'opus', task: 'do x', cwd: '/r' },
      { id: 'z9', status: 'completed', model: 'opus', task: 'done', cwd: '/r' },
    ]),
    stop: vi.fn(),
    launch: vi.fn(async () => ({ id: 'new-run' })),
  },
}));
vi.mock('../src/addons.js', () => ({
  listAddonInfos: vi.fn(async () => [{ id: 'compression', enabled: true, status: 'running' }]),
  setAddonEnabledById: vi.fn(async (id: string, en: boolean) => ({ id, enabled: en, status: en ? 'running' : 'disabled' })),
}));
vi.mock('../src/campaigns.js', () => ({ campaigns: { create: vi.fn(async () => ({ id: 'camp-1' })) } }));

import { dispatchCommand } from '../src/commands.js';

describe('dispatchCommand', () => {
  it('/agents lists only non-terminal runs as a table', async () => {
    const r = await dispatchCommand('/agents', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('table');
    expect(r.rows?.some((row) => row.includes('a1'))).toBe(true);
    expect(r.rows?.some((row) => row.includes('z9'))).toBe(false); // completed excluded
  });

  it('/kill <id> parks an Inbox approval (danger-gated)', async () => {
    const r = await dispatchCommand('/kill a1', '/repo');
    expect(r.ok).toBe(true);
    expect(String(r.text)).toMatch(/approv/i);
  });

  it('/launch <prompt> starts a run and returns its id', async () => {
    const r = await dispatchCommand('/launch fix the bug', '/repo');
    expect(r.runId).toBe('new-run');
  });

  it('/addon enable compression toggles it', async () => {
    const { setAddonEnabledById } = await import('../src/addons.js');
    const r = await dispatchCommand('/addon enable compression', '/repo');
    expect((setAddonEnabledById as any)).toHaveBeenCalledWith('compression', true);
    expect(r.ok).toBe(true);
  });

  it('unknown command returns an error result', async () => {
    const r = await dispatchCommand('/nope', '/repo');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('error');
  });
});
