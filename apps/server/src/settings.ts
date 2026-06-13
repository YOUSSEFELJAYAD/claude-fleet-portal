/**
 * §31 — settings registry. Field descriptors whose writes delegate to the right backend:
 * live → registry.setConfig (now); env/secret → managed .env (next launch); derived → live.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SettingValue, SettingCategory, SettingSource, SettingApplyTiming } from '@fleet/shared';
import { DATA_DIR, HOST, PORT, WEB_PORT, validateConfig } from './config.js';
import { registry } from './registry.js';
import { addonRunEnv, isEngineEnabled } from './addons.js';
import { readMap, upsert, del } from './envfile.js';

const ENV_PATH = path.join(DATA_DIR, '.env');

interface FieldDef {
  key: string;
  label: string;
  category: SettingCategory;
  source: SettingSource;
  editable: boolean;
  secret: boolean;
  applyTiming: SettingApplyTiming;
  gatedBy: string | null;
  gate?: () => boolean;          // default: true
  get: () => string | null;      // running/derived value (plaintext; masked later for secrets)
  liveSet?: (value: string | null) => void; // live fields only
}

const cfgNum = (v: number | null) => (v == null ? '' : String(v));

const FIELDS: FieldDef[] = [
  // ── derived (read-only) ──
  { key: 'proxyUrl', label: 'Compression proxy URL', category: 'derived', source: 'derived', editable: false, secret: false, applyTiming: 'read-only', gatedBy: 'compression', gate: () => !!addonRunEnv().ANTHROPIC_BASE_URL, get: () => addonRunEnv().ANTHROPIC_BASE_URL ?? null },
  { key: 'serverAddr', label: 'Server address', category: 'derived', source: 'derived', editable: false, secret: false, applyTiming: 'read-only', gatedBy: null, get: () => `${HOST}:${PORT}` },
  { key: 'webPort', label: 'Web port', category: 'derived', source: 'derived', editable: false, secret: false, applyTiming: 'read-only', gatedBy: null, get: () => String(WEB_PORT) },
  // ── integration env (next launch) ──
  ...(['CLAUDE_BIN', 'CLAUDE_REAL_BIN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'FLEET_GITHUB_REPO'] as const).map(
    (key): FieldDef => ({ key, label: key, category: 'integration', source: 'env', editable: true, secret: false, applyTiming: 'next-launch', gatedBy: null, get: () => process.env[key] ?? '' }),
  ),
  // ── secrets (masked, next launch) ──
  { key: 'GITHUB_TOKEN', label: 'GitHub token', category: 'integration', source: 'env', editable: true, secret: true, applyTiming: 'next-launch', gatedBy: null, get: () => process.env.GITHUB_TOKEN ?? '' },
  { key: 'CODEX_API_KEY', label: 'Codex API key', category: 'integration', source: 'env', editable: true, secret: true, applyTiming: 'next-launch', gatedBy: 'codex', gate: () => isEngineEnabled('codex'), get: () => process.env.CODEX_API_KEY ?? '' },
  // ── live (applies now) ──
  { key: 'dailySpendCeilingUsd', label: 'Daily spend ceiling (USD)', category: 'live', source: 'portal-config', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => cfgNum(registry.getConfig().dailySpendCeilingUsd), liveSet: (v) => registry.setConfig(validateConfig({ ...registry.getConfig(), dailySpendCeilingUsd: v === '' || v == null ? null : Number(v) })) },
  { key: 'maxRunMinutes', label: 'Max run minutes', category: 'live', source: 'portal-config', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => cfgNum(registry.getConfig().maxRunMinutes), liveSet: (v) => registry.setConfig(validateConfig({ ...registry.getConfig(), maxRunMinutes: v === '' || v == null ? null : Number(v) })) },
  { key: 'maxConcurrentRuns', label: 'Max concurrent runs', category: 'live', source: 'portal-config', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => String(registry.getConfig().maxConcurrentRuns), liveSet: (v) => registry.setConfig(validateConfig({ ...registry.getConfig(), maxConcurrentRuns: Number(v) })) },
];

function toValue(f: FieldDef): SettingValue {
  const gatedOn = f.gate ? f.gate() : true;
  const running = f.get();
  const fileVal = f.source === 'env' ? readMap(ENV_PATH)[f.key] : undefined;
  const pending = f.source === 'env' ? (fileVal ?? '') !== (running ?? '') : false;
  return {
    key: f.key, label: f.label, category: f.category, source: f.source,
    editable: f.editable, secret: f.secret, applyTiming: f.applyTiming,
    gatedBy: f.gatedBy, gatedOn,
    value: f.secret ? null : running,
    set: f.secret ? !!(running && running.length) : !!(running && running.length),
    pending,
  };
}

/** Build the full registry as client-facing values (secrets masked). Exported for tests. */
export function buildSettings(): SettingValue[] {
  return FIELDS.map(toValue);
}

export function fieldDef(key: string): FieldDef | undefined {
  return FIELDS.find((f) => f.key === key);
}

export function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => ({ settings: buildSettings() }));
}
