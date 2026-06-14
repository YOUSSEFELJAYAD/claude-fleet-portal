# Function Test Audit — `function.json`

Goal: discover **every** function in the codebase, catalog them in `function.json`, and ensure each
is exercised by a **real** test (real `bash`/`git` execution, real fastify HTTP, real SQLite, real
process signals, real `chokidar`, real React-hook reducers over a fake transport — never mock-only
assertions). Worked A→Z by module. Two latent issues found along the way were also fixed.

## How to reproduce

```bash
node tools/discover-functions.mjs   # (re)build function.json via the TypeScript AST
pnpm test                            # full suite — server (vitest) + web (vitest/jsdom)
pnpm -r typecheck                    # typecheck all workspaces
```

## Coverage (from `function.json` → `summary.totals`)

| metric | value |
|---|---|
| functions discovered | **608** |
| exported (public surface) | **188** |
| exported **tested** | **188 — 100%** |
| &nbsp;&nbsp;· unit (name-referenced in a test) | 169 |
| &nbsp;&nbsp;· integration (HTTP route hit via `buildServer`) | 18 |
| &nbsp;&nbsp;· transitive (`getShikiHighlighter`, called by tested render fns) | 1 |
| exported **untested** | **0** |

Suite: **server 73 files / 880 passing** (+2 pre-existing skips) · **web 3 files / 19 passing**.
Typecheck clean across `shared`, `server`, `web`. (Started from 46 files / 727 tests.)

## Two findings — fixed

**1. Dead validation behind Fastify's `maxParamLength` (MCP route).** Fastify defaults `maxParamLength`
to 100, so any `:name` longer than 100 chars 404'd *before* the `/api/mcp/:name` handler ran — making
its own `name.length > 200` guard unreachable. Fixed in `server.ts` `buildServer()` via
`routerOptions: { maxParamLength: 256 }`, so handler-level validation governs: an over-long name now
returns a clean **400** (handler) and only names beyond 256 hit Fastify's **404**.
*(`fn-routes-coverage.test.ts` updated to assert both.)*

**2. Orphaned `run_tags` / `scores` on run deletion.** `repo.deleteRun` cascaded into events/nodes/
skills but **not** `run_tags` or `scores` (owned by `tags.ts` / `scores.ts`) — so every deleted run
leaked rows; the `/api/tags` aggregate merely *masked* them with a `JOIN runs`. Fixed with an
`onRunDeleted(cb)` hook in `db.ts` (mirroring the repo's `onProjectDeleted` pattern); `tags.ts` and
`scores.ts` subscribe and delete their own rows in the cascade — no cross-module coupling, no orphans.
*(`fn-run-delete-cascade.test.ts` proves a deleted run’s tags + scores are gone.)*

## New test files (28 total; all real, no mock-only stubs)

Server (`apps/server/test/fn-*.test.ts`): `fn-validation` (real `bash`), `fn-git-conflict` &
`fn-git-worktree` & `fn-git-resolvemerge` (real git merges/worktrees), `fn-mcp-parse`,
`fn-packs-validate`, `fn-shared`, `fn-teamwatcher`, `fn-settings-fielddef`, `fn-processmanager-args`,
`fn-processmanager-kill` (real detached-process kill + H13 guard), `fn-fleet-cap`, `fn-addons-validate`,
`fn-addons-engine`, `fn-server-template`, `fn-catalog-subagents`, `fn-kanban-board`, `fn-inbox`,
`fn-shiki-render`, `fn-boot-listeners`, `fn-routes-coverage` & `fn-chat-routes` (real HTTP via
`buildServer().inject()`), `fn-run-delete-cascade`, `fn-trigger-poller` (fake timers drive a real DB
poll), `fn-watchteam` (real `chokidar` over a temp `$HOME`).

Web (`apps/web/test/fn-*.test.ts`, new vitest + jsdom + `@testing-library/react` harness):
`fn-web-pure` & `fn-web-buildtree` (pure formatters/tree — run via the server harness),
`fn-useasync-usefleet`, `fn-userunstream`, `fn-usecampaign` — the React hooks driven by a controllable
fake `EventSource` (`apps/web/test/setup.ts`): the transport is faked, the hook **reducer logic is real**.

Every new test was adversarially verified (a second agent re-ran it and confirmed it drives real
inputs → asserts real outputs of the real function, with discriminating assertions — not mock-theater).

## Logic coverage (v8) — driving the internal logic, not just the public surface

After the function audit, a second pass measured and raised real **code coverage** (the actual logic
branches/lines, including the 300+ internal helpers), via two adversarially-verified workflow waves of
coverage-driven tests (one new `test/cov-<module>.test.ts` per module, real inputs → asserted outputs).

| metric | baseline | after |
|---|---|---|
| Statements | 81.1% | **92.45%** |
| Branches | 73.3% | **82.44%** |
| Functions | 91.3% | **97.05%** |
| server test files | 73 | **101** |
| server tests | 880 | **1464** (+2 skipped) |

`npx vitest run --coverage` (config in `apps/server/vitest.config.ts`). The suite is stable across
repeated runs (verified 3×): a fork cap + generous timeouts keep the many real-spawn/port tests from
starving each other under parallel load. `src/index.ts` (the process entry point — binds the port +
signal handlers, exercised through `buildServer`) is excluded from the coverage denominator.

**The remaining ~7.5% uncovered is genuinely untestable in a unit harness** (verified per-module, not
faked): `addons.ts` (72.9%) — spawning the real Python compression proxy + `uv`/`pip`/`npm`/`docker`
installers and 25s health-poll loops; `pm.ts` (84.1%) — orchestration paths that spawn real PM runs
(already covered behaviorally by `pm*.test.ts` integration suites); `validation.ts` (86.3%) — the
10-minute command timeout; plus defensive `catch` blocks that only fire on real OS/IO failures and
live-SSE socket callbacks. Covering these would require faking real spawns (violating "real tests") or
full E2E.

## Notes

- `internalUntested` (name-reference metric in `function.json`) fell 307 → 182 as coverage tests began
  exercising internal helpers directly; the rest are covered transitively (line coverage is the truer
  "all the logic" measure — 92.45%).
- The `~register*Routes` registrars are detected as `integration` coverage when a test hits any of the
  module’s `/api/*` route prefixes via `buildServer`.
- DB-touching tests isolate SQLite via `FLEET_DATA_DIR=$(mktemp -d)` set **before** importing any `src`
  module; `watchTeam` additionally sets `HOME` to a temp dir (verified: `os.homedir()` honors `$HOME`).

---

## Runtime / final-user QA pass (2026-06-14)

Goal: exercise every surface as a real user would — not just unit coverage. Method: full automated
suite for the logic, then drive the **real app in a browser** (Playwright) against an **isolated mock
stack** (control plane `:4329` + web `:4328`, `CLAUDE_BIN=mock-claude`, `FLEET_DATA_DIR=/tmp/fleet-qa-data`)
so launches/kills/campaigns are free, deterministic, and never touch live data.

**Baseline (logic):** server **1614 passing / 2 skipped** (112 files), web suite passing, `pnpm -r typecheck`
clean. (The `verify` skill's "don't substitute CI for runtime observation" — so the suite is a baseline,
not the evidence; the evidence below is the running app.)

**Core pipelines driven end-to-end through the UI/API (all PASS):**
- **Launch → stream → tree → complete:** launched from the modal → mock spawn → stream-json parsed →
  **subagent tree built via `parent_tool_use_id`** (4 nodes, depth 2) → live SSE → COMPLETED with cost,
  tokens, timeline, span waterfall, flow graph, session panel. (The highest-risk component renders right.)
- **Kill:** interactive run (real child PID) → `DELETE /api/agents/:id` → status `killed` (reason `user`)
  and the **OS process is gone** (process-group kill verified).
- **Campaign:** objective → orchestrator decomposed a **3-task dependency DAG** (wave 1 t1+t2, wave 2 t3
  `after #t1,#t2`) → workers auto-spawned + completed → synthesizer. Server truth matched the DAG view.
- **Projects/Kanban/Files:** attach git repo (default branch **auto-detected `main`**) → board → create
  card (Backlog, column-move controls) → Files tab renders the **real git tree** + file content (markdown).
- **Tagging:** added a tag from run detail → persisted (`/api/agents/:id/tags` + `/api/tags` aggregate).

**All ~30 pages render against the live API with zero console errors** (Fleet, Metrics, Orchestrate,
Projects, Loops, Templates, Schedules, Teams, History, Compare, Benchmarks, MCP, Notifications,
Guardrails, Settings, Add-ons, Releases, Inbox, Chat, Learning, Research, run detail). MCP panel parses
real `claude mcp list` (~12 s shell-out — slow but correct). Research correctly reports SearXNG unreachable.

**Error/edge probes:** bogus run id → graceful "run unavailable — not found" (no crash); empty-prompt
launch → clean submit-time validation "A prompt or a /command is required." (no run created).

### Bug found + fixed — pages permanently stuck on "loading…" (dev/StrictMode)

`notifications/page.tsx` and `learning/page.tsx` used `const alive = useRef(true); useEffect(() => () =>
{ alive.current = false; }, [])` — cleanup sets `alive=false` but setup never resets it to `true`. Under
**React 18 StrictMode** (`reactStrictMode: true`, and `next dev` double-invokes effects: mount→unmount→
**remount**), the remount leaves `alive=false`, so every post-fetch `if (alive.current) setState(...)` is
silently skipped → the page wedges on "loading…" forever even though the APIs return 200. Confirmed live:
APIs 200 from the browser, no console errors, yet RECENT/RULES/CHANNELS (and Learning's LOOP CONFIG) never
rendered. This is the dev mode the live instance runs in. **Fix:** set `alive.current = true` in setup
(matching the 7 sibling pages that already do — guardrails/inbox/addons/… all loaded fine). Verified: both
pages now populate (Notifications "11 unread · 11 total"; Learning shows its config) and `tsc` stays clean.
Class of bug invisible to `inject()`-based tests and to a production build — only a real browser in dev catches it.

---

## Scroll + UI-consistency pass (2026-06-14)

Goal: test all scrolling and make every page share the same UI/logic/graphics. Method: a parallel
design-system audit of all 34 page sources (one agent/page → conformance fingerprint → synthesis)
plus a runtime scroll/overflow sweep of every page in the real browser (mock stack :4328/:4329).

**Scroll — 2 real bugs found + fixed (browser-verified):**
- **Sidebar overflow (all pages, `Shell.tsx`):** the `<aside h-screen>` held ~1070px of content
  (21 nav items + brand + spend/telemetry/version footer) with `overflow:visible` and no internal
  scroll → on any viewport < ~1070px tall (1280×800, 1366×768, 1440×900 — most laptops) the last
  nav item (**Releases**) and the **entire always-on spend gauge footer** fell below the fold,
  reachable only by scrolling the whole page, and inconsistently per page. Fix: `nav` →
  `flex-1 min-h-0 overflow-y-auto`. Verified: nav scrolls internally, all 21 items reachable,
  footer pinned + visible at 800px height.
- **Chat frame conflict (`chat/page.tsx`):** root used `h-[calc(100vh-0px)]` *inside* Shell's
  `<main p-6>` (which sits below a 58px sticky header), overflowing the body. Fix:
  `h-[calc(100vh-106px)]` (− header − padding) — app-shell now fits the frame exactly; body no
  longer overflows. Verified `chatBottom 776 ≤ vh 800`.
- Sweep result: **zero horizontal overflow on any of the 34 pages** at 1280px; sidebar + header
  stay pinned (`position: sticky`, top 0) on every page — the shared `Shell` frame is sound.

**Consistency — ErrorBanner standardization (16 files):** the most widespread drift was hand-rolled
error boxes (wrong opacities `border-sig-failed/30 bg-sig-failed/5 text-[11px]` vs canonical
`/40 /8 text-[12px]`, or inline `style={{color:'#ff5d5d'}}`, or a red-tinted `<Panel>`). Replaced
every one with the shared `<ErrorBanner>` (board, files, projects/history, fleet, orchestrate, loops,
loops/[id], learning, schedules, compare, mcp, notifications, inbox, addons codex/compression/opencode),
`onRetry` wired to the existing reload fn where a retry already existed. Applied via a fan-out workflow
(one agent/file + a per-file verify agent), then gated by `tsc` (clean) + browser render checks.
Diffs are pure markup/color-token swaps — no logic/endpoint/handler/state changed.

**Loops / Learning / Fleet Scheduler → Campaigns layout (per request):** these three "engine" pages
were restructured to mirror `orchestrate/page.tsx` (Campaigns): header + description → a single-column
`space-y-5` stack of `<Panel ticked>` blocks, each with a `px-4 py-3 border-b hairline` Kicker header
row; entity lists rendered as `md:grid-cols-2 xl:grid-cols-3` card grids whose cards
(`LoopRow`/`SkillCard`) reuse `CampaignRow`'s treatment (inset status bar, dot+status, title, meta,
footer actions). Loops: two-column list|form → new-loop / live-now / paused blocks. Fleet: the config
popup was inlined as the first block (new config form), then live-allocation stats + per-project table.
Learning: feed|config-sidebar → config block + learned-skills card grid. All logic (state, fetches,
handlers, polling) preserved; verified by `tsc` (clean, all workspaces), web vitest (19/19), and
browser screenshots showing each page matching the Campaigns structure.
