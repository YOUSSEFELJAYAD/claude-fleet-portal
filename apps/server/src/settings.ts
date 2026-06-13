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
import { getLearnerConfig, updateLearnerConfig } from './learner.js';
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
  control?: 'text' | 'toggle';   // default: 'text'
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
  // ── learner (F-LEARN, §29) — live (applies now), delegated to the learner_config store ──
  { key: 'learnerEnabled', label: 'Skill auto-learning', category: 'live', source: 'addon', editable: true, secret: false, applyTiming: 'live', gatedBy: null, control: 'toggle', get: () => (getLearnerConfig().enabled ? 'true' : 'false'), liveSet: (v) => { updateLearnerConfig({ enabled: v === 'true' }); } },
  { key: 'learnerMinCostUsd', label: 'Learner · min cost (USD)', category: 'live', source: 'addon', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => String(getLearnerConfig().minCostUsd), liveSet: (v) => { updateLearnerConfig({ minCostUsd: Number(v) }); } },
  { key: 'learnerMinSubagents', label: 'Learner · min subagents', category: 'live', source: 'addon', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => String(getLearnerConfig().minSubagents), liveSet: (v) => { updateLearnerConfig({ minSubagents: Number(v) }); } },
  { key: 'learnerMinDepth', label: 'Learner · min depth', category: 'live', source: 'addon', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => String(getLearnerConfig().minDepth), liveSet: (v) => { updateLearnerConfig({ minDepth: Number(v) }); } },
  { key: 'learnerMinDurationMin', label: 'Learner · min duration (min)', category: 'live', source: 'addon', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => String(getLearnerConfig().minDurationMs / 60000), liveSet: (v) => { updateLearnerConfig({ minDurationMs: Math.round(Number(v) * 60000) }); } },
  { key: 'learnerMaxPerDay', label: 'Learner · max per day', category: 'live', source: 'addon', editable: true, secret: false, applyTiming: 'live', gatedBy: null, get: () => String(getLearnerConfig().maxPerDay), liveSet: (v) => { updateLearnerConfig({ maxPerDay: Number(v) }); } },
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
    control: f.control ?? 'text',
  };
}

function validateFieldValue(f: FieldDef, value: string | null): string | null {
  if (value == null || value === '') return null; // clearing is allowed (null/empty)
  if (f.key === 'maxConcurrentRuns') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'maxConcurrentRuns must be an integer 1–100';
  }
  if ((f.key === 'ANTHROPIC_BASE_URL' || f.key === 'OPENAI_BASE_URL') && !/^https?:\/\//.test(value)) {
    return `${f.key} must be an http(s) URL`;
  }
  return null;
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

  app.put('/api/settings/:key', async (req, reply) => {
    const key = (req.params as any).key as string;
    const f = fieldDef(key);
    if (!f) return reply.code(404).send({ error: 'unknown setting' });
    if (!f.editable || f.applyTiming === 'read-only') return reply.code(400).send({ error: 'this setting is read-only' });
    if (f.gate && !f.gate()) return reply.code(400).send({ error: `enable ${f.gatedBy} first` });

    const value = (req.body as any)?.value as string | null;
    if (value != null && typeof value !== 'string') return reply.code(400).send({ error: 'value must be a string or null' });

    // validation for non-secret formats
    const err = validateFieldValue(f, value);
    if (err) return reply.code(400).send({ error: err });

    try {
      if (f.liveSet) {
        f.liveSet(value); // live fields: portal-config + addon (learner) delegate to their store
      } else if (f.source === 'env') {
        if (value == null || value === '') del(ENV_PATH, f.key);
        else upsert(ENV_PATH, f.key, value);
      }
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'update failed' });
    }
    return toValue(f);
  });
}
