/**
 * Coverage-focused REAL/behavioral tests for addons.ts targeting the previously
 * uncovered logic: config validators (research/compression branches), binary-candidate
 * builders (XDG_BIN_HOME / HEADROOM_BIN authoritative override), the non-ENOENT detect
 * catch branch, the SearXNG service reachability probe (403 / non-ok / ok status mapping),
 * the §30 chat-command exports (listAddonInfos / setAddonEnabledById), the ANTHROPIC_BASE_URL
 * override note, the compression /stats num() helper, and the route handlers
 * (enable/disable/restart/config/install) for engine + service + proxy add-ons.
 *
 * DB is isolated to a fresh tmp dir BEFORE any src module is imported. HEADROOM_BIN is
 * authoritative, so a fake node "headroom" lets us drive the real proxy lifecycle without
 * a python interpreter. A local HTTP server stands in for SearXNG. No real engine/proxy
 * binary or python is ever spawned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Isolate the DB before config.js (and thus addons.js) loads.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-addons-'));

const binDir = mkdtempSync(join(tmpdir(), 'fleet-cov-bins-'));

// ── fake headroom: --version prints semver; `proxy --port N` serves /health + /stats ──
const FAKE_HEADROOM = join(binDir, 'headroom');
writeFileSync(
  FAKE_HEADROOM,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('headroom, version 2.4.0'); process.exit(0); }
if (args[0] !== 'proxy') { console.error('unknown command'); process.exit(2); }
const port = Number(args[args.indexOf('--port') + 1] || 8787);
const health = { service: 'headroom-proxy', status: 'healthy', version: '2.4.0', config: { optimize: !args.includes('--no-optimize') } };
const stats = { summary: { api_requests: 7, cost: { savings_pct: 33.3, total_saved_usd: 0.5 } }, savings: { total_tokens: 2048 } };
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
chmodSync(FAKE_HEADROOM, 0o755);

// ── fake binary that exits NON-ZERO but writes version output (exercises the
//    "CLI without --version still exits non-zero WITH output" detect branch) ──
const FAKE_NOVERSION = join(binDir, 'codex-noversion');
writeFileSync(
  FAKE_NOVERSION,
  `#!/usr/bin/env node
// writes its banner to STDOUT then exits non-zero (mimics a CLI without a --version
// flag): detectEngineBin's catch branch parses the version from e.stdout.
process.stdout.write('codex-cli 3.9.1 (no --version flag)\\n');
process.exit(1);
`,
);
chmodSync(FAKE_NOVERSION, 0o755);

// ── fake codex: --version prints semver and exits 0 ──
const FAKE_CODEX = join(binDir, 'codex');
writeFileSync(
  FAKE_CODEX,
  `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex 1.5.0'); process.exit(0); }
process.exit(1);
`,
);
chmodSync(FAKE_CODEX, 0o755);

const TEST_PORT = 18931;

// ── stub SearXNG server: the probe hits `<base>/search?...`; we route by base path
//    prefix so one server can serve ok / json-disabled(403) / unreachable(500). ──
let searxng: http.Server;
let searxngPort = 0;
function startSearxng(): Promise<void> {
  searxng = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/forbidden/')) { res.statusCode = 403; return res.end('forbidden'); }
    if (url.startsWith('/broken/')) { res.statusCode = 500; return res.end('boom'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: [] }));
  });
  return new Promise((resolve) => searxng.listen(0, '127.0.0.1', () => {
    searxngPort = (searxng.address() as any).port;
    resolve();
  }));
}
const sxBase = (p = '') => `http://127.0.0.1:${searxngPort}${p}`;

let app: any;
let PORT: number;
let addons: typeof import('../src/addons.js');
let db: typeof import('../src/db.js').default;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const post = (url: string) => app.inject({ method: 'POST', url, headers: H() });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

async function waitForCompression(pred: (a: any) => boolean, timeoutMs = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await get('/api/addons/compression')).json();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForCompression timed out; status=${last?.status} detail=${last?.statusDetail}`);
}

beforeAll(async () => {
  process.env.HEADROOM_BIN = FAKE_HEADROOM;
  await startSearxng();
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  addons = await import('../src/addons.js');
  db = (await import('../src/db.js')).default;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  try { await post('/api/addons/compression/disable'); } catch { /* ignore */ }
  await app?.close();
  await new Promise<void>((r) => searxng.close(() => r()));
  delete process.env.HEADROOM_BIN;
  delete process.env.ANTHROPIC_BASE_URL;
  for (const d of [binDir, process.env.FLEET_DATA_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const status = (fn: () => unknown): number | undefined => {
  try { fn(); return undefined; } catch (e: any) { return e?.statusCode; }
};

// ─────────────────────────────────────────────────────────────────────────────
describe('validateCompressionConfig — non-object guard, bool fallback, budget branches', () => {
  it('rejects a non-object body', () => {
    expect(status(() => addons.validateCompressionConfig(undefined))).toBe(400);
    expect(status(() => addons.validateCompressionConfig('cfg'))).toBe(400);
  });

  it('falls back to the stored/default value for an omitted boolean and type-checks a present one', () => {
    // omitted booleans inherit the base (default) value — the bool() else branch
    const cfg = addons.validateCompressionConfig({ port: 9090 });
    expect(cfg.optimize).toBe(true);
    expect(cfg.cache).toBe(true);
    expect(cfg.rateLimit).toBe(true);
    expect(cfg.applyToNewRuns).toBe(true);
    // a present non-boolean is rejected (covers each bool() throw)
    expect(status(() => addons.validateCompressionConfig({ cache: 1 }))).toBe(400);
    expect(status(() => addons.validateCompressionConfig({ rateLimit: 'no' }))).toBe(400);
    expect(status(() => addons.validateCompressionConfig({ applyToNewRuns: {} }))).toBe(400);
  });

  it('accepts null / positive dailyBudgetUsd and rejects non-finite or <= 0', () => {
    expect(addons.validateCompressionConfig({ dailyBudgetUsd: null }).dailyBudgetUsd).toBeNull();
    expect(addons.validateCompressionConfig({ dailyBudgetUsd: 12.5 }).dailyBudgetUsd).toBe(12.5);
    expect(status(() => addons.validateCompressionConfig({ dailyBudgetUsd: 0 }))).toBe(400);
    expect(status(() => addons.validateCompressionConfig({ dailyBudgetUsd: -1 }))).toBe(400);
    expect(status(() => addons.validateCompressionConfig({ dailyBudgetUsd: Number.POSITIVE_INFINITY }))).toBe(400);
    expect(status(() => addons.validateCompressionConfig({ dailyBudgetUsd: 'free' }))).toBe(400);
  });
});

describe('engineLaunchConfig / isEngineEnabled public API', () => {
  it('engineLaunchConfig returns the per-engine shape and throws for a non-engine', () => {
    expect(addons.engineLaunchConfig('codex')).toHaveProperty('sandbox');
    expect(addons.engineLaunchConfig('opencode')).toHaveProperty('skipPermissions');
    expect(() => addons.engineLaunchConfig('claude' as any)).toThrow(/not an engine/);
  });

  it('isEngineEnabled is false by default and false for non-engine ids', () => {
    expect(addons.isEngineEnabled('codex')).toBe(false);
    expect(addons.isEngineEnabled('opencode')).toBe(false);
    expect(addons.isEngineEnabled('claude' as any)).toBe(false);
  });

  it('reflects an engine enabled through setAddonEnabledById', async () => {
    process.env.CODEX_BIN = FAKE_CODEX;
    addons.__resetAddonsForTests();
    await addons.setAddonEnabledById('codex', true);
    expect(addons.isEngineEnabled('codex')).toBe(true);
    await addons.setAddonEnabledById('codex', false);
    expect(addons.isEngineEnabled('codex')).toBe(false);
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });
});

describe('validateResearchConfig — every branch', () => {
  it('rejects non-objects with a 400', () => {
    expect(status(() => addons.validateResearchConfig(null))).toBe(400);
    expect(status(() => addons.validateResearchConfig('x'))).toBe(400);
    expect(status(() => addons.validateResearchConfig(5))).toBe(400);
  });

  it('rejects a non-http(s) searxngUrl and strips trailing slashes from a valid one', () => {
    expect(status(() => addons.validateResearchConfig({ searxngUrl: 'ftp://host' }))).toBe(400);
    expect(status(() => addons.validateResearchConfig({ searxngUrl: 123 }))).toBe(400);
    const cfg = addons.validateResearchConfig({ searxngUrl: 'https://searx.example.com///' });
    expect(cfg.searxngUrl).toBe('https://searx.example.com');
  });

  it('clamps maxResults to 1..20 and rejects non-integers', () => {
    expect(status(() => addons.validateResearchConfig({ maxResults: 4.5 }))).toBe(400);
    expect(status(() => addons.validateResearchConfig({ maxResults: 'lots' }))).toBe(400);
    expect(addons.validateResearchConfig({ maxResults: 999 }).maxResults).toBe(20);
    expect(addons.validateResearchConfig({ maxResults: -3 }).maxResults).toBe(1);
    expect(addons.validateResearchConfig({ maxResults: 8 }).maxResults).toBe(8);
  });

  it('restricts safeSearch to 0/1/2', () => {
    expect(status(() => addons.validateResearchConfig({ safeSearch: 3 }))).toBe(400);
    expect(addons.validateResearchConfig({ safeSearch: 0 }).safeSearch).toBe(0);
    expect(addons.validateResearchConfig({ safeSearch: 2 }).safeSearch).toBe(2);
  });

  it('coerces engines/language and falls back to en for a blank language', () => {
    const cfg = addons.validateResearchConfig({ engines: 'google,bing', language: '' });
    expect(cfg.engines).toBe('google,bing');
    expect(cfg.language).toBe('en'); // blank → default
    expect(addons.validateResearchConfig({ language: 'fr' }).language).toBe('fr');
  });
});

describe('researchConfig — tolerates a garbled stored row (loadRow catch)', () => {
  it('falls back to defaults when the persisted config JSON is corrupt', () => {
    db.prepare(
      `INSERT INTO addons (id, enabled, config, updated_at) VALUES ('web-research', 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config = excluded.config`,
    ).run('{not valid json', Date.now());
    const cfg = addons.researchConfig();
    expect(cfg.searxngUrl).toBe('http://localhost:8080'); // default, not a throw
    expect(cfg.maxResults).toBe(10);
    // restore a clean row so later tests start from defaults
    db.prepare(`UPDATE addons SET config = '{}' WHERE id = 'web-research'`).run();
  });
});

describe('validateEngineConfig — non-object guard + unknown id', () => {
  it('rejects a non-object body', () => {
    expect(status(() => addons.validateEngineConfig('codex', null))).toBe(400);
    expect(status(() => addons.validateEngineConfig('codex', 'nope'))).toBe(400);
  });
  it('rejects an unknown engine id', () => {
    expect(status(() => addons.validateEngineConfig('mystery', {}))).toBe(400);
  });
  it('opencode: accepts defaultModel + skipPermissions, rejects bad skipPermissions', () => {
    const cfg = addons.validateEngineConfig('opencode', { defaultModel: ' kimi ', skipPermissions: true }) as any;
    expect(cfg.defaultModel).toBe('kimi');
    expect(cfg.skipPermissions).toBe(true);
    expect(status(() => addons.validateEngineConfig('opencode', { skipPermissions: 7 }))).toBe(400);
  });
});

describe('getEngineBin / detectEngineBin candidate scanning', () => {
  it('returns null when the engine binary is missing (absolute candidate pre-check skips it)', async () => {
    process.env.CODEX_BIN = '/definitely/not/here/codex';
    addons.__resetAddonsForTests();
    expect(await addons.getEngineBin('codex')).toBeNull();
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });

  it('resolves the bin + version through a real --version probe', async () => {
    process.env.CODEX_BIN = FAKE_CODEX;
    addons.__resetAddonsForTests();
    expect(await addons.getEngineBin('codex')).toBe(FAKE_CODEX);
    const info = (await get('/api/addons/codex')).json();
    expect(info.version).toBe('1.5.0');
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });

  it('detects a bin that exits non-zero but emits version output (non-ENOENT catch branch)', async () => {
    process.env.CODEX_BIN = FAKE_NOVERSION;
    addons.__resetAddonsForTests();
    const info = (await get('/api/addons/codex')).json();
    expect(info.installed).toBe(true);       // found despite a non-zero exit
    expect(info.version).toBe('3.9.1');      // parsed from stderr output
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });
});

describe('binCandidates / executableCandidates honor env overrides', () => {
  it('XDG_BIN_HOME widens the candidate set without breaking detection', async () => {
    const oldXdg = process.env.XDG_BIN_HOME;
    process.env.XDG_BIN_HOME = binDir; // contains our fake `headroom`
    delete process.env.HEADROOM_BIN;   // drop the authoritative override → scan candidates
    addons.__resetAddonsForTests();
    const info = (await get('/api/addons/compression')).json();
    // a headroom is found by scanning the candidate list (XDG_BIN_HOME among them);
    // a real `headroom` on PATH may win the bare-name slot, so assert detection, not a pin
    expect(info.installed).toBe(true);
    expect(typeof info.version === 'string' || info.version === null).toBe(true);
    // restore the authoritative override for the proxy lifecycle tests
    if (oldXdg === undefined) delete process.env.XDG_BIN_HOME; else process.env.XDG_BIN_HOME = oldXdg;
    process.env.HEADROOM_BIN = FAKE_HEADROOM;
    addons.__resetAddonsForTests();
  });
});

describe('SearXNG service probe → addonInfo status mapping', () => {
  afterAll(async () => {
    // leave web-research disabled and pointed at a reachable base for later suites
    await put('/api/addons/web-research/config', { searxngUrl: sxBase() });
    await post('/api/addons/web-research/disable');
  });

  it('reachable + json → installed:true, disabled while not enabled', async () => {
    await put('/api/addons/web-research/config', { searxngUrl: sxBase() });
    const info = (await get('/api/addons/web-research')).json();
    expect(info.installed).toBe(true);
    expect(info.status).toBe('disabled'); // reachable but not enabled
    expect(info.version).toBeNull();
  });

  it('json-disabled (403) + enabled → status error with a settings.yml remediation hint', async () => {
    await put('/api/addons/web-research/config', { searxngUrl: sxBase('/forbidden') });
    await post('/api/addons/web-research/enable');
    const info = (await get('/api/addons/web-research')).json();
    expect(info.installed).toBe(true);          // a 403 still means the service is reachable
    expect(info.status).toBe('error');          // json-disabled → error
    expect(info.statusDetail).toMatch(/settings\.yml/);
    await post('/api/addons/web-research/disable');
  });

  it('non-ok (500) → unreachable → not-installed, detail carries the status code', async () => {
    await put('/api/addons/web-research/config', { searxngUrl: sxBase('/broken') });
    const info = (await get('/api/addons/web-research')).json();
    expect(info.installed).toBe(false);
    expect(info.status).toBe('not-installed');
    expect(info.statusDetail).toMatch(/500/);
  });

  it('connection-refused base → unreachable with a "not reachable" detail', async () => {
    await put('/api/addons/web-research/config', { searxngUrl: 'http://127.0.0.1:1' });
    const info = (await get('/api/addons/web-research')).json();
    expect(info.installed).toBe(false);
    expect(info.statusDetail).toMatch(/not reachable/);
  });
});

describe('§30 chat-command exports', () => {
  it('listAddonInfos returns all four built-ins', async () => {
    const infos = await addons.listAddonInfos();
    const ids = infos.map((i) => i.id).sort();
    expect(ids).toEqual(['codex', 'compression', 'opencode', 'web-research']);
  });

  it('setAddonEnabledById enables/disables web-research (service: no process) and 404s unknown', async () => {
    const on = await addons.setAddonEnabledById('web-research', true);
    expect(on.enabled).toBe(true);
    const off = await addons.setAddonEnabledById('web-research', false);
    expect(off.enabled).toBe(false);
    await expect(addons.setAddonEnabledById('no-such-addon', true)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('route handlers — engine add-on (codex) enable/disable/restart/config', () => {
  beforeAll(() => {
    process.env.CODEX_BIN = FAKE_CODEX;
    addons.__resetAddonsForTests();
  });
  afterAll(() => {
    delete process.env.CODEX_BIN;
    addons.__resetAddonsForTests();
  });

  it('enable installs-gated → running, idempotent re-enable', async () => {
    const r1 = await post('/api/addons/codex/enable');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().status).toBe('running');
    const r2 = await post('/api/addons/codex/enable'); // idempotent branch
    expect(r2.statusCode).toBe(200);
    expect(r2.json().enabled).toBe(true);
  });

  it('config PUT validates + persists', async () => {
    const ok = await put('/api/addons/codex/config', { defaultModel: 'gpt-5-codex', sandbox: 'read-only' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().config).toMatchObject({ defaultModel: 'gpt-5-codex', sandbox: 'read-only' });
    const bad = await put('/api/addons/codex/config', { sandbox: 'turbo' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/sandbox/);
  });

  it('restart is not-applicable for an engine add-on', async () => {
    const r = await post('/api/addons/codex/restart');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not-applicable');
  });

  it('install refuses when the engine binary is already present', async () => {
    const r = await post('/api/addons/codex/install');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('already-installed');
  });

  it('disable on an engine add-on does not touch a process', async () => {
    const r = await post('/api/addons/codex/disable');
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('disabled');
  });

  it('enable refuses with 409 not-installed when the binary is absent', async () => {
    process.env.CODEX_BIN = '/missing/codex';
    addons.__resetAddonsForTests();
    const r = await post('/api/addons/codex/enable');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not-installed');
    process.env.CODEX_BIN = FAKE_CODEX;
    addons.__resetAddonsForTests();
  });
});

describe('route handlers — service add-on (web-research) config + 403 status', () => {
  it('config PUT validates the SearXNG URL and rejects a bad one', async () => {
    const bad = await put('/api/addons/web-research/config', { searxngUrl: 'gopher://x' });
    expect(bad.statusCode).toBe(400);
    const ok = await put('/api/addons/web-research/config', { searxngUrl: `http://127.0.0.1:${searxngPort}`, maxResults: 6 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().config.maxResults).toBe(6);
  });

  it('enabled + reachable JSON probe → running', async () => {
    const en = await post('/api/addons/web-research/enable');
    expect(en.statusCode).toBe(200);
    const info = (await get('/api/addons/web-research')).json();
    expect(info.installed).toBe(true);
    expect(info.status).toBe('running');
    await post('/api/addons/web-research/disable');
  });

  it('restart is not-applicable for a service add-on', async () => {
    const r = await post('/api/addons/web-research/restart');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not-applicable');
  });
});

describe('proxy add-on (compression) lifecycle, stats, env, and override note', () => {
  it('enable spawns the fake proxy → running, stats num() helper maps the 0.24.0 shape', async () => {
    // set the port while still DISABLED so enable spawns once on TEST_PORT (no live-restart race)
    await put('/api/addons/compression/config', { port: TEST_PORT });
    const en = await post('/api/addons/compression/enable');
    expect(en.statusCode).toBe(200);
    const running = await waitForCompression((x) => x.status === 'running');
    expect(running.statusDetail).toBeNull();

    const stats = (await get('/api/addons/compression/stats')).json();
    expect(stats.healthy).toBe(true);
    expect(stats.endpoint).toBe(`http://127.0.0.1:${TEST_PORT}`);
    expect(stats.totalRequests).toBe(7);
    expect(stats.tokensSaved).toBe(2048);
    expect(stats.savingsPercent).toBe(33.3);
    expect(stats.savedUsd).toBe(0.5);
  }, 20_000);

  it('addonRunEnv injects ANTHROPIC_BASE_URL while running', async () => {
    await waitForCompression((x) => x.status === 'running');
    expect(addons.addonRunEnv()).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${TEST_PORT}` });
  }, 20_000);

  it('surfaces the override note when ANTHROPIC_BASE_URL is set in the server env', async () => {
    await waitForCompression((x) => x.status === 'running');
    process.env.ANTHROPIC_BASE_URL = 'http://corp-gateway:9000';
    try {
      const info = (await get('/api/addons/compression')).json();
      expect(info.status).toBe('running');
      expect(info.statusDetail).toMatch(/ANTHROPIC_BASE_URL is already set/);
      expect(addons.addonRunEnv()).toEqual({}); // not overridden
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  }, 20_000);

  it('install refuses while headroom is already present', async () => {
    const r = await post('/api/addons/compression/install');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('already-installed');
  });

  it('restart bounces the child (stopProxy SIGTERM → startProxy) and recovers', async () => {
    const r = await post('/api/addons/compression/restart');
    expect(r.statusCode).toBe(200);
    await waitForCompression((x) => x.status === 'running');
  }, 20_000);

  it('disable issues SIGTERM, the fake proxy port stops answering, run env clears', async () => {
    const r = await post('/api/addons/compression/disable');
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('disabled');
    expect(addons.addonRunEnv()).toEqual({});
    const deadline = Date.now() + 5000;
    let dead = false;
    while (Date.now() < deadline && !dead) {
      try {
        await fetch(`http://127.0.0.1:${TEST_PORT}/health`, { signal: AbortSignal.timeout(300) });
        await new Promise((r) => setTimeout(r, 150));
      } catch { dead = true; }
    }
    expect(dead).toBe(true);
  }, 20_000);

  it('restart refuses (409) while disabled', async () => {
    expect((await post('/api/addons/compression/restart')).statusCode).toBe(409);
  });
});

describe('compression stats while the proxy is down', () => {
  it('reports unhealthy with an error when nothing answers the port', async () => {
    const s = (await get('/api/addons/compression/stats')).json();
    expect(s.healthy).toBe(false);
    expect(s.error).toBe('proxy is not responding');
  });
});

describe('404s for unknown add-ons across every route', () => {
  it('GET / enable / disable / restart / config / install all 404', async () => {
    expect((await get('/api/addons/ghost')).statusCode).toBe(404);
    expect((await post('/api/addons/ghost/enable')).statusCode).toBe(404);
    expect((await post('/api/addons/ghost/disable')).statusCode).toBe(404);
    expect((await post('/api/addons/ghost/restart')).statusCode).toBe(404);
    expect((await put('/api/addons/ghost/config', {})).statusCode).toBe(404);
    expect((await post('/api/addons/ghost/install')).statusCode).toBe(404);
  });
});
