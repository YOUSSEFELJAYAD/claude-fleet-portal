# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Claude Fleet Portal **owns** Claude Code sessions: it spawns headless `claude -p` child processes, parses their `--output-format stream-json` stdout, normalizes it, assembles an orchestrator→subagent tree, and relays everything live to a browser with stop/steer/resume/approve. On top of that sit autonomous PM (Kanban→worktree→merge), campaigns (DAG of workers), self-grading loops, GitHub triggers, human gates, notifications, and a desktop (Electron) build.

- **Monorepo**: pnpm `10.19.0` workspaces `apps/*` + `packages/*`. `desktop/` is **not** in the workspace (uses its own npm + `package-lock.json` because Electron rebuilds `better-sqlite3` for its ABI).
- **Toolchain detect**: `pnpm-lock.yaml` present → always pnpm in `apps/*`/`packages/*`; never run npm there, never run pnpm in `desktop/`.
- **Ports**: web `http://127.0.0.1:4318`, API `:4319`. **Requirements**: Node ≥20, pnpm via corepack, git; Claude Code ≥ 2.1.154 for real runs (mock otherwise).
- **Three packages**: `@fleet/server` (Fastify control plane, tsx/esbuild, better-sqlite3), `@fleet/web` (Next 14, app-router under `apps/web/app` + `apps/web/lib`, NOT `src/`), `@fleet/shared` (the contract).

## Commands

```bash
./install.sh                       # fresh clone: prereqs + pnpm install + build + stamp build-sha
pnpm dev                           # dev: server `tsx watch` :4319 + next dev :4318 (real claude)
pnpm dev:mock                      # same, CLAUDE_BIN=tools/mock-claude.mjs (deterministic, free)
./start.sh        / ./start.sh --mock   # production start (auto-rebuilds if build-sha != HEAD)
pnpm build                         # next build (web only). Add FLEET_STANDALONE=1 for desktop packaging
pnpm test                          # pnpm -r test (server + web, vitest run)
pnpm typecheck                     # pnpm -r typecheck (tsc --noEmit per workspace)
git tag vX.Y.Z && git push --tags  # trigger .github/workflows/release.yml (test → release → desktop matrix)
```

**Single package / single test (vitest):**

```bash
pnpm --filter @fleet/server test                      # server suite only
pnpm --filter @fleet/server test pm.test.ts           # single file (filename filter)
pnpm --filter @fleet/server exec vitest run -t "merge mutex"   # single test by NAME substring
pnpm --filter @fleet/server typecheck
pnpm --filter @fleet/web   test test/fn-chat-concurrency.test.ts
pnpm --filter @fleet/shared typecheck                 # contract package alone
```

- **Server tests are integration tests**: they spawn REAL child processes and bind REAL TCP ports (`apps/server/vitest.config.ts`, maxForks=6, 30s timeout). Always set `MOCK_DELAY_MS=0` for determinism (mock honors it). **Web tests** are jsdom component/hook tests (`apps/web/vitest.config.ts` → `environment: 'jsdom'`, `@testing-library/react`, `test/setup.ts`; files live in `apps/web/test/`, not beside source).
- **Test file prefixes**: `fn-*` = focused function/route, `cov-*` = coverage-targeted, bare `*.test.ts` = feature suite. Mirror the matching prefix when adding tests.
- After editing `packages/shared/src/index.ts` run `pnpm -r typecheck` — both apps consume the raw `.ts` (no build step shields them).

## Architecture

### Portal-owns-the-session pipeline
`POST /api/agents` → `registry.launch()` runs a guardrail gauntlet (concurrency 429 → daily-cap 409 → cwd check → validation → budget defaults), inserts a `starting` run, then `processManager.spawnClaude()` spawns a **detached** `claude -p` child (own process group, `pid===pgid`). stdout is newline-buffered (32MB partial cap), each `{`-line is `JSON.parse`d, `parser.normalize(raw)` maps one raw object → 0..N `ParsedEvent`, `tree.ingest()` routes each to its owning node by `parent_tool_use_id` (root === runId), `registry.handleLine` derives live status + checks budget auto-kill + fans out to SSE immediately, and buffers nodes/events for a coalesced **75ms** batched SQLite write. The browser renders purely from the normalized tree, never raw CLI JSON.

- `apps/server/src/registry.ts` — the control-plane core singleton: lifecycle (launch/launchEngine/resume/stop/delete), wiring, status derivation, guardrails, pub/sub (`subscribeRun`/`subscribeFleet`/`onRunTerminal`), 60s eviction, auto-retry.
- `apps/server/src/server.ts` — `buildServer()`: host allowlist + CORS hooks, module-private `sse()` helper (MAX_SSE cap), ~45 ordered route registrations, background workers.
- `apps/server/src/processManager.ts` — `buildArgs`/`buildResumeArgs` (verified flag order + `--` prompt separator), detached spawn, group-kill with PID-recycle guard.
- `apps/server/src/parser.ts`, `tree.ts`, `db.ts` — normalize / assemble / persist (better-sqlite3 WAL, `repo` object, `batchPersist` single-tx).

### The frozen contract: `packages/shared/src/index.ts`
One ~1539-line file is THE server↔web type contract. `package.json` points `main`/`types` straight at `src/index.ts` and it's consumed as `workspace:*` raw — **no build step**. The cardinal rule (file header): the UI renders from the normalized `parentNodeId`+`nodeType` shape and NEVER parses raw CLI. Add any cross-boundary type here, never duplicate it in an app. Node identity is load-bearing: root `nodeId === runId`; a subagent's `nodeId === the spawning Agent/Task tool_use id`. Cost truth is `result.total_cost_usd` (`Run.costUsd`), NOT the `MODELS` pricing table (display/estimation only). `CLAUDE_MODELS = MODELS.filter(...)` is the native subset; `engineForModel(id)` resolves the executing engine (defaults unknown→claude).

### Web UI (`apps/web`) — strictly a contract consumer
Next 14 **app-router**: one `page.tsx` per route under `apps/web/app/*` (mostly `'use client'`), reusable UI in `apps/web/components`, and **all** data/transport logic in `apps/web/lib`. `@/*` path alias → `apps/web`. `next.config.mjs` sets `transpilePackages: ['@fleet/shared']` so the web bundles the raw-TS contract directly (no build artifact).
- `lib/api.ts` — the SINGLE typed REST client. `API = NEXT_PUBLIC_FLEET_API || http://127.0.0.1:4319`; one `api.*` method per route. The private `j<T>()` helper only attaches `content-type: application/json` **when a body exists** (Fastify 400s an empty JSON body → would break every body-less DELETE), and throws an `ApiError` carrying `.status` + server `.code` so callers branch on e.g. `409`/stale-oid. A few wire types (`ExportedSetup`, `NotifierChannel`, `Benchmark`, `TriggerView`, `ScheduleView`) are declared locally here to dodge cross-package imports — keep them in sync with the server module they mirror.
- `lib/live.ts` — ALL live state lives in `EventSource` SSE hooks: `useFleet()` (fleet stream), `useRunStream(id)` (per-run), `useCampaign`, `useChatStream` (subscribes to the **session**, not a run id, so it survives kill→resume as the backing run changes), `useNotificationStream` (dedupes by id), `usePendingQuestions` (polls `/api/inbox` every 4s), and `useAsync` for one-shot fetches. `buildTree(nodes, rootId)` reassembles the flat node list into the render tree client-side by `parentId`, children sorted by `startedAt`. Streaming token deltas accumulate in `partials[nodeId]` (`assistant_partial`) and clear on the full `assistant_text`; append other events ordered by `seq`. On an `{error}` stream frame the hook **closes** the EventSource (H8 — else it auto-reconnects every ~3s forever); the tree is `useMemo`'d on `nodeMap` only (H19) to keep memoized rows stable under the 1s refresh tick.
- `lib/status.ts` is the single status→`{label,color,live}` palette; `lib/shiki.ts` + `MarkdownView`/`ShikiCode` handle markdown/code rendering. `app/layout.tsx` wraps every page in `<Shell>` (nav + notification toasts).

### Additive-module pattern (server)
Each feature is a self-contained Fastify module that **owns its own SQLite table** via a top-level `db.exec(CREATE TABLE IF NOT EXISTS ...)` at import time, plus migrations as an idempotent `ALTER TABLE` in a try/catch that swallows ONLY `/duplicate column name/i`, and exposes `registerXRoutes(app)` wired in one block in `server.ts`. **Do NOT edit `db.ts` to add a feature.** The CREATE body must carry every column so a fresh DB never depends on the ALTER loop. **Import order matters**: `db.ts`'s own ALTER loop runs before feature modules import, so projects must register before kanban (FK), etc. Self-owned tables with no FK to runs subscribe `db.onRunDeleted` to cascade-clean.

### Major subsystems
- **Autonomous PM + Kanban** — `pm.ts` (state machine: SELECT→BUILD→validate→review gate→merge, per-project merge mutex `withMergeLock`), `kanban.ts`, `projects.ts`. Cards run as a single build run into an isolated git worktree (`task-<id>` / branch `worktree-task-<id>`) OR delegate to a campaign sub-DAG. `git.ts`/`gh.ts` are never-throw layers; engine commits use the `FLEET_PM_AUTHOR` identity. PR mode never auto-merges (locked §10.1 — a human merges on GitHub).
- **Campaigns** — `campaigns.ts`: orchestrator emits a `PLAN_JSON_SCHEMA` DAG → worker run per subtask (`dependsOn` + `maxParallel`) → optional synthesizer.
- **Fleet scheduler** — `fleet.ts`: admission-only cross-project fair-share (`tryAdmit`) of the global concurrency pool by priority; fails CLOSED.
- **Loops / autonomy** — `loops.ts` (contract entity, dry-run→apply trust ramp via atomic `bumpAndEscalateTxn`), `scheduler.ts` (30s), `triggers.ts` (GitHub poll 120s), `loopEval.ts` (LLM judge), `manager.ts`, `benchmarks.ts`, `learner.ts` (skill distillation, disabled by default), `research.ts`.
- **Human gates / permissions** — two orthogonal pause mechanisms drained through `/inbox`: `gate.ts`/`gateServer.ts` = mid-run `ask_human` MCP gate (TTL-resolves EMPTY); `permissionGate.ts`/`permissionHookServer.ts` + `tools/fleet-permission-hook.mjs` = PreToolUse hook (fails CLOSED, decision `deny`). `inbox.ts` merges all gate kinds.
- **Notifications** — `notifier.ts`: subscribes terminal + both gate-enqueue events, persists rows, fans out to webhook/Slack/Discord + SSE → browser + Electron native.
- **Chat** — `chat.ts`/`chatLive.ts`: held interactive `claude` child per session (stdin turns); separate `CHAT_LIVE_MAX` budget so chat can't starve the fleet.
- **Catalog / config / telemetry** — `catalog.ts`/`templates.ts`/`commands.ts`/`packs.ts` (launch surface), `settings.ts`/`portability.ts`/`addons.ts`, `otel.ts` (local OTLP **receiver** at `/v1/*`), `search.ts` (FTS5), `metrics.ts`, `fileview.ts`/`fileedit.ts`, `memory.ts`.

## Conventions & gotchas (high-signal)

- **Citation tags are load-bearing — keep using them.** Comments reference design docs by code: `H<n>` hardening, `F<n>` features, `D-<nnn>` decisions, `§<n>` DC.md, `PRD §<n>` PRD. **`DC.md`, `PRD-Claude-Fleet-Portal.md`, `TEST_REPORT.md` were deleted from the working tree** (git status `D`) — they live only in git history: `git show HEAD:DC.md`. The tags still index real decisions. Cite the same tag when adding tied behavior.
- **Env freeze order is contractual**: `index.ts:1` imports `envboot` (loads managed `data/.env`) BEFORE `config.ts`, which freezes `process.env` into module constants at import time. You cannot change a port/path at runtime. `envboot.ts` must not import `config.ts`.
- **Importing `registry.ts` has aggressive side effects**: its constructor SIGKILLs orphaned PIDs from a prior process and marks orphaned runs failed. A `tsx watch` hot-restart in dev therefore kills live children.
- **DB writes are coalesced** — never upsert per stream line; buffer + `scheduleFlush` (75ms) + `batchPersist`. Always `flush()` before a snapshot read, terminal write, or stop. `resetAllData` uses a HARDCODED table list — a new table with data must be added there or it survives a wipe.
- **SSE handlers are uniform**: call module-private `sse(reply,req)` (null ⇒ 503 already sent); subscribe; `reply.raw.on('close', …)` to unsub. `sse()` echoes the validated Origin manually because `reply.hijack()` bypasses the CORS plugin. `forceCloseConnections:true` is required (hijacked SSE = active connections). Order events by monotonic `seq`, NOT `ts` (server-stamped at ingest).
- **Budget enforced twice / fresh allowance on resume**: budget compares `portionCostUsd` (this-invocation only); usage deduped by `message.id`; authoritative cost comes from the result `modelUsage` sum (H7), live estimate is an intentional upper bound.
- **buildArgs flag order is verified against real claude**: one-shot prompt is positional AFTER `--`; interactive runs deliver turn-1 via stdin or block forever. `runId === sessionId === --session-id`.
- **Gates fail in the safe direction, differently**: `ask_human` TTL → EMPTY selection; permission gate TTL/evict/disconnect → `deny` (it's a SECURITY boundary). The permission-hook callback listens on `reply.raw` `close`, never `req.raw`. Permission tool matchers are regex-escaped. The stdin control-protocol permission path (`registry.decidePermission`) is largely DORMANT; the PreToolUse hook is what actually blocks tools — so the inbox badge polls `/api/inbox`, not run status.
- **One-shot vs interactive**: `sendInput`/`decidePermission` require an interactive run (one-shot has stdin closed at spawn → silent drop). Chat uses held interactive children.
- **Engine (codex/opencode) runs are degraded by design**: no cost stream (`costUsd=0`), no subagent tree, no resume/input/budget; exit code is authoritative. Gate engine behavior on `Run.engine`.
- **OTEL must use OTLP, never the console exporter** — console would corrupt the stream-json stdout channel the parser reads.
- **Mock = hermetic tests/demos**: server spawns `CLAUDE_BIN` as the agent; `tools/mock-claude.mjs` replays `fixtures/*.jsonl` through the real parser→tree→SSE pipeline. `--json-schema` runs replay `orchestrator-plan`, others `workflow-fanout`. Recover deleted-doc context, pick fixtures via `MOCK_FIXTURE=`.
- **Filesystem trust**: resolve project root from `projectsRepo` and workspace root from the chat session cwd — NEVER from client paths. Pass paths through `safePath`/`isSafeRef`/`isSafeId`. Git command failures return HTTP 200 with `error` in body; path/ref rejection is 4xx.
- **Desktop**: ports fixed 4318/4319 (baked at build time, env overrides don't apply); web payload must be symlink-free (`copy-web.cjs`); `output:'standalone'` only under `FLEET_STANDALONE=1`; macOS is ad-hoc signed only (downloads need `xattr -cr` or right-click→Open); GUI PATH is augmented in `main.cjs`.

No Cursor/Copilot rule files are present in this repo.
