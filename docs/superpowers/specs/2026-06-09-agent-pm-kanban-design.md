# Design Spec — Project-scoped Kanban + Autonomous PM ("Head of Product")

> Date: 2026-06-09 · App: Claude Fleet Portal (`/Users/jd/Documents/agent-system`)
> Grounded in a 5-lens research workflow (47 findings) + the existing codebase. Every decision
> below also goes in `DC.md` as the canonical log when implemented.

## 1. Goal

Add a **per-project Kanban board** whose cards are executed by an **autonomous "head of
product" agent**: it picks up tasks, builds them with sub-agents in isolation, runs
service-checks/tests as validation, and gates a **local git merge** — configurable between
human-approve (default) and full-auto. Plus a **read-only file viewer** (type-aware) and
**git history** view, all scoped per project.

## 2. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Merge autonomy | **Configurable**, default **human-approve** (card parks in `Review`); per-project `auto_merge` toggle (default OFF) enables full-auto — but the *checks* always run. |
| Task isolation | Per-task **git worktree + branch** (reuse the H10 `--worktree` flag) → validate → **local** `merge --no-ff` into the project's default branch. No GitHub dependency. |
| Scope | All five subsystems (Projects, Kanban, PM engine, File viewer, Git history). |
| Viewer | **Read-only**, **zero new dependencies** — hand-rolled markdown + hand-rolled diff view + plain-monospace code (no react-markdown/highlight.js/react-diff-view). |
| PM commit author | Dedicated **`fleet-pm <fleet-pm@local>`** (clear git attribution). |
| Human "Request changes" | **Consumes a `max_attempts` slot** (treated like any rework). |
| Validation (v1) | **Pure checks** (test/typecheck/lint/build) — no port binding / per-worktree port allocation in v1. |
| Campaign-per-card | **Deferred** — v1 ships a single build run per card (campaigns engine untouched). |

## 3. Architecture

Five self-contained modules following the established Lane-B pattern (each owns its tables via
the `db` default-export handle + a `registerXxxRoutes(app)`), plus shared-contract types. The PM
engine is a **sibling** of `CampaignEngine` — `campaigns.ts`/`registry.ts` are **not rewritten**.

- `apps/server/src/projects.ts` — `projects` table + CRUD routes; threads `project_id`.
- `apps/server/src/kanban.ts` — `kanban_tasks` table + indexes + CRUD/reorder/board-SSE + Review actions.
- `apps/server/src/pm.ts` — `PmEngine` (select → build → validate → gate → rework loop).
- `apps/server/src/git.ts` — shared `execFile`-git helper + merge automation (write side) + read helpers.
- `apps/server/src/fileview.ts` — read-only file tree / file / status / diff / log / show routes.

Event-stream partition: PM build runs carry `campaignId: null` and link to a card via the indexed
`kanban_tasks.run_id`; `campaigns.handleRunTerminal` already no-ops when `run.campaignId` is null,
so the two engines coexist on the same `onRunTerminal` stream.

## 4. Data model

**`projects`** (new): `id` PK, `name`, `root_dir` (absolute, validated git repo), `default_branch`
(default `main`), `auto_merge` INTEGER default 0, `default_validation_command`, `wip_limit` default 3,
`budget_ceiling_usd` REAL (null=unbounded), `paused` default 0, `created_at`.

**`kanban_tasks`** (new): `id` PK, `project_id` FK, `column` (`Backlog|Ready|InProgress|Review|Done|Blocked|Canceled`),
`execution_phase` (`idle|building|validating|merging|conflicts|paused-budget|failed` — derived badge),
`title`, `description`, `acceptance_criteria` (build prompt + definition-of-done), `validation_command`
(nullable → project default), `priority` INTEGER, `rank` (lexorank ordering), `depends_on` JSON-array
(validated by `planHasCycle`/`planHasDupIds`), `assignee` (`pm|human`), `labels` JSON, `run_id` INDEXED,
`campaign_id` (null in v1), `worktree_name`, `attempt_count` default 0, `max_attempts` default 3,
`budget_usd`, `validation_output`, `last_diff_hash`, `merge_sha`, `last_error`, `created_at`, `updated_at`.

**ALTERs** (idempotent loop, like `campaign_id`): `runs ADD COLUMN project_id TEXT`, `campaigns ADD COLUMN project_id TEXT`.
Threaded through `LaunchRequest`, `Run`, `registry.launch`, row mappers, `upsertRunStmt`.

**Indexes**: `idx_kanban_project(project_id, column, rank)`, `idx_kanban_run(run_id)`, `idx_runs_project(project_id)`.

## 5. PM engine loop (`pm.ts`)

Persistent, never terminates. `pm.init()` subscribes `registry.onRunTerminal` (wired beside `campaigns.init()`).

1. **Select** — `tick(projectId)` (called from card create/move routes **and** an unref'd safety
   `setInterval`, since human card moves fire no terminal event): pull the top `Ready` card by
   `priority` then `rank` while `InProgress < wip_limit`, `paused=0`, and cumulative project spend
   `< budget_ceiling_usd`. Cards with unmet `depends_on` → `Blocked` (re-evaluated each tick).
2. **Build** — `launchBuild()` → `registry.launch` directly: prompt = title+description+acceptance_criteria,
   `cwd` = root_dir, `worktree: "task-<id>"`, `projectId`, `campaignId: null`, `budgetUsd`, model/effort/
   permissionMode from a PM template, `disallowedTools: ["Bash(git push *)", "Bash(git remote *)"]`
   (merges stay local), `interactive: false`. Set `column=InProgress`, `phase=building`, `run_id`, `worktree_name`.
   On 429 → leave `Ready`, break, retry on next terminal.
3. **Terminal** — find card by `run.id`; ensure-committed in the worktree (as `fleet-pm`); `phase=validating`.
4. **Validate** — `execFile` the validation command in the worktree via `git.ts` (timeout, maxBuffer,
   stdout salvage). **Exit 0 → gate; non-zero → rework.** Deterministic — never an LLM self-judging.
5. **Gate** — `auto_merge=0` (default) → `column=Review`, STOP for human Approve. `auto_merge=1` →
   proceed to merge only if the conflict probe + re-validation still pass.
6. **Rework** — under `max_attempts`: relaunch a fix run threading `validation_output`/stderr into the
   prompt; `attempt_count++`. **No-progress guard:** if the git-diff hash equals `last_diff_hash` twice →
   `Blocked`. At/over `max_attempts` → `Blocked`, `phase=failed`, keep the worktree + `last_error`.
   Human **Request-changes** re-enters rework **and consumes an attempt** (per decision).
7. Any terminal frees a slot → re-tick active projects (anti-starvation). Cancel/delete uses **H2
   ordering** (mark card terminal in DB first, then `registry.stop(run_id)`). `reconcileOrphans`
   extended to reset cards stuck `building/validating` whose run is dead on boot.

## 6. Git flow (`git.ts`, write side)

Deterministic from H10: `worktree: "task-<id>"` → `root/.claude/worktrees/task-<id>` on branch
`worktree-task-<id>`. Merge runs under a **per-project async mutex** (the single `main` worktree is
never raced):

1. **Ensure-committed** — `git -C wt status --porcelain`; if dirty, `add` (pathspec-scoped) + `commit`
   as `fleet-pm`; record SHA.
2. **Conflict probe** — `git merge-tree --write-tree --quiet <default_branch> <branch>` (zero side
   effects): exit 0 clean → continue; exit 1 conflict → `phase=conflicts`, park in `Review` with the
   parsed file list; other → engine error, never merge.
3. **Gate** — proceed only if `auto_merge` OR a human Approved.
4. **Integrate + re-validate** — if main advanced past base, merge default_branch INTO the branch and
   re-run validation in the worktree (catches semantic conflicts); integration conflict → `Review`.
5. **Merge** — assert main worktree clean; save backup ref `refs/fleet-backup/<branch>` + ORIG_HEAD;
   `git -C root merge --no-ff <branch>`; on post-merge failure `git reset --hard ORIG_HEAD`.
6. **Record + cleanup** — store `merge_sha` (revert via `git revert -m 1`), `column=Done`,
   `git worktree remove` + `branch -d` + prune.

**Startup guardrail:** ensure `.claude/worktrees/` is gitignored in the target repo before the first
build (it is not by default) so staging can't capture sibling worktree internals.

## 7. Read-only file + git viewer (`fileview.ts`, zero new deps)

**Path safety:** a new **realpath-containment guard** (the existing `isSafeCwd` substring check is
defeated by absolute paths + symlinks): reject null-byte/absolute `rel`; `abs = resolve(root, rel)`;
require `abs === root || abs.startsWith(root + sep)`; then `realpath` both and re-verify (blocks
in-repo symlink escape). `root` comes from the `projects` table, never the client.

**Server (via the `git.ts` `execFile` helper, maxBuffer 16MB, NUL-delimited parsing):**
- tree: `git ls-tree -l <rev> <dir>` (non-recursive, lazy-expand; long form gives blob size for the cap).
- file: `git show <rev>:<path>` with a byte cap; first-8KB NUL-byte → binary descriptor; image
  allowlist (png/jpg/gif/webp) with Content-Type (SVG treated as image, never inline HTML); JSON reserialized.
- status: `git status --porcelain=v2 -z`.
- diff: two-tier — `git diff --numstat -z` TOC, then per-file unified diff capped (~600 lines/64KB +
  truncation marker; short-circuit on "Binary files differ"). A Review card uses
  `git diff <default_branch>...<branch>` for the exact proposed merge.
- log: `git log -z` (hash/author/time/subject), project or per-card-branch scope, merge-commit markers.
- show: `git show <hash>` (hash validated by regex).

All routes return **200 with error-in-body** on git failure (mirrors `mcp.ts`). Behind the H3 Host-allowlist.

**Client (hand-rolled, zero deps):** minimal markdown renderer (headings/lists/code-fences/links —
links sanitized), plain-monospace code blocks, a ~100-line unified-diff renderer (add/del/context
coloring), JSON pretty-print, `<img>` for images, "binary / too large" fallback. Lazy-loaded.

## 8. Web pages

`projects/page.tsx` (list + create + settings incl. `auto_merge` toggle w/ warning, `wip_limit`,
default validation, budget ceiling, Pause/Resume) · `projects/[id]/page.tsx` (hub: spend gauge, scoped
runs/campaigns, tabs) · `projects/[id]/board/page.tsx` (Kanban over per-project SSE; phase badge,
attempt/budget evidence, drag, Review Approve/Request-changes/View-diff) · `projects/[id]/files/page.tsx`
· `projects/[id]/history/page.tsx`. Components: `KanbanBoard`/`KanbanCard`, `FileTree`/`FileViewer`/
`DiffView`/`GitLog`. Extend `lib/api.ts` (typed calls) + `Shell.tsx` (Projects nav).

## 9. Build waves (each independently verified: TDD + typecheck + build + browser; real-claude for spawn/merge)

- **W0 — Foundation:** `projects.ts` + `project_id` ALTERs + thread through launch; shared types;
  worktree-gitignore precheck; projects pages. *Verify:* create project on a real repo (bad path→400);
  run scopes to project; legacy runs unassigned.
- **W1 — Kanban (no automation):** `kanban.ts` + CRUD/reorder/depends_on validation + board SSE; board
  UI; human-only moves. *Verify:* create/edit/reorder; cycle rejected; live SSE; persistence.
- **W2 — PM engine (build→validate→Review, human-approve only):** `pm.ts` select/build/validate/rework,
  `git.ts` ensure-committed + validation runner, no-progress guard, reconcileOrphans, H2 cancel.
  *Verify (real-claude):* a Ready card builds in its worktree, validation runs there, pass→Review (no
  merge), fail→rework→Blocked at cap, no-progress stop, WIP cap, 429 resume, clean kill (no orphan).
- **W3 — Merge automation + gate:** merge-tree probe, merge mutex, integrate+revalidate, `--no-ff` +
  ORIG_HEAD rollback, cleanup; Approve/Request-changes; `auto_merge`; per-project spend ceiling +
  Pause. *Verify (real-claude):* Approve→clean `--no-ff` merge + worktree removed; conflict parked
  without touching main; two cards serialize via mutex; `auto_merge` merges with no human; ceiling
  pauses; rollback restores main.
- **W4 — Read-only viewers:** realpath guard + `git.ts` read helpers; `fileview.ts` routes; viewer UI.
  *Verify:* traversal/symlink/absolute → 400; large file bounded; binary descriptor; names with spaces;
  Review-branch diff; PM merges in log; 200-with-error-in-body on git failure.

## 10. Risks & guardrails

- **Infinite rework loop** → per-card `max_attempts` (3) + **no-progress diff-hash** (identical diff twice = stop).
- **Runaway cost** → per-run `--max-budget-usd` auto-kill + 429 cap (leave card Ready) + **new per-project
  cumulative spend ceiling** + one-click Pause/Resume.
- **Auto-merge shipping broken code** → the toggle removes the *human*, never the *checks* (validation
  exit 0 AND clean merge-tree probe AND green post-integration re-validate). Default off, per-project.
- **TOCTOU / index.lock** on the single main worktree → per-project merge mutex (workers stay parallel
  in isolated worktrees; only merge-to-main serializes).
- **Phantom no-op merge** → explicit ensure-committed before any probe/merge.
- **`git add -A` capturing worktree internals** → gitignore precheck + pathspec-scoped staging.
- **Semantic merge breakage** → integrate + re-validate before merge; ORIG_HEAD rollback on regression.
- **File-viewer path escape** → realpath-containment guard; read-only routes only.
- **Unbounded payloads** → execFile maxBuffer + git count/byte caps + two-tier diffs + truncation markers.
- **Boot-time zombie cards** → extend `reconcileOrphans`.

## 11. Explicit out-of-scope for v1

Everything below is **deliberately NOT in v1**. Each is a clean future extension; none is a
silent gap. The build will not include them, and the UI will not pretend they exist.

1. **In-browser file editing / writing.** The file + git viewer is strictly **read-only** —
   `ls-tree`/`show`/`status`/`diff`/`log` only, never `add`/`commit`/`checkout`/write. (Future: an
   edit-and-commit surface.)
2. **GitHub / remote git (PRs, push, fetch).** Merges are **strictly local** (`merge --no-ff` into
   the project's default branch). PM runs carry `disallowedTools: Bash(git push *)` / `Bash(git remote *)`.
   No `gh`, no PR creation, no pushing. (Future: optional GitHub PR flow.)
3. **PM auto-generating the backlog from a high-level objective.** In v1 a **human creates the
   cards**; the PM only *executes* `Ready` cards (build → validate → merge). The "objective →
   decomposed task list" capability already exists separately as **Campaigns** and is **not** wired
   into the board in v1. (Future: a "Plan board" action that decomposes a goal into `Ready` cards via
   the Campaigns `--json-schema` orchestrator.)
4. **Campaign-per-card delegation.** A card spawns **one build run** (not a sub-DAG of worker runs).
   `kanban_tasks.campaign_id` stays null in v1; `campaigns.ts` is untouched. (Future: complex cards
   delegate to a campaign.)
5. **Server-style validation (port-binding).** v1 validation = **pure checks** only
   (test / typecheck / lint / build, exit-code = pass/fail). No per-worktree port allocation, no
   `.env` copying, no starting long-running servers/browsers for a check. (Future: port-broker +
   ephemeral env per worktree.)
6. **Rendering dependencies.** **Zero new npm deps** — markdown, code display, and diffs are
   hand-rolled (minimal markdown, plain-monospace code, ~100-line unified-diff). No `react-markdown`,
   `highlight.js`/`shiki`, or `react-diff-view`; no syntax highlighting beyond plain text. (Future:
   lazy-loaded highlighter + rich markdown.)
7. **Cross-project / global orchestration.** The PM operates **per project** (per-project tick, WIP
   cap, spend ceiling, merge mutex). There is no global scheduler balancing across projects, and no
   cross-project dependencies. (Future: a fleet-level scheduler.)
8. **Auth / multi-user / remote access.** Unchanged from D-011 — localhost-bound, single-user, no
   auth. Projects are not access-controlled. (Future: auth when exposed.)
9. **Conflict *resolution*.** Merge **conflicts are detected** (`merge-tree` probe) and the card is
   **parked in `Review`** with the file list; v1 does **not** auto-resolve conflicts or run a
   conflict-resolution agent. The human resolves (or cancels). (Future: a resolve-conflicts agent.)
10. **Non-git projects.** A project **must be a git repo** (validated via `git rev-parse` at creation).
    Plain directories are rejected. (Future: optional `git init` on attach.)

## 12. Out of scope (original short list — superseded by §11)

Kept for history: in-browser editing; GitHub PR flow; campaign-per-card delegation; per-worktree
port allocation; syntax-highlighting libraries.
