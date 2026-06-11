/**
 * Add-on Marketplace (DC.md §22) — optional capabilities toggled at runtime.
 *
 * The first (built-in) add-on is `compression`: the Headroom transparent proxy
 * (https://headroom-docs.vercel.app) sits between spawned claude runs and the
 * Anthropic API and compresses tool outputs / logs / search results / code before
 * they reach the model (typ. 60–90% savings on tool-heavy turns; reversible — the
 * model gets a headroom_retrieve tool to fetch originals on demand).
 *
 * Integration shape (per the headroom docs):
 *   pip install "headroom-ai[proxy]"        → `headroom` CLI
 *   headroom proxy --host 127.0.0.1 --port N → Anthropic passthrough on /v1/messages
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:N    → claude routes through the proxy
 *   GET /health, /stats                      → live savings telemetry
 *
 * This module OWNS the proxy child process (start/stop/health/auto-restart), the
 * `addons` table (enabled flag + config per add-on), and the env injected into
 * spawned runs (processManager merges addonRunEnv() — the single injection point,
 * so manual runs, campaigns and the PM all route through the proxy identically).
 *
 * Routes:
 *   GET  /api/addons                      — marketplace listing
 *   GET  /api/addons/:id                  — one add-on
 *   POST /api/addons/:id/enable|disable   — toggle (starts/stops the proxy)
 *   POST /api/addons/:id/restart          — bounce the backing process
 *   PUT  /api/addons/:id/config           — validate + persist + live-restart
 *   GET  /api/addons/compression/stats    — proxy /health + /stats passthrough
 *   POST /api/addons/:id/install          — best-effort dependency install (uv/pipx/pip3)
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AddonInfo, AddonStatus, AddonInstallResult, CompressionConfig, CompressionStats, SelfUpdateStep, RunEngine } from '@fleet/shared';
import { HOME, PORT, WEB_PORT } from './config.js';
import db from './db.js';
import type { CodexEngineConfig, OpencodeEngineConfig } from './engines.js';

const execFileAsync = promisify(execFile);

// projects.ts pattern — the module owns its table; runs after db.ts's migration loop.
db.exec(`
CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
`);

// ── catalog ──────────────────────────────────────────────────────────────────────

const COMPRESSION_ID = 'compression';
const CODEX_ID = 'codex';
const OPENCODE_ID = 'opencode';

/** Discriminator: 'proxy' add-ons manage a child process; 'engine-binary' add-ons
 *  are CLI shims — no backing process, status is derived from installed + enabled. */
type AddonRuntime = 'proxy' | 'engine-binary';

interface AddonDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  kind: 'builtin';
  docsUrl: string;
  page: string;
  runtime: AddonRuntime;
}

/** Static descriptors — adding a marketplace add-on later = one more entry here. */
const ADDON_DEFS: AddonDef[] = [
  {
    id: COMPRESSION_ID,
    name: 'Compression',
    tagline: 'Cut token burn 60–90% on tool-heavy runs',
    description:
      'Routes every agent through the Headroom transparent proxy, which compresses tool outputs, ' +
      'logs, search results and code before they reach the model — statistically, reversibly ' +
      '(agents get a retrieve tool for originals), and without touching your prompts. ' +
      'Live savings show up on the Compression page per request.',
    kind: 'builtin' as const,
    docsUrl: 'https://headroom-docs.vercel.app/docs',
    page: '/addons/compression',
    runtime: 'proxy',
  },
  {
    id: CODEX_ID,
    name: 'Codex Engine',
    tagline: 'Run fleet agents on the OpenAI Codex CLI (ChatGPT)',
    description:
      'Lets you launch one-shot runs on the codex CLI (OpenAI Codex CLI / ChatGPT) from the same fleet console. ' +
      'Experimental: flat timeline, no subagent tree, no resume/input, no budget enforcement. ' +
      'Stop works. Requires `codex` on PATH (npm install -g @openai/codex) and ChatGPT auth.',
    kind: 'builtin' as const,
    docsUrl: 'https://developers.openai.com/codex/cli',
    page: '/addons/codex',
    runtime: 'engine-binary',
  },
  {
    id: OPENCODE_ID,
    name: 'OpenCode Engine',
    tagline: 'Run fleet agents on the open-source OpenCode multi-provider CLI',
    description:
      'Lets you launch one-shot runs on the opencode CLI (open-source, multi-provider) from the same fleet console. ' +
      'Experimental: flat timeline, no subagent tree, no resume/input, no budget enforcement. ' +
      'Stop works. Requires `opencode` on PATH (npm install -g opencode-ai@latest) and your provider credentials.',
    kind: 'builtin' as const,
    docsUrl: 'https://opencode.ai/docs/cli',
    page: '/addons/opencode',
    runtime: 'engine-binary',
  },
];

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  port: 8787, // headroom's own default
  applyToNewRuns: true,
  optimize: true,
  cache: true,
  rateLimit: true,
  dailyBudgetUsd: null,
};

// ── persistence ──────────────────────────────────────────────────────────────────

function loadRow(id: string): { enabled: boolean; config: Record<string, unknown> } {
  const row = db.prepare('SELECT enabled, config FROM addons WHERE id = ?').get(id) as any;
  if (!row) return { enabled: false, config: {} };
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config);
    if (parsed && typeof parsed === 'object') config = parsed;
  } catch {
    /* tolerate a garbled row — defaults apply */
  }
  return { enabled: !!row.enabled, config };
}

function saveRow(id: string, enabled: boolean, config: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO addons (id, enabled, config, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`,
  ).run(id, enabled ? 1 : 0, JSON.stringify(config), Date.now());
}

function compressionConfig(): CompressionConfig {
  return { ...DEFAULT_COMPRESSION_CONFIG, ...(loadRow(COMPRESSION_ID).config as Partial<CompressionConfig>) };
}

/**
 * H9 spirit — validate before it governs a child process. A bad port would collide with
 * the portal's own listeners; a non-finite budget would emit a garbage --budget flag.
 * Missing keys fall back to the stored-then-default value (partial PUTs are fine).
 */
export function validateCompressionConfig(input: unknown): CompressionConfig {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('config must be an object'), { statusCode: 400 });
  }
  const i = input as Record<string, unknown>;
  const base = compressionConfig();
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

  let port = base.port;
  if (i.port !== undefined) {
    if (typeof i.port !== 'number' || !Number.isInteger(i.port)) throw bad('port must be an integer');
    if (i.port < 1024 || i.port > 65535) throw bad('port must be between 1024 and 65535');
    if (i.port === PORT || i.port === WEB_PORT) throw bad(`port ${i.port} is used by the portal itself`);
    port = i.port;
  }
  const bool = (key: keyof CompressionConfig): boolean => {
    if (i[key] === undefined) return base[key] as boolean;
    if (typeof i[key] !== 'boolean') throw bad(`${String(key)} must be a boolean`);
    return i[key] as boolean;
  };
  let dailyBudgetUsd = base.dailyBudgetUsd;
  if (i.dailyBudgetUsd !== undefined) {
    if (i.dailyBudgetUsd === null) dailyBudgetUsd = null;
    else if (typeof i.dailyBudgetUsd !== 'number' || !Number.isFinite(i.dailyBudgetUsd) || i.dailyBudgetUsd <= 0)
      throw bad('dailyBudgetUsd must be a positive number or null');
    else dailyBudgetUsd = i.dailyBudgetUsd;
  }
  return {
    port,
    applyToNewRuns: bool('applyToNewRuns'),
    optimize: bool('optimize'),
    cache: bool('cache'),
    rateLimit: bool('rateLimit'),
    dailyBudgetUsd,
  };
}

// ── headroom binary detection ────────────────────────────────────────────────────

const DETECT_TTL_MS = 60_000;
let detectCache: { at: number; bin: string | null; version: string | null } | null = null;

/** Where `headroom` may live: PATH, plus the dirs uv/pipx/pip --user install into
 *  (GUI-launched desktop apps often miss those in PATH). HEADROOM_BIN, when set,
 *  is AUTHORITATIVE — no fallback scanning behind an explicit operator override. */
function binCandidates(): string[] {
  if (process.env.HEADROOM_BIN) return [process.env.HEADROOM_BIN];
  return [
    'headroom',
    path.join(HOME, '.local', 'bin', 'headroom'),
    '/opt/homebrew/bin/headroom',
    '/usr/local/bin/headroom',
  ];
}

async function detectHeadroom(force = false): Promise<{ bin: string | null; version: string | null }> {
  if (!force && detectCache && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache;
  let found: { bin: string | null; version: string | null } = { bin: null, version: null };
  for (const bin of binCandidates()) {
    // absolute candidates we can pre-check cheaply; bare names go to execFile (PATH lookup)
    if (bin.includes('/') && !existsSync(bin)) continue;
    try {
      const { stdout, stderr } = await execFileAsync(bin, ['--version'], { timeout: 15_000 });
      found = { bin, version: (stdout + stderr).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null };
      break;
    } catch (e: any) {
      // a CLI without --version still exits non-zero WITH output; ENOENT means not there
      if (e?.code !== 'ENOENT' && (e?.stdout || e?.stderr)) {
        found = { bin, version: String(e.stdout ?? '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null };
        break;
      }
    }
  }
  detectCache = { at: Date.now(), ...found };
  return found;
}

export function __resetAddonsForTests() {
  detectCache = null;
  codexDetectCache = null;
  opencodeDetectCache = null;
}

// ── engine add-on defaults ───────────────────────────────────────────────────────

export const DEFAULT_CODEX_CONFIG: CodexEngineConfig = {
  defaultModel: null,
  sandbox: 'workspace-write',
};

export const DEFAULT_OPENCODE_CONFIG: OpencodeEngineConfig = {
  defaultModel: null,
  skipPermissions: false,
};

function codexConfig(): CodexEngineConfig {
  const raw = loadRow(CODEX_ID).config;
  return {
    ...DEFAULT_CODEX_CONFIG,
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : DEFAULT_CODEX_CONFIG.defaultModel,
    sandbox: (['read-only', 'workspace-write', 'danger-full-access'] as const).includes(raw.sandbox as any)
      ? (raw.sandbox as CodexEngineConfig['sandbox'])
      : DEFAULT_CODEX_CONFIG.sandbox,
  };
}

function opencodeConfig(): OpencodeEngineConfig {
  const raw = loadRow(OPENCODE_ID).config;
  return {
    ...DEFAULT_OPENCODE_CONFIG,
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : DEFAULT_OPENCODE_CONFIG.defaultModel,
    skipPermissions: typeof raw.skipPermissions === 'boolean' ? raw.skipPermissions : DEFAULT_OPENCODE_CONFIG.skipPermissions,
  };
}

/** Validate + merge engine config from a PUT body. Partial updates fine; unknown keys ignored. */
export function validateEngineConfig(id: string, input: unknown): CodexEngineConfig | OpencodeEngineConfig {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('config must be an object'), { statusCode: 400 });
  }
  const i = input as Record<string, unknown>;
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

  if (id === CODEX_ID) {
    const base = codexConfig();
    let defaultModel = base.defaultModel;
    let sandbox = base.sandbox;
    if (i.defaultModel !== undefined) {
      if (i.defaultModel !== null && typeof i.defaultModel !== 'string') throw bad('defaultModel must be a string or null');
      defaultModel = (i.defaultModel as string | null);
    }
    if (i.sandbox !== undefined) {
      const valid = ['read-only', 'workspace-write', 'danger-full-access'];
      if (!valid.includes(i.sandbox as string)) throw bad(`sandbox must be one of ${valid.join(', ')}`);
      sandbox = i.sandbox as CodexEngineConfig['sandbox'];
    }
    return { defaultModel, sandbox };
  }

  if (id === OPENCODE_ID) {
    const base = opencodeConfig();
    let defaultModel = base.defaultModel;
    let skipPermissions = base.skipPermissions;
    if (i.defaultModel !== undefined) {
      if (i.defaultModel !== null && typeof i.defaultModel !== 'string') throw bad('defaultModel must be a string or null');
      defaultModel = (i.defaultModel as string | null);
    }
    if (i.skipPermissions !== undefined) {
      if (typeof i.skipPermissions !== 'boolean') throw bad('skipPermissions must be a boolean');
      skipPermissions = i.skipPermissions;
    }
    return { defaultModel, skipPermissions };
  }

  throw Object.assign(new Error(`no engine config schema for id: ${id}`), { statusCode: 400 });
}

// ── engine binary detection ──────────────────────────────────────────────────────

let codexDetectCache: { at: number; bin: string | null; version: string | null } | null = null;
let opencodeDetectCache: { at: number; bin: string | null; version: string | null } | null = null;

function engineBinCandidates(engine: 'codex' | 'opencode'): string[] {
  const envKey = engine === 'codex' ? 'CODEX_BIN' : 'OPENCODE_BIN';
  if (process.env[envKey]) return [process.env[envKey]!];
  const name = engine === 'codex' ? 'codex' : 'opencode';
  return [
    name,
    path.join(HOME, '.local', 'bin', name),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
  ];
}

async function detectEngineBin(engine: 'codex' | 'opencode', force = false): Promise<{ bin: string | null; version: string | null }> {
  const cache = engine === 'codex' ? codexDetectCache : opencodeDetectCache;
  if (!force && cache && Date.now() - cache.at < DETECT_TTL_MS) return cache;

  let found: { bin: string | null; version: string | null } = { bin: null, version: null };
  for (const bin of engineBinCandidates(engine)) {
    if (bin.includes('/') && !existsSync(bin)) continue;
    try {
      const { stdout, stderr } = await execFileAsync(bin, ['--version'], { timeout: 15_000 });
      found = { bin, version: (stdout + stderr).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null };
      break;
    } catch (e: any) {
      if (e?.code !== 'ENOENT' && (e?.stdout || e?.stderr)) {
        found = { bin, version: String(e.stdout ?? '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null };
        break;
      }
    }
  }
  const entry = { at: Date.now(), ...found };
  if (engine === 'codex') codexDetectCache = entry;
  else opencodeDetectCache = entry;
  return found;
}

// ── engine add-on public API (used by registry.ts) ───────────────────────────────

/** Returns the binary path for the engine, or null if not installed. */
export async function getEngineBin(engine: RunEngine): Promise<string | null> {
  if (engine !== 'codex' && engine !== 'opencode') return null;
  return (await detectEngineBin(engine)).bin;
}

/** Returns the validated config for the engine. */
export function engineLaunchConfig(engine: RunEngine): CodexEngineConfig | OpencodeEngineConfig {
  if (engine === 'codex') return codexConfig();
  if (engine === 'opencode') return opencodeConfig();
  throw new Error(`not an engine add-on: ${engine}`);
}

/** Returns true if the engine add-on is enabled. */
export function isEngineEnabled(engine: RunEngine): boolean {
  if (engine !== 'codex' && engine !== 'opencode') return false;
  return loadRow(engine).enabled;
}

// ── proxy lifecycle ──────────────────────────────────────────────────────────────

const HEALTH_TIMEOUT_MS = 2_000;
const START_DEADLINE_MS = 25_000; // python cold start can take a few seconds
const STDERR_TAIL_CHARS = 600;
const MAX_AUTO_RESTARTS = 3;
/** A run shorter than this counts toward the restart cap — otherwise a proxy that
 *  answers ONE health probe and then dies would reset the counter every lap and
 *  crash-loop forever (review: flapping defeats the cap). */
const STABLE_UPTIME_MS = 60_000;
/** Re-verify a 'running' proxy on this cadence — the spawned path has an exit
 *  handler, but an ATTACHED external proxy (or a hung child) would otherwise stay
 *  'running' forever while runs get routed to a dead port (review: latched status). */
const WATCHDOG_MS = 10_000;

interface ProxyState {
  proc: ChildProcess | null;
  status: Extract<AddonStatus, 'starting' | 'running' | 'stopped' | 'error'>;
  detail: string | null;
  /** attached to a proxy we did not spawn (already listening on the port) */
  external: boolean;
  restarts: number;
  /** generation token — a stale async start/exit handler from a previous
   *  enable/disable cycle must not clobber the current state */
  gen: number;
  outTail: string;
  /** when the current incarnation first probed healthy (uptime for the stable-run test) */
  healthyAt: number | null;
}

const proxy: ProxyState = {
  proc: null,
  status: 'stopped',
  detail: null,
  external: false,
  restarts: 0,
  gen: 0,
  outTail: '',
  healthyAt: null,
};

const endpoint = (port: number) => `http://127.0.0.1:${port}`;

/** Probe /health and confirm the responder actually looks like headroom (an
 *  arbitrary service squatting the port must read as "port busy", not "running"). */
async function probeHealth(port: number): Promise<{ healthy: boolean; body: any | null }> {
  try {
    const res = await fetch(`${endpoint(port)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return { healthy: false, body: null };
    const body = await res.json().catch(() => null);
    // verified vs real headroom 0.24.0: /health is {service:'headroom-proxy', status, version,
    // config:{optimize,…}, …}; the docs' {status, optimize, stats} shape is kept as fallback.
    const looksLikeHeadroom =
      !!body && typeof body === 'object' && ((body as any).service === 'headroom-proxy' || 'optimize' in body || 'stats' in body);
    return { healthy: looksLikeHeadroom, body };
  } catch {
    return { healthy: false, body: null };
  }
}

function proxyArgs(cfg: CompressionConfig): string[] {
  const args = ['proxy', '--host', '127.0.0.1', '--port', String(cfg.port)];
  if (!cfg.optimize) args.push('--no-optimize');
  if (!cfg.cache) args.push('--no-cache');
  if (!cfg.rateLimit) args.push('--no-rate-limit');
  if (cfg.dailyBudgetUsd != null) args.push('--budget', String(cfg.dailyBudgetUsd));
  return args;
}

async function startProxy(): Promise<void> {
  // never resurrect a disabled add-on (a watchdog/auto-restart racing a disable),
  // and never run two children: an existing child is stopped first — without this,
  // a second enable would orphan the live child's exit handler and the attach-probe
  // below would re-label our OWN child as 'external' (review: re-enable race).
  if (!loadRow(COMPRESSION_ID).enabled) return;
  if (proxy.proc) {
    const keep = proxy.restarts; // stopProxy zeroes the cap counter (intentional stops)
    await stopProxy('starting');
    proxy.restarts = keep;
  }
  const gen = ++proxy.gen;
  // a restart must wait for the previous child to actually release the port —
  // otherwise the attach-probe below can latch onto our own dying process.
  await lastStop;
  if (gen !== proxy.gen) return;
  const cfg = compressionConfig();
  proxy.status = 'starting';
  proxy.detail = null;
  proxy.external = false;
  proxy.outTail = '';

  // attach mode — the user (or a previous server) already runs headroom on this port
  const pre = await probeHealth(cfg.port);
  if (gen !== proxy.gen) return;
  if (pre.healthy) {
    proxy.external = true;
    proxy.status = 'running';
    proxy.detail = 'attached to an already-running proxy on this port';
    return;
  }

  const { bin } = await detectHeadroom();
  if (gen !== proxy.gen) return;
  if (!bin) {
    proxy.status = 'error';
    proxy.detail = 'headroom binary not found — install it from the Compression page';
    return;
  }

  let child: ChildProcess;
  try {
    child = spawn(bin, proxyArgs(cfg), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HEADROOM_TELEMETRY: 'off' },
    });
  } catch (e: any) {
    proxy.status = 'error';
    proxy.detail = `failed to spawn headroom: ${e?.message ?? e}`;
    return;
  }
  proxy.proc = child;

  const tail = (chunk: string) => {
    proxy.outTail = (proxy.outTail + chunk).slice(-STDERR_TAIL_CHARS);
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', tail);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', tail);
  child.on('error', (e) => {
    if (gen !== proxy.gen) return;
    proxy.status = 'error';
    proxy.detail = `headroom failed to start: ${e.message}`;
    proxy.proc = null;
  });
  child.on('exit', (code, signal) => {
    if (gen !== proxy.gen) return; // an intentional stop/restart already moved on
    proxy.proc = null;
    // only a STABLE run earns a fresh restart budget — resetting on the first healthy
    // probe would let a flapping proxy (healthy for seconds, then dead) loop forever
    const uptime = proxy.healthyAt ? Date.now() - proxy.healthyAt : 0;
    if (uptime >= STABLE_UPTIME_MS) proxy.restarts = 0;
    proxy.healthyAt = null;
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    if (loadRow(COMPRESSION_ID).enabled && proxy.restarts < MAX_AUTO_RESTARTS) {
      proxy.restarts += 1;
      proxy.status = 'starting';
      proxy.detail = `proxy died (${why}) — restarting (attempt ${proxy.restarts}/${MAX_AUTO_RESTARTS})`;
      setTimeout(() => {
        if (gen === proxy.gen && loadRow(COMPRESSION_ID).enabled) void startProxy();
      }, 1500 * proxy.restarts).unref();
    } else {
      proxy.status = 'error';
      proxy.detail = `proxy died (${why})${proxy.outTail ? ` — ${proxy.outTail.trim().split('\n').slice(-2).join(' · ')}` : ''}`;
    }
  });

  // wait for the first healthy probe (in the background of the enable request)
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (gen !== proxy.gen) return;
    if (child.exitCode != null || child.signalCode != null) return; // exit handler owns status
    const { healthy } = await probeHealth(cfg.port);
    if (gen !== proxy.gen) return;
    if (healthy) {
      proxy.status = 'running';
      proxy.detail = null;
      proxy.healthyAt = Date.now(); // restart budget resets only after STABLE_UPTIME_MS
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (gen !== proxy.gen) return;
  // deadline kill is a TERMINAL diagnosis, not a crash — stopProxy bumps gen so this
  // child's exit handler can't flip 'error' back into futile 25s retry cycles
  const detail = `proxy did not become healthy within ${START_DEADLINE_MS / 1000}s${proxy.outTail ? ` — ${proxy.outTail.trim().split('\n').slice(-2).join(' · ')}` : ''}`;
  void stopProxy('error');
  proxy.detail = detail;
}

/** Resolves once the spawned child has exited (or after the SIGKILL escalation window). */
let lastStop: Promise<void> = Promise.resolve();

function stopProxy(finalStatus: ProxyState['status'] = 'stopped'): Promise<void> {
  proxy.gen += 1; // invalidate any in-flight start loop / exit handler
  proxy.restarts = 0;
  proxy.healthyAt = null;
  const child = proxy.proc;
  proxy.proc = null;
  proxy.status = finalStatus;
  proxy.detail = proxy.external ? 'external proxy left running (not spawned by the portal)' : null;
  proxy.external = false;
  if (!child || child.exitCode != null || child.signalCode != null) return lastStop;
  lastStop = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve(); // the port frees as the process dies; don't hang the caller past this
    }, 3000);
    t.unref();
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
  return lastStop;
}

// ── run env injection ────────────────────────────────────────────────────────────

/**
 * Env merged into every spawned claude child (processManager) — the ONE place the
 * compression add-on becomes real for runs. Only while the proxy is verified healthy
 * (`running`): pointing runs at a dead proxy would fail every API call. An operator's
 * own ANTHROPIC_BASE_URL (corporate gateway, custom endpoint) is NEVER overridden —
 * silently re-routing credentialed egress away from a configured gateway is worse
 * than skipping compression (the add-on page surfaces this).
 */
export function addonRunEnv(): Record<string, string> {
  if (process.env.ANTHROPIC_BASE_URL) return {};
  const { enabled } = loadRow(COMPRESSION_ID);
  if (!enabled || proxy.status !== 'running') return {};
  const cfg = compressionConfig();
  if (!cfg.applyToNewRuns) return {};
  return { ANTHROPIC_BASE_URL: endpoint(cfg.port) };
}

// ── AddonInfo assembly ───────────────────────────────────────────────────────────

async function addonInfo(id: string): Promise<AddonInfo | null> {
  const def = ADDON_DEFS.find((d) => d.id === id);
  if (!def) return null;
  const { enabled } = loadRow(id);

  // ── engine-binary add-ons: no backing process, status derived from installed+enabled ──
  if (def.runtime === 'engine-binary') {
    const engine = id as 'codex' | 'opencode';
    const det = await detectEngineBin(engine);
    const installed = !!det.bin;
    let status: AddonStatus;
    if (!installed) status = 'not-installed';
    else if (!enabled) status = 'disabled';
    else status = 'running'; // "running" = enabled and available (no backing process to probe)
    const authHint = engine === 'codex'
      ? 'auth via `codex login` or CODEX_API_KEY'
      : 'uses your `opencode auth` providers';
    const statusDetail = (enabled && installed) ? authHint : null;
    const cfg = engine === 'codex'
      ? codexConfig() as unknown as Record<string, unknown>
      : opencodeConfig() as unknown as Record<string, unknown>;
    return {
      ...def,
      enabled,
      installed,
      version: det.version,
      status,
      statusDetail,
      config: cfg,
    };
  }

  // ── proxy add-on (compression) ──
  const det = await detectHeadroom();
  const installed = !!det.bin;
  const cfg = compressionConfig();
  let status: AddonStatus;
  if (!installed && !proxy.external) status = 'not-installed';
  else if (!enabled) status = 'disabled';
  else status = proxy.status;
  // proxy.detail is meaningful disabled too ('external proxy left running'); the env-override
  // note explains why a green proxy may still not be routing runs (addonRunEnv respects it).
  let statusDetail = proxy.detail;
  if (enabled && proxy.status === 'running' && cfg.applyToNewRuns && process.env.ANTHROPIC_BASE_URL) {
    statusDetail = [statusDetail, 'ANTHROPIC_BASE_URL is already set in the server environment — the portal will not override it, so runs are NOT routed through the proxy'].filter(Boolean).join(' · ');
  }
  return {
    ...def,
    enabled,
    installed,
    version: det.version,
    status,
    statusDetail,
    config: cfg as unknown as Record<string, unknown>,
  };
}

// ── dependency install (uv → pipx → pip3, first available) ──────────────────────

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INSTALLERS: Array<{ cmd: string; args: string[] }> = [
  { cmd: 'uv', args: ['tool', 'install', 'headroom-ai[proxy]'] },
  { cmd: 'pipx', args: ['install', 'headroom-ai[proxy]'] },
  { cmd: 'pip3', args: ['install', '--user', 'headroom-ai[proxy]'] },
];
let installInFlight = false;

async function installHeadroom(): Promise<AddonInstallResult> {
  const steps: SelfUpdateStep[] = [];
  const trunc = (s: string) => (s.length > 4000 ? `…${s.slice(-4000)}` : s);

  let installer: { cmd: string; args: string[] } | null = null;
  for (const cand of INSTALLERS) {
    try {
      await execFileAsync(cand.cmd, ['--version'], { timeout: 15_000 });
      installer = cand;
      break;
    } catch {
      /* not available — try the next */
    }
  }
  steps.push({
    step: 'detect a Python package installer (uv / pipx / pip3)',
    ok: !!installer,
    output: installer ? `using ${installer.cmd}` : 'none found — install Python 3.10+ first',
  });
  if (!installer) return { ok: false, steps, note: 'No Python installer found. Install Python 3.10+, then retry.' };

  try {
    const { stdout, stderr } = await execFileAsync(installer.cmd, installer.args, { timeout: INSTALL_TIMEOUT_MS });
    steps.push({ step: `${installer.cmd} ${installer.args.join(' ')}`, ok: true, output: trunc(stdout + stderr) });
  } catch (e: any) {
    steps.push({ step: `${installer.cmd} ${installer.args.join(' ')}`, ok: false, output: trunc(String(e?.stderr ?? e?.message ?? e)) });
    return { ok: false, steps, note: 'Install failed — output above. You can also run it manually in a terminal.' };
  }

  const det = await detectHeadroom(true);
  steps.push({
    step: 'verify the headroom binary',
    ok: !!det.bin,
    output: det.bin ? `${det.bin}${det.version ? ` (v${det.version})` : ''}` : 'installed, but `headroom` is not on PATH — add ~/.local/bin to PATH',
  });
  return {
    ok: !!det.bin,
    steps,
    note: det.bin ? 'Headroom installed — enable the add-on to start compressing.' : 'Installed but not found on PATH.',
  };
}

// ── engine dependency install (npm first; brew/curl advisory fallback) ──────────────

const NPM_INSTALL_PACKAGES: Record<string, string[]> = {
  [CODEX_ID]: ['install', '-g', '@openai/codex'],
  [OPENCODE_ID]: ['install', '-g', 'opencode-ai@latest'],
};

async function installEngine(id: string): Promise<AddonInstallResult> {
  const engine = id as 'codex' | 'opencode';
  const steps: SelfUpdateStep[] = [];
  const trunc = (s: string) => (s.length > 4000 ? `…${s.slice(-4000)}` : s);
  const npmArgs = NPM_INSTALL_PACKAGES[id];
  if (!npmArgs) return { ok: false, steps, note: 'Unknown engine.' };

  // Detect npm
  let hasNpm = false;
  try {
    await execFileAsync('npm', ['--version'], { timeout: 10_000 });
    hasNpm = true;
  } catch {
    /* no npm */
  }
  steps.push({
    step: 'detect npm',
    ok: hasNpm,
    output: hasNpm ? 'npm found' : 'npm not found — install Node.js 18+ first, or use brew/curl to install manually',
  });
  if (!hasNpm) {
    const manualHint = engine === 'codex'
      ? 'brew install --cask codex  OR  npm install -g @openai/codex'
      : 'brew install opencode-ai/tap/opencode  OR  npm install -g opencode-ai@latest';
    return { ok: false, steps, note: `npm not available. Manual install: ${manualHint}` };
  }

  try {
    const { stdout, stderr } = await execFileAsync('npm', npmArgs, { timeout: INSTALL_TIMEOUT_MS });
    steps.push({ step: `npm ${npmArgs.join(' ')}`, ok: true, output: trunc(stdout + stderr) });
  } catch (e: any) {
    steps.push({ step: `npm ${npmArgs.join(' ')}`, ok: false, output: trunc(String(e?.stderr ?? e?.message ?? e)) });
    return { ok: false, steps, note: 'Install failed — output above. You can also run it manually in a terminal.' };
  }

  const det = await detectEngineBin(engine, true);
  const binName = engine === 'codex' ? 'codex' : 'opencode';
  steps.push({
    step: `verify the ${binName} binary`,
    ok: !!det.bin,
    output: det.bin ? `${det.bin}${det.version ? ` (v${det.version})` : ''}` : `installed, but \`${binName}\` is not on PATH — add npm global bin to PATH`,
  });
  return {
    ok: !!det.bin,
    steps,
    note: det.bin
      ? `${engine === 'codex' ? 'Codex' : 'OpenCode'} installed — enable the add-on to use it.`
      : 'Installed but not found on PATH.',
  };
}

// ── stats ────────────────────────────────────────────────────────────────────────

async function compressionStats(): Promise<CompressionStats> {
  const cfg = compressionConfig();
  const base: CompressionStats = {
    healthy: false,
    endpoint: endpoint(cfg.port),
    totalRequests: null,
    tokensSaved: null,
    savingsPercent: null,
    savedUsd: null,
    error: null,
  };
  const { healthy, body } = await probeHealth(cfg.port);
  if (!healthy) return { ...base, error: 'proxy is not responding' };
  const h = (body?.stats ?? {}) as Record<string, unknown>; // docs-shape fallback
  // the counters live on /stats — verified vs real headroom 0.24.0:
  //   summary.api_requests · savings.total_tokens · summary.cost.{savings_pct,total_saved_usd}
  let s: any = {};
  try {
    const res = await fetch(`${base.endpoint}/stats`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (res.ok) s = (await res.json().catch(() => null)) ?? {};
  } catch {
    /* /health alone is enough */
  }
  const num = (...vals: unknown[]): number | null => {
    for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  };
  return {
    ...base,
    healthy: true,
    totalRequests: num(s?.summary?.api_requests, h.total_requests, s.total_requests),
    tokensSaved: num(s?.savings?.total_tokens, s?.summary?.compression?.total_tokens_removed, h.tokens_saved, s.tokens_saved),
    savingsPercent: num(s?.summary?.cost?.savings_pct, s?.summary?.compression?.avg_compression_pct, h.savings_percent, s.savings_percent),
    savedUsd: num(s?.summary?.cost?.total_saved_usd),
  };
}

// ── routes + boot ────────────────────────────────────────────────────────────────

export function registerAddonRoutes(app: FastifyInstance) {
  // boot: an add-on enabled in a previous server life resumes automatically
  if (loadRow(COMPRESSION_ID).enabled) void startProxy();

  // Watchdog — 'running' must stay TRUE, not latched: an attached external proxy has
  // no exit handler, and a spawned child can hang without exiting. Two consecutive
  // failed probes ≈ dead → recover through the normal restart budget (which may
  // re-attach or respawn), or park in 'error' once the budget is spent. Without this,
  // addonRunEnv would keep routing every new run to a dead port.
  let healthFails = 0;
  let watchTick = false; // probes can outlive the interval slot — never overlap
  const watchdog = setInterval(async () => {
    if (watchTick) return;
    watchTick = true;
    try {
      if (!loadRow(COMPRESSION_ID).enabled || proxy.status !== 'running') {
        healthFails = 0;
        return;
      }
      const { healthy } = await probeHealth(compressionConfig().port);
      if (healthy) {
        healthFails = 0;
        return;
      }
      healthFails += 1;
      if (healthFails < 2) return;
      healthFails = 0;
      const attempts = proxy.restarts + 1;
      if (attempts > MAX_AUTO_RESTARTS) {
        await stopProxy('error');
        proxy.detail = 'proxy stopped responding repeatedly — check it, then Restart from the Compression page';
        return;
      }
      await stopProxy('starting');
      proxy.restarts = attempts; // stopProxy zeroes it; recovery attempts must count
      proxy.detail = `proxy stopped responding — recovering (attempt ${attempts}/${MAX_AUTO_RESTARTS})`;
      void startProxy();
    } finally {
      watchTick = false;
    }
  }, WATCHDOG_MS);
  watchdog.unref();

  app.addHook('onClose', async () => {
    clearInterval(watchdog);
    await stopProxy();
  });

  app.get('/api/addons', async () => {
    const infos = await Promise.all(ADDON_DEFS.map((d) => addonInfo(d.id)));
    return infos.filter(Boolean);
  });

  app.get('/api/addons/:id', async (req, reply) => {
    const info = await addonInfo((req.params as any).id);
    if (!info) return reply.code(404).send({ error: 'unknown add-on' });
    return info;
  });

  app.post('/api/addons/:id/enable', async (req, reply) => {
    const id = (req.params as any).id as string;
    const def = ADDON_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: 'unknown add-on' });

    // ── engine-binary enable ──
    if (def.runtime === 'engine-binary') {
      const engine = id as 'codex' | 'opencode';
      const row = loadRow(id);
      if (row.enabled) return addonInfo(id); // idempotent
      const det = await detectEngineBin(engine, true);
      if (!det.bin) {
        return reply.code(409).send({ error: `${engine} binary is not installed — install it first`, code: 'not-installed' });
      }
      saveRow(id, true, row.config);
      return addonInfo(id);
    }

    // ── proxy enable (compression) ──
    const row = loadRow(id);
    // idempotent: re-enabling a live add-on must NOT bounce (or orphan) the proxy —
    // a double-click / stale tab / retried request is a no-op, like the running state itself.
    if (row.enabled && (proxy.status === 'running' || proxy.status === 'starting')) return addonInfo(id);
    const det = await detectHeadroom(true);
    if (!det.bin) {
      // no binary, but a healthy external proxy on the configured port is attachable —
      // refusing would contradict startProxy's own attach mode
      const pre = await probeHealth(compressionConfig().port);
      if (!pre.healthy) {
        return reply.code(409).send({ error: 'headroom is not installed — install it first', code: 'not-installed' });
      }
    }
    saveRow(id, true, row.config);
    void startProxy(); // resolves in the background; the UI polls status
    return addonInfo(id);
  });

  app.post('/api/addons/:id/disable', async (req, reply) => {
    const id = (req.params as any).id as string;
    const def = ADDON_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: 'unknown add-on' });
    const row = loadRow(id);
    saveRow(id, false, row.config);
    // engine-binary: no process to stop
    if (def.runtime === 'proxy') stopProxy();
    return addonInfo(id);
  });

  app.post('/api/addons/:id/restart', async (req, reply) => {
    const id = (req.params as any).id as string;
    const def = ADDON_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: 'unknown add-on' });
    // engine-binary: no backing process to restart
    if (def.runtime === 'engine-binary') {
      return reply.code(409).send({ error: 'restart is not applicable to engine add-ons', code: 'not-applicable' });
    }
    if (!loadRow(id).enabled) return reply.code(409).send({ error: 'add-on is disabled' });
    stopProxy();
    void startProxy();
    return addonInfo(id);
  });

  app.put('/api/addons/:id/config', async (req, reply) => {
    const id = (req.params as any).id as string;
    const def = ADDON_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: 'unknown add-on' });

    // ── engine-binary config ──
    if (def.runtime === 'engine-binary') {
      let cfg: CodexEngineConfig | OpencodeEngineConfig;
      try {
        cfg = validateEngineConfig(id, req.body ?? {});
      } catch (e: any) {
        return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid config' });
      }
      const row = loadRow(id);
      saveRow(id, row.enabled, cfg as unknown as Record<string, unknown>);
      return addonInfo(id);
    }

    // ── proxy config (compression) ──
    let cfg: CompressionConfig;
    try {
      cfg = validateCompressionConfig(req.body ?? {});
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid config' });
    }
    const row = loadRow(id);
    saveRow(id, row.enabled, cfg as unknown as Record<string, unknown>);
    if (row.enabled) {
      // live-apply: the proxy's flags only change on relaunch
      stopProxy();
      void startProxy();
    }
    return addonInfo(id);
  });

  app.get('/api/addons/compression/stats', async () => compressionStats());

  app.post('/api/addons/:id/install', async (req, reply) => {
    const id = (req.params as any).id as string;
    const def = ADDON_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: 'unknown add-on' });

    // ── engine-binary install ──
    if (def.runtime === 'engine-binary') {
      const engine = id as 'codex' | 'opencode';
      const det = await detectEngineBin(engine, true);
      if (det.bin) {
        const name = engine === 'codex' ? 'codex' : 'opencode';
        return reply.code(409).send({ error: `${name} is already installed`, code: 'already-installed' });
      }
      if (installInFlight) return reply.code(409).send({ error: 'an install is already running', code: 'install-in-flight' });
      installInFlight = true;
      try {
        return await installEngine(id);
      } finally {
        installInFlight = false;
      }
    }

    // ── headroom (compression) install ──
    const det = await detectHeadroom(true);
    if (det.bin) return reply.code(409).send({ error: 'headroom is already installed', code: 'already-installed' });
    if (installInFlight) return reply.code(409).send({ error: 'an install is already running', code: 'install-in-flight' });
    installInFlight = true;
    try {
      return await installHeadroom();
    } finally {
      installInFlight = false;
    }
  });
}
