# Web Research (open-source, SearXNG-backed) — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Constraint:** Open-source only — no proprietary/paid search APIs (no Tavily/Brave/Serper/Exa/SerpAPI, no Anthropic `web_search`). All web search goes through self-hosted **SearXNG** (AGPL-3.0, JSON API, no API key).

## 1. Goal

Add a web-research capability to the Claude Fleet Portal that lets the user:

1. Type a topic in the portal and see **live web results** (direct search).
2. Pipe selected results into a **dedicated research agent run** that synthesizes a cited answer ("Synthesize with agent").
3. Optionally let **launched agents search the web mid-run** via an OSS SearXNG MCP server.

All on open source, runnable on the user's macOS machine, reusing the portal's existing add-on / launch / MCP patterns.

## 2. Why SearXNG

SearXNG is the open-source standard for this: a self-hostable metasearch engine that aggregates 70+ engines (Google/Bing/DuckDuckGo/…), exposes a clean JSON API (`?format=json`), requires **no API key**, has unlimited queries at server cost only, and runs locally — matching the portal's self-hosted ethos. Commercial alternatives (Tavily/Brave/etc.) and Claude's built-in `WebSearch` (Anthropic server-side, paid) are excluded by the open-source-only constraint.

### SearXNG API contract (used by `research.ts`)

- Request: `GET ${searxngUrl}/search?q=<query>&format=json` (+ optional `engines`, `language`, `safesearch`, `pageno`).
- JSON must be enabled server-side: SearXNG returns **403** for `format=json` unless `search.formats` in its `settings.yml` includes `json`.
- Response (relevant fields):
  ```json
  {
    "query": "…",
    "results": [
      { "title": "…", "url": "…", "content": "…", "score": 1.23, "engine": "…", "publishedDate": "…" }
    ],
    "answers": ["…"],
    "suggestions": ["…"],
    "number_of_results": 42
  }
  ```

## 3. Architecture

A new built-in add-on `web-research` (provider: SearXNG) + a `/research` page + a server `research` module + optional SearXNG MCP registration. Search is server-side via Node global `fetch` (Node 22). The synthesis run reuses `registry.launch` and the existing **Researcher** template profile.

### Components (each isolated, single-purpose)

| Component | Kind | Responsibility |
|---|---|---|
| `apps/server/src/research.ts` | new | SearXNG client (`searchWeb`), prompt builder (`buildResearchPrompt`), route registration (`registerResearchRoutes`), status probe. |
| `apps/server/src/addons.ts` | extend | Add `web-research` to `BUILTIN_ADDONS`; `validateResearchConfig`; status derived from reachability probe; `installSearxng` helper (Docker best-effort). |
| `packages/shared/src/index.ts` | extend | `WebResult`, `WebResearchConfig`, `ResearchSearch{Request,Response}`, `ResearchSynthesize{Request,Response}`; `/research` nav entry. |
| `apps/web/app/research/page.tsx` | new | Search box → results list → select → "Synthesize with agent" → link to run. |
| `apps/web/app/addons/web-research/page.tsx` | new | Config (URL/engines/maxResults/safeSearch/language), status, install, "Register SearXNG MCP server". |
| `apps/web/lib/api.ts` | extend | `researchSearch`, `researchSynthesize`, `researchStatus`. |

### Reused, not rebuilt

- `registry.launch(LaunchRequest)` — spawns the synthesis run.
- The **Researcher** template in `templates.ts` (its `allowedTools` already include `WebSearch`/`WebFetch`) — supplies the synthesis profile via `appendSystemPrompt`.
- `mcp.ts` shell-out pattern — extended to run `claude mcp add searxng …` for the agent-tool path (the portal's MCP support is otherwise read-only).
- The add-on config storage (`loadRow`/`saveRow`), status, and install cascade patterns already used by `compression`/`codex`/`opencode`.

## 4. Data flow

**(a) Direct search**
`/research` page → `POST /api/research/search { query, maxResults? }` → `research.searchWeb` → SearXNG JSON → normalized `WebResult[]` → rendered (title, url, snippet, score, engine).

**(b) Synthesize pipeline**
`/research` page (topic + selected results) → `POST /api/research/synthesize { topic, results, model?, cwd? }` → `buildResearchPrompt` embeds the topic + selected sources (title/url/snippet, capped count & length) → `registry.launch({ prompt, cwd, model: model ?? 'claude-opus-4-8', effort: 'high', permissionMode: 'default', allowedTools: ['Read','Grep','Glob','WebSearch','WebFetch'], appendSystemPrompt: RESEARCHER_PROFILE })` → returns `{ runId }` → page navigates to `/runs/:id`. `cwd` defaults to the server's default working directory (the Researcher profile never modifies files, so it is only a read context); the request may override it. The agent may search further via its own `WebFetch`/`WebSearch` or the `mcp__searxng` tool if registered.

**(c) Mid-run agent search (optional)**
Add-on "Register SearXNG MCP server" → `claude mcp add searxng -- <oss searxng mcp server cmd>` → launched agents get `mcp__searxng__*` tools, surfaced in the existing tool picker and `/mcp` panel. Idempotent; shows the equivalent command; advisory fallback if `claude mcp add` is unavailable.

## 5. SearXNG provisioning

- **Default:** connect to `searxngUrl` (default `http://localhost:8080`).
- **Status probe** (`GET /api/research/status`): checks reachability AND that `format=json` works (a 403 → surface "enable `json` in SearXNG `search.formats`"). Add-on `status`/`statusDetail`/`installed` derive from this.
- **Install helper** (`POST /api/addons/web-research/install`): if `docker` is on PATH, best-effort `docker run -d -p 8080:8080` of the official `searxng/searxng` image with a minimal `settings.yml` enabling `json` formats; otherwise return advisory `SelfUpdateStep[]` with copy-paste setup. Mirrors `installHeadroom`'s "first available installer, else advisory" shape. Never crashes.

## 6. Error handling

- SearXNG unreachable / JSON disabled / empty results / empty topic → typed 4xx with a clear message; `/research` renders an explicit state (e.g. "SearXNG not reachable — set the URL on the Web Research add-on page or install it"), never a blank crash.
- `searchWeb` wraps `fetch` with an `AbortController` timeout; failures map to `{ error }` in the route body (200 with body error for the status route, 4xx for search/synthesize), consistent with `mcp.ts` and the addon routes.
- All shell-outs (`docker`, `claude mcp add`) use `execFile` (no shell string interpolation) with timeouts and truncated stdout/stderr — same as `installHeadroom`.
- Synthesize launch failures bubble through the existing `registry.launch` error path (same as every other launch).

## 7. Security

- `searxngUrl` validated as `http`/`https`; it is user-configured and local-first. No arbitrary server-side fetch of user-supplied URLs beyond the configured SearXNG base.
- Results are plain text/markdown; before embedding into the synthesis prompt they are length-capped and count-capped to bound prompt size and avoid injection-via-content surprises.
- No secrets stored (SearXNG needs no key); add-on config holds only the URL and search preferences.

## 8. Testing (vitest, server)

- `apps/server/test/research.test.ts` (new):
  - `searchWeb` normalizes SearXNG JSON → `WebResult[]`.
  - 403 (json disabled), connection error, and empty-results paths return the documented typed errors.
  - `buildResearchPrompt` embeds topic + sources and respects caps.
  - `synthesize` calls `registry.launch` with `WebSearch`/`WebFetch` in `allowedTools` and the researcher profile (assert via a launch spy/stub).
  - status probe classifies reachable / unreachable / json-disabled.
  - SearXNG is stubbed with a local fake HTTP server (matching `portbroker`/`addons` test style — no network).
- `apps/server/test/addons.test.ts` (extend):
  - `web-research` appears in the marketplace listing.
  - `validateResearchConfig` clamps `maxResults` and applies defaults.
  - status transitions: not-installed (unreachable) → ok (reachable).

## 9. Out of scope (YAGNI for v1)

- No result-history/saved-research persistence (a `saved_searches`-style table could be added later).
- No multi-provider abstraction beyond SearXNG (the `searchWeb` interface stays provider-shaped, but only SearXNG is implemented — and any future provider must remain OSS per the constraint).
- No scheduled/recurring research (the existing scheduler can later drive `POST /api/research/synthesize`).
- "Synthesize" **directly launches** a Researcher-profile run and navigates to it (v1 decision); an "open in launcher prefilled" variant is deferred.

## 10. Open questions / assumptions

- Assumes Node 22 global `fetch` (confirmed by `@types/node ^22`).
- Assumes the user will run SearXNG locally (install helper assists; Docker optional).
- The OSS SearXNG MCP server command for path (c) is pluggable; the exact package is chosen during planning (e.g. a maintained `searxng-mcp`), with an advisory fallback if absent.
