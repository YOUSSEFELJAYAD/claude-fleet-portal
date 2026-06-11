# DC.md — Decision Log: Claude Fleet Portal

> Every non-trivial decision taken while executing `PRD-Claude-Fleet-Portal.md` is recorded here,
> with rationale, the PRD clause it serves, alternatives considered, and any deviation called out.
> Format: `D-NNN` decisions, append-only (amendments noted, not rewritten).
>
> Author/operator: Youssef El Jayad · Started: 2026-06-08 · Claude Code 2.1.168 · Opus 4.8

---

## 0. Memory check (per goal: "read it if u need to request any memory")

- **personal-rag MCP**: searched for prior context on this project ("Claude Fleet Portal agent monitoring dashboard PRD"). Index has only **3 chunks**, all from `~/rag-sys-perso/welcome.md` (the RAG welcome doc). **No prior project memory exists** to import. Proceeding from the PRD alone.
- **`~/.claude/projects/.../memory/`**: no pre-existing memories relevant to this build surfaced in session context.
- **Decision**: build from the PRD as the single source of truth; will `save_text` a project summary to personal-rag at the end so future sessions have continuity.

---

## 1. Verified ground-truth facts (resolve PRD §11/§14 open questions)

These were captured live from the installed Claude Code (`2.1.168`, ≥ 2.1.154 ✓), **replacing the PRD's guesses**. Evidence: ran `claude -p "..." --output-format stream-json --verbose --include-partial-messages` and `claude --help`.

### F-1 — Real `stream-json` event schema (resolves §14 Q2)
Newline-delimited JSON; one object per line. Observed `type`s:
- `system` / `subtype`: `init` (carries `session_id`, `cwd`, `model`, `tools[]`, `mcp_servers[]`, `agents[]`, `skills[]`, `permissionMode`, `claude_code_version`, `fast_mode_state`, `memory_paths`), `status`, `hook_started`, `hook_response`, `hook_progress`.
- `stream_event` → `event.type` ∈ `message_start`, `content_block_start`, `content_block_delta` (`delta.text_delta.text` = **token deltas**), `content_block_stop`, `message_delta` (carries `usage` + `stop_reason`), `message_stop`. Each has `ttft_ms` on message_start.
- `assistant` — full assistant message (`message.content[]`, `message.usage`).
- `user` — user/tool-result messages (when present).
- `result` — terminal: `subtype` (`success`/error), `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`, `result` (final text), **`total_cost_usd`**, `usage` (input/output/cache tokens), `modelUsage` (keyed by model id e.g. `claude-opus-4-8[1m]`), `permission_denials[]`, `terminal_reason`.
- `rate_limit_event` — `rate_limit_info` (status, resetsAt, rateLimitType).

### F-2 — **`parent_tool_use_id` is the hierarchy key** (resolves §14 Q2, §9.1 `parentId`)
Every `stream_event` / `assistant` / `user` event carries `parent_tool_use_id` (null for root). A subagent/workflow-spawned agent's events carry the `tool_use_id` of the spawning `Task` call. **This — not the PRD's invented `parentId` — is how the tree is built.** `session_id` is on *every* event.

### F-3 — Real task-list schema (resolves §7.4 Agent Teams surface)
`~/.claude/tasks/{id}/` contains numbered `N.json` files + a `.lock`. Each task:
```json
{ "id":"1", "subject":"...", "description":"...", "activeForm":"...",
  "status":"completed|pending|in_progress", "blocks":[], "blockedBy":[] }
```
`blocks`/`blockedBy` = dependency edges. No explicit `owner`/mailbox file observed in sampled dirs → model `owner` as optional; treat any non-`N.json` files as potential mailbox (defensive).

### F-4 — Real CLI flag surface (resolves §14 Q3, §9.2)
Confirmed flags: `-p/--print`, `--output-format {text,json,stream-json}`, `--input-format {text,stream-json}`, `--verbose`, `--include-partial-messages`, `--include-hook-events`, `--model`, **`--effort {low,medium,high,xhigh,max}`**, **`--max-budget-usd <amt>`**, `--permission-mode {acceptEdits,auto,bypassPermissions,default,dontAsk,plan}`, `--dangerously-skip-permissions`, `--allowedTools`/`--disallowedTools`, `--add-dir`, `--resume [id]`, **`--session-id <uuid>`**, `--fork-session`, `--no-session-persistence`, `--agents <json>`, `--append-system-prompt`, `--replay-user-messages`, `--json-schema`.

### F-5 — Cost reality
One trivial Opus 4.8 `-p` call cost **$0.18 USD** (12.4k input + 19.3k cache-creation tokens). Confirms the PRD's cost-guardrail urgency and motivates the free **mock-claude** test harness (D-009) to avoid burning real tokens during development.

### F-7 — **Confirmed** tree-build mechanism from a REAL subagent trace (`/tmp/subagent_capture.txt`, $0.32)
Ran a `-p` prompt that dispatched a subagent. Observed:
- Spawn tool is named **`Agent`** in CC 2.1.168 (PRD/older docs say `Task`). Root assistant emits `tool_use name=Agent id=toolu_01Atwvm…`.
- **All child events carry `parent_tool_use_id = <Agent tool_use id>`**: the subagent's injected `user` prompt, its inner `Bash` `tool_use`, and its `tool_result` — all chain to the spawning id. ✓ (proves F-2 links child→parent, not just "exists").
- **Subagent completion** = a `tool_result` block (inside a `user` event) at parent level whose `tool_use_id == <Agent id>`.
- Soft lifecycle hints: `system/{task_started,task_progress,task_notification}` and `system/thinking_tokens` (extended thinking).
- **Routing rule (version-proof):** *any `tool_use` id that later appears as a `parent_tool_use_id` is a subtree root.* Do NOT hardcode the tool name — label as subagent if name ∈ {Agent, Task}, but route purely by id. Nesting chains automatically (a subagent's own Agent call becomes the next parent id) → arbitrary depth, matching the ≤16-concurrent/1000-total model.
- Both captures saved as test fixtures (D-009).

### F-8 — **`--json-schema` output lands in `result.structured_output` (object), NOT `result.result`** (advisor catch)
Verified live ($0.40): `claude -p --json-schema '<plan schema>'` returns the schema-conforming data as an **already-parsed object** on the `result` event's **`structured_output`** field. `result.result` is a PROSE summary ("The structured plan has been delivered…"). The model also emits a `StructuredOutput` tool_use in the stream. **My initial campaign engine did `JSON.parse(run.resultText)` → would have failed on EVERY real campaign (marked failed, 0 tasks), while all mock tests stayed green.** Fixed: parser captures `structured_output`; Run gains `structuredOutput`; engine reads `run.structuredOutput ?? JSON.parse(resultText)` (fallback for mock). Same class of bug as `parentId`-vs-`parent_tool_use_id` and the 3s-stall — caught by exercising the REAL path, not the mock.

### F-9 — Interactive runs must send the prompt via STDIN, not the `-p` positional (real-claude verified; was a hang)
A user-launched interactive run sat at `status: "starting"` forever (no `init`, no events; the `claude` process alive but sleeping). Reproduced: `claude -p "<prompt>" --input-format stream-json` with stdin held open emits only `hook_started` then blocks — **in stream-json INPUT mode the positional `-p` prompt is ignored; claude waits for a user message on stdin.** Fix verified: send the prompt as a stream-json user message on stdin (no positional) → `init`→`running`→`result`→`awaiting-input`, and follow-up `send input` works. The mock never caught this (it replays regardless of stdin) — same "verify vs real claude" lesson as F-2, the 3s-stall, and F-8.

### F-6 — No dedicated Dynamic-Workflows on/off flag
`claude --help` exposes **no `--workflows` flag**. Workflow orchestration is driven by effort (`xhigh`/`max`) for substantive tasks (the "ultracode" concept = `xhigh` + auto-orchestration). The PRD's "Dynamic Workflows allow/deny toggle" (§7.2) has no direct CLI equivalent → modeled honestly (D-007).

---

## 2. Decision log

### D-001 — Resolve "execute the PRD" autonomously; document, don't interrogate
The goal says *"do ur best and note every decision"*. Interpreting this as a mandate to make defensible product/architecture decisions independently and log them here, rather than blocking on `AskUserQuestion` for each. Will only ask the user if genuinely blocked. **Serves:** the goal directive.

### D-002 — Verify platform facts against installed Claude Code before coding
The PRD (§11, §14, §9.2) repeatedly flags that the stream-json schema and flags are undocumented/evolving and must be verified against the installed version. Since I *am* Claude Code, I captured real events + `--help` first (§1 above). De-risks the parser/tree-builder, the highest-risk components. **Serves:** §9.2, §11, §14.

### D-003 — Two-process architecture: standalone Fastify control-plane + Next.js frontend
The PRD's own diagram (§8) separates "Backend / control plane" from "Next.js portal (UI)". The process manager must be a **long-lived singleton** holding `child_process` handles — incompatible with Next.js's request-scoped/serverless route handlers. **Decision:** `apps/server` = Fastify (TS) owns spawn/stdin/signals/parse/SSE/persistence; `apps/web` = Next.js App Router (UI) talks to it via REST + SSE. **Alternatives rejected:** (a) Next custom server (couples UI build to the daemon, loses HMR ergonomics); (b) everything in Next route handlers (singleton survival across reloads is fragile). **Serves:** §8, §8.1, §14 Q1 (Node runtime).

### D-004 — pnpm workspace monorepo with a shared types package
`packages/shared` holds the normalized event schema (§9.1), API DTOs, and enums — the **frozen contract** both apps import. Lets the backend and UI evolve against one source of truth and enables safe parallel construction. pnpm 10.19 present. **Serves:** §9.1 (event normalization is the contract the UI renders from).

### D-005 — **SQLite (better-sqlite3) + in-process state instead of Postgres + Redis** ⚠️ DEVIATION
The PRD names Postgres + Redis (§8, §9.3). For a single-user, localhost-first portal (explicit §3 non-goal: no cloud/multi-user; §10 Portability: "no cloud dependency") requiring Postgres + Redis means the user must run docker-compose just to launch. **Decision:** persist to **SQLite** with a schema mirroring §9.3 (`runs`, `run_nodes`, `events`, `teams`, `run_skills`, `config`); keep hot status/heartbeats in an **in-process registry** (no Redis — single process needs no cross-process pub/sub). Data-access is isolated behind a repository module so Postgres can swap in later. **Why acceptable:** SQLite is durable + SQL-searchable (satisfies §7.8 history/search) with zero external infra. **Trade-off:** no multi-process horizontal scale (a non-goal). **Serves:** §3, §7.8, §10; **deviates from** §8/§9.3 named stack — flagged intentionally.

### D-006 — Pre-assign `--session-id <uuid>`; `runId == sessionId`
Using the verified `--session-id` flag (F-4), the portal generates the UUID up front and passes it in, so the DB row, the live process, and `--resume` all key off the same id immediately — no race waiting for the `init` event to learn the session id. **Serves:** §7.6 (resume), §9.3 (`runs.session_id`), reliability §10.

### D-007 — Effort model uses REAL flag values; "ultracode"/"workflows" are presets
Launch form effort options = the real `--effort` values `low | medium | high | xhigh | max` (F-4). The PRD's "effort level (high/xhigh/ultracode)" (§5,§7.2) is mapped: **"ultracode" = a UI preset → `--effort xhigh` + workflows-expected + stricter budget default**. The "Dynamic Workflows allow/deny" toggle (§7.2) has no CLI flag (F-6); modeled as a UI hint/flag persisted on the run + derived from effort, with a documented note that the portal cannot hard-disable orchestration via CLI on this version. **Serves:** §6, §7.2; honestly bounds §14 Q3.

### D-008 — Dual budget enforcement: `--max-budget-usd` + portal-side kill
Pass the per-run ceiling to the process via verified `--max-budget-usd` (F-4) AND track cost from `result`/`usage` events to auto-kill on breach server-side (§7.7, §10 cost-safety). Belt-and-suspenders: process-level ceiling is the primary guard; portal kill covers cases the flag doesn't (e.g., wall-clock/concurrency). Stricter default ceiling for `xhigh`/ultracode runs. **Serves:** §7.7, §10, §13 (zero runs exceed ceiling).

### D-009 — `mock-claude` fixture replayer for free, deterministic pipeline tests
A small script emits canned stream-json (including a `Task`-spawned subagent with `parent_tool_use_id` to exercise the tree builder) on a configurable delay. Server reads `CLAUDE_BIN` env (default `claude`) so tests point at the mock. **Why:** real calls cost ~$0.18 each (F-5) and are non-deterministic; the mock makes the parser/tree-builder/SSE testable in CI with zero spend and stable assertions. **Serves:** §10 reliability, §13 (100% subagents in tree — verifiable), dev velocity.

### D-010 — SSE (not WebSocket) for live events; REST for commands (resolves §14 Q4)
Live event flow is one-directional (server→browser, root + subtree). SSE over a single `GET /api/agents/:id/stream` is sufficient and simpler than a ws upgrade; commands (stop/input/resume/permission) are discrete REST calls. **Serves:** §7.3, §8.1, §9.4, §14 Q4.

### D-011 — localhost-bind, no auth for v1 (resolves §14 Q5)
Bind server + web to `127.0.0.1`; no auth layer in v1 (§3 non-goal: single-user localhost; §10 security: "localhost-bound by default; auth required if exposed"). Auth is a documented future item, not built now. **Serves:** §3, §10, §14 Q5.

### D-012 — Phasing: a VERIFIED vertical slice first, then layer breadth (amended per advisor)
~~Original: build all 5 phases breadth-first.~~ **Amended:** advisor flagged breadth-first as the top risk (context exhaustion → broad half-verified code). New order built around one demo-able loop that satisfies success metrics #1–#2:
1. Freeze `packages/shared` contract (event schema §9.1, DTOs).
2. Backend core: process manager + stream parser + tree builder (coherent, main-loop, **TDD against the real-trace fixtures** F-7).
3. Verify backend boots + emits a correct tree from `mock-claude` (curl/test) BEFORE any UI.
4. UI for the core loop: launch → fleet grid (live) → run detail (tree + timeline) → stop.
5. THEN layer breadth: control (input/resume/permission) → teams & skills → guardrails & history.
At every checkpoint something actually runs. **Serves:** §12, §13; risk-reduction per advisor.

### D-013 — Workflows reserved for leaf UI fan-out + final adversarial review (per advisor)
Ultracode is on, but the process-manager/parser/tree-builder are built coherently in the main loop and verified first. A `Workflow` is used only (a) to fan out genuinely-independent leaf React components AFTER the shared contract is frozen and the backend is proven, and (b) for an adversarial review pass at the end. Prevents parallel UI agents building against a contract that shifts during backend integration. **Serves:** correctness over raw parallelism. *Applied:* the UI was built coherently in the main loop (tightly-coupled shared design system made single-threaded construction safer than fan-out); the workflow was used for the final 3-dimension adversarial correctness review of the control-plane core.

### D-014 — `interactive` launch flag; default one-shot for clean completion
With `--input-format stream-json` the process stays alive after the first `result` awaiting stdin. Default `interactive:false` → stdin closed at spawn → the run executes the prompt once and **exits cleanly** (reliable `completed` status), which suits fire-and-forget fleet tasks. `interactive:true` keeps it alive → `awaiting-input` after each turn, enabling **send-input** (§7.6). Resume (§7.6) covers continuing a finished run. **Serves:** §3 goal 4, §7.6; reliable lifecycle.

### D-015 — Frontend stack: Next 14.2 + React 18.3 + Tailwind 3.4 (reliability over bleeding-edge)
Chose the well-trodden App-Router stack over Next 15 / React 19 to guarantee a clean one-pass `next build` with no RC-era edge cases. Hand-written config (no `create-next-app`) for determinism/no interactive prompts. **Trade-off:** not the newest majors; irrelevant to this app's needs. **Serves:** §10 reliability/portability.

### D-016 — Validate launch `cwd` exists → 400, not a silent failed spawn
`spawn(claude, …, {cwd})` errors if `cwd` doesn't exist, surfacing only as an opaque `failed` run. The registry now checks `existsSync(cwd) && isDirectory` at launch and returns a clear 400. (Found during M2/demo verification — a real robustness gap.) **Serves:** §10 reliability, operator UX.

### D-017 — "Mission Control" aesthetic (frontend-design skill)
Industrial telemetry console: charcoal canvas + blueprint-grid/scanline texture, amber-phosphor brand accent, **status-as-signal** color coding, monospace-forward data. Fonts: **Chakra Petch** (HUD display), **Archivo** (body), **JetBrains Mono** (telemetry/IDs) — distinctive, not generic. Signature element: the **budget gauge that heats amber→red** as a run nears its ceiling, beside the live branching workflow tree. **Serves:** §1 (a real console, not a flat list), operator legibility under density.

---

## 3. Deviations from the PRD (explicit)

| # | PRD says | Built instead | Why |
|---|---|---|---|
| D-005 | Postgres + Redis | SQLite + in-process registry | Zero-infra localhost single-user; schema stays Postgres-portable |
| D-007 | "ultracode" as an effort value; workflows allow/deny | real `--effort` values; ultracode/workflows as UI presets | matches verified CLI; no `--workflows` flag exists |

All other choices implement the PRD as written.

---

## 3.5 Build milestones (verification log, per "evidence before assertions")

- **M1 — Core pipeline verified (✓).** 12/12 vitest pass: parser + tree builder against the REAL subagent trace (correct parent/child, cost reconciled to authoritative $0.32) and synthetic fan-out (3 subagents, depth-2). `apps/server/test/pipeline.test.ts`.
- **M2 — Control plane verified end-to-end against mock-claude (✓).** Booted Fastify server with `CLAUDE_BIN=tools/mock-claude.mjs`; launched a run via `POST /api/agents`; pipeline produced the correct nested tree (root→AG1→AG3 depth-2, +AG2), `status: completed`, cost reconciled to `$1.8423`, subagentCount=3, maxDepth=2. `/api/skills` read real `~/.claude/skills`; `/api/teams` read real `~/.claude/tasks` (7 task-lists). 
- **Build-system notes (decisions):** (a) better-sqlite3 + esbuild require `pnpm.onlyBuiltDependencies` allowlist; native binding fetched via `prebuild-install`. (b) `tools/mock-claude.mjs` must be `chmod +x` (it's spawned directly via its `#!/usr/bin/env node` shebang). (c) D-009 mock keyed off `CLAUDE_BIN` env — server is agnostic to real-vs-mock.
- **M3 — Full-stack verified live + visually (✓).** `next build` clean (7/7 routes, type-checked, fonts fetched). Booted both servers against mock-claude, launched a live fleet; Playwright screenshots (`docs/dashboard.png`, `docs/run-detail-live.png`) confirm: fleet grid with live status/cost gauges (budget-breach run renders RED at 92%), and run-detail rendering the correct nested workflow tree (session→Agent→nested Agent +Agent), streaming timeline, and cost reconciled to $1.8423. **Success metrics #1 (start/watch/stop end-to-end) and #2 (100% subagents with correct parent/child) demonstrated.**
- **M4 — Adversarial review + fixes (✓).** Ran a 3-dimension review Workflow (15 agents, parser/tree · registry/lifecycle · process/SSE/db) with adversarial verification of each finding: **12 raw → 9 confirmed real** (good filtering). **All 9 fixed and re-verified** (15/15 tests, all typechecks, both builds clean, boot smoke incl. budget=0 case):

| # | Sev | Bug | Fix |
|---|---|---|---|
| 1 | high | Failed subagent reported `completed` — parser dropped `is_error` from tool_result | parser captures `isError`; tree sets `failed`; UI renders failure (red ✕) + regression test |
| 2 | high | Resume reused prior run's stale `RunTree` (frozen authoritativeCost → instant re-kill / masked spend) | always a fresh tree on resume; prior totals carried as a **baseline** (cumulative display, fresh per-invocation guardrail) |
| 3 | high | `resume()` bypassed the max-concurrent-runs cap | same 429 active-count check added to resume |
| 4 | high | Resume after restart dropped new events (`seq` collision under `INSERT OR IGNORE`) | seed `tree.seq = repo.maxEventSeq(runId)+1` on resume |
| 5 | med | `permission_request` consumed by tree but never produced by parser (dead flow) | defensive parser cases for `system/permission_request`, `can_use_tool`, `control_request` (best-effort, documented) |
| 6 | med | Live runs never evicted from `this.live` (unbounded leak) | `scheduleEvict` (60s grace, only when no subscribers) on terminal; cancelled on resume |
| 7 | med | Uncleared SIGKILL timer could signal a PID-reused group 3s post-exit | `exited` guard + stored/cleared `killTimer` |
| 8 | low | `budgetUsd === 0` caused instant auto-kill | guardrail requires `budgetUsd > 0` (verified: budget=0 run completes) |
| 9 | low | Hello-replay capped first 5000 events → late subscribers missed the middle | `getEventsTail` replays the most-recent N for continuity-to-live |

- **M5 — Advisor-driven completion checks (✓).** The advisor flagged three things verified only by reading code; all now empirically closed:
  1. **Budget auto-kill observed firing MID-STREAM** (PRD success metric #3). Built `fixtures/runaway.jsonl` (live estimate climbs fast); a $0.50-budget run flipped to `killed` at ~$1.85 *before* completion, both live subagents cascade-flipped to `killed`, and the mock process was terminated (process-group cascade). Regression test added (16th test). **Also fixed a real bug the demo exposed:** the guardrail was retroactively "killing" already-finished runs (cost jumps to authoritative at the `result` event) → added `!resultSeen` so a completed run is never killed post-hoc (the spend already happened; over-budget completion is surfaced via the red cost UI, not a kill).
  2. **`pnpm dev:mock` one-command path verified** — both servers up, dashboard served, run launched through the `$PWD`-wired mock end-to-end.
  3. **Real `claude` binary path verified through the portal** — a real one-shot run completed in **4.2s**, cost reconciled to the authoritative **$0.1824**, result text exact, correct single-root tree. **No 3s stdin stall** (one-shot `.end()` gives immediate EOF; the earlier warning was from a manual test that left stdin open). Real multi-subagent `parent_tool_use_id` linkage was already confirmed pre-build (F-7).

- **Final state:** **16/16 server tests pass; all 3 packages typecheck clean; `next build` clean.** Pipeline verified live end-to-end against both mock and **real claude**; budget auto-kill, cascade-kill, `dev:mock`, and resume paths all exercised. All 9 review findings + 3 advisor items resolved. **Implementation complete.**

## 4.5 Feature: Orchestration Mode + Agent Templates (post-PRD extension)

User request (2026-06-08): *"a template of agent + orchestration mode [where] one agent can get a task and auto-create automated agents to work on it — go deep."*

### D-018 — Build "Campaigns": the portal itself orchestrates real, separately-controllable agents
Interpretation: a **meta-orchestration layer** on top of the existing run model. One **orchestrator agent** receives an objective, **decomposes it into a structured plan**, and the **portal auto-spawns a real worker run per subtask** (each a normal tracked `claude -p` run, fully controllable), respecting dependencies + a parallelism cap, optionally feeding results to a **synthesizer**. This is deliberately *distinct* from Claude's in-process Dynamic Workflows (which the portal already observes as a tree): Campaigns give one **independently controllable, resumable, separately-budgeted agent per subtask**, visible in the fleet. **Serves:** the user's "one agent auto-creates agents" ask with maximum control/visibility.

### D-019 — Orchestrator emits its plan via the verified `--json-schema` flag
The orchestrator run is launched with `--json-schema <PLAN_SCHEMA>` (verified real flag, F-4) so its final result is **guaranteed-valid structured JSON** — no brittle free-text parsing. PLAN = `{ tasks: [{ id, title, prompt, template, dependsOn[] }] }`. **Serves:** robust auto-decomposition.

### D-020 — Agent Templates are first-class, DB-backed, with built-in seeds
Reusable profiles (name, role, system prompt, model, effort, fast, allowed tools, skills, permission mode, budget). Seeded built-ins (Orchestrator, Researcher, Implementer, Reviewer, Synthesizer). A campaign references templates by name for the orchestrator, workers, and synthesizer. **Serves:** the "template of agent" ask; reuse.

### D-021 — Integration over isolation for the campaign engine; verified end-to-end (not unit-mocked)
The engine couples to the `registry` singleton (it must spawn real runs + react to terminals). Rather than refactor for DI/mocks, it's verified by **integration**: a full campaign driven through the real engine+DB+registry against mock-claude. The pure contract (PLAN_JSON_SCHEMA, plan→DAG) is unit-tested. **Serves:** correctness evidence without inventing a mock that wouldn't exercise the real wiring.

### M6 — Orchestration Mode built & verified (✓)
- **Mechanism:** `registry.onRunTerminal` hook lets the engine react to the orchestrator's structured (`--json-schema`) plan, then auto-spawn a worker run per task via `registry.launch` (reused as-is), respecting `dependsOn` + `maxParallel`, then an optional synthesizer. New tables: `agent_templates`, `campaigns`, `campaign_tasks`; `runs.campaign_id` added (with idempotent migration). 5 built-in templates seeded.
- **Verified live (mock):** a campaign decomposed into a **3-task DAG** (t1 Research + t2 Audit in parallel → t3 Implement after both → Synthesizer), auto-spawned 5 real campaign-tagged runs, respected dependencies, and rolled up cost to **$0.73**. UI screenshots `docs/campaign-dag.png` (orchestrator→waves→synthesizer) + `docs/templates.png`. 18/18 tests, all typechecks, `next build` clean (9 routes).
- **Design panel note:** a 4-agent judge-panel design workflow was launched, but the working implementation was finished and **empirically verified** while it ran (the stronger validation), so the panel was stopped before returning — its purpose (de-risk the design) was already met by the live end-to-end test.
- **mock-claude upgrade:** detects `--json-schema` → replays the plan fixture (orchestrator) vs a quick worker fixture (workers), so the whole campaign flow is testable for free.
- **F-8 fix (advisor catch, CRITICAL):** the original engine read the plan from `run.resultText` via `JSON.parse` — but a live `--json-schema` run proved the plan lands on `result.structured_output` (an object), with `result.result` being prose. Without the fix EVERY real campaign would have failed with 0 tasks while all mock tests stayed green. Fixed end-to-end (parser→tree→Run.structuredOutput→db column→engine reads `structuredOutput` first); the orchestrator-plan fixture was made faithful (object + prose) so the mock now exercises the real path; re-verified E2E (3-task DAG → completed, $0.73). This is the third instance of the "verify against real claude, not the mock" lesson (after `parent_tool_use_id` and the 3s-stall).

## 4.6 Feature research: "Auto-Learn" (self-improving orchestration)

User request (2026-06-08): *"the auto-learn — use the skills to start a workflow to search how it can be done."*

### D-022 — Research-first: run a multi-agent search workflow before designing Auto-Learn
Interpretation: an **Auto-Learn** loop where the portal (a) **researches *how* to do an objective** before orchestrating — using the available Skills/MCP primitives (`deep-research`, `context7` docs, web search, codebase grep, `graphify` knowledge-graph, `personal-rag` memory) — and (b) **learns from past runs/campaigns**, distilling successful patterns into reusable Skills/Templates. Honoring the explicit "start a workflow to search how it can be done", I launched a research Workflow (4 parallel research lenses + synthesis) that *uses the skills* (WebSearch/WebFetch for prior art, context7 for Claude Code/Agent-SDK skill mechanics, codebase reads) and returns a concrete buildable design. **Build follows the synthesis** (kept as a separate step so the user stays in the loop). **Serves:** the user's "auto-learn via skills + search" ask; grounds the design in real prior art + the actual codebase.

### D-023 — Fix the interactive hang + reconcile orphaned runs on boot (debugging, systematic)
Two distinct, verified changes from a live bug report ("run stuck pending, no raw, no response"):
1. **Root cause (F-9):** `buildArgs` no longer passes the prompt as the `-p` positional for interactive runs; `registry.startProcess` delivers it via stdin (`proc.writeUserMessage(prompt)`) after spawn. One-shot runs unchanged (positional + closed stdin). Regression-locked by a `buildArgs` argv unit test (the mock can't reproduce real stdin behavior). Verified end-to-end vs real claude: interactive run → `awaiting-input`, follow-up input works.
2. **Orphan reconciliation:** `repo.reconcileOrphans()` (called in the registry constructor on boot) marks any non-terminal run/campaign/task `failed`, since a fresh process owns no live handles — clears the permanent "starting" zombie a server restart (incl. `tsx watch` hot-reload) leaves behind (PRD §10). Confirmed: the user's stuck run flipped to `failed` after hot-reload.
**Serves:** §7.6 (send-input now actually works), §10 reliability.

### F-11 — One-shot runs failed (exit 1): variadic `--add-dir` swallowed the trailing prompt (regression from F-9)
**Symptom:** a run `failed` instantly (exitCode 1, ~1s, no session transcript). **Root cause:** the F-9 interactive fix moved the positional prompt to the END of argv via `args.push(req.prompt)` — placing it *after* `--add-dir <cwd>`. `--add-dir` is **variadic** (`<directories...>`), so commander consumed the prompt as another directory → claude got no prompt → `Error: Input must be provided… when using --print` → exit 1. F-9 was only verified with an *interactive* run (which has no positional), so the one-shot regression slipped through. Verified vs real claude: prompt-after-`--add-dir` → exit 1; prompt-first or prompt-after-`--` → exit 0. **Fix:** emit the positional with a `--` separator (`args.push('--', req.prompt)`) so no variadic option can swallow it (also makes prompts starting with `-` safe). Regression test updated to assert the `--` separator. Re-verified: one-shot run through the portal (cwd `/Users/jd`) now completes (exit 0). **Lesson:** when fixing one launch mode, re-verify the OTHER mode end-to-end.

### F-10 / D-025 — Control must survive server restarts (Stop/Delete "didn't work" — root-caused)
**Symptom:** a run page showed `awaiting-input`; Stop and Delete did nothing. **Root cause (multi-component, evidenced):** the dev server (`tsx watch`) had hot-reloaded repeatedly (triggered by my own code edits this session). On reload the in-memory `live` map is wiped, so: (a) `registry.stop` hit the `!lr` branch, couldn't reach the orphaned `claude` process (no persisted handle) and didn't broadcast → UI frozen; (b) the run-detail page's SSE subscriber was tied to the (now-gone) `LiveRun`, so it never received updates; (c) orphaned `claude` processes lingered. **Fixes (all verified):**
1. **Persist the OS pid** (`runs.pid` + migration); set on spawn. Stop's not-in-memory branch kills the process group by pid (`killProcessGroup`, verified to terminate a surviving detached group) and broadcasts the status change.
2. **Boot-time orphan kill:** `repo.nonTerminalPids()` → `killProcessGroup(pid, true)` in the registry constructor, then `reconcileOrphans()` marks rows `failed` (real PRD §10). Verified: a real surviving `claude` orphan + its DB row both resolved after restart.
3. **Decouple per-run SSE subscribers** into a registry-level `runSubs` map keyed by runId (no longer tied to `LiveRun`) → an open run page receives stop/updates even when the run isn't in the live map; the EventSource also re-subscribes + gets a fresh `hello` after a server reconnect.
4. Then Delete works (run is terminal). Verified end-to-end (mock + real claude restart): pid persisted, orphan killed, run `failed`, delete `200→404`.
**Process note:** my repeated file edits were hot-reloading the user's running server — the actual trigger. With reconcile-on-boot, a restart now cleanly fails in-flight runs instead of stranding zombies; but I should avoid editing while long runs are in flight.

### D-024 — Delete finished runs from history (user request)
Added `registry.deleteRun` (terminal-only guard → 409 on live runs) + `repo.deleteRun` (cascade: events/run_nodes/run_skills/runs) + `DELETE /api/agents/:id/record` (distinct from `DELETE /api/agents/:id` = stop). Fleet SSE gains `run-removed` so cards vanish live. UI delete affordances: hover ✕ on finished fleet cards + history rows, and a Delete button on the run-detail for terminal runs (with confirm). Verified live: completed run deletes (→404, fleet→0); live run rejected (409). **Serves:** §7.8 history hygiene.

## 5. Residual risks (verified vs not)
- **Verified against real claude:** stream-json schema + `parent_tool_use_id` linkage (F-1/F-7), CLI flags (F-4), one-shot spawn→stream→complete→cost-reconcile path, one real subagent fan-out.
- **Not yet verified against real claude (low risk):** a real *wide* Dynamic-Workflow fan-out through the live portal (mechanism proven on the single real subagent + synthetic fan-out); the headless permission control protocol (`decidePermission` + parser cases are best-effort — most fleet runs use a non-prompting permission mode); real Agent-Teams mailbox file format (watcher tolerates absence). None block local single-user use; all are documented here rather than assumed.

## 4. Open items / to revisit
- Real Dynamic-Workflow subtree event identifiers beyond `parent_tool_use_id` (need a live xhigh run that actually fans out to confirm subagent spawn/teardown markers) — parser written defensively around F-2.
- Agent-Teams mailbox file format (not observed in sampled dirs) — watcher tolerates absence.
- OpenTelemetry metrics panel (§10) — `CLAUDE_CODE_ENABLE_TELEMETRY=1` wiring deferred; cost/tokens sourced from `result`/`usage` events instead (sufficient for guardrails). (Now backlogged as **H6**, see §6.)

## 6. Post-audit hardening — Wave 1 / Lane A (2026-06-08)

A read-only discovery workflow (4 web-research lenses + 8 per-module code audits → synthesis) produced a 34-item backlog split into **additive (A1–A12)** vs **hardening (H1–H22)**. User chose "everything, in safe waves." **Wave 1 = the 7 proven critical correctness/security items.** Discipline: each fix is **failing-test-first**, then full suite + typecheck + `next build`; spawn/lifecycle items re-verified against a real child process. Result: **20 → 39 tests, all green; typecheck clean; build clean.**

### F-12 — CC 2.1.168 splits one assistant message into N `assistant` objects sharing `message.id`, each REPEATING the message-level usage
Discovered by audit, confirmed in-tree: `msg_01PByqSz29cDP9SuDDvz1185` appears **3×** in `fixtures/real-subagent.jsonl`. The parser's `attachUsage()` dedups only *within* one raw event, so `tree.addUsage` accrued cost/output 3× → the **live** estimate read by the budget guardrail over-counted (real fixture: $0.269 vs true $0.090, exactly 3×). Invisible to the suite because `result.total_cost_usd` overwrites the estimate at completion. Same "verify the live path, not just the mock" lesson as F-8/F-9/F-11.

| # | Sev | Fix | Files | Verified |
|---|-----|-----|-------|----------|
| **H1** | high | Dedup usage by `message.id` (parser carries `messageId`; `RunTree.costedMessageIds` skips repeats) so a split message is costed once → no premature budget auto-kill | parser.ts, tree.ts | failing-first unit test on the 3× split; reconciled to single cost. Fixture is REAL captured claude data (F-12). |
| **H2** | high | Campaign `kill()` now marks the campaign `killed` in the DB **before** any `registry.stop()`, so the synchronous `handleRunTerminal` guard short-circuits and can't schedule an orphan worker | campaigns.ts | invariant test: status is `killed` at first `stop()` |
| **H3** | high | DNS-rebinding lockdown: Host-header allowlist `onRequest` hook (load-bearing) + CORS scoped to the web origin + echo validated origin in hijacked SSE (replacing `*`) | server.ts, config.ts | inject: bad Host→403, foreign Origin not reflected |
| **H5** | high | `killReason` ('user'\|'budget') + captured child `error` (stderr/guardrail note) persisted on Run instead of discarded | registry.ts, shared, db.ts | unit (killReason) + real-child integration (stderr→error) |
| **H4** | high | Graceful shutdown: SIGINT/SIGTERM → `app.close()` → `registry.shutdown()` kills live child process groups → `repo.checkpoint()`+`close()` (WAL truncate) | index.ts, registry.ts, db.ts | integration: spawns a real mock child, `shutdown()` reaps it |
| **H9** | high | `validateConfig()` clamps/merges DEFAULT_CONFIG (rejects `maxConcurrentRuns<1`, non-positive/NaN budgets → 400); `/input` + `/permission` bodies validated before forwarding | config.ts, registry.ts, server.ts | inject: bad config/bodies → 400; partial merges defaults |
| **H21** | med | Path-traversal guards: `isSafeId` for team `:id` (rejects `..`/separators) + absolute-path `cwd` guard on `/skills`,`/subagents` | teamWatcher.ts, server.ts | inject: `..` id → 400, traversing cwd → 400 |

**New test files:** `campaigns.test.ts` (H2/H5/H4 — temp-DB harness via `FLEET_DATA_DIR`), `server.test.ts` (H3/H9/H21 — Fastify `inject`), `shutdown.test.ts` (H4 real child), `failure.test.ts` (H5 real failing child).

**H1 verified live against a FRESH real-claude capture (2.1.168, opus, $0.42 run):** the split pattern persists (`msg_016SKpQofckAKajtcixbfpzN` appears 3×). Fed through the live pipeline: authoritative=$0.4218, **deduped live max=$0.3569** (tracks toward the real cost), vs **naive no-dedup=$0.7299** (~1.7× over — would trip a tight `--max-budget-usd` early). Confirms the fix prevents premature budget kills on real data. (Verified via a throwaway test over `/tmp/h1-live.jsonl`; the committed `fixtures/real-subagent.jsonl` remains the durable regression.)

## 7. Wave 2 / Lane B — additive features (2026-06-08)

12 additive items. Built the 10 self-contained ones via a **build workflow** (one agent per feature, *new files only* — each a `registerXxxRoutes(app)` module owning its own tables via the shared `db` default-export handle, plus web pages/components), then the main loop did the thin wiring (route registration in server.ts, nav in Shell.tsx, mounting components into runs/[id] + history) and central verification. **A10** (error/not-found boundaries) was built in the main loop; **A12** (OTel tool-decision overlay) is deferred — it depends on **H6** (the OTLP receiver in Lane C).

| ID | Feature | Surface |
|----|---------|---------|
| A1 | Per-run **span waterfall** (TTFT + per-tool latency, derived from existing events) | Waterfall.tsx → runs/[id] |
| A2 | **Aggregate metrics dashboard** (cost/tokens/success/duration by model+effort, daily sparkline) | metrics.ts + /metrics |
| A3 | **Notifications** on terminal/threshold (feed + config + webhook), via `onRunTerminal` | notifier.ts + /notifications |
| A4 | **Scheduler** (interval / daily-at recurring runs → registry.launch) | scheduler.ts + /schedules |
| A5 | **MCP health panel** (`claude mcp list` shell-out) | mcp.ts + /mcp |
| A6 | **Run comparison** (side-by-side metric deltas) | /compare |
| A7 | **Run scoring/annotations** | scores.ts + ScorePanel |
| A8 | **Tags + saved searches** | tags.ts + TagBar + history |
| A9 | **Export** run JSON/MD + history CSV | exporter.ts + buttons |
| A10 | Route **error boundary** + 404 | error.tsx, not-found.tsx |
| A11 | **Flow-graph** view over the run tree (SVG edges) | FlowGraph.tsx → runs/[id] |

**Main-loop integration fixes** (caught in central verification, not by the agents): (a) exporter.ts compared an event type to the nonexistent `'tool_call'` → corrected to `'tool_use'`; (b) **A5 used `CLAUDE_BIN`, which is the MOCK replayer under `dev:mock`** → `claude mcp list` returned replayed stream-json parsed as bogus servers. Added `CLAUDE_REAL_BIN` (falls back to `claude` on PATH when CLAUDE_BIN is the mock) + raised the `mcp list` timeout to 30s (it health-checks every server). Re-verified: all 14 real MCP servers parse with correct statuses matching the live init dump.

**Verified:** 39/39 tests, all 3 typechecks clean, `next build` clean (**14 routes**, +5 pages). Live: every new endpoint returns real data (/metrics aggregates over 13 runs; /api/mcp lists 14 servers); write/validation paths smoke-pass (tag normalize, score, schedule 400/201, notification-test, saved-search); browser-confirmed /metrics + runs/[id] render all new components (tags, scoring, waterfall, flow-graph w/ SVG, export links) with no exceptions.

## 8. Wave 3 / Lane C — hardening & performance (in progress; sequential main-loop TDD, no parallel mutation of verified code)

**Batch C1 (mock-safe, high-value) — server items done:**

| # | Fix | Verified |
|---|-----|----------|
| **H7** | Authoritative run tokens summed from `result.modelUsage` (camelCase keys) instead of the orchestrator-only `result.usage` — multi-agent runs no longer undercount (real fixture: 92063 ctx / 559 out vs 64088 / 422). Falls back to `result.usage` when modelUsage absent (mock). | failing-first test vs the REAL captured fixture |
| **H15** | `synchronous=NORMAL` + `busy_timeout=5000` pragmas; **dropped the redundant `idx_events_run`** (the `(run_id,seq)` PK already covers it — was pure write amplification on the hottest insert path); migration loop now **re-throws** anything but "duplicate column". | pragma + index-absence test |
| **H20** | Pure `planHasCycle` (DFS back-edge, incl. self-dep) + `planHasDupIds` guards wired into `onOrchestratorDone` → a cyclic/duplicate LLM plan fails fast (logged reason) instead of wedging 'running' forever or silently dropping tasks. Refactored the fail path into `failCampaign`. | pure-helper unit tests (cycle/self-dep/DAG/dangling/dup) |

State: **42/42 tests, 3/3 typechecks clean.** H7 touches the parser result path but is verified against REAL captured data (modelUsage shape confirmed from `real-subagent.jsonl` + the H1 live capture).

**Batch C1 web — done:**
- **H8** — `useRunStream` now closes the EventSource + surfaces an `error` on a `{error}` envelope (unknown/deleted run) instead of reconnecting every ~3s forever; run page renders the error; LaunchModal meta-fetch gained a `.catch`; history already got error+retry in Wave 2.
- **H19** — `useRunStream` memoizes nodes/tree derivation (no more `buildTree` on every render + the 1s tick); `EventRow` wrapped in `React.memo`; Timeline auto-scroll is now **stick-to-bottom, container-only** (no viewport hijack when scrolled up); chokidar watcher gained an `'error'` listener (a watch error no longer crashes the control plane).

**Batch C2 spawn/lifecycle — done (core):**
- **H17** — stdout partial-line buffer capped at 32MB (drops a pathological newline-less line) — memory-exhaustion/DoS guard.
- **H13** — `killProcessGroup` now verifies via `ps -o args=` that a persisted pid is alive AND looks like one we spawned (`looksLikeClaudePid` matches `claude`/`mock-claude`/`--output-format`/`--session-id`) before SIGKILL — a reboot-recycled PID can't get an innocent process group killed. **Verified:** the shutdown integration test spawns a real child, asserts `looksLikeClaudePid(pid)===true` (and `false` for a dead pid), asserts **`repo.nonTerminalPids()` contains that pid** (the boot sweep WOULD discover it), then reaps it via `killProcessGroup`. Caveat closed: the by-pid reap of a real child + the boot-sweep discovery query are both exercised; only a literal server-restart-while-orphan-survives wasn't simulated (the constructor singleton can't be re-instantiated in-process), but every constituent step is tested.
- **H12** — `registry.handleLine` early-returns once `lr.killed` — no more wasted DB writes / SSE noise during the post-kill SIGTERM→SIGKILL window.

**Batch C3 — done (features):**
- **H11** — Session panel (`SessionPanel.tsx`) surfaces the init payload (model / permissionMode / fast-mode / output-style / version / MCP servers / plugins / counts) — what a run ACTUALLY got. Pure UI: the full init object already flows on the init event's `payload.raw`; slash-commands/output-style are shown read-only (not headless launch levers). Browser-confirmed.
- **H10** — launch-surface flags (all confirmed in `claude --help` 2.1.168): `-w/--worktree <name>` (isolated git worktree → safe parallel writes), `--disallowedTools` (tool deny-list, **variadic**), `--agents <json>` (inline ephemeral subagents). Added to `LaunchRequest` + `buildArgs` + LaunchModal (worktree + deny-list inputs). F-11 hazard regression-locked by a `buildArgs` argv test (prompt stays last after `--`). **Real-claude verified ($0.019 haiku run):** `claude … --worktree h10test --add-dir <repo> -- "<prompt>"` exited 0 with the correct result AND created `<repo>/.claude/worktrees/h10test` on branch `worktree-h10test` (confirmed via `git worktree list`) — the prompt was NOT swallowed by the variadic flags.

**Batch C2/C3 — the remaining 5 + A12 (completed in a follow-up pass — "fix all the points"):**
- **H22** — parser surfaces `system/api_retry` (a retrying run no longer looks frozen) + detects the `SendUserMessage` tool (`--brief`) as an `agent_message` event; `--brief` added to buildArgs + a LaunchModal toggle; new `api_retry`/`agent_message` NormalizedEventTypes + Timeline glyphs. Unit-tested.
- **H14** — corrected control-protocol response shape via `buildPermissionControlResponse` (`subtype:'success'` wrapper, inner `behavior: allow|deny` — NOT `decision`); no more optimistic state-clear (awaitingPermission clears in handleLine only when the child advances). **`--permission-prompt-tool` correctly OMITTED** — verified it does NOT exist in `claude --help` 2.1.168 (the audit assumed wrong; adding it would've been an invalid-flag bug). Shipped best-effort (path largely dormant under headless `-p`). Wire-shape unit-tested.
- **H16** — `repo.batchPersist` coalesces changed nodes + events + the run row into ONE outer transaction (nested per-method txns become savepoints → one fsync vs per-line). registry buffers + flushes on a 75ms timer / on terminal / **before any snapshot read** (snapshot reads events from the DB even for live runs). Guardrail unaffected (in-memory). Integration-tested (a completed mock run's events are durable) + the runaway guardrail test still trips.
- **H18** — SSE connection cap (`MAX_SSE`, default 64 → 503); `id:<seq>` frames (Last-Event-ID groundwork); `getEventsTail` truncation marker (`tailTruncatedBefore`) surfaced through the hello → `RunLiveState.truncatedBefore` → a "earlier events omitted" note on the run page for >5000-event runs. Unit-tested.
- **H6 — DONE + REAL-CLAUDE VERIFIED.** Local OTLP/HTTP-**JSON** receiver (`otel.ts`: `/v1/metrics` + `/v1/logs` on the existing Fastify server — no protobuf dep, no second server); on spawn the run's OTLP exporter is pointed at the control plane (`OTEL_EXPORTER_OTLP_*` env in `processManager.otelEnv`, `http/json`, NEVER the console exporter), replacing the inert hardcoded flag. Accumulates delta-temporality cost/token by `session.id` + `query_source` + model, plus `tool_decision` from logs. **Verified live (both ends AND the middle):** (1) a real haiku run POSTed 9 OTLP payloads to our endpoints; (2) feeding the real `/v1/metrics` bodies through `ingestMetrics` extracted cost $0.0205 + tokens {in 10, out 481, cacheRead 17959, cacheCreation 13043} split by source/model; (3) the full Fastify round-trip (Host-allowlist hook → JSON body-parse → `/v1/metrics` route → ingest → `GET /api/agents/:id/otel`) confirmed: POST→200, retrieve→costUsd 0.07 / bySource [main,subagent] on the synthetic payload. Default-on (disable via `FLEET_OTEL=0`).
- **A12 — DONE.** `OtelOverlay.tsx` on the run page reads `/api/agents/:id/otel` → per-source/per-model cost+tokens, lines +/−, and tool-decision chips (accept ✓ / reject ✕); polls while live; renders nothing when no telemetry received (additive).

### Final state — entire improvement program complete
**51 server tests (was 20), 3/3 typechecks clean, `next build` clean (14 routes).** Lane A (7) + Lane B (11) + Lane C (15) + A12 all delivered & verified. New test files: campaigns/server/shutdown/failure/batch/otel.test.ts. Real-claude verifications performed this program: H1 (cost split, $0.42), H10 (worktree created, $0.019), H5 (failing-child stderr), H6 (live OTLP ingest, ~$0.02). Caveats H13 (boot-sweep discovery + identity guard) and H10 (worktree) both closed. **Operational note:** OTel telemetry is now default-on for spawned runs; `pnpm build` and `next dev` share `apps/web/.next` → stop dev before building.

## 9. Agent-PM / Kanban feature (2026-06-09) — spec docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md

Brainstormed → researched (5-lens workflow, 47 findings) → spec (approved) → built via a 2-phase
build workflow (8 agents) → integrated + verified in the main loop. Five subsystems, all reusing the
existing run/campaign/worktree/db machinery; campaigns.ts/registry.ts NOT rewritten.

**Decisions:** merge gate configurable, default human-approve (per-project `auto_merge` toggle for
full-auto — checks always run); per-task git worktree+branch → local `merge --no-ff`; read-only viewer,
**zero new deps** (hand-rolled markdown/diff); PM commits as `fleet-pm`; human request-changes consumes
a `max_attempts` slot; validation = pure checks (no ports) in v1; campaign-per-card deferred. §11 of the
spec lists 10 explicit out-of-scope items.

**Modules (Lane-B pattern — own tables via the `db` handle + `registerXxxRoutes`):** `projects.ts`
(project = git-repo root, scopes everything), `kanban.ts` (`kanban_tasks` + board SSE + CRUD/reorder +
Review actions), `pm.ts` (`PmEngine`: select Ready → build in worktree via `registry.launch` → validate
(execFile, exit-code oracle) → gate → `merge --no-ff` under a per-project mutex → Done; rework w/
max-attempts + no-progress diff-hash; per-project spend ceiling + pause; H2 cancel; boot reconcile),
`git.ts` (one execFile-git wrapper + merge automation + realpath path-guard), `fileview.ts` (read-only
tree/file/status/diff/log/show). `runs`/`campaigns` gained a `project_id` (idempotent ALTER, threaded
through the run model). Web: `/projects`, `/projects/[id]`, `.../board`, `.../files`, `.../history` +
KanbanBoard/Card, FileTree/Viewer/DiffView/GitLog (all hand-rolled, zero deps) + Projects nav.

**Two bugs found by the LIVE real-claude E2E (the mock can't create git worktrees, so this path
*requires* real claude — exactly the F-8/F-9/F-11 lesson):**
1. **Default-branch assumption.** Project create hardcoded `main`; a repo on `master` (older `git init`)
   → merge against a non-existent base → false "conflict". Fixed: `detectDefaultBranch` via
   `git symbolic-ref --short HEAD` on create.
2. **Precheck left main worktree dirty.** `ensureWorktreeIgnored` appended `.claude/worktrees/` to
   `.gitignore` but didn't commit it → dirty main worktree → `mergeBranch` (correctly) refused. Fixed:
   commit just `.gitignore` (pathspec-scoped, as fleet-pm) in the precheck.

**Verified:** typecheck clean (3 pkgs), `next build` clean (**15 routes**), 51/51 server tests.
W0/W1/W4 via curl on a real repo (project git-validation 400/200, kanban CRUD, file tree/log/status,
**traversal guard 400**). **W2/W3 full real-claude E2E ($0.23):** a Ready card → PM autonomously built
`hello.txt` in an isolated worktree → ensure-committed (fleet-pm) → validated → integrate-base →
`merge --no-ff` into `master` → `Done` with `merge_sha`, worktree+branch cleaned up, `hello.txt` on
master — `git log` shows the full fleet-pm-authored chain. Board UI browser-confirmed (columns, cards,
Review Approve/Request-changes, SSE). The dev-only Fast-Refresh "Should have a queue" exceptions are an
HMR artifact on the run-detail route (absent in the production build), not a feature bug.

**Follow-up fix + clean re-verification (the two bug-fixes above were originally confirmed with the OLD
server + manual git steps; an adversarial review caught that they had never actually run on the fixed
code path).** Root cause: `ensureWorktreeIgnored` was fire-and-forget (`void …`) *before* `registry.launch`,
so the `.gitignore` commit raced claude's `git worktree add` on the same index (`index.lock`) and could
land after `mergeBranch`'s clean-check. Fix: `launchBuild` is now `async` and `await`s
`ensureWorktreeIgnored` (inside the try, so a git failure parks the card instead of rejecting `tick()`)
*before* spawning claude; the `tick()` caller `await`s `launchBuild`. **Side-fix the `await` also
repaired:** `launchBuild` returning a `Promise` made `launched === 'ok'`/`=== 'capped'` always-false
(TS2367) — the WIP-cap increment and the 429-`break` in `tick()` were dead code; the `await` restored both.
**Discriminating re-verification ($0.19, zero manual steps):** booted the server on the *new* code with
real claude + a clean `FLEET_DATA_DIR`, created a project on a fresh `master` repo with `auto_merge:true`
(no `defaultBranch` → `detectDefaultBranch` returned `master`, fix #1 live), dropped one `Ready` card →
PM drove it to `Done` autonomously. The resulting commit DAG is *structural* proof the ordering held: the
work commit is rooted at the gitignore commit (`2bf0e7a`), not the initial commit — so the worktree branch
was created *after* the gitignore commit, i.e. the race is gone by construction. Run record: `completed`,
`claude-opus-4-8`, `$0.19` (a mock is exactly `$0`), `bypassPermissions`. Worktree+branch cleaned, main
worktree clean. Human-approve path is transitively covered (same `doMerge` via `approve()`). `worktree`/
`disallowedTools` read `null` in the run API by design — they are launch-only spawn args (processManager
H10), not persisted runs-table columns.

## 10. v2 program — completing the v1 "out-of-scope" items (2026-06-09)

Spec: `docs/superpowers/specs/2026-06-09-v2-out-of-scope-design.md` (9-designer + integration design
workflow). User decisions: **skip §11.8 auth** (stay localhost); **§11.2 full remote git, PM may push**;
**§11.6 add Shiki + react-markdown**; **§11.1 full file CRUD** (create/update/delete); paid E2Es
**deferred → deterministic-first** (confirm each throwaway-repo run at fire time). Built **spec-first, in
3 contention-driven waves, per-item green-gate + commit**. Cross-cutting rules (binding): per-module ALTER
loops (NOT db.ts — it runs before projects/kanban CREATE → fresh-DB boot crash); `validation.ts`
extraction; `validateAndGate` shared sink; `disallowedToolsForProject` single deny-list source (push
relaxes only for single build/fix); credential scrub on git/gh stderr; `+resolving` phase.

**Wave 1 — DONE (independent items, serial build, all committed):**
- **#3 plan-board** (`planboard.ts`, `plan_drafts` table, PlanModal): objective → Campaigns planner DAG →
  preview → cards with mapped `depends_on`. Partitioned onRunTerminal (campaignId:null planning run
  claimed by neither engine — tested). **mock-claude genuinely drives the planner** (yes-fixture; first
  server test to exercise the real spawn→parse→terminal path).
- **#6 rich rendering** (shiki ^4.2 + react-markdown ^10.1 + remark-gfm ^4): `lib/shiki.ts` singleton
  highlighter, `ShikiCode`/`MarkdownView`; replaced the hand-rolled renderers; lazy/SSR-safe (Shiki only
  in useEffect, code-split → files route 48.5kB vs 91.8kB shared); sanitization kept (skipHtml,
  urlTransform, inert `img` placeholder — no remote-image auto-fetch).
- **#10 git-init on attach** (`git.ts initRepo`): non-git dir + `initGit` → `git init` + `.gitignore` +
  `git add -A` (stages EXISTING files so a non-empty attach yields a clean tree — a reviewer-caught
  blocker; staging only `.gitignore` left source untracked → empty PM worktree + perpetual dirty main).
  Backward-compatible (no initGit → still 400 with `code:'not_a_git_repo'`).

**Wave 2 — DONE (foundation + 3 items):**
- **Foundation** (`eabf9e7`): all `projects`(+15)/`kanban_tasks`(+8)/`campaigns`(+2) migrations in per-module
  ALTER loops (NOT db.ts — §3.1), `validation.ts` extraction (§3.2), `validateAndGate`/`withProjectLock`/
  `disallowedToolsForProject` pm hooks, `scrubCredentials`, `+resolving` phase. Behavior-preserving.
- **4 scaffold modules** (`8da3013`): fileedit/gh/portbroker/fleet authored in PARALLEL (disjoint new
  files, unit-tested); two reviewer-caught majors fixed (fileedit CREATE-rollback unlink; fleet
  no-starve trim).
- **#5 port-broker** (`88ab089`): `validateCard` selector routes both validate sites (validateAndGate +
  doMerge re-validate) through brokerValidate when a server-start command is set, else pure runValidation.
- **#2 full remote git** (`d30c565`): doMerge PR-mode (fetch/FF-sync→push→gh pr create→park Review w/
  pr_state; never auto-merges PR, never force-pushes); `disallowedToolsForProject` relaxes push ONLY for
  single build/fix when pushEnabled; refreshPr; git/health route; re-approve guard; credential scrub.
- **#1 file CRUD** (`529cf54`): fileedit routes registered, `pm.withProjectLock` alias; FileViewer edit
  mode (create/update/delete, baseOid 409 guard) gated by `editingEnabled`.

**Wave 3 — DONE (serial pm.ts chain):**
- **#4 campaign-per-card** (`135b2db`): a `mode:'campaign'` card runs a campaign sub-DAG; gate fires on
  campaign completion via `onCampaignTerminal`→`validateAndGate`; workers get the UNRELAXED deny-list
  (discriminating security test); single-mode unchanged, no double-gate, engine reused. cancel kills the campaign.
- **#9 conflict-resolution agent** (`47757df`): opt-in resolve run on a merge conflict → ALWAYS re-validate
  → merge/abort; reconcile sweeps a mid-resolve worktree. Reviewer-caught correctness FIX: the ship step
  re-integrates the CURRENT base + re-validates INSIDE the mutex (a disjoint advance during the lock-
  released resolve run can't ship an unvalidated tree) — discriminating stale-base test added.
- **#7 fleet scheduler** (`5ef98b0`): `tryAdmit` admission gate in launchBuild (fair-share by priority,
  reserve slots, daily ceiling, no preemption) + `/fleet` page. Mutation-verified wiring test.

**Post-review — fleet-reserve deadlock hardening** (advisor-flagged H9 class; honest scope below):
when `reserveSlotsForNonPm >= maxConcurrentRuns` the PM pool is 0, so EVERY card stalls in Ready with no
surfaced error. Three changes, NOT a full "fix" — the deadlock is reachable from two paths and only one is
sealed:
- **Guard (`bbede02`):** `validateFleetConfig` reads `registry.config` and REJECTS `reserve >= cap` at
  `/fleet` PUT time. `tryAdmit` keeps its `max(0,…)` floor so a config written straight via `fleetRepo.set`
  (bypassing validation) degrades to "admit nothing", not a negative pool. Tests: `==`/`>` cap reject,
  `cap-1` accept. NOTE the guard only fires when `cap ≤ 100` (reserve is independently clamped ≤ 100; the
  live dev config carries a STALE hand-set `maxConcurrentRuns: 300` that predates config.ts's `max:100`
  clamp — would be re-clamped on any fresh PUT — so the guard is unreachable under the live cap and was
  exercised only in unit tests at `cap=4`).
- **Residual path NOT sealed:** lowering the GLOBAL `maxConcurrentRuns` (via `/api/config`) at/below an
  existing reserve still drives pool→0; that path never touches fleet config, so the PUT guard can't catch
  it. A symmetric guard in `validateConfig` was rejected (risk of a config↔registry↔fleet circular import).
- **Loud, not silent (`<default-flip commit>`):** `fleetStatus.deadlocked` = `pool 0 && ≥1 demanding
  project`; `/fleet` renders a red banner. `tryAdmit` still returns false, so on BOTH paths the H9 harm is
  now LOUD instead of silent. Tests: deadlocked true (pool 0 + demand) / false (pool 0, no demand) / false
  (healthy pool).
- **Default reserve 2 → 0:** the reserve is a soft hold-back for opt-in campaign workers; a non-zero
  default silently taxed single-project throughput (8→6) and widened the deadlock surface. Default 0 = full
  PM pool; campaign users raise it. (fleetRepo default tests read `DEFAULT_FLEET_CONFIG` dynamically.)

Curl-smoked live against `dev:mock`: fleet config GET/PUT (+reject), fleet status (full `FleetStatus` incl.
`deadlocked`), `git/health` (`GitHealth` shape), files tree, `files/edit` (`editable` gated by
`editingEnabled`), plans, git/status — all contracts green (web redeclares `FleetStatus`/`GitHealth`
locally, so these aren't typecheck-covered).

**Verified:** **313 server tests** (21 files), `pnpm -r typecheck` clean (3 pkgs). `next build` last clean
at **16 routes**; the small additive `/fleet` banner (one type field + one conditional element, no new
imports/routes) is typecheck-clean but `next build` was NOT re-run (would tear down the live dev server).
Merged to local **main** (no remote; nothing pushed).

**Real-claude E2Es — ALL THREE deferred items now PASSED (2026-06-09, user-authorized, $1.73 real Opus,
on an ISOLATED server: `CLAUDE_BIN=claude FLEET_DATA_DIR=/tmp/fleet-e2e-data FLEET_SERVER_PORT=4329`,
non-watch `tsx`, live dev:mock untouched):**
- **#2 PR-open ($0.19):** throwaway PRIVATE repo `yeljayad/fleet-pm-e2e-throwaway` (free push/PR auth
  pre-flight FIRST, then paid build). defaultBranch `main` (matched the repo's real default — dodged the
  v1 main-vs-master bug). Result: `hello.txt` built → branch pushed → base FF-synced → **PR #2 OPEN** →
  card parked Review WITH pr_url. All 4 pass conditions met.
- **#4 campaign-per-card ($1.04):** card `mode:'campaign'` → delegated to a campaign (campaignId set, NOT
  a single run) → 3 worker runs all terminal → card gated on the CAMPAIGN terminal → local `--no-ff`
  merge → **Done** (`alpha.txt`/`beta.txt` on main, mergeSha set). COST FINDING: per-project
  `budgetCeilingUsd` is ADMISSION-ONLY — it does NOT preempt an in-flight campaign (spent $1.04 > the
  $0.75 ceiling); the tiny objective was the real bound. (By design — admission-only, no preemption.)
- **#9 conflict resolution ($0.50 = $0.27 build + $0.23 resolve):** `resolveConflicts:true`,
  `autoMerge:false` so the card parked in Review for a GUARANTEED conflict injection (advisor's adaptive
  method: read the branch's actual committed file, THEN write a conflicting change to those exact lines on
  main; `merge-tree` pre-confirmed the conflict). Approve → ship → integrate hit the conflict →
  `executionPhase:'resolving'` (resolve agent ran) → re-integrate → **clean union merge, ZERO conflict
  markers** → **Done** (mergeSha `7f24dc1`).

**IMPORTANT verification caveat:** all three E2Es ran with `defaultValidationCommand: null`, so every
validate / re-validate gate was a PASS-THROUGH (no-op). These E2Es prove the real-claude **mechanisms** —
build→push→PR (#2), campaign delegation→gate→merge (#4), conflict→resolve-agent→re-integrate→merge (#9).
They do NOT exercise validation-with-teeth. Specifically #9 exercised the re-INTEGRATE-inside-mutex half
(the stale-base fix) but NOT the re-VALIDATE half; gating-with-teeth (incl. the #9 re-validation-fails→park
path) stays covered by the DETERMINISTIC suite (`pm #9 re-validation-fails → parks Review/failed`), not by
these runs.

On branch `feat/agent-pm-kanban` (merged into local **main**), **20 commits**, NOT pushed (no remote).

**Post-E2E follow-ups (2026-06-09, on main) — the three §10 caveats that were actually actionable:**
- **Residual deadlock path SEALED (`d029ea2`).** `PUT /api/config` now cross-checks the post-clamp
  cap against the live fleet reserve via `fleet.assertCapAboveReserve` before applying — the check
  sits at the ROUTE layer (server.ts imports both sides already), so config.ts still never imports
  fleet state and the rejected circular-import design stays rejected. TDD: 3 route tests (reject
  `==`, reject `<`, accept `>`; a rejected PUT provably leaves config unchanged). Live-smoked on
  dev:mock: reserve→4, `PUT {maxConcurrentRuns:4}` → 400 naming `reserveSlotsForNonPm` + remedy,
  live config untouched (still the stale 300 — deliberately NOT re-PUT, which would re-clamp it),
  reserve restored→0. Remaining exposure is code-level only (direct `repo.setConfig`/`fleetRepo.set`
  writes, no HTTP path; boot also loads the stored config unvalidated — pre-existing H9 scope) —
  both still surfaced loud by `fleetStatus.deadlocked`.
- **`FleetStatus`/`FleetProjectStatus`/`GitHealth` moved to `@fleet/shared` (`98866a9`).** The web
  imported hand-mirrored copies (lib/api.ts, projects page) — the §10 "not typecheck-covered"
  caveat. Now: one declaration in shared; fleet.ts imports it; projects.ts binds the git/health
  response to `GitHealth`; web re-exports from lib/api.ts. Contract drift now fails `tsc` in all
  3 packages.
- **`next build` re-run CLEAN — 16/16 routes** (the `/fleet` banner + both changes above included),
  closing the "build not re-run" caveat. dev:mock stopped for the build (shared `.next`), restarted
  detached after, both ports verified healthy.

State: **316 server tests** (21 files, +3 guard tests), `pnpm -r typecheck` clean, `next build` clean.
Not actioned (unchanged scope): validation-with-teeth real-claude E2E (deterministic suite covers
gating; paid run only on request) and the throwaway repo `yeljayad/fleet-pm-e2e-throwaway` (deletion
offered, awaiting user say-so).

## 11. Production-readiness pass — full E2E + 20-bug fix batch (2026-06-10)

**Trigger:** user-reported "git functions sometimes not working" and "delete doesn't work"; asked for
end-to-end production-readiness testing. Method: live API e2e (curl, isolated `FLEET_DATA_DIR`) + full
Playwright UI walk + a 53-agent ultracode bug-hunt workflow (6 finders → adversarial verification;
29 confirmed findings, 4 refuted as already-fixed-on-disk).

**ROOT CAUSE of "delete doesn't work" (critical):** the web's `j()`/`mutate()` helpers set
`content-type: application/json` on EVERY request; Fastify rejects an EMPTY body with that header
(`FST_ERR_CTP_EMPTY_JSON_BODY` → 400) BEFORE the route runs. Every body-less DELETE in the UI failed:
kill run, delete run record, delete project, delete card, delete template, kill campaign. curl/inject
never sends the header, which is why 316 tests + API e2e all passed while every UI delete 400'd.
Fixed BOTH sides: server.ts empty-body-tolerant JSON parser (delegates non-empty to
`getDefaultJsonParser('error','error')` — proto-poisoning protection intact, pinned by test) + all
three client helpers now send the header only when a body exists. 4 regression tests.

**Second critical:** deleted-run resurrection — `stop()` flips a run terminal instantly but the
detached child dies up to ~3s later; deleting the record in that window let the late `onExit` re-INSERT
the deleted rows + re-broadcast the ghost run + double-fire `notifyTerminal`. Fixed: `lr.deleted` flag +
`live.get(id) !== lr` identity check at the top of `onExit` (also seals the stop→resume overwrite variant).

**Fix batch (all verifier-confirmed; 332 server tests, was 316):**
- git: `mergeBranch(root, branch, expectedBase)` refuses when the root has the wrong branch / detached
  HEAD checked out (was: merged into WHATEVER was checked out); `commit.gpgsign=false` + `--no-verify`
  on ensureCommitted/integrate/resolve/merge/initRepo (a signing setup or failing hook broke every
  engine commit — fixtures had masked it); unborn-HEAD → empty tree/log instead of raw git fatals;
  `--` rev/path disambiguators in gitLog/gitShow; untracked-DIRECTORY diff returns an explanatory
  error instead of an empty "No changes".
- view-diff (board): UI sends the WORKTREE name (`task-<id>`) but the branch is `worktree-task-<id>` —
  the per-card diff ALWAYS failed. Fixed server-side in the git/diff route: resolve branch param
  against [branch, worktree-<branch>, refs/fleet-backup/…] so the convention stays in one place.
- fileedit delete: `git rm -f` (plain rm refused any file with uncommitted modifications — i.e. exactly
  the files agents just edited); untracked files are unlinked with NO phantom commit.
- projects: DELETE 404s on unknown id and CASCADES via new `onProjectDeleted` listener registry
  (pm cancels+deletes every card → stops runs/campaigns + tears down worktrees; planboard stops live
  planners + drops drafts; campaigns kills live project-scoped campaigns) — the UI confirm's promise
  is now true; defaultBranch must EXIST on create/PUT (web form now blank→auto-detect, killing the
  'main'-prefill-on-master-repo phantom-base class).
- kanban/pm: column-move liveness guard (raw move of a card with a live run 409s; → Canceled routes
  through pm.cancel); approve/request-changes 409 while resolving/merging (stale client could clobber
  a live resolve and merge conflict markers); prState='closed' no longer wedges the card (approve
  re-opens a fresh PR; request-changes clears prState/prUrl; UI gate buttons follow).
- campaigns: synthesizer launch wrapped (429→retry by tick, else failCampaign — was a permanent
  'running' wedge after all tasks terminal); tickActive guards per-campaign.
- registry: resume() validates cwd exists (400 instead of silent insta-fail); permission decide on a
  one-shot run → honest 409 (stdin closed at spawn; write was silently dropped, child waited forever);
  stop() on a not-in-memory run only signals the persisted pid while the record is LIVE (recycled-pid
  could kill an unrelated fleet run).
- gh/pm: prView discriminates genuine no-PR (`no pull requests found`) from auth/network/missing-gh
  errors; refreshPr persists the error to lastError instead of silently pretending "no PR".
- templates: create/PUT whitelist+validate (blind `{...existing, ...body}` persisted e.g. a string
  allowedTools that later crashed registry.launch mid-campaign); DELETE 404s unknown + 409s builtins.
- exporter: history CSV uses new uncapped `repo.listRunsForExport` (was silently truncated to the UI's
  500-row LIMIT).
- web polish: app/icon.svg (favicon 404 on every page); delete/kill error surfacing on RunCard ✕,
  template delete, Kill Campaign (404 = benign refresh; everything else now visible); card budget
  relabelled "per-run budget" (engine semantics are per-run by design — spec §10; label promised
  per-card).

**Verified:** 332 server tests (21 files), `pnpm -r typecheck` clean, `next build` clean (17 routes incl.
icon), live re-e2e on dev:mock: view-diff-by-worktree-name returns the diff, unborn-HEAD files/log return
empty (no fatals), phantom defaultBranch 400s, untracked-dir diff explains itself, all UI deletes work
(project/card/run/template verified in-browser via Playwright), zero console errors on the home page.
NOT exercised live: deleted-run resurrection race (mock exits instantly on SIGTERM — guard is
code-level + identity-checked), real-gh PR-closed re-approve (deterministic tests only).

## 12. Agent-template library v2 — skills made real + 12-profile library + detail page (2026-06-10)

**User ask:** improve the built-in templates, grow the agent library, make templates carry skills +
working instructions, and add a template detail/edit page.

- **Skills were write-only metadata (root-cause fix).** `LaunchRequest.skills` was persisted on the
  run row but NEVER reached the spawned process (claude has no --skills flag). buildArgs now merges a
  SKILLS instruction block ("invoke each matching one with the Skill tool BEFORE starting…") into
  `--append-system-prompt`, composing AFTER any template systemPrompt in a single merged flag (F-11
  prompt-last invariant pinned). 3 new buildArgs tests.
- **Built-in library rebuilt: 12 profiles** (templates.ts). The 5 originals (Orchestrator / Researcher /
  Implementer / Reviewer / Synthesizer) upgraded + 7 specialists added: Debugger, Test Writer,
  Security Auditor, Refactorer, Docs Writer, Frontend Builder, Perf Optimizer. Every prompt follows one
  contract: identity + guardrails → numbered WORKING METHOD → shared SKILL_RULE (honor the appended
  SKILLS block) → shared REPORT_RULE output contract (worker results feed the Synthesizer/human gate).
  Reviewer's role corrected 'worker'→'reviewer' (name-keyed lookups unaffected; worker fallback pool
  still non-empty). Orchestrator now assigns across the full library by name.
- **Seeding auto-upgrade:** `seedTemplates` upgrades a built-in row ONLY if its systemPrompt is
  byte-equal to a LEGACY_SEED_PROMPTS entry (untouched v1 seed) — user-edited built-ins are never
  clobbered; ids/createdAt preserved. Idempotent. New names insert as before.
- **Detail page `/templates/[id]`** (+ `GET /api/templates/:id`, `api.template/updateTemplate`):
  full system-prompt editor, skills picker fed by the live `~/.claude/skills` catalog (`/api/skills`)
  + add-by-name for uncataloged skills, role/model/effort/permission/tools/budget editors, Save via
  the (validated) PUT, Delete for non-builtins; built-ins editable with name/isBuiltin immutable.
  List cards link through ("open →") and show attached skills.

**Verified:** 344 server tests (+12: 9 templates.test.ts seeding/round-trip incl. clobber-protection,
3 buildArgs skills), `pnpm -r typecheck` clean, `next build` clean (18 routes, /templates/[id] added),
live smoke: 12 builtins seeded on the running dev:mock (5 auto-upgraded in place), detail page edit →
✓ saved → persisted (`skills:['graphify']` on Debugger), launch with skills carries them onto the run,
zero console errors.

## 13. Skill catalog: full Claude-setup collection + full model lineup (2026-06-10)

- **Skills now collected from the WHOLE Claude setup (user ask: "collect all skills").** catalog.ts
  previously scanned only `~/.claude/skills` + project `.claude/skills` (2 hits on this machine).
  Added `scanPluginSkills()`: reads `~/.claude/plugins/installed_plugins.json` (v2 manifest —
  source of truth for the CURRENT install path; blind cache-globbing would surface stale versions),
  scans each enabled plugin's `<installPath>/skills/<dir>/SKILL.md` AND `commands/*.md`
  (slash-commands are Skill-invocable), emits fully-qualified `<plugin>:<segment>` names (the
  Skill-tool invoke form; segment = dir name / file stem, not drifting frontmatter), respects
  settings.json `enabledPlugins:false` (e.g. ralph-loop excluded), de-dupes multi-version installs
  newest-lastUpdated-first, fully defensive (missing/corrupt manifest → []). listSkills also picks
  up `~/.claude/commands` + project `.claude/commands`. Live: **2 → 34 skills** (32 plugin: all of
  superpowers, commit-commands, code-review, feature-dev, hookify, eq-session…), each with
  frontmatter description + scope badge in the LaunchModal and template-detail pickers.
  6 hermetic tests (test/catalog.test.ts — fake manifest/installs).
- **Model catalog: full current + legacy lineup (user ask: "add all possible claude llm models like
  fable5").** @fleet/shared MODELS 3 → 9 entries, pricing per the claude-api reference (2026-06):
  **Fable 5 `claude-fable-5` $10/$50 · 1M ctx · 128K out** (new top tier, no fast mode), Opus
  4.8/4.7/4.6 $5/$25 (fast 2× capable per CC), Sonnet 4.6 $3/$15 · 1M, Haiku 4.5 $1/$5 · 200K,
  legacy-active Opus 4.5 / Opus 4.1 ($15/$75) / Sonnet 4.5 pinnable. Launch default UNCHANGED
  (route hardcodes `body.model || 'claude-opus-4-8'`); `modelRates` unknown-id fallback re-pinned
  to the opus entry by ID (was `MODELS[0]` — would have priced unknowns at Fable's 2×). Catalog
  test added (server.test.ts).

**Verified:** 351 server tests (+7), 3/3 typecheck, `next build` clean, live `/api/models` lists all
9 with pricing, `/api/skills` returns 34, template-detail dropdown + skill picker render the full
catalogs in-browser.

## 14. Launch on a /command — full slash-command surface for agents (2026-06-10)

**User ask:** let a launched agent start on any available slash-command, including plugin /commands.

- **SkillInfo.kind** (`'skill' | 'command'`, shared) — the catalog now discriminates SKILL.md skills
  from `commands/*.md` slash-commands; scope union gains `'builtin'`.
- **Built-in claude commands**: the binary embeds its bundled skills and extracts them only
  per-invocation (no stable on-disk enumeration), so the 8 stable task-shaped built-ins ship as a
  static catalog entry set (`init`, `review`, `code-review`, `security-review`, `simplify`,
  `verify`, `run`, `deep-research`; scope `builtin`, path `claude-builtin:/<name>`). Unknown-to-CLI
  names fail loud in run output — best-effort by design.
- **LaunchModal "run a /command" picker**: optional select, grouped — built-in (claude) /
  commands (plugins·user·project) / skills (also /-invocable) — ALL 42 entries on this machine.
  Picking one re-labels the prompt to "arguments for /<cmd>", shows a "will run: /<cmd> <args>"
  preview, and submits `prompt = "/<cmd> <args>"` (headless claude executes slash-commands passed
  as -p prompt). Free-form prompt unchanged when no command picked.
- **Dup-path bug fixed (React dup-key warning in launch modal)**: a cwd of $HOME made the
  'project' catalog scan resolve to the SAME ~/.claude dirs as the 'user' scan → every user skill
  listed twice. listSkills/listSubagents now de-dupe by path; catalog test pins unique paths.

**Verified:** 352 server tests (23 files; +catalog kind/builtin/unique-path pins), 3/3 typecheck,
`next build` clean, live: /api/skills = 42 (8 builtin·command, 12 plugin·command, 20 plugin·skill,
2 user·skill), picker renders all 42 grouped, /code-review selection composes the preview correctly,
dup-key console warning gone.

**§14 addendum (same day):** a /command launch no longer double-injects the command as a skill —
claude auto-loads the command's own instructions when the prompt starts with `/<name>`, so
buildArgs filters the prompt-head command out of the SKILLS note (server-side guarantee, all
callers) and the LaunchModal filters it from the submitted skills array. 2 pinning tests
(354 total). Other attached skills still inject normally alongside a /command.

## 15. Release page + GitHub-based update check / self-update (2026-06-10)

**User ask:** "the release page and the autoupdate based on the version on the github".

- **Server `release.ts`** (+ ReleaseStatus/ReleaseInfo/SelfUpdateResult in @fleet/shared):
  - `GET /api/release/status` — local version (root package.json) + short HEAD sha vs the repo's
    newest GitHub Release (newest STABLE preferred over prereleases); `updateAvailable` via loose
    semver compare (v-prefix/prerelease-tail tolerant, numeric not string order).
  - Repo slug resolves from `FLEET_GITHUB_REPO` (override) else the `origin` remote URL
    (https/ssh/git@ forms parsed). THIS repo has no remote yet → everything degrades quietly
    (repo:null, no error spam) and the page explains the two ways to link it.
  - GitHub fetch: 10-min cache + 6-h unref'd background refresh (so the sidebar badge works
    without visiting the page), optional GITHUB_TOKEN, 404→empty-not-error, failures land in
    `status.error` never 5xx, last-known releases kept on flaky network. Fetcher injectable for
    tests (`__setFetcherForTests`).
  - `GET /api/release/list` — releases for the changelog page.
  - `POST /api/release/update` — SELF-UPDATE: refuses without origin (400) / with a dirty tree
    (409, lists the dirt — never pulls over local work) / detached HEAD; else
    `git fetch origin --tags` → `git pull --ff-only origin <branch>` → `pnpm install`, each step
    logged (stops at first failure), cache invalidated. Note in response: dev watchers reload
    themselves; production needs `pnpm build` + restart.
- **Web `/releases`** (nav "⇪ Releases"): version strip (installed/sha/latest/status), update
  banner with one-click "⇪ Update to <tag>" (only when updateAvailable AND canSelfUpdate),
  per-step output log, not-linked explainer, full changelog (release bodies via MarkdownView,
  "installed" badge on the matching tag). **Sidebar badge**: pulsing amber dot on the Releases
  nav entry when an update is available (one-shot status fetch in Shell).

**Verified:** 368 server tests (24 files; +14 release: slug parse forms, semver compare, status
shapes incl. prerelease preference + degrade-on-network-failure, no-remote 400 on update —
repo-state-dependent cases `skipIf(hasOrigin)`), 3/3 typecheck, `next build` clean (18 routes),
live demo against `FLEET_GITHUB_REPO=anthropics/claude-code`: latest v2.1.172 detected,
updateAvailable true, sidebar badge lit, 20-release changelog rendered, honest "no origin —
pull manually" state (no update button); restarted clean without the env (quiet not-linked state).

## 16. Installer, production start point + startup banner; published to GitHub (2026-06-11)

- **Published:** private repo **github.com/YOUSSEFELJAYAD/claude-fleet-portal** (gh account
  switched yeljayad → YOUSSEFELJAYAD), all of §11–§15 committed on main (`c7e5492`), tagged +
  released **v0.1.0**. The /releases page now reports "up to date" against it.
- **§15 addendum — private-repo update checks:** unauthenticated GitHub API 404s private repos,
  so the release checker falls back to `gh auth token` when GITHUB_TOKEN is unset (same trust
  surface as PR mode's gh dependency; 10-min token cache so `gh auth switch` applies without a
  server restart). Verified live: latest v0.1.0 detected on the private repo, updateAvailable
  false, canSelfUpdate true.
- **`install.sh`** — fresh-clone installer: prereq checks (node ≥20 w/ version gate, pnpm w/
  corepack fallback, git required, claude + gh optional w/ honest notes), `pnpm install`,
  `pnpm build`, data dir, chmod, next-steps card. Idempotent.
- **`start.sh`** — the production "point of start": octopus + Claude-mark ANSI startup banner,
  `--mock` flag (free deterministic runs), build-exists + claude-exists + ports-free guards,
  starts server (`tsx src/index.ts`) + web (`next start`), one Ctrl-C stops both. Root
  `pnpm start` added; web `start` honors FLEET_WEB_PORT. README "Install & run" rewritten
  around clone → ./install.sh → ./start.sh.

**Verified end-to-end:** ./install.sh ran clean on this checkout (build 18 routes), ./start.sh
--mock booted production mode (banner rendered, both ports healthy, 12 templates served, mock
run launched + record deleted), dev mode restored after.

## 17. Update popup + sidebar version line + stale-build auto-rebuild (2026-06-11) → v0.3.0

- **UpdateModal** (components/UpdateModal.tsx, mounted by Shell): pops when
  `updateAvailable && canSelfUpdate` — shows current→latest, release-notes excerpt, "full
  changelog →"; **⇪ Update now** runs the guarded self-update and then ASKS THE USER TO
  RESTART (amber instruction card: Ctrl-C + ./start.sh; dev reloads itself); **Later**
  snoozes THAT version via localStorage (`fleet-update-dismissed-<tag>`) — next release
  pops again. Failure path shows the per-step log.
- **Sidebar version line** (bottom, under telemetry): `v<version> · <sha>` linking to
  /releases, with an amber `→ <tag> available` suffix when an update exists.
- **start.sh stale-build auto-rebuild**: install.sh/start.sh stamp `.next/fleet-build-sha`
  after building; start.sh compares it to HEAD and rebuilds when the code moved past the
  bundle (i.e. right after a self-update restart) — making "restart the app" genuinely
  complete an update in production.

**Verified live** (FLEET_GITHUB_REPO=anthropics/claude-code demo env): popup rendered with
v0.2.0 → v2.1.172, Later closed it and the snooze held across navigation while the nav badge
+ footer amber hint stayed; clean env shows quiet `v0.2.0 · <sha>` footer. 3/3 typecheck,
`next build` clean. Released as **v0.3.0**.

## 18. Desktop app + auto-release pipeline + popup v2 + app icon (2026-06-11) → v0.4.0

- **Popup v2 (user: "same UI, no tech info, background"):** UpdateModal rebuilt on the portal's
  own Panel/Kicker/Btn language; release notes render via MarkdownView; ZERO tech jargon (step
  logs live on /releases only). The update runs in the BACKGROUND — Shell owns the phase
  (idle/running/ready/failed), so the popup can be closed mid-update ("Continue working") and
  the sidebar version line carries the state ("updating…" → "restart to apply"); on completion
  the popup resurfaces asking for a plain restart. Packaged apps (canSelfUpdate false) get a
  "⇪ Get <tag>" button that opens the release download page instead.
- **Desktop app (`desktop/`, Electron 33 + electron-builder):** main.cjs forks the esbuild-bundled
  control plane (import.meta.url shimmed for CJS; better-sqlite3 external, rebuilt for Electron's
  ABI) and the Next standalone web server (FLEET_STANDALONE=1 build; payload DEREFERENCED —
  packagers mangle pnpm symlinks — and shipped via extraResources because electron-builder's
  smart node_modules handling prunes `files` payloads). Data in the OS userData dir; PATH
  augmented for GUI apps; `claude` resolved from common install dirs with a bundled-mock fallback
  driven through an ELECTRON_RUN_AS_NODE shim (zero system-Node requirement); FLEET_REPO_ROOT →
  app dir (version-stamped package.json), FLEET_GITHUB_REPO pinned for update checks; external
  links open in the system browser; double-start attaches to the existing instance.
  **Verified locally on macOS:** `electron-builder --dir` → packaged .app boots the full stack
  (API+web up, /releases 200, run launched), mock shim + userData DB confirmed.
- **App icon:** amber fleet octopus + coral Claude spark on the charcoal tile (SVG → rendered at
  1024px via Playwright → desktop/build/icon.png; electron-builder converts per-platform).
- **Auto-release pipeline (.github/workflows/release.yml):** push a vX.Y.Z tag → test (suite +
  typecheck) → create the GitHub release with auto-generated notes → 3-OS matrix builds installers
  (dmg/zip, nsis exe, AppImage/deb) and attaches them via electron-builder --publish. Static
  commands only; ref_name passed through env (injection-safe).

366 tests + 2 by-design skips (origin now exists), 3/3 typecheck. Released as **v0.4.0** — the
first tag the pipeline builds installers for.

## 19. Brand reset → public v0.1.0 (2026-06-11)

README rewritten professionally (logo header from the app icon, badges, fresh screenshots shot
from a seeded mock env — dashboard / run detail / board / template editor; stale wave-era PNGs
and two unreferenced research-note docs removed). Release history RESET at user request: releases
v0.1.0–v0.4.0 + tags deleted, versions (root + desktop) set back to 0.1.0, single clean **v0.1.0**
tag pushed — the auto-release pipeline (tests → auto-notes release → 3-OS installers) produces
the public debut release. Pipeline previously validated end-to-end on the v0.4.0 dry run
(15 assets: dmg arm64/x64 + zips, NSIS exe, AppImage + deb).

## 20. Landing page (three.js) on GitHub Pages + MIT LICENSE (2026-06-11)

`site/index.html` — single-file landing page deployed to GitHub Pages
(youssefeljayad.github.io/claude-fleet-portal) via .github/workflows/pages.yml (official
actions only). Hero: three.js (CDN importmap) animated fleet-octopus — wireframe icosahedron
core + pulsing coral heart, 8 swimming cubic-bezier tentacles ending in glowing agent nodes,
900-particle sea, additive blending, pointer parallax; zero console errors. Sections: features
(9 cards), screenshot tour (fresh §19 shots), install (download vs source), OPEN-SOURCE focus
(MIT end-to-end, local-first, auditable CI, hackable-without-tokens; stat chips) and footer.
**LICENSE (MIT, © 2026 YOUSSEF EL JAYAD) added** — the repo previously claimed nothing.

**§20 addendum:** landing page restyled with the PORTAL'S OWN design tokens (Chakra Petch display
/ Archivo body / JetBrains Mono, exact tailwind palette incl. signal colors, and the
mission-control body atmosphere: amber/teal vignettes + blueprint grid + scanlines). New
"how it works" section headlined by the octopus motto: 5 auto-cycling animated pipeline steps
(Launch → Orchestrate → Watch live → Guardrails → Ship), each with its signal-color accent,
fill-bar timer, pulse icon, hover-pause + click-select, started by IntersectionObserver; the
hero motto now anchors to it. Zero console errors.

## 21. macOS "app is damaged" fix — ad-hoc signing (2026-06-11)

User-reported: the downloaded .dmg app failed with «"Claude Fleet Portal" is damaged and can't
be opened» — Gatekeeper's message for a fully UNSIGNED app on Apple Silicon (we had
`mac.identity: null`, which skips even ad-hoc signing). Fix chain:
- **afterPack hook** signs the .app AD-HOC via @electron/osx-sign (`identity: '-'`,
  `identityValidation: false` — '-' is not a keychain identity; bare `codesign --deep` left
  nested helpers failing strict verify) and gates the build on
  `codesign --verify --deep --strict`.
- osx-sign stat-walks the bundle → the payload must be SYMLINK-FREE: copy-web.cjs now scrubs
  every symlink after assembly (realize valid ones, drop dangling .pnpm leftovers).
- Verified locally: strict deep verify passes (Signature=adhoc), and a QUARANTINED copy
  (xattr-simulated download) opens via LaunchServices — no "damaged" dialog.
- Honest residual (no Apple Developer account → no notarization): on other Macs Gatekeeper
  still shows the one-time "unverified developer" prompt — right-click→Open or `xattr -cr`.
  Documented in README, the landing-page download card, and the release notes.
- v0.1.0 re-cut from the fixed commit (tag re-pushed; pipeline rebuilds all installers signed).

## 22. Add-on Marketplace + built-in Compression add-on (Headroom) (2026-06-11)

User request: a settings-style "add-on marketplace" where capabilities can be toggled; first
built-in add-on = **compression** via Headroom (headroom-docs.vercel.app); enabling it unlocks
a dedicated info/config page.

- **Server `addons.ts`** (module-owned `addons` table: enabled + config JSON per add-on):
  static `ADDON_DEFS` catalog (one entry per add-on — marketplace grows by appending), routes
  `GET /api/addons[, /:id]`, `POST enable|disable|restart|install`, `PUT config`,
  `GET /api/addons/compression/stats`.
- **Integration shape**: the portal OWNS a `headroom proxy --host 127.0.0.1 --port N` child
  (spawn / health-probe / auto-restart / SIGTERM→SIGKILL stop), and `addonRunEnv()` injects
  `ANTHROPIC_BASE_URL=http://127.0.0.1:N` into every spawned claude child (single injection
  point in processManager → manual runs, campaigns and the PM all route identically). Binary
  detection: `HEADROOM_BIN` authoritative, else PATH + `~/.local/bin` + homebrew dirs;
  one-click install tries uv → pipx → pip3 (10-min cap, step output like self-update).
- **Verified vs REAL headroom 0.24.0** (docs had drifted): `/health` is
  `{service:'headroom-proxy', …, config:{…}}` (not the documented `{status, optimize, stats}`),
  and counters live on `/stats` (`summary.api_requests`, `savings.total_tokens`,
  `summary.cost.{savings_pct,total_saved_usd}`). Probe + stats mapping target the real shape
  with the docs shape as fallback; the test fake mirrors the REAL wire shapes. Live-verified:
  the portal auto-ATTACHED to the user's already-running proxy on 8787 (attach mode) and
  surfaced its real savings.
- **Lifecycle hardening** (17 confirmed findings from a 24-agent adversarial review, all fixed):
  idempotent enable (no orphan/self-attach race), restart waits for the old child to free the
  port, restart budget only resets after 60s STABLE uptime (flapping can't loop forever),
  deadline-kill is terminal (gen-bumped, no futile retry cycles), a 10s WATCHDOG re-verifies
  'running' (a dead external/hung proxy can't stay green while poisoning run env), and
  `addonRunEnv` NEVER overrides an operator-set `ANTHROPIC_BASE_URL` (surfaced in statusDetail).
- **Web**: `/addons` marketplace (status-chip cards, enable/disable, open-contribution card) +
  `/addons/compression` (live savings incl. `$ saved`, config form with string-typed number
  inputs + client-side validation, install helper, how-it-works) + Shell nav: "Add-ons" entry,
  and an ENABLED add-on's page slots beneath it with a live status dot ('fleet:addons' event
  keeps the rail in sync with toggles; unmount-safe setTimeout polling chains).
- Tests: +19 (`addons.test.ts`, fake headroom binary speaking the real 0.24.0 protocol) →
  suite 385 pass + 2 by-design skips; 3/3 typecheck.

## 23. Searchable tool/skill pickers + packs (launch presets) (2026-06-11)

User request: allowed-tools and skills should be dropdowns WITH SEARCH, and the operator can
save a "model" of skills/tools — preconfigured packs.

- **`MultiPicker`** (shared component): searchable multi-select — selected entries as removable
  chips, inline query filters by name AND hint, grouped option lists (skills grouped
  `kind · scope`), free-text entries via a "+ add" row (tool PATTERNS like `Bash(git *)` /
  `mcp__server__tool` can't be enumerated). Enter picks the first MATCH; custom only when
  nothing matches (live-testing caught Enter adding the literal query "graph" instead of
  selecting `graphify` — fixed). Replaces the comma-text inputs (allowed/disallowed tools) and
  the skills chip-wall/checkbox-list in BOTH the launch modal and the template editor.
- **`CLAUDE_TOOLS`** in @fleet/shared: the discoverable baseline of Claude Code's tool surface
  (15 entries with hints) — a baseline, not a constraint (custom patterns pass through verbatim
  to `--allowedTools`/`--disallowedTools`, D-006).
- **Packs** (`packs.ts`, table `tool_packs`, routes `/api/packs` CRUD): named presets pairing
  tools + skills. Validation at the door (name 1–60, entries trimmed/deduped/≤120 chars/≤100,
  UNIQUE name → 409 duplicate-name incl. rename). `PackBar` renders packs as one-click chips
  (apply = UNION into current selection, never clears), "save current as pack" snapshots the
  live selection, ✕ deletes (confirm). Mounted in the launch modal and the template editor.
- Verified end-to-end in the live UI (Playwright): search→select, pack save (correct contents
  via API), fresh-modal one-click apply repopulating both pickers.
- Tests: +15 (`packs.test.ts`) → suite 400 pass + 2 by-design skips; 3/3 typecheck.

## 24. Engine add-ons (Codex / OpenCode) + Guardrails v2 (2026-06-11)

User: improve Guardrails UI + propose features; add Codex-by-ChatGPT and OpenCode as engine-
switch add-ons; build with low-cost subagents (sonnet implementation, Fable review).
Process: 2 sonnet research agents (verified headless CLI contracts) → Fable wrote the shared
contract + specs → 2 sonnet implementers (sequential — both touch registry.ts) → Fable review
fixed: Timeline payload key (result events read payload.result, not .text), engine-orphan
recognition in looksLikeClaudePid (post-restart sweep/stop would have leaked codex/opencode
children), lint nits. All sonnet-claimed results re-verified.

**Engine add-ons (§24a)** — `RunEngine = claude | codex | opencode`:
- addons.ts: `runtime: 'proxy' | 'engine-binary'` discriminator; engine add-ons have no backing
  process (status = installed+enabled), npm one-click install (@openai/codex / opencode-ai),
  per-engine config (codex: defaultModel + sandbox; opencode: defaultModel + skipPermissions).
- engines.ts: pure buildEngineArgs (codex: `--ask-for-approval never --sandbox … --cd … exec
  --json --skip-git-repo-check`; opencode: `run --format json [--model] [--dangerously-skip-
  permissions]`) + parseEngineLine (codex item.completed/turn.completed/turn.failed; opencode
  text/tool_use/step_finish/error → the EXISTING NormalizedEvent types, so the run timeline
  renders engine runs unchanged) + spawnEngine (spawnClaude contract, no stdin protocol).
- registry.launchEngine: flat-root run records (engine column on runs), tokens from the JSONL
  usage, costUsd 0 (no cost stream), stop works (group kill), input/resume/permission → 409
  engine-unsupported. Launch route branches on body.engine.
- LaunchModal: ENGINE segmented control (shown when an engine add-on is enabled); non-claude
  collapses the form to engine-relevant fields; budget marked 'not enforced on this engine'.
- Live-verified: OpenCode v1.17.3 installed VIA THE PORTAL's install route, enabled, engine
  switch rendered (real runs need the user's `opencode auth` providers — not exercised).
  Codex card shows install CTA (binary absent; runs additionally need ChatGPT auth).

**Guardrails v2 (§24b)** — three new server-enforced rails + page revamp:
- `dailySpendCeilingUsd` (null=off): launch+launchEngine refuse with 409 'daily-cap' once
  today's spend reaches it. `maxRunMinutes` (null=off): 30s registry sweep auto-kills over-
  duration runs with killReason 'timeout' (covers claude AND engine runs; sweepTimeouts(now)
  exported for deterministic tests). `POST /api/agents/stop-all` panic route (kill every live
  run, killReason 'user').
- /guardrails: three blocks — LIVE STATUS (5s poll, spend-vs-cap + active-vs-max gauges,
  cap-reached banner), LIMITS (6 editable fields + read-only platform ceilings), DANGER ZONE
  (STOP ALL RUNS, confirm with live count, disabled at 0).
- Tests: +24 across engines.test.ts / guardrails.test.ts / addons.test.ts updates (incl. a
  fake-bin engine E2E through spawnEngine) → suite 464 pass + 2 by-design skips; 3/3 typecheck.

**§24 addendum — adversarial verification round (34 agents, 5 dimensions, all findings
independently verified; 19 confirmed, ALL fixed):**
- GUARDRAIL BYPASSES: resume() now checks the daily cap (was an open side gate for unbounded
  spend); sweepTimeouts uses a per-INVOCATION clock (lr.invocationStartedAt — resume no longer
  killed instantly off the ORIGINAL startedAt); campaigns/PM treat 409 'daily-cap' as TRANSIENT
  like 429 (was: burned DAGs / permanently Blocked cards when the cap tripped mid-flight).
- STOP-ALL RE-ENTRANCY: the panic route now kills campaigns FIRST (terminal-before-kill, their
  own H2 defense) — a bare registry.stopAll() synchronously triggered schedule() to spawn
  REPLACEMENT workers mid-panic. Returns {stopped, campaignsKilled}.
- ENGINE CORRECTNESS: '--' separator before the positional prompt for BOTH engines (F-11
  regression class — empirically reproduced: hyphen-leading prompts parsed as flags; an
  opencode prompt could even flip --dangerously-skip-permissions); engine exit status no longer
  OR'd with resultSeen (a crash after one streamed message was recorded 'completed'); codex
  turn.failed nested {error:{message}} unwrapped (was: raw JSON in the Timeline); killed engine
  runs keep node status 'killed' (was clobbered to 'failed'); no-op JSONL lines no longer run
  the dirty/flush/emit pipeline (2 DB aggregates per skipped line); looksLikeClaudePid already
  fixed for engine orphans in the first review pass.
- VALIDATION/COPY: engine defaultModel trimmed/length-capped/no-leading-dash; compression
  description scoped to claude runs (engine runs are NOT proxied); opencode page now states
  that skipPermissions:false auto-rejects permission asks headlessly.
- WEB: stale /command no longer silently prefixes engine prompts (and engineModel resets on
  engine switch); Resume hidden for engine runs (was a guaranteed 409 dead-end); run header
  shows an engine badge, hides the inapplicable effort dial, and renders killReason
  ('timed out (maxRunMinutes)' / 'budget kill' / 'stopped by operator') + run.error (both were
  persisted but invisible); launch-modal footer shows the real codex spawn shape; STOP ALL no
  longer gated on the (possibly failed) spend poll; the three required guardrail number fields
  edit as strings (clearing no longer snaps to 0).
- Known accepted gap (documented, not fixed): daily spend is bucketed by started_at — a run
  crossing midnight attributes post-midnight accrual to the previous day.
- Suite: 466 pass + 2 by-design skips (+2 regression tests: resume-cap, nested turn.failed).

## 25. Template-driven agent creation (launch = claude-style profiles) (2026-06-11)

User: creating an agent should have the same profile machinery claude has — also templates.
Sonnet implemented, Fable reviewed (clean — no findings).
- LaunchModal (claude engine only): "agent profile · template" select (grouped by role) —
  applying a template fills EVERYTHING it defines (system prompt → --append-system-prompt,
  model, fast mode, effort, permission mode, allowed tools, skills, budget), all still editable;
  '— blank agent —' clears only the instructions. New collapsible "agent instructions · system
  prompt" textarea (amber ACTIVE chip when collapsed-but-set) so ad-hoc agents get working
  instructions without a template. Engine runs (codex/opencode) see neither and never send
  appendSystemPrompt. No server changes (LaunchRequest.appendSystemPrompt already existed).
- Template detail page: "launch with this profile" quick-launch panel (prompt + cwd + ▶) using
  the CURRENT edit state — tweak, launch, navigate to the run.

## 26. Thinking mode for every engine (2026-06-11)

User: add think-mode for all models where the LLM supports it. Sonnet implemented, Fable
reviewed (clean) + re-verified suite/typecheck.
- LaunchRequest.thinkingLevel (per-invocation knob, not persisted — resume uses defaults).
- claude: MAX_THINKING_TOKENS env on the spawned child (off→0 · think→4000 · megathink→10000
  · ultrathink→31999; absent = adaptive default). spawnClaude gained extraEnv (merged LAST so
  it wins); startProcess passes thinkingEnv(req.thinkingLevel) — `claude --help` exposes no
  thinking flag (verified), the env var is the documented mechanism.
- codex: `-c model_reasoning_effort=<minimal|low|medium|high>` global flag before `exec`
  (argv-direct, no shell quoting).
- opencode: `--variant <level>` (provider-specific; validated /^[a-z0-9-]{1,32}$/i).
- Server-side validation per engine (400 with per-engine message, ordered BEFORE the
  engine-disabled check so bad input never reads as a 409).
- LaunchModal: "thinking depth" select for claude AND engine runs (per-engine option sets),
  reset on engine switch (cross-engine levels are invalid), included in both submit branches,
  footer spawn hint reflects it. Tests +17 → suite 483 pass + 2 by-design skips.

## 27. v0.4 feature batch — PRD-driven multi-agent build (2026-06-11)

User: implement ALL proposed features except remote/mobile as one batch, full PRD in one file,
dedicated subagents per task (sonnet/haiku by complexity), Fable reviews everything deeply —
"this stays production ready".

**Process** (docs/PRD-v0.4-features.md is the spec): 4 implementation waves of parallel
subagents with disjoint file ownership + unique wiring anchors in shared files; Fable gate
between waves (line-by-line diff review, fresh suite+typecheck, live UI); then a 54-agent
adversarial verification workflow (6 dimensions × refuting verifiers) over the whole batch;
then 1 Fable + 4 sonnet FIX clusters; final re-gate.

**Shipped** (all per PRD v1 scope):
- F1 GitHub triggers (poll via gh; issue-label/pr-opened → Kanban card or template-profiled run)
- F2 recurring schedules (every/daily/weekly grammar, pure nextFire(), template at fire time)
- F3 auto-retry with escalation (retry_of chain links, full guardrail surface on retries)
- F4+F5 benchmarks (engine/model matrix + best-of-N with structured judge verdict)
- F6 approval inbox (+ rail badge derived from the existing fleet stream)
- F7 full-text transcript search (FTS5, graceful fallback, XSS-safe snippets)
- F8 notification channels (slack/discord/generic, https-only) + 50/80/100% spend alerts
- F9 fleet memory (md+jsonl capture, recall toggle wiring personal-rag into launches)
- F10 config-as-code (export/import with per-item skip-and-report)

**Adversarial verification: 46 confirmed findings (1 critical, 13 major), ALL fixed.** The
themes worth remembering:
- AUTONOMOUS SPEND is where everything bites: trigger ticks lacked overlap guards (double
  launches), stale full-row persists could resurrect a disabled trigger, hardcoded model
  defaults made template models dead code in BOTH triggers and scheduler (operators pointing
  triggers at haiku templates would have run opus-4-8/high on every labeled issue), smuggled
  internal _attempt fields could defeat the retry cap (now stripped at the door, internal-only
  via launch(req,{_internalRetry})), and cap-blocked benchmark judges stranded benchmarks
  forever (now a 45s DB-state sweep owns judge-retry AND restart convergence).
- CRITICAL: benchmark kill() raced its own judge launch — fixed with the campaigns H2
  terminal-before-kill pattern; judge now also requires ≥1 COMPLETED variant.
- TEST HONESTY was its own dimension and earned it: 9 tests looked like coverage but could
  not fail (vacuous fixtures, dead fixture branches, asserting via routes that bypass the
  code under test, and a fixture broken twice over — process.exit() truncating piped stdout
  AND per-test CLAUDE_BIN swaps being no-ops because config.ts freezes it at import; replaced
  with a FAKE_MODE runtime dispatcher).
- Misc systemic: fleet-config import bypassed the sealed cap≤reserve guard; legacy webhook
  leaked full run transcripts; '..' path traversal past the repo regex into gh API paths.

Suite: 483 → **658 pass + 2 by-design skips** (38 files); 3/3 typecheck; every new surface
verified live. Junk templates an import test leaked into the live dev DB were removed.

## 28. v0.4.1 patch release — unblock release CI (2026-06-11)

The `v0.4.0` tag pushed successfully, but its release workflow failed before publishing because
`guardrails.test.ts` changed `process.env.CLAUDE_BIN` after `config.ts` had already frozen the
binary path at import time. CI spawned the default `claude` command instead of the sleeping test
stub, so stop/timeout assertions saw early failed runs rather than killed live runs.

Fix: pin the sleeping guardrails test binary at module top before any src imports, matching the
runtime-dispatcher pattern used by other process-spawn tests, and remove misleading per-test env
swaps. Bumped app/package metadata to `0.4.1` for a fresh patch tag because `v0.4.0` already
exists. Verified: `pnpm -r typecheck`, targeted guardrails test, and full `pnpm test` suite
(`658 pass + 2 by-design skips`).
