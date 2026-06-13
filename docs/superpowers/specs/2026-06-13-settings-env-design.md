# Environment & Settings Panel — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Decisions:** DC.md §31 (to be added with the plan)

## 1. Goal

A panel where the operator can view and manage the environment/config the app uses, honestly reflecting how each value actually applies:

- **Derived/live values** (proxy URL when the compression add-on is up, host, ports) shown **read-only**.
- **Live config** (guardrail caps, addon configs) editable and **applied immediately** (delegated to the existing stores).
- **Env values** (`CLAUDE_BIN`, base URLs, `FLEET_*`) editable, persisted to a managed `.env`, flagged **"applies on next launch"** (env is frozen at process import).
- **Secrets** (`GITHUB_TOKEN`, engine keys) masked — set/clear only, never echoed back.
- Field **visibility/editability gated** by whether its feature is "on" (e.g. the proxy URL only when compression is enabled).

## 2. Why a registry

The codebase has two config layers: env vars (read once at import in `config.ts`, then frozen) and `PortalConfig` (DB-backed, live-editable via `/api/config`, shown on `/guardrails`). A single **registry of field descriptors** unifies them in one panel while **delegating writes to the correct backend**, so no logic is duplicated and each field's real apply-timing is explicit.

## 3. Architecture

### Registry field descriptor

```
SettingField {
  key: string;              // canonical id (e.g. 'CLAUDE_BIN', 'dailySpendCeilingUsd', 'proxyUrl')
  label: string;
  category: 'derived' | 'integration' | 'live';
  source: 'env' | 'portal-config' | 'addon' | 'derived';
  editable: boolean;
  secret: boolean;
  applyTiming: 'live' | 'next-launch' | 'read-only';
  gatedBy: string | null;   // addon/feature id that must be enabled, or null
}
```

Each field has a server-side getter (current value) and, when editable, a validating setter that delegates:
- `portal-config`/`addon` → existing `/api/config` + addon config setters (**applies now**).
- `env`/secret → managed `.env` file (**applies next launch**).
- `derived` → computed live from runtime state; no setter.

### Components (isolated, single-purpose)

| Component | Action | Responsibility |
|---|---|---|
| `apps/server/src/envfile.ts` | create | Parse/serialize the managed `.env` (read map, upsert key, delete key), written `0600` in `DATA_DIR`. |
| `apps/server/src/settings.ts` | create | The field registry (descriptors + getters + delegated setters), masking, pending detection, and routes. |
| `apps/server/src/index.ts` | modify | Load the managed `.env` into `process.env` **before** `config.ts` imports (so boot values reflect it). |
| `packages/shared/src/index.ts` | modify | `SettingField`, `SettingValue`, `SettingsResponse`, `UpdateSettingRequest`. |
| `apps/web/app/settings/page.tsx` | create | Grouped panel: derived (read-only), integrations (next-launch + secrets), live (applies now). |
| `apps/web/components/Shell.tsx` | modify | `/settings` nav entry. |

### v1 field set (curated, explicit)

- **derived (read-only):** `proxyUrl` (compression addon's live URL, gated by `compression`), `serverAddr` (`HOST:PORT`), `webPort`.
- **integration / env (next-launch):** `CLAUDE_BIN`, `CLAUDE_REAL_BIN`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `FLEET_GITHUB_REPO`.
- **secret / env (next-launch, masked):** `GITHUB_TOKEN`, `CODEX_API_KEY` (gated by `codex`), `OPENCODE` provider key env (gated by `opencode`).
- **live (applies now, delegated to `/api/config`):** `dailySpendCeilingUsd`, `maxRunMinutes`, `maxConcurrentRuns`.

Adding a field later = one more descriptor in the registry. The live ones intentionally mirror three high-signal `PortalConfig` guardrails for one-stop visibility; the full guardrail editor remains on `/guardrails` (no behavior duplicated — both call the same `/api/config` setter).

### Managed `.env`

- Location: `${DATA_DIR}/.env` (e.g. `data/.env`), git-ignored, file mode `0600`.
- Loaded at the very top of `index.ts` (before any `./config.js` import) via `envfile.load()` which sets `process.env[k] ??= v` for each managed key — environment passed on the command line still wins (never override an explicitly-set env).

## 4. Data flow

- **`GET /api/settings`** → registry mapped to `SettingValue[]`: `{ key, label, category, source, editable, secret, applyTiming, gatedOn, value, pending }`. Secrets return `null` value + a `set: boolean` ("is a value present"), never the plaintext. `pending` = (managed `.env` value ≠ the value the process booted with) for env fields.
- **`PUT /api/settings/:key { value }`** → look up the field; reject if unknown / read-only / gated-off (4xx); validate; then:
  - live field → call the existing setter (config/addon) → return updated state (`pending:false`).
  - env/secret field → `envfile.upsert(key, value)` (or `delete` on clear) → return state with `pending:true`.
- **Derived values** are computed on each `GET` from live runtime (e.g. proxy URL from the compression addon's running state; ports from `config`).

## 5. Error handling

Per-field validation (port range 1024–65535, `http(s)` URL format, non-empty where required); unknown/read-only/gated-off edits → typed 4xx; `.env` write failure → 500 with a clear message; secrets never echoed in any response; values never logged. Reuses the existing Host-allowlist + CORS guards.

## 6. Security

- Managed `.env` at mode `0600` under `DATA_DIR`, git-ignored — secrets at rest are owner-only.
- `GET` masks secrets (`value:null`, `set:true`); a secret's plaintext is never returned after it's set.
- Setters validate the key against the registry (no arbitrary env injection).
- Single-operator local portal (consistent with the chat-dashboard multi-user deferral).

## 7. Testing (vitest + build)

- `envfile.test.ts`: parse/serialize round-trip; upsert preserves other keys; delete removes a key; written file mode is `0600`; quoting/escaping of values with spaces/`=`.
- `settings.test.ts`: registry masks secrets in `GET`; `applyTiming` correct per field; pending detection (managed value ≠ boot value → pending); `PUT` validation (port range, URL, non-empty); editing a read-only/gated-off field is rejected; live field delegates to the config setter (mock); derived field reflects mocked addon state.
- Web: `pnpm -r typecheck`, `pnpm --filter @fleet/web build` (with `/settings` present).

## 8. Out of scope (YAGNI v1)

- **Auto-restart** the server — the panel shows "applies on next launch" + a manual restart instruction (self-restart is fragile). A restart endpoint is a possible fast-follow.
- Editing arbitrary/unknown env vars (curated registry only).
- Multiple env profiles / per-environment sets.
- Surfacing secrets' plaintext for verification (write-only by design).
