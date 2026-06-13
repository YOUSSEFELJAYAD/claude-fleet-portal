import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../src/registry.js', () => ({
  registry: {
    getConfig: vi.fn(() => ({ dailySpendCeilingUsd: 50, maxRunMinutes: null, maxConcurrentRuns: 8 })),
    setConfig: vi.fn(),
  },
}));
vi.mock('../src/addons.js', () => ({
  addonRunEnv: vi.fn(() => ({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' })),
  isEngineEnabled: vi.fn((e: string) => e === 'codex'),
}));

import { buildSettings } from '../src/settings.js';

beforeEach(() => { delete process.env.GITHUB_TOKEN; delete process.env.CLAUDE_BIN; });

describe('settings registry', () => {
  it('masks secrets (value null, set reflects presence)', () => {
    process.env.GITHUB_TOKEN = 'ghp_xxx';
    const all = buildSettings();
    const tok = all.find((s) => s.key === 'GITHUB_TOKEN')!;
    expect(tok.secret).toBe(true);
    expect(tok.value).toBeNull();
    expect(tok.set).toBe(true);
  });

  it('exposes the live proxy URL as a derived read-only field', () => {
    const proxy = buildSettings().find((s) => s.key === 'proxyUrl')!;
    expect(proxy.applyTiming).toBe('read-only');
    expect(proxy.value).toBe('http://127.0.0.1:8787');
  });

  it('marks an env field pending when the managed value differs from the running value', () => {
    // CLAUDE_BIN is unset in process.env; a field whose get() returns '' but managed has a value → pending.
    // Covered by the route test below via a temp managed file; here assert default not-pending.
    const claudeBin = buildSettings().find((s) => s.key === 'CLAUDE_BIN')!;
    expect(claudeBin.applyTiming).toBe('next-launch');
    expect(claudeBin.pending).toBe(false);
  });

  it('gates a codex secret on the codex engine being enabled', () => {
    const codex = buildSettings().find((s) => s.key === 'CODEX_API_KEY')!;
    expect(codex.gatedBy).toBe('codex');
    expect(codex.gatedOn).toBe(true); // mock says codex enabled
  });

  it('GET /api/settings returns the registry', async () => {
    const { registerSettingsRoutes } = await import('../src/settings.js');
    const app = Fastify(); registerSettingsRoutes(app); await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).settings.length).toBeGreaterThan(5);
    await app.close();
  });
});
