# PRD — Claude Fleet Portal v0.4 feature batch

Status: APPROVED · Owner: operator (YOUSSEF) · 2026-06-11
Process: one dedicated implementer subagent per feature (model by complexity), Fable reviews every diff.
Scope: F1–F10 below. Explicitly OUT of this batch: remote/mobile access (proposal #10).

House rules for every feature (implementers: these are requirements):
- Match existing code style; self-contained server modules owning their tables (projects.ts pattern).
- Server modules register routes via `register<X>Routes(app)`; tests use the standard harness
  (tmp `FLEET_DATA_DIR`, `buildServer()`, `app.inject` with the Host header helper).
- Web pages use the house components (Panel/Kicker/Field/Input/Select/Btn/Toggle/Stat/Gauge,
  MultiPicker where lists are picked) and the block-with-header-row layout (`px-4 py-3 border-b
  hairline` header + `p-4` body). Unmount-safe polling (alive-ref + setTimeout chain).
- Number inputs that can be blank are STRING-typed in form state (blank ≠ 0).
- Validation at the door: bad input → 400 with a readable message; transient caps (429 /
  409 daily-cap) must never permanently fail autonomous flows.
- Nothing interactive at boot; all timers `unref()`d.

---

## F1 — GitHub triggers (autonomy front door)
**Complexity: HIGH → sonnet**

Problem: the PM can build cards autonomously but nothing creates work from the outside world.

v1 scope (POLLING, not webhooks — the portal is localhost-only):
- New module `apps/server/src/triggers.ts`, table `triggers(id TEXT PK, repo TEXT NOT NULL
  ("owner/name"), kind TEXT CHECK in ('issue-label','pr-opened'), config TEXT JSON (e.g.
  {label:'agent'}), action TEXT CHECK in ('card','run'), project_id TEXT NULL (required for
  action 'card'), template TEXT NULL (template NAME for action 'run' prompt profile), enabled
  INTEGER, state TEXT JSON ({seen:[ids]}), created_at INTEGER)`.
- Poller: every 120s (unref'd, started in register fn), for each enabled trigger shell out to
  the `gh` CLI (same trust surface as PR mode / release checks — never store tokens):
  - issue-label: `gh api repos/<repo>/issues --method GET -f labels=<label> -f state=open
    -f per_page=20` → items not in state.seen.
  - pr-opened: `gh api repos/<repo>/pulls -f state=open -f per_page=20` → ids not in seen.
- On a new item: action 'card' → create a Kanban card in project_id's Ready column
  (title `#<n> <title>`, description = body + `\n\nsource: <html_url>`; use the kanban module's
  existing create path). action 'run' → registry.launch with prompt = title+body+url, cwd =
  the project's repo path if project_id set else reject at validation, applying the named
  template's profile fields (mirror the template application in campaigns.launchWorker).
  Then add the id to seen (cap seen at 500, FIFO) and persist state.
- Failures: gh errors → store last_error on the trigger row (add column), surface in UI, never
  throw out of the tick. 429/daily-cap on launch → do NOT mark seen (retry next tick).
- Routes: GET /api/triggers · POST /api/triggers · PUT /api/triggers/:id ·
  DELETE /api/triggers/:id · POST /api/triggers/:id/poll (manual tick for tests/UX).
- Validation: repo must match /^[\w.-]+\/[\w.-]+$/; kind/action whitelists; label non-empty for
  issue-label; project must exist for action card.
- Web: a "triggers" Panel on the PROJECT DETAIL page (apps/web/app/projects/[id]/page.tsx):
  list (kind, repo, config, enabled toggle, last_error, ✕), add-form (kind select, repo input
  prefilled from the project's origin if available, label input, action select, template select
  when action=run), and a "poll now" button per trigger.
- Tests (`test/triggers.test.ts`): CRUD + validation; poll tick with a FAKE `gh` binary (PATH
  shim like test/gh.test.ts does) returning fixture issues → card created, seen dedupe (second
  tick creates nothing), launch-blocked-by-cap not marked seen.

## F2 — Recurring scheduled agents
**Complexity: MEDIUM → sonnet**

v1 scope (extends the EXISTING scheduler — read apps/server/src/scheduler.ts first):
- Schedules gain: `recurrence TEXT NULL` — null = one-shot (today's behavior, unchanged) or
  one of: `every:<minutes>` (15–10080) · `daily:<HH:MM>` · `weekly:<0-6>:<HH:MM>` (0=Sunday,
  server-local time); `template TEXT NULL` (template NAME whose profile applies at fire time:
  appendSystemPrompt/model/effort/permissionMode/allowedTools/skills/budget — mirror
  campaigns.launchWorker's application); `last_run_id TEXT NULL`, `enabled INTEGER DEFAULT 1`.
- Fire semantics: on fire, a recurring schedule computes + stores its next_at instead of
  completing; catch-up policy = SKIP missed windows (fire once, schedule from NOW). A fire
  blocked by 429/daily-cap retries on the next scheduler tick (do not advance next_at past it
  more than once — advance next_at only after a successful or permanently-failed launch).
- Routes: extend the existing schedule CRUD to accept/validate the new fields (recurrence
  grammar → 400 on garbage; template must exist if named).
- Web (apps/web/app/schedules/page.tsx): recurrence picker (one-shot / every N min / daily@ /
  weekly@), template select, enabled toggle per row, "next fire" + "last run →" link columns.
- Tests (`test/scheduler` — extend existing): recurrence validation table; fire advances
  next_at per grammar (inject a fake clock or compute-next pure helper `nextFire(recurrence,
  from)` — MAKE IT A PURE EXPORT and unit-test DST-safe local-time math); cap-blocked fire
  does not advance; template profile applied to the launched run's req.

## F3 — Auto-retry with escalation
**Complexity: MEDIUM-HIGH (registry-touching) → sonnet, runs ALONE in its wave**

v1 scope:
- `LaunchRequest.retryPolicy?: { maxRetries: 1 | 2; escalateModel?: string | null } | null`.
- `runs` gains column `retry_of TEXT NULL` (migration in db.ts's existing loop) + Run.retryOf
  in shared + mappers.
- Registry: on a run reaching FAILED (never killed/completed; never campaign/PM/project runs —
  those have their own state machines: skip when campaignId or projectId set), if its req
  carried retryPolicy and attempt count < maxRetries: relaunch the SAME req (fresh run id)
  with `retry_of = failed run id`, attempt tracked on the req (internal field `_attempt`),
  model swapped to escalateModel on the LAST attempt when set. Subject to ALL guardrails
  (daily cap → drop the retry silently with a one-line registry log note on the failed run's
  error). Implement inside the existing notifyTerminal/onExit flow WITHOUT breaking the
  campaign/PM subscribers — a small `maybeRetry(lr)` called where terminal status is decided.
- Validation: maxRetries 1–2; escalateModel must be in MODELS when present. Engine runs: not
  supported in v1 (400 if engine && retryPolicy).
- Web: LaunchModal (claude only) — "auto-retry" select: off / retry once / retry once,
  escalate to Opus 4.8 / retry twice, escalate to Fable 5 (maps to policy objects; escalate
  target select shown when retrying). Run page: when run.retryOf → link "retry of <id>"; when
  a newer run has retryOf = this id → link "retried as <id>" (server: include `retriedBy` in
  GET /api/agents/:id response by a cheap indexed lookup).
- Tests (`test/retry.test.ts`): failed run with policy relaunches once (fake CLAUDE_BIN exits
  1), escalation swaps model on final attempt, completed runs never retry, killed runs never
  retry, campaign-member runs never retry, daily-cap suppresses the retry, retry_of links
  persisted both directions.

## F4 — Benchmark mode (engine/model matrix)
**Complexity: MEDIUM-HIGH → sonnet (one agent implements F4+F5 together — same machinery)**

v1 scope:
- New module `apps/server/src/benchmarks.ts`, table `benchmarks(id, prompt, cwd, mode TEXT
  CHECK in ('matrix','best-of-n'), variants TEXT JSON, run_ids TEXT JSON, judge_template TEXT
  NULL, judge_run_id TEXT NULL, winner_run_id TEXT NULL, status, created_at, ended_at)`.
- POST /api/benchmarks {prompt, cwd, mode, variants: 2–4 of {label?, engine ('claude'|
  'codex'|'opencode'), model?, engineModel?, thinkingLevel?, effort?}, judgeTemplate?: name,
  budgetPerRunUsd?} → launches one run per variant through the EXISTING registry surface
  (claude → launch; engines → launchEngine via the same code path server.ts uses — call
  registry methods directly). Engine variants require that engine add-on enabled (else 400
  naming the variant). Subject to guardrails; a variant blocked by 429 → 409 the whole create
  (atomic: stop already-launched variants, return the error).
- Completion: subscribe onRunTerminal; when all variant runs are terminal: mode 'best-of-n'
  with judgeTemplate → launch a judge run (claude, the judge template's profile, prompt =
  the original task + each variant's resultText (trimmed 4k each) + instruction to pick the
  best, `--json-schema {winner: {type:'string', enum: [run ids]}, reasoning: string}`); when
  the judge completes parse structuredOutput.winner → winner_run_id. Matrix mode: no judge,
  status completed.
- Routes: GET /api/benchmarks (list) · GET /api/benchmarks/:id (detail: benchmark + per-run
  rollups {status,costUsd,tokens,durationMs,resultText 500-char preview}) · DELETE (kill live
  variant runs, mark killed).
- Web: new page `/benchmarks` + nav entry `{ href: '/benchmarks', label: 'Benchmarks',
  glyph: '⚖' }`… NOTE the Scheduler page uses ⚖ — use glyph '⚗' instead. Form block (prompt,
  cwd, mode toggle matrix/best-of-N, 2–4 variant rows each with engine select + model/
  engineModel + thinking + effort, judge template select for best-of-N) and a results list:
  per benchmark a card with a comparison table (variant label, engine, status dot, duration,
  tokens, cost, result preview, ⭐ on winner) linking each cell to the run page.
- Tests (`test/benchmarks.test.ts`): create validation (variant count bounds, disabled engine
  → 400, unknown judge template → 400); with fake CLAUDE_BIN: matrix of 2 claude variants
  completes and rollups populate; best-of-n launches a judge after variants finish (fake bin
  emits a result; judge run req carries --json-schema); atomic-abort on concurrency cap.

## F5 — Best-of-N launches
Folded into F4 (mode 'best-of-n'). No separate module.

## F6 — Approval inbox
**Complexity: MEDIUM → sonnet**

v1 scope:
- Server (`apps/server/src/inbox.ts`): GET /api/inbox → `{ items: [{run (slim: id, task, cwd,
  model, status, startedAt, costUsd), kind: 'permission'|'input', request?: {id, payload — the
  LATEST permission_request event's payload}, lastText?: string (last assistant_text preview
  400 chars for input items)}] }` — derived from registry live runs with status
  awaiting-permission / awaiting-input (read events via the existing repo.getEventsTail).
  Actions reuse the EXISTING routes (permission / input) — no new mutation endpoints.
- Web: new page `/inbox` + nav entry `{ href: '/inbox', label: 'Inbox', glyph: '◳' }` placed
  right after Fleet. Shell nav badge: amber count dot on Inbox derived from the EXISTING
  useFleet() runs (statuses awaiting-permission|awaiting-input) — zero new polling in Shell.
  Page: one block per item — permission items show the requested tool/payload summary +
  ✓ Approve / ✕ Deny inline; input items show lastText + an Input + Send; every item links to
  the run page; empty state '— nothing waiting on you —'. Poll the inbox endpoint every 4s
  (unmount-safe).
- Tests (`test/inbox.test.ts`): with a fake CLAUDE_BIN that emits a permission_request then
  stalls — inbox lists it with kind permission + request payload; after deny via the existing
  route the item leaves the inbox; awaiting-input run (interactive fake) appears with
  lastText.

## F7 — Full-text transcript search
**Complexity: MEDIUM → sonnet**

v1 scope:
- `apps/server/src/search.ts`: FTS5 virtual table `events_fts(run_id UNINDEXED, seq UNINDEXED,
  node_id UNINDEXED, text)` (create with `IF NOT EXISTS`; if the sqlite build lacks FTS5,
  catch at module init, export `searchAvailable=false`, and the route returns
  `{available:false, hits:[]}` — NEVER crash the server).
- Indexing: a hook function `indexEvents(events)` called from db.ts's insertEvents (one line
  added there — extract text per event type: assistant_text/thinking/agent_message →
  payload.text; tool_result → payload.text; result → payload.result; tool_use →
  payload.name + ' ' + stringified payload.input (cap 2000 chars); skip others. Same
  transaction safety: best-effort, wrapped, never throws into the write path.
- Backfill: at register time, if fts rowcount == 0 and events exist, backfill the most recent
  100_000 events (batched 5k per transaction, synchronous at boot is fine at this cap — log
  one line with the count).
- Route: GET /api/search?q=&limit= (default 30, max 100) → `{available, hits: [{runId, seq,
  nodeId, snippet (use the FTS snippet() function, 12 tokens), run: slim {id, task, status,
  startedAt, model}}]}` — group is NOT required; one hit per matching event, runs deduped
  client-side. Sanitize q into a safe FTS MATCH string (quote it; strip double quotes) — a
  user typing `payments.ts AND x` must not 500.
- Web: history page (apps/web/app/history/page.tsx) gains a "deep search · full transcripts"
  input above the existing filter; non-empty query swaps the list for search hits (run card +
  highlighted snippet + 'jump to run' link → /runs/:id). Debounce 300ms.
- Tests (`test/search.test.ts`): insert events via repo, search finds text in assistant_text +
  tool_result + result payloads; snippet present; garbage/operator-laced queries don't 500;
  limit respected; (skip-if FTS unavailable pattern).

## F8 — Notification channels + spend alerts
**Complexity: MEDIUM → sonnet**

v1 scope (read apps/server/src/notifier.ts FIRST and extend it — do not create a parallel
system):
- Channel config stored by the notifier module (its own table or config row):
  `channels: [{id, kind: 'slack'|'discord'|'generic', url, events: subset of
  ['run-failed','run-completed','run-killed','awaiting-permission','spend-threshold'],
  enabled}]` (max 10 channels; url must be https and ≤ 512 chars).
- Dispatch: wherever the notifier currently records an in-app notification for run terminals,
  ALSO fan out to matching channels (fetch POST, 5s timeout, fire-and-forget with a
  last_error/last_ok_at per channel). Payloads: slack `{text}` · discord `{content}` ·
  generic `{event, run:{id,task,status,costUsd,model}, ts}`. Message text:
  `[fleet] <status icon> <task 80 chars> · $<cost> · <model>` + portal link
  `http://127.0.0.1:4318/runs/<id>`.
- Spend alerts: when dailySpendCeilingUsd is set, on each run-terminal compute today's spend %;
  crossing 50/80/100% (track already-fired thresholds per local DAY in the notifier's state)
  → 'spend-threshold' event to channels + an in-app notification.
- Routes: GET/PUT /api/notifier/channels (validate), POST /api/notifier/channels/:id/test
  (send a test message, return ok/error).
- Web (apps/web/app/notifications/page.tsx): a "channels" block — list with kind/url
  (masked middle)/events chips/enabled toggle/last error/⚡test/✕, and an add form (kind
  select, url input, events MultiPicker).
- Tests (`test/notifier-channels.test.ts`): channel CRUD validation (bad url, >10, bad
  event); dispatch formatting per kind against a local http server fixture capturing the
  body; threshold-crossing fires once per day per threshold (inject spend via seeded runs).

## F9 — Fleet memory (compounding knowledge)
**Complexity: MEDIUM → sonnet**

v1 scope (file-based, RAG-agnostic — the operator's personal-rag indexes a directory):
- `apps/server/src/memory.ts`: config row (its own table or reuse addons-style row) —
  `{enabled: boolean (default false), dir: string (default <DATA_DIR>/memory)}`.
- When enabled: on run-terminal COMPLETED claude runs (skip campaign workers/judges:
  campaignId set; skip PM runs: projectId set — v1 captures only operator-launched runs),
  append to `<dir>/fleet-runs.md` a markdown entry:
  `\n## <ISO ts> · <model> · $<cost>\n**task:** <task 300 chars>\n**cwd:** <cwd>\n**result:**\n<resultText 1500 chars>\n`
  and mirror a JSONL line to `<dir>/fleet-runs.jsonl` (full untrimmed resultText). mkdir -p
  the dir; write failures → one console.warn, never crash.
- Recall at launch: LaunchModal (claude only) gains a "memory recall" Toggle — when on, the
  submitted appendSystemPrompt gets an appended block: `MEMORY: before starting, search the
  operator's knowledge base for relevant past runs/notes (personal-rag MCP search tool if
  available) and apply what was learned.` and `mcp__personal-rag` is unioned into
  allowedTools. (Pure client-side composition — no server change for recall.)
- Routes: GET/PUT /api/memory (config), GET /api/memory/stats {entries, bytes, dir}.
- Web: a "fleet memory" block on the guardrails page? NO — put it on the /addons page as a
  THIRD column card? NO. Put it on the notifications page? NO. Decision: a compact Panel at
  the bottom of the HISTORY page (history = past runs; memory of past runs belongs there):
  enabled toggle, dir (read-only input + note 'point your RAG indexer here'), stats line.
- Tests (`test/memory.test.ts`): disabled by default → no files; enabled + completed run
  (fake bin) → md + jsonl entries appear with trimmed/untrimmed semantics; campaign-member
  completion writes nothing; config validation (dir must be absolute, no '..').

## F10 — Config as code (export / import the whole setup)
**Complexity: LOW → haiku**

v1 scope:
- `apps/server/src/portability.ts`:
  - GET /api/portability/export → JSON download
    `{version: 1, exportedAt, templates: [ALL templates incl. builtins (full field set, minus
    id/createdAt)], packs: [...], guardrails: PortalConfig, fleet: FleetConfig}` with
    `content-disposition: attachment; filename=fleet-setup.json`.
  - POST /api/portability/import (body = that shape) → upsert templates BY NAME (existing →
    update fields; new → create via the same validated paths the template routes use), packs
    by name likewise, guardrails/fleet via their existing validate+set functions. Returns
    `{templates: {created, updated}, packs: {created, updated}, guardrails: 'applied'|'skipped',
    fleet: 'applied'|'skipped', errors: [strings]}` — items failing validation are SKIPPED and
    reported, never abort the batch. Unknown top-level keys ignored; version !== 1 → 400.
- Web (apps/web/app/templates/page.tsx header): two Btns — `⇪ Export setup` (anchor to the
  export URL) and `⇩ Import` (file input → POST → result summary inline).
- Tests (`test/portability.test.ts`): export shape contains seeded builtins + a created pack;
  import round-trip is idempotent (counts go to updated on second run); a bad template inside
  the bundle is reported in errors while the rest applies; version 2 → 400.

---

## Wave plan (conflict-free parallelism)
- Wave 1: F7 (sonnet) ∥ F8 (sonnet) ∥ F10 (haiku) — disjoint modules/pages.
- Wave 2: F2 (sonnet) ∥ F6 (sonnet) ∥ F9 (sonnet) — disjoint.
- Wave 3: F1 (sonnet) ∥ F4+F5 (sonnet) — disjoint.
- Wave 4: F3 (sonnet) ALONE — registry-touching.
Shared-file rules per wave: each agent gets a UNIQUE anchor in apps/web/lib/api.ts and
apps/server/src/server.ts (assigned in its brief); nav (Shell.tsx) edits only in waves where a
single agent touches it. Fable wires/reviews/tests between waves.
