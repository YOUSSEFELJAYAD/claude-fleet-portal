# Web Research (SearXNG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an open-source web-research capability to the Fleet Portal: a SearXNG-backed `web-research` add-on, a `/research` page (live results + "Synthesize with agent"), and optional `mcp__searxng` registration so launched agents can search mid-run.

**Architecture:** A new `apps/server/src/research.ts` owns the SearXNG client, prompt builder, and HTTP routes; it launches the synthesis run through the existing `registry.launch`. `addons.ts` gains a third add-on runtime (`'service'`) for the `web-research` descriptor (config = SearXNG URL + search prefs, status = a reachability probe, install = best-effort Docker). The `/research` page is the add-on's unlocked nav page and folds the SearXNG settings/status/install/MCP controls into a compact strip above the search UI.

**Tech Stack:** TypeScript, Fastify (server), Next.js/React (web), better-sqlite3 (addon config), vitest (tests), Node 22 global `fetch`. Search provider: self-hosted SearXNG (AGPL, JSON API, no key).

**Spec:** `docs/superpowers/specs/2026-06-13-web-research-design.md`

**Plan refinement vs spec:** The spec listed a separate `apps/web/app/addons/web-research/page.tsx`. This plan folds the add-on's config/status/install/MCP controls into the top of `/research` (the add-on's unlocked page) — one page, better UX, less surface. To avoid an `addons.ts ↔ research.ts` import cycle (the codebase is cycle-averse — see `search.ts`'s setter pattern), the add-on's status probe is a small inline `fetch` in `addons.ts`; `research.ts` imports `researchConfig` from `addons.ts` one-way only.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/index.ts` | modify | Add `WebResult`, `WebResearchConfig`, `ResearchSearchRequest/Response`, `ResearchSynthesizeRequest/Response`. |
| `apps/server/src/research.ts` | create | SearXNG client (`searchWeb`), `buildResearchPrompt`, `registerResearchRoutes` (search/synthesize/status). |
| `apps/server/src/addons.ts` | modify | `web-research` descriptor (runtime `'service'`), `DEFAULT_RESEARCH_CONFIG`, `researchConfig()`, `validateResearchConfig`, `'service'` branches in `addonInfo`/enable/disable/restart/config/install, `installSearxng`, `registerSearxngMcp`. |
| `apps/server/src/server.ts` | modify | `registerResearchRoutes(app)`. |
| `apps/web/lib/api.ts` | modify | `researchSearch`, `researchSynthesize`, `researchStatus`. |
| `apps/web/app/research/page.tsx` | create | Settings/status strip + search box + results + "Synthesize with agent". |
| `apps/server/test/research.test.ts` | create | Unit + route tests (stubbed SearXNG + `registry.launch` spy). |
| `apps/server/test/addons.test.ts` | modify | `web-research` listing + config validation. |

---

## Task 1: Shared types

**Files:**
- Modify: `packages/shared/src/index.ts` (append near the other request/response interfaces, e.g. after the addon types block)

- [ ] **Step 1: Add the types**

Add this block to `packages/shared/src/index.ts`:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Web Research (open-source, SearXNG-backed) — §28
// ─────────────────────────────────────────────────────────────────────────────

/** One normalized web result (from SearXNG's JSON API). */
export interface WebResult {
  title: string;
  url: string;
  /** Snippet / summary text (SearXNG `content`). */
  snippet: string;
  /** Relevance score from the metasearch engine (0 when absent). */
  score: number;
  /** Originating engine(s), e.g. "google", "duckduckgo". */
  engine: string;
}

/** Persisted config for the `web-research` add-on. */
export interface WebResearchConfig {
  /** Base URL of the self-hosted SearXNG instance. */
  searxngUrl: string;
  /** Comma-separated SearXNG engine list, or '' for the instance default. */
  engines: string;
  /** Default number of results to request (1–20). */
  maxResults: number;
  /** SearXNG safesearch level: 0 off, 1 moderate, 2 strict. */
  safeSearch: 0 | 1 | 2;
  /** Language code passed to SearXNG (e.g. 'en', 'all'). */
  language: string;
}

export interface ResearchSearchRequest {
  query: string;
  maxResults?: number;
}
export interface ResearchSearchResponse {
  query: string;
  results: WebResult[];
}

export interface ResearchSynthesizeRequest {
  topic: string;
  results: WebResult[];
  /** Catalog model id; null/omitted → 'claude-opus-4-8'. */
  model?: string | null;
  /** Working dir for the run; omitted → server default. */
  cwd?: string;
}
export interface ResearchSynthesizeResponse {
  runId: string;
}

/** GET /api/research/status — SearXNG reachability for the /research page. */
export interface ResearchStatusResponse {
  /** SearXNG reachable AND JSON format enabled. */
  ok: boolean;
  searxngUrl: string;
  /** 'ok' | 'unreachable' | 'json-disabled' */
  state: 'ok' | 'unreachable' | 'json-disabled';
  detail: string | null;
}
```

- [ ] **Step 2: Typecheck the shared package**

Run: `pnpm --filter @fleet/shared typecheck`
Expected: PASS (no output errors)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): web-research types (WebResult, config, request/response)"
```

---

## Task 2: SearXNG client (`searchWeb`)

**Files:**
- Create: `apps/server/src/research.ts`
- Test: `apps/server/test/research.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/research.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { searchWeb } from '../src/research.js';

// ── a fake SearXNG that returns canned JSON (or 403 when json is disabled) ──
let server: Server;
let baseUrl = '';
let mode: 'ok' | 'json-403' = 'ok';

beforeEach(async () => {
  mode = 'ok';
  server = createServer((req, res) => {
    if (mode === 'json-403') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html>json format disabled</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      query: 'q',
      results: [
        { title: 'A', url: 'https://a.example', content: 'snippet a', score: 1.5, engine: 'google' },
        { title: 'B', url: 'https://b.example', content: 'snippet b', engine: 'duckduckgo' },
      ],
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('searchWeb', () => {
  it('normalizes SearXNG JSON into WebResult[]', async () => {
    const out = await searchWeb({ searxngUrl: baseUrl, query: 'q', maxResults: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'A', url: 'https://a.example', snippet: 'snippet a', score: 1.5, engine: 'google' });
    // missing score → 0
    expect(out[1].score).toBe(0);
  });

  it('throws a 502 with json-disabled hint on a 403', async () => {
    mode = 'json-403';
    await expect(searchWeb({ searxngUrl: baseUrl, query: 'q' })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws a 502 when SearXNG is unreachable', async () => {
    await expect(searchWeb({ searxngUrl: 'http://127.0.0.1:1', query: 'q' })).rejects.toMatchObject({ statusCode: 502 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/research.test.ts`
Expected: FAIL — `Cannot find module '../src/research.js'` / `searchWeb is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/research.ts`:

```typescript
/**
 * Web Research (§28) — open-source web search via a self-hosted SearXNG instance.
 * SearXNG exposes a JSON API (`?format=json`, AGPL, no API key). This module owns the
 * client, the synthesis-prompt builder, and the HTTP routes; the synthesis run is spawned
 * through the existing registry.launch path (no engine awareness needed).
 */
import type { FastifyInstance } from 'fastify';
import type { WebResult } from '@fleet/shared';

const SEARCH_TIMEOUT_MS = 15_000;

function httpErr(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** Query a SearXNG instance and normalize its JSON into WebResult[]. */
export async function searchWeb(opts: {
  searxngUrl: string;
  query: string;
  maxResults?: number;
  engines?: string;
  safeSearch?: number;
  language?: string;
}): Promise<WebResult[]> {
  const base = opts.searxngUrl.replace(/\/+$/, '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('q', opts.query);
  u.searchParams.set('format', 'json');
  if (opts.engines) u.searchParams.set('engines', opts.engines);
  if (opts.language) u.searchParams.set('language', opts.language);
  if (opts.safeSearch != null) u.searchParams.set('safesearch', String(opts.safeSearch));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(u, { headers: { accept: 'application/json' }, signal: ctrl.signal });
  } catch {
    throw httpErr(502, `SearXNG unreachable at ${base} — check the Web Research add-on URL or install it`);
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 403) {
    throw httpErr(502, 'SearXNG returned 403 for format=json — enable `json` in its settings.yml `search.formats`');
  }
  if (!r.ok) throw httpErr(502, `SearXNG error ${r.status}`);

  let body: any;
  try {
    body = await r.json();
  } catch {
    throw httpErr(502, 'SearXNG returned a non-JSON body (is json format enabled?)');
  }
  const rows: any[] = Array.isArray(body?.results) ? body.results : [];
  const max = Math.max(1, Math.min(opts.maxResults ?? 10, 20));
  return rows.slice(0, max).map((x) => ({
    title: String(x?.title ?? ''),
    url: String(x?.url ?? ''),
    snippet: String(x?.content ?? ''),
    score: typeof x?.score === 'number' && Number.isFinite(x.score) ? x.score : 0,
    engine: String(x?.engine ?? (Array.isArray(x?.engines) ? x.engines.join(',') : '')),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/research.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/research.ts apps/server/test/research.test.ts
git commit -m "feat(research): SearXNG JSON client with timeout + error classification"
```

---

## Task 3: Research prompt builder

**Files:**
- Modify: `apps/server/src/research.ts`
- Test: `apps/server/test/research.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/research.test.ts` (add `buildResearchPrompt` to the import on line 4):

```typescript
import { searchWeb, buildResearchPrompt } from '../src/research.js';

describe('buildResearchPrompt', () => {
  const results = [
    { title: 'A', url: 'https://a.example', snippet: 'alpha', score: 1, engine: 'google' },
    { title: 'B', url: 'https://b.example', snippet: 'beta', score: 0.5, engine: 'ddg' },
  ];

  it('embeds the topic and every source URL', () => {
    const p = buildResearchPrompt('quantum widgets', results);
    expect(p).toContain('quantum widgets');
    expect(p).toContain('https://a.example');
    expect(p).toContain('https://b.example');
  });

  it('caps the number of embedded sources at 20', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      title: `T${i}`, url: `https://e${i}.example`, snippet: 's', score: 0, engine: 'g',
    }));
    const p = buildResearchPrompt('t', many);
    expect(p).toContain('https://e19.example');
    expect(p).not.toContain('https://e20.example');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/research.test.ts -t buildResearchPrompt`
Expected: FAIL — `buildResearchPrompt is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/server/src/research.ts`:

```typescript
const MAX_SOURCES = 20;
const MAX_SNIPPET = 500;

/** Build the synthesis prompt: the topic plus the (capped) selected sources. */
export function buildResearchPrompt(topic: string, results: WebResult[]): string {
  const sources = results.slice(0, MAX_SOURCES).map((r, i) => {
    const snippet = r.snippet.length > MAX_SNIPPET ? r.snippet.slice(0, MAX_SNIPPET) + '…' : r.snippet;
    return `[${i + 1}] ${r.title}\n    ${r.url}\n    ${snippet}`;
  }).join('\n\n');
  return [
    `RESEARCH TOPIC: ${topic}`,
    '',
    'You are given web search results below. Synthesize a tight, factual answer to the topic.',
    'Cite sources inline by their [n] number and URL. Cross-check load-bearing claims against a',
    'second source where possible. Distinguish FACT (with citation) from INFERENCE. If the sources',
    'are insufficient, you may use WebFetch/WebSearch to read further, then say what remains open.',
    '',
    'SOURCES:',
    sources || '(none provided)',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/research.test.ts -t buildResearchPrompt`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/research.ts apps/server/test/research.test.ts
git commit -m "feat(research): synthesis prompt builder with source caps"
```

---

## Task 4: Add-on config (`web-research` descriptor + validation)

**Files:**
- Modify: `apps/server/src/addons.ts` (descriptor near `ADDON_DEFS`, defaults near `DEFAULT_COMPRESSION_CONFIG`, validation near `validateCompressionConfig`)
- Test: `apps/server/test/addons.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/addons.test.ts` (reuse its existing imports/bootstrap; add `validateResearchConfig` to the `../src/addons.js` import):

```typescript
describe('web-research add-on config', () => {
  it('lists web-research in /api/addons (id present)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/addons' });
    const ids = (res.json() as any[]).map((a) => a.id);
    expect(ids).toContain('web-research');
  });

  it('validateResearchConfig clamps maxResults and applies defaults', () => {
    const cfg = validateResearchConfig({ maxResults: 999 });
    expect(cfg.maxResults).toBe(20);
    expect(cfg.searxngUrl).toBe('http://localhost:8080');
    expect(cfg.safeSearch).toBe(1);
  });

  it('validateResearchConfig rejects a non-http URL', () => {
    expect(() => validateResearchConfig({ searxngUrl: 'ftp://x' })).toThrow();
  });
});
```

> If `app` is not already bootstrapped in `addons.test.ts`, mirror the app-setup block used at the top of that file (it already exercises `/api/addons`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/addons.test.ts -t web-research`
Expected: FAIL — `validateResearchConfig` not exported / `web-research` not in listing.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/addons.ts`:

(a) Add the id constant near `COMPRESSION_ID`:
```typescript
const RESEARCH_ID = 'web-research';
```

(b) Widen the runtime union (line ~60):
```typescript
type AddonRuntime = 'proxy' | 'engine-binary' | 'service';
```

(c) Append a descriptor to `ADDON_DEFS` (after the opencode entry):
```typescript
  {
    id: RESEARCH_ID,
    name: 'Web Research',
    tagline: 'Open-source web search (SearXNG) + synthesize-with-agent',
    description:
      'Adds a Research page: search the web through your self-hosted SearXNG instance (open source, ' +
      'AGPL, no API key) and hand the results to a research agent that synthesizes a cited answer. ' +
      'Optionally registers a SearXNG MCP server so launched agents can search mid-run. ' +
      'Requires a running SearXNG (the Install button starts the official Docker image if Docker is present).',
    kind: 'builtin' as const,
    docsUrl: 'https://docs.searxng.org/',
    page: '/research',
    runtime: 'service',
  },
```

(d) Add defaults near `DEFAULT_COMPRESSION_CONFIG`:
```typescript
export const DEFAULT_RESEARCH_CONFIG: WebResearchConfig = {
  searxngUrl: 'http://localhost:8080',
  engines: '',
  maxResults: 10,
  safeSearch: 1,
  language: 'en',
};

export function researchConfig(): WebResearchConfig {
  return { ...DEFAULT_RESEARCH_CONFIG, ...(loadRow(RESEARCH_ID).config as Partial<WebResearchConfig>) };
}
```

(e) Add the validator near `validateCompressionConfig`:
```typescript
export function validateResearchConfig(input: unknown): WebResearchConfig {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('config must be an object'), { statusCode: 400 });
  }
  const i = input as Record<string, unknown>;
  const base = researchConfig();
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

  let searxngUrl = base.searxngUrl;
  if (i.searxngUrl !== undefined) {
    if (typeof i.searxngUrl !== 'string' || !/^https?:\/\//.test(i.searxngUrl)) throw bad('searxngUrl must be an http(s) URL');
    searxngUrl = i.searxngUrl.replace(/\/+$/, '');
  }
  let maxResults = base.maxResults;
  if (i.maxResults !== undefined) {
    if (typeof i.maxResults !== 'number' || !Number.isInteger(i.maxResults)) throw bad('maxResults must be an integer');
    maxResults = Math.max(1, Math.min(i.maxResults, 20));
  }
  let safeSearch = base.safeSearch;
  if (i.safeSearch !== undefined) {
    if (i.safeSearch !== 0 && i.safeSearch !== 1 && i.safeSearch !== 2) throw bad('safeSearch must be 0, 1, or 2');
    safeSearch = i.safeSearch;
  }
  const engines = i.engines === undefined ? base.engines : String(i.engines);
  const language = i.language === undefined ? base.language : String(i.language || 'en');
  return { searxngUrl, engines, maxResults, safeSearch, language };
}
```

(f) Add `WebResearchConfig` to the `@fleet/shared` type import at the top of `addons.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/addons.test.ts -t web-research`
Expected: the `validateResearchConfig` tests PASS. (The listing test still fails until Task 5 adds the `'service'` branch to `addonInfo` — that is expected; proceed.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/addons.ts apps/server/test/addons.test.ts
git commit -m "feat(addons): web-research descriptor + config validation"
```

---

## Task 5: Add-on `'service'` runtime branches (status / enable / disable / config / install)

**Files:**
- Modify: `apps/server/src/addons.ts` (`addonInfo`, the route handlers in `registerAddonRoutes`)
- Test: `apps/server/test/addons.test.ts`

- [ ] **Step 1: Add the `'service'` status branch to `addonInfo`**

In `addonInfo` (after the `engine-binary` block, before the proxy block), add:

```typescript
  // ── service add-on (web-research → SearXNG) — status from a reachability probe ──
  if (def.runtime === 'service') {
    const cfg = researchConfig();
    const probe = await probeSearxng(cfg.searxngUrl);
    const installed = probe.state !== 'unreachable';
    let status: AddonStatus;
    if (!installed) status = 'not-installed';
    else if (!enabled) status = 'disabled';
    else if (probe.state === 'json-disabled') status = 'error';
    else status = 'running';
    return {
      ...def,
      enabled,
      installed,
      version: null,
      status,
      statusDetail: probe.detail,
      config: cfg as unknown as Record<string, unknown>,
    };
  }
```

Add the inline probe helper near the other detection helpers in `addons.ts` (kept here, not imported from `research.ts`, to avoid a module cycle):

```typescript
async function probeSearxng(url: string): Promise<{ state: 'ok' | 'unreachable' | 'json-disabled'; detail: string | null }> {
  const base = url.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const r = await fetch(`${base}/search?q=ping&format=json`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (r.status === 403) return { state: 'json-disabled', detail: 'enable `json` in SearXNG settings.yml `search.formats`' };
    if (!r.ok) return { state: 'unreachable', detail: `SearXNG returned ${r.status}` };
    return { state: 'ok', detail: null };
  } catch {
    return { state: 'unreachable', detail: `not reachable at ${base}` };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Add `'service'` branches to the route handlers**

In `registerAddonRoutes`:

- `enable` (`/api/addons/:id/enable`) — add before the proxy block:
```typescript
    if (def.runtime === 'service') {
      const row = loadRow(id);
      saveRow(id, true, row.config); // status reflects reachability; enabling never blocks
      return addonInfo(id);
    }
```
- `disable` — already generic (`saveRow(id, false, ...)`); guard the `stopProxy()` call so it only runs for `def.runtime === 'proxy'` (it already does).
- `restart` — extend the not-applicable guard:
```typescript
    if (def.runtime === 'engine-binary' || def.runtime === 'service') {
      return reply.code(409).send({ error: 'restart is not applicable to this add-on', code: 'not-applicable' });
    }
```
- `config` (`PUT /api/addons/:id/config`) — add before the proxy block:
```typescript
    if (def.runtime === 'service') {
      let cfg: WebResearchConfig;
      try {
        cfg = validateResearchConfig(req.body ?? {});
      } catch (e: any) {
        return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid config' });
      }
      const row = loadRow(id);
      saveRow(id, row.enabled, cfg as unknown as Record<string, unknown>);
      return addonInfo(id);
    }
```

- [ ] **Step 3: Run the listing + status tests**

Run: `pnpm --filter @fleet/server exec vitest run test/addons.test.ts -t web-research`
Expected: PASS — `web-research` now appears in `/api/addons` and config validation holds.

- [ ] **Step 4: Run the full addons suite (no regressions)**

Run: `pnpm --filter @fleet/server exec vitest run test/addons.test.ts`
Expected: PASS (all existing tests + new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/addons.ts apps/server/test/addons.test.ts
git commit -m "feat(addons): service runtime (web-research) status + enable/disable/config branches"
```

---

## Task 6: Research routes (search / synthesize / status) + server wiring

**Files:**
- Modify: `apps/server/src/research.ts` (add `registerResearchRoutes`)
- Modify: `apps/server/src/server.ts` (register the routes)
- Test: `apps/server/test/research.test.ts`

- [ ] **Step 1: Write the failing test (route + launch spy)**

Append to `apps/server/test/research.test.ts`:

```typescript
import Fastify from 'fastify';
import { vi } from 'vitest';

vi.mock('../src/registry.js', () => ({
  registry: { launch: vi.fn(async () => ({ id: 'run-123' })) },
}));
vi.mock('../src/addons.js', () => ({
  researchConfig: () => ({ searxngUrl: baseUrl, engines: '', maxResults: 10, safeSearch: 1, language: 'en' }),
}));

describe('research routes', () => {
  it('POST /api/research/synthesize launches a run with web tools allowed', async () => {
    const { registry } = await import('../src/registry.js');
    const { registerResearchRoutes } = await import('../src/research.js');
    const app = Fastify();
    registerResearchRoutes(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/research/synthesize',
      payload: { topic: 'widgets', results: [{ title: 'A', url: 'https://a.example', snippet: 's', score: 1, engine: 'g' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: 'run-123' });
    const arg = (registry.launch as any).mock.calls[0][0];
    expect(arg.allowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    expect(arg.prompt).toContain('widgets');
    await app.close();
  });

  it('POST /api/research/synthesize 400s on an empty topic', async () => {
    const { registerResearchRoutes } = await import('../src/research.js');
    const app = Fastify();
    registerResearchRoutes(app);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/research/synthesize', payload: { topic: '', results: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

> Place the two `vi.mock` calls at the top level of the test file (they are hoisted). `baseUrl` is assigned in `beforeEach`; the mock factory closes over it lazily.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/research.test.ts -t "research routes"`
Expected: FAIL — `registerResearchRoutes is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/server/src/research.ts`:

```typescript
import { registry } from './registry.js';
import { researchConfig } from './addons.js';
import type {
  ResearchSearchRequest, ResearchSearchResponse,
  ResearchSynthesizeRequest, ResearchSynthesizeResponse,
  ResearchStatusResponse,
} from '@fleet/shared';

const RESEARCHER_PROFILE =
  'You are a focused web-research agent. You NEVER modify files. Synthesize a tight, factual, ' +
  'cited answer from the provided sources; cross-check load-bearing claims; distinguish FACT ' +
  '(with citation) from INFERENCE; end with open questions.';

export function registerResearchRoutes(app: FastifyInstance) {
  // Live web search → results for the /research page.
  app.post('/api/research/search', async (req, reply) => {
    const b = (req.body ?? {}) as ResearchSearchRequest;
    if (typeof b.query !== 'string' || !b.query.trim()) {
      return reply.code(400).send({ error: 'query is required' });
    }
    const cfg = researchConfig();
    try {
      const results = await searchWeb({
        searxngUrl: cfg.searxngUrl, query: b.query.trim(),
        maxResults: b.maxResults ?? cfg.maxResults,
        engines: cfg.engines, safeSearch: cfg.safeSearch, language: cfg.language,
      });
      return { query: b.query.trim(), results } satisfies ResearchSearchResponse;
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 502).send({ error: e?.message ?? 'search failed' });
    }
  });

  // Hand selected results to a research agent → spawns a run, returns its id.
  app.post('/api/research/synthesize', async (req, reply) => {
    const b = (req.body ?? {}) as ResearchSynthesizeRequest;
    if (typeof b.topic !== 'string' || !b.topic.trim()) {
      return reply.code(400).send({ error: 'topic is required' });
    }
    const results = Array.isArray(b.results) ? b.results : [];
    const prompt = buildResearchPrompt(b.topic.trim(), results);
    try {
      const run = await registry.launch({
        prompt,
        cwd: b.cwd || process.cwd(),
        model: b.model ?? 'claude-opus-4-8',
        effort: 'high',
        permissionMode: 'default',
        allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        appendSystemPrompt: RESEARCHER_PROFILE,
      });
      return { runId: run.id } satisfies ResearchSynthesizeResponse;
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'launch failed' });
    }
  });

  // SearXNG reachability for the page's settings strip.
  app.get('/api/research/status', async () => {
    const cfg = researchConfig();
    const base = cfg.searxngUrl.replace(/\/+$/, '');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const r = await fetch(`${base}/search?q=ping&format=json`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.status === 403) {
        return { ok: false, searxngUrl: base, state: 'json-disabled', detail: 'enable `json` in SearXNG `search.formats`' } satisfies ResearchStatusResponse;
      }
      if (!r.ok) return { ok: false, searxngUrl: base, state: 'unreachable', detail: `SearXNG returned ${r.status}` } satisfies ResearchStatusResponse;
      return { ok: true, searxngUrl: base, state: 'ok', detail: null } satisfies ResearchStatusResponse;
    } catch {
      return { ok: false, searxngUrl: base, state: 'unreachable', detail: `not reachable at ${base}` } satisfies ResearchStatusResponse;
    }
  });
}
```

- [ ] **Step 4: Wire into `server.ts`**

Add the import near the other route imports:
```typescript
import { registerResearchRoutes } from './research.js';
```
Add the registration next to `registerAddonRoutes(app);`:
```typescript
  registerResearchRoutes(app); // §28 — web research (SearXNG)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/research.test.ts`
Expected: PASS (all research tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/research.ts apps/server/src/server.ts apps/server/test/research.test.ts
git commit -m "feat(research): search/synthesize/status routes wired into the server"
```

---

## Task 7: SearXNG install helper + MCP registration routes

**Files:**
- Modify: `apps/server/src/addons.ts` (extend `/api/addons/:id/install`; add a `POST /api/addons/web-research/register-mcp` route)

- [ ] **Step 1: Add the `'service'` install branch**

In the `/api/addons/:id/install` handler, add before the existing branches:

```typescript
    if (def.runtime === 'service') {
      return reply.send(await installSearxng());
    }
```

Add `installSearxng` near `installHeadroom` (best-effort Docker; advisory otherwise). Reuse the existing `execFileAsync`, `executableAvailable`, `trunc`, and `INSTALL_TIMEOUT_MS` helpers:

```typescript
async function installSearxng(): Promise<AddonInstallResult> {
  const steps: SelfUpdateStep[] = [];
  const hasDocker = await executableAvailable('docker', ['--version']);
  steps.push({
    step: 'detect docker',
    ok: hasDocker,
    output: hasDocker ? 'docker found' : 'docker not found — install Docker or run SearXNG yourself, then set the URL',
  });
  if (!hasDocker) {
    return {
      ok: false,
      steps,
      note: 'Docker not found. Run SearXNG yourself (docker run -d -p 8080:8080 searxng/searxng) with json enabled in settings.yml `search.formats`, then set the URL on the Web Research page.',
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['run', '-d', '--name', 'fleet-searxng', '-p', '8080:8080',
       '-e', 'SEARXNG_SETTINGS_PATH=', '-e', 'SEARXNG_FORMATS=json',
       'searxng/searxng'],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
    );
    steps.push({ step: 'docker run searxng/searxng', ok: true, output: trunc(stdout + stderr) });
    return { ok: true, steps, note: 'SearXNG started on http://localhost:8080. If json is still disabled, set `search.formats: [html, json]` in its settings.yml and restart the container.' };
  } catch (e: any) {
    steps.push({ step: 'docker run searxng/searxng', ok: false, output: trunc(String(e?.stderr ?? e?.message ?? e)) });
    return { ok: false, steps, note: 'Could not start SearXNG via Docker (a container named fleet-searxng may already exist). Check `docker ps -a`.' };
  }
}
```

> Confirm `SelfUpdateStep` and `AddonInstallResult` are already imported in `addons.ts` (they are, for `installHeadroom`). Add `executableAvailable` usage matches its existing signature.

- [ ] **Step 2: Add the MCP registration route**

In `registerAddonRoutes`, add:

```typescript
  // Register a SearXNG MCP server so launched agents can search mid-run (open source).
  app.post('/api/addons/web-research/register-mcp', async () => {
    const cfg = researchConfig();
    try {
      const { stdout, stderr } = await execFileAsync(
        CLAUDE_REAL_BIN,
        ['mcp', 'add', 'searxng', '--', 'npx', '-y', 'mcp-searxng'],
        { timeout: 60_000, env: { ...process.env, SEARXNG_URL: cfg.searxngUrl }, maxBuffer: 1024 * 1024 },
      );
      return { ok: true, output: trunc(stdout + stderr) };
    } catch (e: any) {
      return {
        ok: false,
        output: trunc(String(e?.stderr ?? e?.message ?? e)),
        note: `Run it yourself: SEARXNG_URL=${cfg.searxngUrl} claude mcp add searxng -- npx -y mcp-searxng`,
      };
    }
  });
```

> `CLAUDE_REAL_BIN` is exported from `config.js` (already used by `mcp.ts`). Add the import to `addons.ts` if not present: `import { CLAUDE_REAL_BIN } from './config.js';`. The MCP package id (`mcp-searxng`) is the chosen OSS server; the advisory `note` covers the fallback if `claude mcp add` or the package is unavailable.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @fleet/server typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/addons.ts
git commit -m "feat(addons): SearXNG Docker install helper + claude mcp add route"
```

---

## Task 8: Web API client helpers

**Files:**
- Modify: `apps/web/lib/api.ts`

- [ ] **Step 1: Add the client methods**

Add to the `api` object (after `compressionStats`), and import the new types from `@fleet/shared` at the top of the file:

```typescript
  // ── §28 web research (SearXNG) ──
  researchSearch: (body: ResearchSearchRequest) =>
    j<ResearchSearchResponse>('/api/research/search', { method: 'POST', body: JSON.stringify(body) }),
  researchSynthesize: (body: ResearchSynthesizeRequest) =>
    j<ResearchSynthesizeResponse>('/api/research/synthesize', { method: 'POST', body: JSON.stringify(body) }),
  researchStatus: () => j<ResearchStatusResponse>('/api/research/status'),
  registerSearxngMcp: () =>
    j<{ ok: boolean; output: string; note?: string }>('/api/addons/web-research/register-mcp', { method: 'POST', body: JSON.stringify({}) }),
```

Add to the shared-types import line:
```typescript
import type { /* …existing… */ ResearchSearchRequest, ResearchSearchResponse, ResearchSynthesizeRequest, ResearchSynthesizeResponse, ResearchStatusResponse } from '@fleet/shared';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fleet/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): research API client helpers"
```

---

## Task 9: `/research` page (settings strip + search + synthesize)

**Files:**
- Create: `apps/web/app/research/page.tsx`

- [ ] **Step 1: Create the page**

Create `apps/web/app/research/page.tsx`. Follow the existing page conventions (`'use client'`, `api`, the shared `ui` components, `useRouter`). Minimal but complete:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { WebResult, ResearchStatusResponse } from '@fleet/shared';
import { Btn, Input } from '@/components/ui';

export default function ResearchPage() {
  const router = useRouter();
  const [status, setStatus] = useState<ResearchStatusResponse | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WebResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.researchStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  async function runSearch() {
    setErr(null); setBusy(true);
    try {
      const res = await api.researchSearch({ query });
      setResults(res.results);
      setSelected(new Set(res.results.map((r) => r.url))); // default: all selected
    } catch (e: any) { setErr(e?.message ?? 'search failed'); }
    finally { setBusy(false); }
  }

  function toggle(url: string) {
    setSelected((s) => { const n = new Set(s); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }

  async function synthesize() {
    setErr(null); setBusy(true);
    try {
      const chosen = results.filter((r) => selected.has(r.url));
      const { runId } = await api.researchSynthesize({ topic: query, results: chosen });
      router.push(`/runs/${runId}`);
    } catch (e: any) { setErr(e?.message ?? 'synthesize failed'); setBusy(false); }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold">Web Research</h1>

      {/* settings / status strip */}
      <div className="text-[12px] rounded border hairline p-3 space-y-2">
        <div>
          SearXNG: <span className="font-mono">{status?.searxngUrl ?? '…'}</span>{' '}
          <span style={{ color: status?.ok ? '#3ad29f' : '#ff5d5d' }}>
            {status ? (status.ok ? '● reachable' : `● ${status.state}`) : ''}
          </span>
        </div>
        {status && !status.ok && <div style={{ color: '#ff8a5d' }}>{status.detail}</div>}
        <div className="flex gap-2">
          <Btn onClick={() => api.installAddon('web-research').then((r) => alert(r.note))}>Install SearXNG (Docker)</Btn>
          <Btn onClick={() => api.registerSearxngMcp().then((r) => alert(r.note ?? (r.ok ? 'Registered mcp__searxng' : r.output)))}>Register agent MCP tool</Btn>
        </div>
      </div>

      {/* search box */}
      <div className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the web…"
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && runSearch()} />
        <Btn variant="solid" onClick={runSearch} disabled={busy || !query.trim()}>Search</Btn>
      </div>
      {err && <div className="text-[12px]" style={{ color: '#ff5d5d' }}>{err}</div>}

      {/* results */}
      {results.length > 0 && (
        <>
          <div className="space-y-2">
            {results.map((r) => (
              <label key={r.url} className="flex gap-2 items-start text-[13px] rounded border hairline p-2 cursor-pointer">
                <input type="checkbox" checked={selected.has(r.url)} onChange={() => toggle(r.url)} className="mt-1" />
                <span>
                  <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline">{r.title || r.url}</a>
                  <span className="opacity-50"> · {r.engine}</span>
                  <div className="opacity-70">{r.snippet}</div>
                </span>
              </label>
            ))}
          </div>
          <Btn variant="solid" onClick={synthesize} disabled={busy || selected.size === 0}>
            {busy ? 'Launching…' : `Synthesize with agent (${selected.size})`}
          </Btn>
        </>
      )}
    </div>
  );
}
```

> Verify the imports against `apps/web/components/ui.tsx` — use the exact exported names (`Btn`, `Input`, `Select`); adjust class names to match the project's Tailwind conventions seen on existing pages (e.g. `/inbox`, `/guardrails`). The `web-research` add-on's `page: '/research'` makes this the nav entry unlocked when the add-on is enabled (see `Shell.tsx` add-on unlock logic) — no static NAV edit needed.

- [ ] **Step 2: Build the web app**

Run: `pnpm --filter @fleet/web build`
Expected: PASS — `/research` listed in the route output.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/research/page.tsx
git commit -m "feat(web): /research page — search, select, synthesize-with-agent"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Server tests**

Run: `pnpm --filter @fleet/server test`
Expected: PASS — all suites incl. `research.test.ts` and the extended `addons.test.ts`.

- [ ] **Step 2: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: PASS (shared, server, web).

- [ ] **Step 3: Web build**

Run: `pnpm --filter @fleet/web build`
Expected: PASS, `/research` route present.

- [ ] **Step 4: Manual smoke (optional, needs a local SearXNG)**

Start a SearXNG with json enabled (`docker run -d -p 8080:8080 searxng/searxng`, set `search.formats: [html, json]`), run `pnpm dev`, enable **Web Research** on `/addons`, open `/research`, search, select results, click **Synthesize with agent**, confirm it navigates to the spawned run.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(research): verification fixups"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 asks (live search → Task 6/9; synthesize-with-agent → Task 6/9; mid-run agent search → Task 7 MCP route + Task 9 button); SearXNG provisioning → Task 7 install + Task 5 status; error handling → Tasks 2/6 (typed 4xx/502, page states); security → Task 2 (execFile, length/count caps in Task 3); testing → Tasks 2/3/4/6 + addons extension. Provider abstraction kept provider-shaped (Task 2 `searchWeb` opts) but SearXNG-only — matches YAGNI scope.
- **Placeholder scan:** none — every code step has complete code; the only deferred item (exact OSS MCP package) is concrete (`mcp-searxng`) with an advisory fallback.
- **Type consistency:** `WebResult`/`WebResearchConfig`/`ResearchSearchRequest`/`ResearchSearchResponse`/`ResearchSynthesizeRequest`/`ResearchSynthesizeResponse`/`ResearchStatusResponse` defined in Task 1 and used verbatim in Tasks 2/6/8/9; `researchConfig()`/`validateResearchConfig`/`DEFAULT_RESEARCH_CONFIG`/`RESEARCH_ID`/`probeSearxng`/`installSearxng` consistent across Tasks 4/5/7; `registry.launch` field names match `LaunchRequest`.
