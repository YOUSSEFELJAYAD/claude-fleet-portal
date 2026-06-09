# Design Spec — Fleet Portal v2 (completing the v1 "out-of-scope" items)

> Date: 2026-06-09 · App: Claude Fleet Portal (`/Users/jd/Documents/agent-system`)
> Implements all of v1 spec §11 "Explicit out-of-scope for v1" **except §11.8 (auth)**.
> Grounded in a 9-designer + integration design workflow that verified every load-bearing
> claim against source. Every decision below also goes in `DC.md` when implemented.

## 1. Goal

Take the v1 agent-PM/Kanban portal (project-scoped Kanban + autonomous "head of product" PM +
read-only viewer, all shipped and tested) and complete the deferred capabilities so the portal
can: edit & commit files in the browser, push and open GitHub PRs, generate its own backlog from
an objective, delegate a card to a whole campaign, validate against a live server, render rich
code/markdown, balance work across projects, auto-resolve merge conflicts, and attach non-git
directories.

## 2. Locked decisions (from the user)

| # | Item | Decision |
|---|------|----------|
| §11.8 | Auth / multi-user / remote access | **SKIPPED.** App stays localhost-bound, single-user, unauthenticated (D-011 unchanged). |
| §11.2 | Remote git (push/fetch/PR) | **Full remote, PM may push by default.** Per-project `merge_mode` (`local`\|`pr`); the v1 push/remote deny-list is relaxed *only* for single-mode build/fix launches when `push_enabled=1`. |
| §11.6 | Rendering deps | **Add Shiki + react-markdown/remark-gfm.** The v1 "zero new deps" rule is lifted for the web app only. |
| Process | Build process | **Spec-first** (this doc), then build in dependency-ordered waves via workflows. |

The remaining 9 items (§11.1, .2, .3, .4, .5, .6, .7, .9, .10) are all in scope.

## 3. Cross-cutting architecture (READ FIRST — these prevent the known collisions)

The design workflow found one **blocking bug** and several **file-contention hotspots** shared
across items. These rules are binding for every build wave:

### 3.1 Migration routing (the blocking bug — do NOT regress)
`db.ts`'s top-level idempotent ALTER loop (`db.ts:165-182`, which swallows only
`/duplicate column name/i`) runs **before** `projects.ts`/`kanban.ts` execute their
`CREATE TABLE`. Putting `ALTER TABLE projects/kanban_tasks …` in the db.ts loop throws
`no such table` on a fresh DB (every `FLEET_DATA_DIR` test) → rethrows → boot crash. Therefore:

- **`projects` columns** → a NEW idempotent ALTER loop inside `projects.ts`, right after its `CREATE TABLE`.
- **`kanban_tasks` columns + indexes** → a NEW idempotent ALTER loop inside `kanban.ts`.
- **`campaigns` columns ONLY** → the existing `db.ts` loop (db.ts already owns the campaigns table).
- Every new column must ALSO be added to the module's own `CREATE TABLE IF NOT EXISTS` body (so fresh DBs get it without relying on the ALTER) **and** to its `COLS` string, insert/update stmts, and the `rowToX`/`xToRow` mappers.

### 3.2 Shared validation primitive (avoid an import cycle)
`#5 (port-broker)` extracts `runValidation` / `ValidationResult` / `capOutput` and the
`VALIDATION_*` constants out of `pm.ts` into a new `apps/server/src/validation.ts`. `#4` and `#9`
(which both call `runValidation`) import from there. This avoids a `pm.ts ↔ portbroker.ts` cycle
and a three-way collision on the validate region. **This extraction lands in the Wave-2 schema/refactor step.**

### 3.3 `validateAndGate(cardId, project)` shared sink
`#4` extracts the `onCardRunDone` validate→gate region of `pm.ts` into a single
`validateAndGate(cardId, project)` function. The single-run terminal, the campaign terminal (#4),
and the resolve terminal (#9) all funnel through it; `#5` wraps the (possibly brokered) validation
*inside* it. Only `#4` reshapes this region; `#9`/`#5` consume it. This is why Wave 3 serializes.

### 3.4 `disallowedToolsForProject(project)` — single deny-list source
`#2` introduces `disallowedToolsForProject(project)` as the ONE function every launch path reads
(build, fix, campaign-worker #4, resolve-agent #9). The push relaxation (`push_enabled=1`) applies
**only** to single-mode build/fix. Campaign workers and the resolve agent **never** inherit the
relaxation — they edit files only; push is an engine-side step as `fleet-pm`.

### 3.5 Credential scrubbing
`#2` adds one shared helper that strips `https://x-access-token:TOKEN@…` / `user:pass@` from any
git/gh stderr **before** it reaches `lastError`, the DB, or the SSE broadcast. Applied at every
site that surfaces git stderr.

### 3.6 `ExecutionPhase` union
`#9` adds `'resolving'` to the `ExecutionPhase` union in `packages/shared`. Both consumers must be
updated: `kanban.ts` `PHASES` set and web `KanbanCard` `PHASE_META` (has a fallback, but add it
explicitly). All other shared-contract additions are pure-additive.

### 3.7 Partition invariant (#3 vs #4)
A `#3` planning run carries `campaignId:null` and has no card; it must no-op through both engines.
`#4`'s new `getTaskByCampaignId` must NOT match it. A test asserts a planning run creates no
`campaign_tasks` row and is claimed by neither `getTaskByCampaignId` nor `getTaskByRunId`.

## 4. The nine items

### #1 — In-browser file CRUD + commit surface
- **Goal:** create, update, AND delete files in the project's MAIN working tree from the browser and
  commit the change as the ambient human git identity (not `fleet-pm`), gated by a per-project
  `editing_enabled` toggle (default OFF), reusing `fileview.ts`'s `safePath` guard, coexisting safely
  with the PM. (Decision: full add/update/remove, not edit-existing-only.)
- **CRUD shape:** the atomic commit route takes `{ path, content?, delete?, message, baseOid? }`:
  `delete:true` → `git rm -- <path>` + commit; otherwise write `content` (creating parent dirs +
  the file if it doesn't exist → covers "add") → `git add -- <path>` + commit. New-file creation and
  deletion run under the SAME `safePath` + `.claude/worktrees/**` reject + `pm.withProjectLock` guards.
  A `baseOid` of `null`/absent is allowed for a brand-new path; a delete requires the path to exist.
- **Keystones:** (a) New `apps/server/src/fileedit.ts` (`registerFileeditRoutes`) — keeps
  `fileview.ts`'s "read-only" contract intact. (b) Reuse the PM's lock: add a thin public
  `pm.withProjectLock(projectId, fn)` delegating to the private `withMergeLock`, and run the whole
  write→add→commit critical section under it (so a PM merge never sees a half-written file).
  (c) Close the worktree hole: `safePath` passes for paths under `root/.claude/worktrees/` (active
  task worktrees) — the write route explicitly rejects (409) any path under `.claude/worktrees/**`.
  (d) ONE atomic route `POST /api/projects/:pid/files/commit` (`fs.writeFile` → `git add -- <path>`
  → `git commit -- <path>`, pathspec-scoped, never `add -A`) so the main tree is never left dirty.
  (e) Author = ambient identity (omit the `-c user.name/email` flags fleet-pm uses); optional
  per-project `commit_author_name/email` override. (f) Lost-update guard: `GET …/files/edit`
  returns the blob OID; commit accepts `baseOid` → 409 on mismatch (advisory).
- **Routes:** `GET /api/projects/:pid/files/edit?path=` (working-tree bytes, text-only, byte-capped);
  `POST /api/projects/:pid/files/commit`; extend `PUT /api/projects/:id` for the toggle/author.
- **Data:** `projects`: `editing_enabled INTEGER DEFAULT 0`, `commit_author_name TEXT`, `commit_author_email TEXT`.
- **UI:** edit mode in `FileViewer` (textarea, save/commit, conflict 409 toast); toggle in project settings.
- **Test:** route tests w/ temp repo — toggle 403, traversal/worktree 409, atomic commit author + sha, stale-OID 409. Deterministic.

### #2 — Full remote git (push / fetch / GitHub PR)
- **Goal:** after a clean validated build, a project either does today's local `merge --no-ff` OR
  pushes the task branch and opens a PR via `gh`, per `merge_mode`.
- **Keystones:** (a) New `apps/server/src/gh.ts` wrapping the `gh` CLI (auth status, `pr create`,
  `pr view`, `pr merge`) + `git push`/`fetch` helpers in `git.ts`. (b) `merge_mode='pr'` flow:
  fetch+FF-sync the default branch → integrate+revalidate → push branch → `gh pr create`; card
  parks in `Review` with a `pr_state` badge; `Done` only when `refresh-pr` detects merged.
  (c) `disallowedToolsForProject` (see §3.4) — push relaxes only for single build/fix when
  `push_enabled=1`. (d) FF-only sync: `fetchAndSyncDefault` parks (never force) on a diverged local
  default. (e) credential scrubbing (§3.5).
- **Routes:** extend create/`PUT` for `merge_mode`/`remote_name`/`push_enabled`;
  `GET /api/projects/:id/git/health` (remote resolves, gh installed/auth); `POST /api/tasks/:id/refresh-pr`.
- **Data:** `projects`: `merge_mode TEXT DEFAULT 'local'`, `remote_name TEXT DEFAULT 'origin'`,
  `push_enabled INTEGER DEFAULT 0`. `kanban_tasks`: `pr_url TEXT`, `pr_state TEXT`.
- **UI:** project remote settings (mode/remote/push + a readiness check); card PR badge + link + Refresh.
- **Test:** deterministic git push/fetch against a local bare-repo "remote"; `gh` calls stubbed via a fake gh on PATH. PR-mode E2E (real `gh`) flagged optional.
- **Decisions baked in:** auto-merge stops at PR-open (human merges on GitHub); PR base = `project.defaultBranch`; pushed branch keeps the deterministic `worktree-task-<id>` name.

### #3 — PM Plan-board (objective → Ready cards)
- **Goal:** a human enters an objective; the Campaigns planner (`--json-schema` + `PLAN_JSON_SCHEMA`)
  decomposes it into a task DAG; the human reviews/edits a preview; on apply each task becomes a
  card with `depends_on` mapped from the DAG edges.
- **Keystones:** new `apps/server/src/planboard.ts` (own `plan_drafts` table) bridges
  campaigns→kanban without touching `campaigns.ts`. Planning run is a single orchestrator call
  (`campaignId:null`); its `orchestratorRunId` lets the UI stream live progress over the EXISTING
  `/api/agents/:id/stream` (zero new SSE). Apply re-validates cycle/dup before creating cards.
- **Routes:** `POST /api/projects/:pid/plan`; `GET /api/plans/:id`; `POST /api/plans/:id/apply` (idempotent); `GET /api/projects/:pid/plans`.
- **Data:** new `plan_drafts` table (planboard.ts).
- **UI:** `PlanModal.tsx` (objective input + live planner progress + editable task preview + apply).
- **Test:** `planboard.test.ts` — plan→draft→apply→cards with deps; cycle rejection; partition invariant (§3.7). Planner exercised via the existing mock-claude plan fixture (deterministic).
- **Decisions baked in:** apply target column defaults to `Ready` (param-overridable); lossy AC/validation map (preview is the review step); planning allowed regardless of pause/ceiling (gating applies to execution).

### #4 — Campaign-per-card delegation
- **Goal:** a card can run as a CAMPAIGN (sub-DAG of orchestrator+worker runs) instead of one build
  run; the card's validate/merge gate fires when the whole campaign completes.
- **Keystones:** per-card `mode` (`single`|`campaign`, immutable once executing). `pm.launchBuild`
  branches: campaign mode creates+starts a campaign scoped to the card worktree, wires
  `kanban_tasks.campaign_id`, and an `onCampaignTerminal` handler routes into the shared
  `validateAndGate` (§3.3). Reuses `CampaignEngine` unchanged.
- **Routes:** existing — `POST …/tasks` gains `mode`; `PUT /api/tasks/:id` gains a `mode` edit
  (Backlog only); `GET /api/campaigns/:id[/stream]` reused for sub-DAG drill-down.
- **Data:** `kanban_tasks`: `mode TEXT DEFAULT 'single'` + `idx_kanban_campaign`. `campaigns`:
  `disallowed_tools TEXT`, `permission_mode TEXT` (so `interactive:false` workers don't stall).
- **UI:** mode toggle in the card-create modal; campaign-DAG embed in card detail.
- **Test:** campaign-mode card → campaign runs (mock) → completion drives the gate; mode immutability; deny-list (workers never push). Mostly deterministic via mock-claude.
- **Decisions baked in:** `budgetPerWorkerUsd = card.budgetUsd` bounded by project ceiling; rework = single `launchFix` reuse; validation command is the incompleteness catch.

### #5 — Port-broker server validation
- **Goal:** validate against a *live server* — allocate an ephemeral free port per worktree, inject
  it + optionally copy a `.env`, start the server, wait for a health check, run the validation, then
  guarantee teardown.
- **Keystones:** new `apps/server/src/portbroker.ts`; the shared `validation.ts` extraction (§3.2);
  unconditional teardown (`try/finally` → `killProcessGroup(pid,false)` SIGTERM-group → SIGKILL
  after 2.5s, per `processManager.ts:58`; release the reserved port). Always sets `PORT` (+ custom
  var if configured); default health probe `GET http://127.0.0.1:$PORT/` (<500) if no URL/regex given.
- **Routes:** no new endpoints — extend project create/`PUT` (7 fields) and card create/`PUT` (3 override fields).
- **Data:** `projects`: `server_start_command`, `health_check_url`, `health_check_regex`,
  `readiness_timeout_ms`, `port_range_start`, `port_range_end`, `copy_env_from`. `kanban_tasks`:
  `server_start_command`, `health_check_url`, `health_check_regex` (overrides).
- **UI:** server-validation config in project settings; per-card overrides; validation tail on the card.
- **Test:** broker against a trivial real HTTP server fixture (start → health → check → teardown; port freed; timeout path kills). Deterministic, no claude.
- **Decisions baked in:** per-card override = the 3 card-specific fields only (rest inherit); a separate small cap on concurrent brokered validations (RAM) — coordinated with #7.

### #6 — Rich rendering (Shiki + react-markdown)
- **Goal:** replace the hand-rolled `CodeBlock`/`Markdown` in `FileViewer.tsx` and the presentational
  layer of `DiffView.tsx` with maintained libraries.
- **Keystones:** WEB-ONLY (no server/contract change). New `lib/shiki.ts` (singleton highlighter),
  `MarkdownView.tsx`, `ShikiCode.tsx`; lazy-loaded/code-split; keep link/HTML sanitization; safe
  plain-text fallback. Deps added: `shiki`, `react-markdown`, `remark-gfm`.
- **Data/routes/types:** none.
- **Test:** component render tests + `next build` clean + bundle check. No server tests.
- **Decisions baked in:** ship a built-in Shiki theme (e.g. `github-dark-default`) for v2; diff
  per-line language by file extension (fallback `text`); CSP deferred (localhost-only, D-011).

### #7 — Fleet-level cross-project scheduler
- **Goal:** a scheduler ABOVE the per-project `PmEngine` that fair-shares the single global
  concurrency pool across projects by priority, enforces a fleet spend ceiling, and supports
  cross-project card deps.
- **Keystones:** new `apps/server/src/fleet.ts` with a `tryAdmit` admission gate the PM launch path
  calls; `fleet_config` single-row JSON table; `reserveSlotsForNonPm` keeps slots for campaigns;
  admission-only (NO preemption). Project `priority` drives the fair-share weight.
- **Routes:** `GET/PUT /api/fleet/config`; `GET /api/fleet/status` (live allocation); `priority` via existing `PUT /api/projects/:id`.
- **Data:** `projects`: `priority INTEGER DEFAULT 0`. New `fleet_config` table (fleet.ts).
- **UI:** new `/fleet` page (live allocation, per-project quota/priority) + Shell nav.
- **Test:** `fleet.test.ts` — fair-share math, admission under a global cap, reserve slots, spend ceiling. Deterministic.
- **Known interaction (risk register):** #4 campaign workers carry `campaignId` not `run_id` → they escape the PM run-count; admission must count them via `reserveSlotsForNonPm` (documented).
- **Decisions baked in:** daily spend window (matches current Guardrails); priority-only weight; no preemption; campaigns balanced only via the reserve (full campaign admission is a follow-up).

### #9 — Conflict-resolution agent
- **Goal:** when `doMerge` hits a conflict, OPTIONALLY launch a resolve-conflicts claude run in the
  task worktree that performs the integration merge, resolves conflicts, commits; then ALWAYS
  re-validate before merging; park for the human on failure or after N attempts.
- **Keystones:** per-project `resolve_conflicts` toggle (default OFF). Resolve agent prompt: "edit
  files only, remove every conflict marker to satisfy <acceptanceCriteria>, do not run git." Always
  re-validates the resolved tree (never ships a bad resolution). `resolve_attempt_count` separate
  from build `attempt_count`. `reconcile()` must sweep a crash mid-resolve (`merge --abort` + park).
  New `'resolving'` phase (§3.6). Resolve agent uses `disallowedToolsForProject` and never pushes.
- **Routes:** extend `PUT /api/projects/:id` (`resolveConflicts`) and `PUT /api/tasks/:id` (`maxResolveAttempts`). No new endpoints (internal to the gate).
- **Data:** `projects`: `resolve_conflicts INTEGER DEFAULT 0`. `kanban_tasks`: `resolve_attempt_count INTEGER DEFAULT 0`, `max_resolve_attempts INTEGER DEFAULT 2`.
- **UI:** toggle in settings; `resolving` badge; conflict file list on the card.
- **Test:** deterministic conflict fixture → (with toggle) resolve path drives a launch (stubbed) → re-validate; abort-on-failure parks; reconcile sweeps a mid-merge worktree. Full resolve E2E (real claude) flagged optional.
- **Decisions baked in:** on resolve failure → abort the integration merge + park with the file list (don't leave a half-merged worktree).

### #10 — Non-git projects (git init on attach)
- **Goal:** attach a non-git directory with an opt-in `initGit` flag — run `git init` + seed
  `.gitignore` (just `.claude/worktrees/`) + an initial commit; else keep the v1 400.
- **Keystones:** `git.ts` `initRepo(dir, branch)`; create route gains `initGit?:boolean`; the
  not-a-git-repo 400 now returns `{ error, code: 'not_a_git_repo' }` so the UI can offer init.
- **Data:** none (an init'd project row is indistinguishable from an attached one).
- **UI:** "directory is not a git repo — initialize it?" affordance on create.
- **Test:** create on a plain dir → 400 w/ code; with `initGit` → repo created, initial commit, project created. Deterministic.
- **Decisions baked in:** branch from the form's `defaultBranch` (default `main`); minimal `.gitignore`; no remote creation (that's #2); no provenance column/badge.

## 5. Consolidated data model & migrations

Per §3.1 — each in its module's own loop + CREATE body + mappers.

**`projects` (projects.ts):** `editing_enabled`, `commit_author_name`, `commit_author_email` (#1);
`merge_mode 'local'`, `remote_name 'origin'`, `push_enabled 0` (#2); `server_start_command`,
`health_check_url`, `health_check_regex`, `readiness_timeout_ms`, `port_range_start`,
`port_range_end`, `copy_env_from` (#5); `priority 0` (#7); `resolve_conflicts 0` (#9).

**`kanban_tasks` (kanban.ts):** `mode 'single'` + `idx_kanban_campaign` (#4 — `campaign_id` already
exists at kanban.ts:49, just index + populate); `pr_url`, `pr_state` (#2); `server_start_command`,
`health_check_url`, `health_check_regex` (#5); `resolve_attempt_count 0`, `max_resolve_attempts 2` (#9).

**`campaigns` (db.ts loop):** `disallowed_tools`, `permission_mode` (#4 — `project_id` already exists, start writing it).

**New tables:** `plan_drafts` (planboard.ts, #3); `fleet_config` (fleet.ts, #7).

## 6. Consolidated shared-contract changes (`packages/shared`, append-only)

`Project` += editing/author (#1), `MergeMode` + merge/remote/push (#2), server-validation fields
(#5), `priority` (#7), `resolveConflicts` (#9). `CreateProjectRequest` += optional mirrors +
`initGit` (#10). `KanbanTask` += `mode` (#4), `prUrl`/`prState` (#2), per-card server fields (#5),
resolve attempt fields (#9). `ExecutionPhase` += `'resolving'` (#9, §3.6). New: `FleetConfig` (#7),
plan-draft types (#3).

## 7. Build waves

**Wave 1 — independent, fully parallel (separate agents):**
`#6` (web-only), `#10` (create route + `git.ts initRepo`, no column), `#3` (new `planboard.ts` module).
Zero contention on the pm.ts / projects-mapper hotspots.

**Wave 2 — one coordinated schema step, then parallel wiring:**
First, ONE commit: all `projects` + `kanban_tasks` column additions, the per-module ALTER loops,
CREATE-body updates, and mapper edits for #1/#2/#5/#9 **plus the `validation.ts` extraction (§3.2)**.
Then parallel: `#5` (port-broker), `#2` (remote git + `gh.ts`), `#1` (`fileedit.ts`).

**Wave 3 — serialized pm.ts edits, in this order (one agent):**
`#4` (adds `onCampaignTerminal` + the `validateAndGate` extraction §3.3) → `#9` (resolve agent into
the gate) → `#7` (fleet admission). They edit overlapping pm.ts regions, so they cannot be parallel.

Each wave ends green (typecheck + tests) and is committed before the next starts.

## 8. Risk register (cross-cutting)

1. **PM-push token leakage** → shared credential-scrub helper on all git/gh stderr (§3.5).
2. **Deny-list reach** → only single build/fix relaxes push; campaign workers (#4) + resolve agent
   (#9) never inherit it; enforced by the single `disallowedToolsForProject` source (§3.4).
3. **FF-only sync** (#2) parks (never force) on a diverged default — document the surprise.
4. **Edit-surface worktree hole** (#1) — blanket `.claude/worktrees/**` reject must also cover #4's
   campaign worktrees (same dir).
5. **Port-broker teardown** (#5) must be unconditional (try/finally process-group kill + port release).
6. **Broker × fleet RAM** (#5×#7) — brokered validations run up to `wip_limit` in parallel, each a
   heavy server; needs the brokered-validation cap.
7. **Admission miscount** (#4×#7) — campaign workers carry `campaignId` not `run_id`; count them via
   `reserveSlotsForNonPm`.
8. **Mid-resolve worktree** (#9) — a crash leaves `MERGE_HEAD` set; `reconcile()` must `merge --abort` + park.
9. **Double-gate** (#4) — two terminal streams (run + campaign); defended by the `merging` set +
   per-project mutex + column re-reads + a terminal-dedupe set.

## 9. Verification strategy

- **Deterministic (no claude), the default:** all of #1, #5, #6 (component + build), #7, #10, plus the
  state-machine/git portions of #2, #3, #4, #9 — via temp git repos, a local bare-repo "remote", a
  fake `gh` on PATH, a trivial HTTP server fixture, the mock-claude plan fixture, and `registry.launch`
  stubs. Each new module gets a `*.test.ts` mirroring the v1 harness (`FLEET_DATA_DIR` + `inject`).
- **Real-claude E2E (paid, flagged, run once per item):** #2 PR-open against a throwaway GitHub repo;
  #4 a small real campaign-per-card; #9 a real conflict resolve. Each ~$0.20–0.50.
- Gate per wave: `pnpm -r typecheck` green + full server suite green + `next build` clean.

## 10. Decisions — RESOLVED (user sign-off 2026-06-09)

1. **PR auto-merge (#2):** ✅ portal opens the PR, a human merges it on GitHub (no `gh pr merge --auto`).
2. **Edit surface (#1):** ✅ **full file CRUD** — create / update / delete (not edit-existing-only). See §4 #1.
3. **Real-claude E2E budget (#2/#4/#9):** **deferred → deterministic-first.** All items ship with
   no-cost tests; each ~$0.20–0.50 paid E2E (#2 PR, #4 campaign, #9 resolve) is confirmed with the
   user at the moment it would run. The #2 PR E2E MUST target a throwaway repo via an explicit repo
   arg — never the user's real `origin`.
4. **Fleet scheduler (#7):** ✅ admission-only, daily spend window, priority-only weight, no preemption.
