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
