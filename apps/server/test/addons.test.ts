import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-addons-'));

// ── fake headroom binary (HEADROOM_BIN is authoritative — no PATH fallback) ──────
// `--version` prints a semver; `proxy --port N …` serves /health + /stats and dies
// cleanly on SIGTERM. Wire shapes mirror REAL headroom 0.24.0 (verified live):
// /health = {service:'headroom-proxy', status, version, config:{optimize,…}} and
// /stats  = {summary:{api_requests, cost:{savings_pct,total_saved_usd}}, savings:{total_tokens}}.
const binDir = mkdtempSync(join(tmpdir(), 'fleet-fake-headroom-'));
const FAKE_BIN = join(binDir, 'headroom');
writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('headroom, version 1.2.3'); process.exit(0); }
if (args[0] !== 'proxy') { console.error('unknown command'); process.exit(2); }
const port = Number(args[args.indexOf('--port') + 1] || 8787);
const health = { service: 'headroom-proxy', status: 'healthy', ready: true, version: '1.2.3', config: { optimize: !args.includes('--no-optimize') } };
const stats = { summary: { api_requests: 42, cost: { savings_pct: 45.2, total_saved_usd: 1.23 } }, savings: { total_tokens: 15000 } };
const http = require('node:http');
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify(health));
  if (req.url === '/stats') return res.end(JSON.stringify(stats));
  res.statusCode = 404; res.end('{}');
});
srv.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { srv.close(); process.exit(0); });
`,
);
chmodSync(FAKE_BIN, 0o755);
process.env.HEADROOM_BIN = FAKE_BIN;

const TEST_PORT = 18791;

let app: any;
let PORT: number;
let addons: typeof import('../src/addons.js');

const H = () => ({ host: `127.0.0.1:${PORT}` });

const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const post = (url: string) => app.inject({ method: 'POST', url, headers: H() });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

/** Poll the add-on until `pred` holds (the proxy start/stop paths are async by design). */
async function waitForAddon(pred: (a: any) => boolean, timeoutMs = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await get('/api/addons/compression')).json();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForAddon timed out; last status=${last?.status} detail=${last?.statusDetail}`);
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  addons = await import('../src/addons.js');
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('marketplace listing', () => {
  it('lists all 3 built-in add-ons (compression, codex, opencode)', async () => {
    const res = await get('/api/addons');
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(3);
    const ids = list.map((a: any) => a.id);
    expect(ids).toContain('compression');
    expect(ids).toContain('codex');
    expect(ids).toContain('opencode');
    // compression is always first
    expect(list[0].id).toBe('compression');
  });

  it('has correct shape for the compression add-on', async () => {
    const res = await get('/api/addons/compression');
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.id).toBe('compression');
    expect(c.kind).toBe('builtin');
    expect(c.page).toBe('/addons/compression');
    expect(c.enabled).toBe(false);
    expect(c.installed).toBe(true);
    expect(c.version).toBe('1.2.3');
    expect(c.status).toBe('disabled');
    expect(c.config.port).toBe(8787); // headroom's own default
    expect(c.config.applyToNewRuns).toBe(true);
  });

  it('has correct shape for the codex engine add-on', async () => {
    const res = await get('/api/addons/codex');
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.id).toBe('codex');
    expect(c.kind).toBe('builtin');
    expect(c.page).toBe('/addons/codex');
    expect(c.enabled).toBe(false);
    // no CODEX_BIN env in this test context → either not-installed or installed depending on PATH
    expect(['not-installed', 'disabled', 'running']).toContain(c.status);
    expect(c.config).toHaveProperty('defaultModel');
    expect(c.config).toHaveProperty('sandbox');
  });

  it('has correct shape for the opencode engine add-on', async () => {
    const res = await get('/api/addons/opencode');
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.id).toBe('opencode');
    expect(o.kind).toBe('builtin');
    expect(o.page).toBe('/addons/opencode');
    expect(o.enabled).toBe(false);
    expect(o.config).toHaveProperty('defaultModel');
    expect(o.config).toHaveProperty('skipPermissions');
  });

  it('404s for an unknown add-on (GET / enable / config)', async () => {
    expect((await get('/api/addons/nope')).statusCode).toBe(404);
    expect((await post('/api/addons/nope/enable')).statusCode).toBe(404);
    expect((await put('/api/addons/nope/config', {})).statusCode).toBe(404);
  });
});

describe('config validation (H9 spirit — bad values must not reach the child process)', () => {
  it.each([
    [{ port: 80 }, /port/],
    [{ port: 4319.5 }, /port/],
    [{ dailyBudgetUsd: -1 }, /dailyBudgetUsd/],
    [{ optimize: 'yes' }, /optimize/],
  ])('%j → 400', async (body, msgRe) => {
    const res = await put('/api/addons/compression/config', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(msgRe);
  });

  it("rejects the portal's own ports", async () => {
    const res = await put('/api/addons/compression/config', { port: PORT });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/portal itself/);
  });

  it('persists a valid partial update without spawning anything (still disabled)', async () => {
    const res = await put('/api/addons/compression/config', { port: TEST_PORT });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.config.port).toBe(TEST_PORT);
    expect(a.config.applyToNewRuns).toBe(true); // untouched keys keep their value
    expect(a.status).toBe('disabled');
  });
});

describe('not-installed flow', () => {
  it('reports not-installed and refuses enable when the binary is missing', async () => {
    process.env.HEADROOM_BIN = '/nonexistent/headroom';
    addons.__resetAddonsForTests();
    const a = (await get('/api/addons/compression')).json();
    expect(a.installed).toBe(false);
    expect(a.status).toBe('not-installed');

    const res = await post('/api/addons/compression/enable');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not-installed');

    process.env.HEADROOM_BIN = FAKE_BIN;
    addons.__resetAddonsForTests();
  });
});

describe('enable → proxy lifecycle → run env → disable', () => {
  it('enable starts the proxy and it becomes healthy', async () => {
    const res = await post('/api/addons/compression/enable');
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
    const a = await waitForAddon((x) => x.status === 'running');
    expect(a.statusDetail).toBeNull();
  });

  it('stats passthrough maps the real 0.24.0 /stats shape', async () => {
    const res = await get('/api/addons/compression/stats');
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.healthy).toBe(true);
    expect(s.endpoint).toBe(`http://127.0.0.1:${TEST_PORT}`);
    expect(s.totalRequests).toBe(42);
    expect(s.tokensSaved).toBe(15000);
    expect(s.savingsPercent).toBe(45.2);
    expect(s.savedUsd).toBe(1.23);
  });

  it('injects ANTHROPIC_BASE_URL into the env of newly spawned runs', () => {
    expect(addons.addonRunEnv()).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${TEST_PORT}` });
  });

  it('injects engine-appropriate proxy base URLs for codex/opencode provider models', () => {
    expect(addons.addonRunEnvForEngine('codex', 'gpt-5-codex')).toEqual({ OPENAI_BASE_URL: `http://127.0.0.1:${TEST_PORT}/v1` });
    expect(addons.addonRunEnvForEngine('opencode', 'anthropic/claude-sonnet-4-5')).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${TEST_PORT}` });
    expect(addons.addonRunEnvForEngine('opencode', 'openai/gpt-5')).toEqual({ OPENAI_BASE_URL: `http://127.0.0.1:${TEST_PORT}/v1` });
    expect(addons.addonRunEnvForEngine('opencode', 'google/gemini-2.5-pro')).toEqual({});
  });

  it("NEVER overrides an operator's own ANTHROPIC_BASE_URL (corporate gateway)", () => {
    process.env.ANTHROPIC_BASE_URL = 'http://gateway.corp:9999';
    try {
      expect(addons.addonRunEnv()).toEqual({});
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it('re-enable while running is a no-op — the managed child is not bounced or re-labeled external', async () => {
    const res = await post('/api/addons/compression/enable');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.status).toBe('running'); // still up — no restart cycle
    expect(a.statusDetail).toBeNull(); // NOT 'attached to an already-running proxy' (the orphan-race symptom)
    expect(addons.addonRunEnv()).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${TEST_PORT}` });
  });

  it('applyToNewRuns:false keeps the proxy up but stops routing new runs', async () => {
    const res = await put('/api/addons/compression/config', { applyToNewRuns: false });
    expect(res.statusCode).toBe(200);
    expect(addons.addonRunEnv()).toEqual({});
    // config saves live-restart the proxy — it must come back healthy
    await waitForAddon((x) => x.status === 'running');
    expect(addons.addonRunEnv()).toEqual({}); // still off while running
    await put('/api/addons/compression/config', { applyToNewRuns: true });
    await waitForAddon((x) => x.status === 'running');
    expect(addons.addonRunEnv()).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${TEST_PORT}` });
  });

  it('restart bounces the child and recovers to healthy', async () => {
    const res = await post('/api/addons/compression/restart');
    expect(res.statusCode).toBe(200);
    await waitForAddon((x) => x.status === 'running');
  });

  it('install refuses when the dependency is already present', async () => {
    const res = await post('/api/addons/compression/install');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('already-installed');
  });

  it('disable stops the proxy and clears the run env', async () => {
    const res = await post('/api/addons/compression/disable');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.enabled).toBe(false);
    expect(a.status).toBe('disabled');
    expect(addons.addonRunEnv()).toEqual({});
    // the fake proxy must actually be gone — its port stops answering
    const deadline = Date.now() + 5000;
    let dead = false;
    while (Date.now() < deadline && !dead) {
      try {
        await fetch(`http://127.0.0.1:${TEST_PORT}/health`, { signal: AbortSignal.timeout(300) });
        await new Promise((r) => setTimeout(r, 150));
      } catch {
        dead = true;
      }
    }
    expect(dead).toBe(true);
  });

  it('restart refuses while disabled', async () => {
    expect((await post('/api/addons/compression/restart')).statusCode).toBe(409);
  });
});

// ── fake codex binary setup ───────────────────────────────────────────────────────
const codexBinDir = mkdtempSync(join(tmpdir(), 'fleet-fake-codex-'));
const FAKE_CODEX_BIN = join(codexBinDir, 'codex');
writeFileSync(
  FAKE_CODEX_BIN,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 0.114.0'); process.exit(0); }
process.exit(1);
`,
);
chmodSync(FAKE_CODEX_BIN, 0o755);

describe('engine add-on (codex) — enable / disable / restart / install', () => {
  it('reports not-installed when CODEX_BIN is absent', async () => {
    process.env.CODEX_BIN = '/nonexistent/codex';
    addons.__resetAddonsForTests();
    const res = await get('/api/addons/codex');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.installed).toBe(false);
    expect(a.status).toBe('not-installed');
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });

  it('enable with CODEX_BIN pointing at fake binary → status running', async () => {
    process.env.CODEX_BIN = FAKE_CODEX_BIN;
    addons.__resetAddonsForTests();
    const res = await post('/api/addons/codex/enable');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.enabled).toBe(true);
    expect(a.status).toBe('running');
    expect(a.installed).toBe(true);
    expect(a.version).toBe('0.114.0');
  });

  it('re-enable while already enabled is idempotent', async () => {
    const res = await post('/api/addons/codex/enable');
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it('disable → status disabled', async () => {
    const res = await post('/api/addons/codex/disable');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.enabled).toBe(false);
    expect(a.status).toBe('disabled');
  });

  it('restart on engine add-on → 409 not-applicable', async () => {
    const res = await post('/api/addons/codex/restart');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not-applicable');
  });

  it('install when CODEX_BIN is already present → 409 already-installed', async () => {
    const res = await post('/api/addons/codex/install');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('already-installed');
    // cleanup
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });
});

describe('engine add-on — config validation (codex)', () => {
  it('rejects invalid sandbox value', async () => {
    const res = await put('/api/addons/codex/config', { sandbox: 'turbo-unsafe' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/sandbox/);
  });

  it('rejects non-string defaultModel', async () => {
    const res = await put('/api/addons/codex/config', { defaultModel: 42 });
    expect(res.statusCode).toBe(400);
  });

  it('accepts valid partial update — sandbox + defaultModel', async () => {
    const res = await put('/api/addons/codex/config', { sandbox: 'read-only', defaultModel: 'gpt-5' });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.config.sandbox).toBe('read-only');
    expect(a.config.defaultModel).toBe('gpt-5');
  });

  it('accepts null defaultModel (reset to engine default)', async () => {
    const res = await put('/api/addons/codex/config', { defaultModel: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.defaultModel).toBeNull();
  });
});

describe('launch gating — engine disabled check', () => {
  it('POST /api/agents with engine codex while codex is disabled → 409 engine-disabled', async () => {
    // Ensure codex is disabled (it was disabled above; confirm)
    const addonRes = await get('/api/addons/codex');
    expect(addonRes.json().enabled).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...H(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        prompt: 'hello',
        cwd: '/tmp',
        engine: 'codex',
        model: 'claude-opus-4-8',
        effort: 'low',
        permissionMode: 'default',
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('engine-disabled');
  });

  it('POST /api/agents with a codex catalog model auto-routes to the disabled codex engine', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...H(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        prompt: 'hello',
        cwd: '/tmp',
        model: 'gpt-5-codex',
        effort: 'low',
        permissionMode: 'default',
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('engine-disabled');
  });
});
