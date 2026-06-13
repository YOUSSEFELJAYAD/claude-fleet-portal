# Environment & Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/settings` panel + registry that surfaces the app's env/config — derived/live values read-only, env values via a managed `data/.env` (applies next launch), masked write-only secrets, and three live guardrails delegated to `/api/config`.

**Architecture:** A server-side registry of field descriptors (`settings.ts`) whose writes delegate to the correct backend: live fields → `registry.setConfig` (now); env/secret fields → a managed `.env` (`envfile.ts`, `0600`) flagged "next launch"; derived fields → computed live. A tiny `envboot.ts` loads the managed `.env` into `process.env` before `config.ts` freezes values at import. The web `/settings` page groups fields and shows pending/gated state.

**Tech Stack:** TypeScript, Fastify, Node `fs`, Next.js/React, vitest. Reuses `registry.getConfig/setConfig`, `validateConfig`, `addonRunEnv()`, `isEngineEnabled()`.

**Spec:** `docs/superpowers/specs/2026-06-13-settings-env-design.md`

**Plan refinement (flagged):** the spec listed an "OPENCODE provider key" secret, but opencode has no single canonical key env (creds come from `opencode auth`). v1 ships two concrete secrets — `GITHUB_TOKEN` and `CODEX_API_KEY` (gated by `codex`); an opencode secret is deferred. `data/.env` needs no `.gitignore` change (both `data/` and `.env` are already ignored).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/index.ts` | modify | `SettingValue`, `SettingsResponse`, `UpdateSettingRequest` + the category/source/timing unions. |
| `apps/server/src/envfile.ts` | create | Pure managed-`.env` I/O: `parseEnv`/`serializeEnv`/`readMap`/`upsert`/`del`/`load` (path-parameterized; no config import). |
| `apps/server/src/envboot.ts` | create | Compute the managed-`.env` path and `load()` it into `process.env` at boot (before config). |
| `apps/server/src/settings.ts` | create | Field registry (descriptors + getters + delegated setters), masking, pending detection, routes. |
| `apps/server/src/index.ts` | modify | `import './envboot.js'` as the FIRST import. |
| `apps/server/src/server.ts` | modify | `registerSettingsRoutes(app)`. |
| `apps/web/lib/api.ts` | modify | `settings()` + `updateSetting()` client helpers. |
| `apps/web/app/settings/page.tsx` | create | Grouped settings panel. |
| `apps/web/components/Shell.tsx` | modify | `/settings` nav entry. |
| `apps/server/test/envfile.test.ts` | create | `.env` I/O round-trip + perms. |
| `apps/server/test/settings.test.ts` | create | Registry masking/pending/validation/delegation. |

---

## Task 1: Shared types

**Files:** Modify `packages/shared/src/index.ts` (append after the chat §30 block)

- [ ] **Step 1: Add the types**

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Environment & Settings panel (§31)
// ─────────────────────────────────────────────────────────────────────────────

export type SettingCategory = 'derived' | 'integration' | 'live';
export type SettingSource = 'env' | 'portal-config' | 'addon' | 'derived';
export type SettingApplyTiming = 'live' | 'next-launch' | 'read-only';

export interface SettingValue {
  key: string;
  label: string;
  category: SettingCategory;
  source: SettingSource;
  editable: boolean;
  secret: boolean;
  applyTiming: SettingApplyTiming;
  gatedBy: string | null;   // feature/addon id required, or null
  gatedOn: boolean;         // is the gate satisfied (feature enabled)?
  value: string | null;     // current value; null for secrets and for unset
  set: boolean;             // secrets: is a value present?
  pending: boolean;         // env field: managed-file value differs from the running value
}

export interface SettingsResponse { settings: SettingValue[] }
export interface UpdateSettingRequest { value: string | null } // null = clear
```

- [ ] **Step 2: Typecheck** — `pnpm --filter @fleet/shared typecheck` → PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): settings panel types"
```

---

## Task 2: Managed `.env` I/O (`envfile.ts`)

**Files:** Create `apps/server/src/envfile.ts` · Test `apps/server/test/envfile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync, existsSync, rmSync } from 'node:fs';
import { parseEnv, serializeEnv, readMap, upsert, del, load } from '../src/envfile.js';

const paths: string[] = [];
function tmp() { const p = join(tmpdir(), `fleet-env-${Math.floor(performance.now() * 1000)}-${paths.length}.env`); paths.push(p); return p; }
afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });

describe('envfile', () => {
  it('parses and serializes a round-trip, quoting values with spaces', () => {
    const map = { A: '1', B: 'has space', C: 'plain' };
    const text = serializeEnv(map);
    expect(text).toContain('A=1');
    expect(text).toContain('B="has space"');
    expect(parseEnv(text)).toEqual(map);
  });

  it('upsert preserves other keys; del removes one', () => {
    const p = tmp();
    upsert(p, 'X', 'one'); upsert(p, 'Y', 'two');
    expect(readMap(p)).toEqual({ X: 'one', Y: 'two' });
    upsert(p, 'X', 'changed');
    expect(readMap(p).X).toBe('changed');
    del(p, 'Y');
    expect(readMap(p)).toEqual({ X: 'changed' });
  });

  it('writes the file with 0600 permissions', () => {
    const p = tmp();
    upsert(p, 'SECRET', 'shh');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('readMap returns {} when the file is absent', () => {
    expect(readMap(tmp())).toEqual({});
  });

  it('load sets process.env without overriding an already-set var', () => {
    const p = tmp();
    upsert(p, 'FLEET_TEST_NEW', 'fromfile');
    upsert(p, 'FLEET_TEST_EXISTING', 'fromfile');
    process.env.FLEET_TEST_EXISTING = 'fromshell';
    delete process.env.FLEET_TEST_NEW;
    load(p);
    expect(process.env.FLEET_TEST_NEW).toBe('fromfile');
    expect(process.env.FLEET_TEST_EXISTING).toBe('fromshell'); // shell wins
    delete process.env.FLEET_TEST_NEW; delete process.env.FLEET_TEST_EXISTING;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/envfile.test.ts`
Expected: FAIL — `Cannot find module '../src/envfile.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/envfile.ts`:

```typescript
/**
 * Managed `.env` I/O for the settings panel (§31). Pure, path-parameterized (no config import,
 * so envboot can use it before config.ts evaluates). Values are written with 0600 perms.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const needsQuote = (v: string) => /[\s="#']/.test(v) || v === '';

export function parseEnv(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    map[key] = val;
  }
  return map;
}

export function serializeEnv(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${needsQuote(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v}`)
    .join('\n') + '\n';
}

export function readMap(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try { return parseEnv(readFileSync(path, 'utf8')); } catch { return {}; }
}

function write(path: string, map: Record<string, string>): void {
  writeFileSync(path, serializeEnv(map), { mode: 0o600 });
}

export function upsert(path: string, key: string, value: string): void {
  const map = readMap(path); map[key] = value; write(path, map);
}

export function del(path: string, key: string): void {
  const map = readMap(path); delete map[key]; write(path, map);
}

/** Load managed values into process.env WITHOUT overriding anything already set (shell wins). */
export function load(path: string): void {
  const map = readMap(path);
  for (const [k, v] of Object.entries(map)) if (process.env[k] === undefined) process.env[k] = v;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/envfile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/envfile.ts apps/server/test/envfile.test.ts
git commit -m "feat(settings): managed .env I/O (parse/serialize/upsert/del/load, 0600)"
```

---

## Task 3: Boot loader (`envboot.ts`) + index wiring

**Files:** Create `apps/server/src/envboot.ts` · Modify `apps/server/src/index.ts`

- [ ] **Step 1: Create `envboot.ts`**

```typescript
/**
 * §31 — load the managed `.env` into process.env BEFORE config.ts freezes env at import.
 * Computes the data dir the same way config.ts does, WITHOUT importing config.ts (which would
 * read env before this runs). Imported first in index.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './envfile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.FLEET_REPO_ROOT || path.resolve(here, '..', '..', '..');
const dataDir = process.env.FLEET_DATA_DIR || path.join(repoRoot, 'data');

export const MANAGED_ENV_PATH = path.join(dataDir, '.env');
load(MANAGED_ENV_PATH);
```

- [ ] **Step 2: Wire it as the FIRST import in `index.ts`**

Add as the very first line of `apps/server/src/index.ts` (before `./server.js`, so the managed env is loaded before config.ts is evaluated transitively):

```typescript
import './envboot.js'; // §31 — load managed .env BEFORE config.ts freezes env at import
import { buildServer } from './server.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @fleet/server typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/envboot.ts apps/server/src/index.ts
git commit -m "feat(settings): load managed .env at boot before config freezes"
```

---

## Task 4: Settings registry + GET route

**Files:** Create `apps/server/src/settings.ts` · Test `apps/server/test/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/settings.test.ts`
Expected: FAIL — `Cannot find module '../src/settings.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/settings.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/settings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/settings.ts apps/server/test/settings.test.ts
git commit -m "feat(settings): field registry + GET /api/settings (masking, pending, gating)"
```

---

## Task 5: PUT route + delegated setters

**Files:** Modify `apps/server/src/settings.ts` · Test `apps/server/test/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/settings.test.ts`:

```typescript
describe('PUT /api/settings/:key', () => {
  async function app() {
    const { registerSettingsRoutes } = await import('../src/settings.js');
    const a = Fastify(); registerSettingsRoutes(a); await a.ready(); return a;
  }
  it('rejects a read-only/derived field', async () => {
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/api/settings/proxyUrl', payload: { value: 'x' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
  it('rejects an unknown key', async () => {
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/api/settings/NOPE', payload: { value: 'x' } });
    expect(res.statusCode).toBe(404);
    await a.close();
  });
  it('rejects when the gate is off', async () => {
    const { isEngineEnabled } = await import('../src/addons.js');
    (isEngineEnabled as any).mockReturnValueOnce(false);
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/api/settings/CODEX_API_KEY', payload: { value: 'k' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
  it('delegates a live field to registry.setConfig', async () => {
    const { registry } = await import('../src/registry.js');
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/api/settings/maxConcurrentRuns', payload: { value: '4' } });
    expect(res.statusCode).toBe(200);
    expect((registry.setConfig as any)).toHaveBeenCalled();
    await a.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/settings.test.ts -t "PUT /api/settings"`
Expected: FAIL — route returns 404 for all (PUT not implemented yet).

- [ ] **Step 3: Write minimal implementation**

Add the PUT route inside `registerSettingsRoutes` in `settings.ts` (and the validators):

```typescript
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
      if (f.source === 'portal-config' && f.liveSet) {
        f.liveSet(value);
      } else if (f.source === 'env') {
        if (value == null || value === '') del(ENV_PATH, f.key);
        else upsert(ENV_PATH, f.key, value);
      }
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'update failed' });
    }
    return toValue(f);
  });
```

Add the validator helper near `toValue`:

```typescript
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
```

> `validateConfig` (called by `liveSet`) already clamps/validates the PortalConfig numbers and throws a 400 on invalid, so live-field bounds are enforced there too; `validateFieldValue` adds the URL/int checks for env fields and a fast pre-check for `maxConcurrentRuns`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/settings.test.ts`
Expected: PASS (all settings tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/settings.ts apps/server/test/settings.test.ts
git commit -m "feat(settings): PUT /api/settings/:key with delegated setters + validation"
```

---

## Task 6: Server wiring

**Files:** Modify `apps/server/src/server.ts`

- [ ] **Step 1: Register the routes**

Add the import near the other route imports:
```typescript
import { registerSettingsRoutes } from './settings.js';
```
Add the registration next to `registerAddonRoutes(app);`:
```typescript
  registerSettingsRoutes(app); // §31 — environment & settings panel
```

- [ ] **Step 2: Typecheck + full server suite**

Run: `pnpm --filter @fleet/server typecheck` → PASS
Run: `pnpm --filter @fleet/server test` → PASS (incl. envfile + settings)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "feat(settings): register settings routes"
```

---

## Task 7: Web API client

**Files:** Modify `apps/web/lib/api.ts`

- [ ] **Step 1: Add the methods + type imports**

Add to the `api` object:
```typescript
  // ── §31 settings ──
  settings: () => j<SettingsResponse>('/api/settings'),
  updateSetting: (key: string, value: string | null) =>
    j<SettingValue>(`/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
```
Add to the `@fleet/shared` type import:
```typescript
import type { /* …existing… */ SettingsResponse, SettingValue } from '@fleet/shared';
```

- [ ] **Step 2: Typecheck** — `pnpm --filter @fleet/web typecheck` → PASS.
- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): settings API client helpers"
```

---

## Task 8: `/settings` page + nav + verification

**Files:** Create `apps/web/app/settings/page.tsx` · Modify `apps/web/components/Shell.tsx`

- [ ] **Step 1: Create the page**

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SettingValue } from '@fleet/shared';
import { api } from '@/lib/api';
import { Btn, Input } from '@/components/ui';

const CATS: { id: SettingValue['category']; label: string }[] = [
  { id: 'derived', label: 'Live · read-only' },
  { id: 'live', label: 'Applies now' },
  { id: 'integration', label: 'Integrations · applies next launch' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingValue[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => { setSettings((await api.settings()).settings); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function save(s: SettingValue, clear = false) {
    setErr(null);
    try {
      await api.updateSetting(s.key, clear ? null : (draft[s.key] ?? s.value ?? ''));
      setDraft((d) => { const n = { ...d }; delete n[s.key]; return n; });
      await refresh();
    } catch (e: any) { setErr(`${s.key}: ${e?.message ?? 'update failed'}`); }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <h1 className="text-lg font-semibold">Environment &amp; Settings</h1>
      {err && <div className="text-[12px]" style={{ color: '#ff5d5d' }}>{err}</div>}
      {CATS.map((cat) => (
        <div key={cat.id} className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide opacity-50">{cat.label}</div>
          {settings.filter((s) => s.category === cat.id).map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[13px] border-b hairline py-2">
              <div className="w-48 shrink-0">
                {s.label}
                {s.gatedBy && !s.gatedOn && <span className="opacity-50"> · enable {s.gatedBy}</span>}
                {s.pending && <span style={{ color: '#ffb000' }}> · ⏱ next launch</span>}
              </div>
              {!s.editable ? (
                <span className="font-mono opacity-80">{s.value ?? '—'}</span>
              ) : s.secret ? (
                <>
                  <span className="font-mono opacity-60">{s.set ? '••••set' : '(unset)'}</span>
                  <Input placeholder="new value" value={draft[s.key] ?? ''} disabled={!s.gatedOn}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
                  <Btn disabled={!s.gatedOn || !(draft[s.key] ?? '').trim()} onClick={() => save(s)}>set</Btn>
                  <Btn disabled={!s.set} onClick={() => save(s, true)}>clear</Btn>
                </>
              ) : (
                <>
                  <Input value={draft[s.key] ?? s.value ?? ''} disabled={!s.gatedOn}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
                  <Btn disabled={!s.gatedOn} onClick={() => save(s)}>save</Btn>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="text-[11px] opacity-50">Changes marked “next launch” take effect after you restart the portal.</div>
    </div>
  );
}
```

> Verify `Btn`/`Input` exports in `apps/web/components/ui.tsx`; match class conventions used by `/guardrails` and `/research`.

- [ ] **Step 2: Add the nav entry in `Shell.tsx`**

Add to the `NAV` array (near the Guardrails entry):
```typescript
  { href: '/settings', label: 'Settings', glyph: '⚙' },
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @fleet/web build`
Expected: PASS — `/settings` listed.

- [ ] **Step 4: Full verification**

Run: `pnpm --filter @fleet/server test` → PASS
Run: `pnpm -r typecheck` → PASS
Run: `pnpm --filter @fleet/web build` → PASS, `/settings` present.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/settings/page.tsx apps/web/components/Shell.tsx
git commit -m "feat(web): /settings page + nav entry"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** derived read-only (proxy/host/ports) → Task 4 FIELDS; env next-launch + managed `.env` → Tasks 2/3/4/5; masked write-only secrets → Task 4 (`value:null`, `set`) + Task 5 (clear via `del`); live guardrails delegated to `/api/config` → Task 4 `liveSet` + Task 5; load-before-config → Task 3; gating → `gate()`/`gatedOn` (Tasks 4/5); pending detection → `toValue` (Task 4); 0600 + git-ignored → Task 2 (`mode:0o600`; `.gitignore` already covers `data/`+`.env`). Tests → Tasks 2/4/5. Out-of-scope (auto-restart, arbitrary env, profiles) correctly absent.
- **Placeholder scan:** none — every code step complete. The one refinement (opencode secret deferred) is explicit with the two concrete secrets shipped.
- **Type consistency:** `SettingValue`/`SettingsResponse`/`UpdateSettingRequest` defined in Task 1, used verbatim in Tasks 4/5/7/8. `buildSettings`/`fieldDef`/`registerSettingsRoutes`/`toValue`/`validateFieldValue`/`FieldDef` consistent within `settings.ts`. `envfile` exports (`parseEnv`/`serializeEnv`/`readMap`/`upsert`/`del`/`load`) consistent across Tasks 2/3/4/5. `registry.getConfig/setConfig`, `validateConfig`, `addonRunEnv`, `isEngineEnabled`, `DATA_DIR/HOST/PORT/WEB_PORT` match confirmed exports.
