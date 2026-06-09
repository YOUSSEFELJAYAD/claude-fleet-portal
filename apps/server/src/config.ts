import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PortalConfig, PermissionMode } from '@fleet/shared';
import { PERMISSION_MODES } from '@fleet/shared';

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

export const HOME = os.homedir();
/** The `claude` binary (or the mock-claude replayer). DC.md D-009. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
/**
 * The REAL claude binary for management subcommands (e.g. `mcp list`) — these can't be
 * emulated by the mock replayer, so when CLAUDE_BIN points at the mock we fall back to
 * `claude` on PATH. Override with CLAUDE_REAL_BIN. (A5 — MCP panel.)
 */
export const CLAUDE_REAL_BIN =
  process.env.CLAUDE_REAL_BIN || (/mock/i.test(CLAUDE_BIN) ? 'claude' : CLAUDE_BIN);
export const TASKS_DIR = path.join(HOME, '.claude', 'tasks');
export const USER_SKILLS_DIR = path.join(HOME, '.claude', 'skills');
export const PROJECT_SKILLS_DIRNAME = path.join('.claude', 'skills');
export const USER_AGENTS_DIR = path.join(HOME, '.claude', 'agents');
export const PROJECT_AGENTS_DIRNAME = path.join('.claude', 'agents');

export const DATA_DIR = process.env.FLEET_DATA_DIR || path.join(REPO_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'fleet.db');

export const HOST = process.env.FLEET_HOST || '127.0.0.1';
export const PORT = Number(process.env.FLEET_SERVER_PORT || 4319);
/** Port the Next.js web app runs on (DC.md D-015) — the only allowed CORS origin. */
export const WEB_PORT = Number(process.env.FLEET_WEB_PORT || 4318);

/**
 * H3 — DNS-rebinding defense for the unauthenticated localhost control plane (D-011).
 * The Host allowlist is the load-bearing guard: a rebound attacker domain becomes
 * same-origin in the browser but its Host header is still the attacker domain, so it
 * is rejected here. CORS origin scoping is defense-in-depth for the browser read path.
 */
export const ALLOWED_HOSTS = new Set<string>([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
  `${HOST}:${PORT}`,
]);

export const ALLOWED_ORIGINS = new Set<string>([
  `http://127.0.0.1:${WEB_PORT}`,
  `http://localhost:${WEB_PORT}`,
  `http://[::1]:${WEB_PORT}`,
]);

/**
 * H6 — point spawned runs' OTLP exporter at the control plane itself (it hosts /v1/metrics +
 * /v1/logs). Default on; disable with FLEET_OTEL=0. NEVER use the console exporter (would
 * corrupt the stream-json stdout channel the parser reads).
 */
export const OTEL_ENABLED = process.env.FLEET_OTEL !== '0';
export const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || `http://127.0.0.1:${PORT}`;

/** Default guardrails (PRD §7.7). ultracode runs get a tighter ceiling (DC.md D-008). */
export const DEFAULT_CONFIG: PortalConfig = {
  maxConcurrentRuns: 8,
  defaultBudgetUsd: 5,
  ultracodeBudgetUsd: 15,
  permissionDefault: 'default',
  subagentConcurrentCeiling: 16,
  subagentTotalCeiling: 1000,
};

/**
 * H9 — validate & clamp an incoming PortalConfig before it governs the guardrails.
 * Unvalidated config is a safety hole: maxConcurrentRuns:0 deadlocks every launch,
 * and a missing/negative/NaN budget disables the per-run ceiling. Missing keys fall
 * back to DEFAULT_CONFIG (so a partial PUT never leaves a ceiling undefined); a
 * present-but-invalid value throws a 400. Unknown keys are ignored.
 */
export function validateConfig(input: unknown): PortalConfig {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('config must be an object'), { statusCode: 400 });
  }
  const i = input as Record<string, unknown>;
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
  const num = (
    key: keyof PortalConfig,
    opts: { min: number; max?: number; int?: boolean },
  ): number => {
    if (i[key] === undefined) return DEFAULT_CONFIG[key] as number;
    const v = i[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${String(key)} must be a finite number`);
    if (opts.int && !Number.isInteger(v)) throw bad(`${String(key)} must be an integer`);
    if (v < opts.min) throw bad(`${String(key)} must be >= ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) throw bad(`${String(key)} must be <= ${opts.max}`);
    return v;
  };
  let permissionDefault = DEFAULT_CONFIG.permissionDefault;
  if (i.permissionDefault !== undefined) {
    if (!PERMISSION_MODES.includes(i.permissionDefault as PermissionMode)) throw bad('permissionDefault invalid');
    permissionDefault = i.permissionDefault as PermissionMode;
  }
  return {
    maxConcurrentRuns: num('maxConcurrentRuns', { min: 1, max: 100, int: true }),
    defaultBudgetUsd: num('defaultBudgetUsd', { min: 0.0001 }),
    ultracodeBudgetUsd: num('ultracodeBudgetUsd', { min: 0.0001 }),
    permissionDefault,
    subagentConcurrentCeiling: num('subagentConcurrentCeiling', { min: 1, max: 16, int: true }),
    subagentTotalCeiling: num('subagentTotalCeiling', { min: 1, max: 1000, int: true }),
  };
}
