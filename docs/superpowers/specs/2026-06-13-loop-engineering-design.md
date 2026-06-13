# Loop Engineering — Design Spec

- **Date:** 2026-06-13
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Feature handle:** Loops (loop-engineering as a first-class abstraction)
- **Reference:** [loop-engineering tutorial](https://github.com/owainlewis/youtube-tutorials/blob/main/tutorials/loop-engineering/README.md)
- **Related specs:** `docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md` (the PM/Kanban Worker loop this generalizes)

---

## 1. Summary & motivation

**Loop engineering** is the practice of designing the autonomous *system* around agents rather than building smarter agents. A *loop* is a job an agent does on repeat: it **wakes on a SCHEDULE, reads STATE, does one JOB within fixed PERMISSIONS, writes results back, and sleeps.** The tutorial's core pattern is two loops that coordinate only through shared state (never directly):

- a **Manager loop** that triages a backlog — classifies each item by **risk** (low/medium/high) and **type** (bug/feature/docs/test/refactor/chore), marks low-risk unambiguous work `agent:ready`, flags the rest `needs:human` with specific questions, and leaves an auditable *Agent Assessment* comment;
- a **Worker loop** that implements *only* `agent:ready` + `risk:low` items, has a **separate agent review its diff** (maker ≠ checker), and **opens a PR without merging** — a human is always the last function.

The discipline around the loops: a six-field pre-flight contract (**JOB / INPUTS / ALLOWED / FORBIDDEN / OUTPUT / EVALUATION**), a **dry-run → apply** escalation (a new loop runs inspection-only until its judgment validates over several runs), and reversibility (wrong label → change it; bad PR → close it, nothing merged).

### What the portal already has

A workflow audit of the codebase confirmed ~11 loop-engineering primitives are already live:

| Primitive | Where |
|---|---|
| SCHEDULE (cron-free wake clock) | `scheduler.ts` — recurrence grammar (`every:`/`daily:`/`weekly:`), per-loop cadence, run-now, no-stampede catch-up |
| STATE (shared, outside the chat) | `runs`/`run_nodes`/`events` + `kanban_tasks` + `triggers.state` — "one writes, the other queries" |
| JOB (one bounded unit per wake) | `registry.launch` "executes ONE run; does not decide what to run" |
| PERMISSIONS (scoped authority) | `LaunchRequest.{permissionMode,allowedTools,disallowedTools,skills,budgetUsd}`, `pm.disallowedToolsForProject`, registry guardrail envelope (429 concurrency / daily-cap / budget auto-kill / timeout) |
| Worker loop (build in isolation → PR, no merge) | `pm.ts` worktrees + `gh.ts` (`prMerge` exists but is **deliberately never called**) |
| Human merge gate | `autoMerge=0` parks in Review; PR mode structurally cannot merge |
| Reversibility / backpressure / event wake | draggable cards, 429+daily-cap deferral, `registry.onRunTerminal` |
| Structured-output / LLM-judge plumbing | `req.jsonSchema → --json-schema`, `run.structuredOutput`, `benchmarks.ts` `JUDGE_JSON_SCHEMA`, `campaigns` `PLAN_JSON_SCHEMA` |

### The genuine gaps this feature closes

1. **No Manager/triage loop** — nothing classifies a backlog by risk/type. `kanban_tasks.labels[]`/`assignee` columns exist but are written **only by humans**; today *the human is the triage manager*.
2. **No `agent:ready`/`needs:human` permission vocabulary** distinct from a tag.
3. **No maker/checker separation** — the Reviewer template exists but is never structurally run on a worker diff; the maker self-certifies.
4. **No first-class JOB/INPUTS/ALLOWED/FORBIDDEN/OUTPUT/EVALUATION contract**, and no stored EVALUATION rubric.
5. **No dry-run / inspection-only escalation** before apply-mode.
6. **No assessment write-back** — `gh.ts` has zero issue/label/comment verbs.

---

## 2. Goals & non-goals

### Goals
- Make a **Loop** a first-class, persisted, contract-bearing entity — loop-engineering becomes the platform's organizing abstraction; the PM becomes the reference Worker loop.
- Ship a built-in **Manager (triage) loop** and a built-in **Worker loop** that coordinate only through a control plane.
- Support a **pluggable control plane per loop**: the local Kanban board or GitHub Issues+labels.
- Enforce the **dry-run → auto-escalate** lifecycle and the **EVALUATION-required** contract gate.
- Insert a **mandatory maker/checker** review on the worker path (contract default `always`).
- Keep the **human merge gate** as the default, with a bounded opt-in to low-risk auto-merge.

### Non-goals (v1)
- **Fleet-wide triage** — Manager loops are per-project (matches `pm.ts`/`kanban`/`fleet.ts`).
- **Replacing the existing scheduler/triggers/PM** — we *extend and reuse*, never rewrite. The PM stays the execution engine; Loops add the contract + Manager + lifecycle on top.
- **Hard-enforced self-feeding** — filing evidence-backed tickets for incidental findings is a *prompted capability*, not a runtime-enforced rule.
- **Non-GitHub remote providers** for the github adapter (only `gh`-backed GitHub, like `triggers.ts`/`gh.ts` today).

---

## 3. The Loop abstraction & six-part contract

A `Loop` carries the tutorial's pre-flight card as structured, machine-readable data:

```ts
interface LoopContract {
  job: string;          // the single responsibility (free text, required)
  inputs: string;       // what STATE it inspects (free text, required)
  allowed: string[];    // tool patterns it MAY use      → LaunchRequest.allowedTools
  forbidden: string[];  // tool patterns it must NEVER use → LaunchRequest.disallowedTools
  output: string;       // the concrete artifact after a good run (free text, required)
  evaluation: string;   // how we grade success (free text, REQUIRED — create fails if empty)
}
```

**Validation rule (enforced on create/edit):** a Loop with an empty `evaluation` is rejected — "if you can't grade it, you're not ready to run it autonomously." `forbidden` is always merged into the project deny-list and may only *narrow*, never widen, the existing `disallowedToolsForProject` baseline (`Bash(git push *)` / `Bash(git remote *)`).

---

## 4. Data model

### 4.1 New `loops` table (owned by `loops.ts`, self-contained like `scheduler.ts`)

```sql
CREATE TABLE IF NOT EXISTS loops (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  project_id             TEXT NOT NULL,
  kind                   TEXT NOT NULL,          -- 'manager' | 'worker'
  control_plane          TEXT NOT NULL DEFAULT 'board', -- 'board' | 'github'
  schedule_id            TEXT,                   -- FK → schedules.id (reuse the wake clock)
  contract               TEXT NOT NULL,          -- JSON LoopContract
  mode                   TEXT NOT NULL DEFAULT 'dry-run', -- 'dry-run' | 'apply' (forced start)
  consecutive_good_runs  INTEGER NOT NULL DEFAULT 0,
  escalation_threshold   INTEGER NOT NULL DEFAULT 3,
  merge_posture          TEXT NOT NULL DEFAULT 'human-gate', -- 'human-gate' | 'auto-low-risk'
  review_policy          TEXT NOT NULL DEFAULT 'always',     -- 'always' | 'threshold:<N>' | 'off'
  risk_rubric            TEXT NOT NULL DEFAULT '[]', -- JSON: [{glob, force_risk}]
  routable_ceiling       TEXT NOT NULL DEFAULT 'low',-- max risk that may be agent:ready
  enabled                INTEGER NOT NULL DEFAULT 1,
  last_run_id            TEXT,
  last_eval              TEXT,                   -- JSON LoopEvalResult of the most recent run
  last_error             TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loops_project ON loops(project_id, enabled);
```

Schema is created idempotently (`CREATE TABLE IF NOT EXISTS` + the swallow-`duplicate column name` ALTER loop already used by `kanban.ts`/`scheduler.ts`).

### 4.2 `ExecutionPhase` extension (`packages/shared/src/index.ts:631`)

Add two values to the existing union:

```
'idle' | 'building' | 'validating' | 'merging' | 'conflicts'
  | 'paused-budget' | 'failed' | 'resolving'
  | 'inspecting'   // NEW: a dry-run loop is reporting intended actions, changing nothing
  | 'reviewing'    // NEW: a separate Reviewer agent (maker/checker) is judging the diff
```

### 4.3 Reused `kanban_tasks` columns (confirmed present, `kanban.ts` + `index.ts:642`)

The Manager loop's write targets **already exist** and are currently human-only:

- `assignee TEXT NOT NULL DEFAULT 'human'` → becomes `'pm'` when `agent:ready`.
- `labels TEXT NOT NULL DEFAULT '[]'` (JSON `string[]`) → carries `risk:low|medium|high`, `type:<type>`, `agent:ready`, `needs:human`.
- `column` (`Backlog`→`Ready` on promotion), `depends_on`, `priority`, `pr_url`/`pr_state`, `mode`, `model`, `validation_command` — all reused unchanged.

`kanban.ts` `createTask` currently hardcodes `assignee:'human'`, `labels:[]` — unchanged. The Manager loop (not the create path) writes these via the control-plane adapter.

### 4.4 New card comment thread (board adapter assessment target)

```sql
CREATE TABLE IF NOT EXISTS kanban_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  author      TEXT NOT NULL,   -- 'manager' | 'reviewer' | 'worker' | 'human'
  body        TEXT NOT NULL,   -- the Agent Assessment / review verdict (markdown)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_comments_task ON kanban_comments(task_id, created_at);
```

The github adapter writes assessments as GitHub issue comments instead (see §5).

### 4.5 New shared types (`packages/shared/src/index.ts`)

```ts
export type RiskLevel = 'low' | 'medium' | 'high';
export type WorkType = 'bug' | 'feature' | 'docs' | 'test' | 'refactor' | 'chore';
// Keyed (object) form — consumers index by key, e.g. RISK_LABELS.low === 'risk:low'.
export const RISK_LABELS = { low: 'risk:low', medium: 'risk:medium', high: 'risk:high' } as const;
export const TYPE_LABELS: Record<WorkType, string> = { bug:'type:bug', feature:'type:feature', docs:'type:docs', test:'type:test', refactor:'type:refactor', chore:'type:chore' };
export const ROUTING = { ready: 'agent:ready', needsHuman: 'needs:human' } as const;

export interface Loop { /* mirrors the loops table, camelCase */ }
export interface LoopContract { /* §3 */ }
export interface TriageVerdict { risk: RiskLevel; type: WorkType; agentReady: boolean; reason: string; questions?: string[]; }
export interface LoopEvalResult { clean: boolean; score: number; notes: string; }
```

---

## 5. Control-plane adapter (configurable per loop)

A single interface with two implementations, in a new `controlplane.ts`. A loop's `control_plane` field selects the adapter at fire time. The Worker loop's *execution* (worktree build, validate, PR) is identical across adapters — only backlog read/classify/write differs.

```ts
interface WorkItem { id: string; title: string; body: string; labels: string[]; }

interface ControlPlane {
  listBacklog(projectId: string): Promise<WorkItem[]>;   // unclassified / untriaged work
  listReady(projectId: string): Promise<WorkItem[]>;     // agent:ready + within routable_ceiling
  classify(id: string, v: TriageVerdict): Promise<void>; // write risk/type + agent:ready|needs:human
  postAssessment(id: string, markdown: string): Promise<void>;
  attachQuestions(id: string, questions: string[]): Promise<void>; // needs:human escalation
}
```

- **board adapter** → `kanban_tasks` via `kanbanRepo`. `listBacklog` = `column='Backlog'` cards lacking a `risk:*` label (untriaged); `listReady` = `column='Ready'` (already `readyTasksStmt`, `priority DESC, rank ASC`); `classify` writes `labels`/`assignee` and on `agentReady` moves `Backlog`→`Ready`; `postAssessment` inserts a `kanban_comments` row and broadcasts on the board SSE; `attachQuestions` appends to labels + a comment. Fully offline.
- **github adapter** → `listBacklog` = open issues lacking a `risk:*` label; `listReady` = open issues carrying `agent:ready`. Reads via the existing `triggers.ts` issue intake (`gh api repos/<repo>/issues`); writes via **new `gh.ts` verbs**: `ghLabelAdd`/`ghLabelRemove` (`gh issue edit --add-label`), `ghIssueComment` (`gh issue comment`). Requires a GitHub remote + `gh` auth (same precondition as `triggers.ts`/`gh.ts` today). Each new verb follows the `ghExec` never-throw + `scrubCredentials` contract.

**Dry-run mode wraps the adapter:** in `mode='dry-run'`, `classify`/`postAssessment`/`attachQuestions` are intercepted — the intended write is logged to the run timeline and `last_eval`, but no state changes. Only `mode='apply'` performs real writes.

---

## 6. Loop lifecycle & scheduler integration

### 6.1 Scheduler reuse (`scheduler.ts` extension)

A `schedules` row may target a `loopId` instead of a raw `launch_request`. When the tick fires such a schedule it calls `loops.fire(loopId)` rather than `registry.launch` directly. Add a **"fire only if there is work" predicate**: a Manager fire is skipped (no-op, no spend) when `listBacklog` is empty; a Worker fire is skipped when `listReady` is empty. The cadence, enable/disable, run-now, and 429/daily-cap deferral are inherited unchanged.

### 6.2 The lifecycle state machine

```
schedule tick ─▶ loops.fire(id)
                   │
                   ├─ mode = 'dry-run' ─▶ run JOB with adapter in INSPECT-ONLY
                   │                       (logs intended writes; phase 'inspecting')
                   │                          │
                   │                   loopEval.grade(run, contract)
                   │                          │
                   │                   clean? ── yes ─▶ consecutive_good_runs++
                   │                   │                 ≥ escalation_threshold?
                   │                   │                    └─ yes ─▶ mode='apply' (AUTO, notify)
                   │                   └── no ─▶ consecutive_good_runs = 0; store last_eval
                   │
                   └─ mode = 'apply'  ─▶ run JOB with adapter performing REAL writes
```

Auto-escalation has **no human gate** (per decision): a notification is emitted via `notifier.ts` when a loop flips to apply-mode. The counter resets on any non-clean dry run.

---

## 7. `loopEval.ts` — judgment grader

Reuses the `benchmarks.ts` LLM-judge json-schema pattern. After each dry run, an LLM-judge run grades the loop's *judgment* against its contract's `evaluation` criterion and the loop kind:

- **Manager:** did it reject risky work (not mark `risk:high` as `agent:ready`)? did it attach specific questions to ambiguous items? did it honor the rubric hard-floors? is each verdict's `reason` evidence-backed?
- **Worker:** did its intended plan stay within `agent:ready`+`risk:low`? did it respect `forbidden`? would it have opened a PR without merging?

Output `LoopEvalResult { clean, score, notes }` via `--json-schema`. `clean` gates the escalation counter; `notes` are surfaced in the UI and stored in `loops.last_eval`.

---

## 8. Manager loop (`manager.ts`)

Per fire (in apply-mode):

1. `cp.listBacklog(projectId)` → untriaged items.
2. For each item, launch a **read-only Manager run** that emits a `TriageVerdict` via `--json-schema` (the `campaigns`/`benchmarks` path). The Manager template (`templates.ts`, read-only, no write tools) reads the item + repo context.
3. **Apply rubric hard-floors** (`risk_rubric`): if the item touches any configured sensitive glob (`auth`, `migrations`, CI config, secrets, deletions), force `risk:high` + `agentReady:false`, **overriding the agent's verdict**. Record the override in the assessment.
4. `cp.classify(id, verdict)` — write `risk:*`/`type:*` labels; if `agentReady` *and* risk ≤ `routable_ceiling` (default `low`), set `agent:ready` + `assignee='pm'` (board: move to `Ready`); else `needs:human` + `cp.attachQuestions`.
5. `cp.postAssessment(id, "Risk: … Type: … Agent-ready: … Reason: …")`.

**The Manager never writes code.** Its contract `forbidden` compiles to a read-only tool envelope (no `Edit`/`Write`/`Bash(git …)`). It does not auto-generate the backlog — humans (or `triggers.ts` intake) create items.

---

## 9. Worker loop (PM extension)

The Worker loop **is** `pm.ts`, generalized:

- **Selection gate:** only pick up items that are `agent:ready` *and* within `routable_ceiling` (today `pm.tick` selects bare `column='Ready'`; add the label/risk filter so a human-dragged-but-not-triaged card is not silently worked when a Manager loop owns the project). **Backward-compatible:** the filter engages *only* for a project that has an enabled `kind='worker'` Loop; a project with no Loop keeps today's exact PM behavior (bare `column='Ready'`), so existing PM-only users are unaffected.
- **`reviewing` phase (maker/checker):** in the shared `validateAndGate` funnel, after `validateCard` passes, if `review_policy` ≠ `off` (and, for `threshold:N`, the diff changed **more than N files**), launch a **separate Reviewer run** (`review.ts`, existing adversarial read-only template) on the worker's diff. `execution_phase='reviewing'`.
  - **pass** → proceed to gate.
  - **reject** → `rework`: relaunch a fix run with the reviewer's findings threaded as the fix prompt, reusing the existing `attempt_count`/`max_attempts` cap and the `last_diff_hash` no-progress guard.
- **Gate** honors `merge_posture` (§11).

The maker is never the only judge of its own diff (contract default `review_policy='always'`).

---

## 10. Contract → permissions compilation

On loop create/edit, `loops.ts` compiles the contract into the launch envelope used for every run the loop spawns:

- `contract.allowed` → `LaunchRequest.allowedTools`.
- `contract.forbidden` → merged into `disallowedTools`, **on top of** `pm.disallowedToolsForProject(project)` — the baseline `Bash(git push *)`/`Bash(git remote *)` deny is never relaxed beyond the project's existing `pushEnabled` rule. Compilation may only add denies.
- `permissionMode` set per kind (Manager runs read-only/non-interactive; Worker uses the existing PM `bypassPermissions`-in-isolated-worktree posture).
- Budget/concurrency/daily-cap/timeout guardrails are inherited from the registry envelope unchanged.

---

## 11. Merge gate posture

`merge_posture` defaults to `'human-gate'`: the Worker opens a PR / parks the card in `Review`; `gh.prMerge` stays uncalled (locked decision preserved). A loop may opt into `'auto-low-risk'`, which auto-merges **only** when *all* hold: local merge mode, `risk:low`, maker/checker passed, and the global `loopAutoMergeCeiling` portal-config flag permits it. The **PR path never auto-merges** under any posture. `risk:medium`/`risk:high` are always human-gated.

---

## 12. Risk taxonomy & rubric

- **Agent-inferred:** the Manager emits `{risk, type, agentReady, reason}` per item.
- **Rubric hard-floors:** `risk_rubric` is a list of `{glob, force_risk}` rules; any item matching a sensitive glob is forced to `force_risk` (default `high`), overriding the agent. Ships with sane defaults (auth, DB migrations, CI config, secrets, deletions → `high`).
- **Human override:** editing a card's labels/`assignee` (board) or issue labels (github) overrides any verdict — the reversibility property.
- **Routable ceiling:** `routable_ceiling` (default `low`) is the max risk the Manager may mark `agent:ready`.

---

## 13. Permissions, guardrails, backpressure (reused)

No new safety machinery — the feature rides the existing envelope: registry concurrency (`429`), per-run budget auto-kill, `dailySpendCeilingUsd` (`409 daily-cap`), wall-clock timeout, and `fleet.tryAdmit` cross-project fair-share. Loop fires that hit a cap defer (don't advance the schedule / don't mark items worked), exactly like `scheduler.ts`/`triggers.ts` today.

---

## 14. Reversibility

- Wrong verdict → drag the card back a column / edit labels (board) or remove the label (github).
- Bad worker run → isolated worktree means main is untouched; close the unmerged PR.
- Bad loop → disable it (`enabled=0`) or revert it to `dry-run`.
- Every classification carries an Agent Assessment, so decisions are auditable, not opaque.

---

## 15. New modules & changed files

### New
| File | Responsibility |
|---|---|
| `apps/server/src/loops.ts` | `Loop` entity + `loops` table + driver (`fire`, lifecycle, escalation) + CRUD/run-now routes |
| `apps/server/src/manager.ts` | Built-in Manager (triage) loop algorithm |
| `apps/server/src/loopEval.ts` | Judgment grader (LLM-judge json-schema), gates apply-mode escalation |
| `apps/server/src/controlplane.ts` | `ControlPlane` interface + board adapter + github adapter + dry-run wrapper |
| `apps/server/src/review.ts` | Maker/checker gate: launch Reviewer on the worker diff, parse verdict, route pass/reject |

### Extended
| File | Change |
|---|---|
| `apps/server/src/scheduler.ts` | A schedule may target `loopId`; "fire only if work exists" predicate |
| `apps/server/src/gh.ts` | New `ghLabelAdd`/`ghLabelRemove`/`ghIssueComment` verbs; widen `prView --json` (labels/reviewDecision) |
| `apps/server/src/pm.ts` | `reviewing` phase in `validateAndGate`; `agent:ready`+risk selection filter; merge-posture honoring |
| `apps/server/src/kanban.ts` | risk/type label vocabulary helpers; `kanban_comments` table + thread; promotion gate |
| `apps/server/src/server.ts` | Register loop routes + wire `loops.init()` beside `pm.init()`/`campaigns.init()` |
| `packages/shared/src/index.ts` | `Loop`/`LoopContract`/`TriageVerdict`/`LoopEvalResult`/`RiskLevel`/`WorkType`/label constants; `ExecutionPhase` += `inspecting`/`reviewing` |
| `apps/server/src/templates.ts` | Manager profile (read-only); bind Reviewer as the structural checker |
| `apps/server/src/notifier.ts` | Notify on auto-escalation to apply-mode |
| `apps/web/**` | A **Loops** view: contract editor (6 fields, EVALUATION required), mode badge (dry-run/apply + counter), per-loop control-plane + posture config, last-eval panel, assessment thread |

---

## 16. API routes (REST, mirroring `scheduler.ts`/`triggers.ts`)

```
GET    /api/loops                 list (newest first)
POST   /api/loops                 create (rejects empty contract.evaluation)
GET    /api/loops/:id             detail (+ last_eval, last_run)
PUT    /api/loops/:id             edit (enable/disable, contract, posture, schedule) — re-validate
DELETE /api/loops/:id
POST   /api/loops/:id/fire        run-now (one fire, respects mode)
POST   /api/loops/:id/promote     manual flip dry-run → apply (escape hatch)
POST   /api/loops/:id/demote      flip apply → dry-run
GET    /api/tasks/:id/comments    card assessment thread (board adapter)
```

---

## 17. Web UI

A new **Loops** section in the web app:
- **List** — each loop with kind badge (manager/worker), control-plane badge (board/github), mode badge (`dry-run N/3` ↔ `apply`), enabled toggle, last-eval status.
- **Contract editor** — the six fields; `evaluation` required (save disabled while empty); `allowed`/`forbidden` as tool-pattern lists; merge posture, review policy, routable ceiling, risk rubric.
- **Loop detail** — recent fires, the dry-run intended-action log, `loopEval` notes, the Agent Assessment thread, manual promote/demote.

---

## 18. Error handling

- Adapters never throw out of a fire — expected failures (missing `gh` auth, no remote, API error) land in `loops.last_error` and the timeline, exactly like `triggers.ts`.
- Cap-blocked fires defer (no counter advance, no state write).
- `loopEval` failure → treated as a non-clean run (counter resets), never auto-escalates on uncertainty.
- Boot reconcile: a loop left mid-fire on restart is reset to idle (mirrors `pm.reconcile()`); `mode`/counter persist in SQLite, so a restart never silently re-grants apply-mode.

---

## 19. Testing strategy

- **Unit:** rubric hard-floor matching (sensitive globs force `high`); contract→tool compilation (`forbidden` never relaxes the baseline deny); escalation counter (clean → ++, non-clean → reset, ≥threshold → flip); EVALUATION-required create rejection; dry-run wrapper suppresses all adapter writes.
- **Adapter:** board adapter classify/promote/comment against an in-memory SQLite; github adapter verbs against a mocked `ghExec`.
- **Integration:** drive a Manager loop `dry-run → 3 clean evals → auto-apply` against a mock control plane; drive the Worker `reviewing` path `reject → rework → pass → gate`; verify `merge_posture='human-gate'` never calls `prMerge`.
- **Regression:** existing PM/campaign/scheduler/triggers tests stay green (we extend, not rewrite).

---

## 20. Scope decisions (resolved during brainstorming)

| Decision | Resolution |
|---|---|
| Abstraction depth | **First-class Loop entity** with the full six-part contract (loop-engineering as the organizing abstraction) |
| Control plane | **Pluggable per loop**: `board` (kanban) \| `github` (issues+labels) |
| Merge gate | **Per-loop posture, `human-gate` default**; opt-in `auto-low-risk` only for local + risk:low + review-pass, under a global ceiling; PR path never auto-merges |
| Dry-run escalation | **Forced dry-run**, `loopEval`-graded, **auto-escalate** after N (default 3) clean runs (notify, no human gate) |
| Risk taxonomy | **Agent-inferred verdict + deterministic rubric hard-floors** for sensitive paths; human override; default routable ceiling `risk:low` |
| Maker/checker | **Always** (contract default `review_policy='always'`); separate Reviewer on every apply-mode worker diff; reject → rework |
| Scope | **Per-project** Manager (fleet-wide ranking out of scope v1) |
| Self-feeding | **Prompted capability**, not hard-enforced |

---

## 21. Build sequence (high level — detailed plan via writing-plans)

1. **Shared types** — `Loop`/`LoopContract`/`TriageVerdict`/`LoopEvalResult`, label constants, `ExecutionPhase` additions.
2. **`loops.ts`** — table, CRUD routes, contract validation, compilation, the driver shell (no Manager/Worker logic yet).
3. **`controlplane.ts`** — interface + board adapter + dry-run wrapper (github adapter after).
4. **`scheduler.ts`** — `loopId` target + work-exists predicate.
5. **`loopEval.ts`** — judgment grader.
6. **`manager.ts`** — triage algorithm + rubric hard-floors; wire as a built-in loop kind.
7. **`gh.ts` verbs + github adapter** — label/comment write path.
8. **`review.ts` + `pm.ts` `reviewing` phase** — maker/checker; selection filter; merge posture.
9. **Web Loops view.**
10. **Tests** at each layer (TDD per the project's discipline).

Each step is independently testable and leaves the existing PM/scheduler/campaigns paths untouched.
