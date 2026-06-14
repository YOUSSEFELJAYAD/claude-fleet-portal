# Chat Surface Upgrade — end-to-end conversational control-plane — Design Spec

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Supersedes / extends:** `2026-06-13-chat-dashboard-design.md` (the shipped MVP). This spec **reverses** that doc's §2 transport decision ("resume-per-turn over a long-lived process") in favour of an **always-live process with a graceful resumable fallback** (see §3 D1).
**Decisions log:** DC.md §30 (D-029…D-032), §32 (design system). New decisions D-033…D-041 below to be appended to DC.md.
**Supersedes stale line:** PRD §11 "abort and session-resume are mutually exclusive" — no longer true; the registry resumes terminal/killed runs.

---

## 1. Goal

Turn the thin `/chat` MVP into an **end-to-end, ChatGPT/Claude-grade conversational control-plane** for the Fleet Portal. Concretely:

1. **Sessions stay open, killable, and resumable.** A focused session feels always-live (instant turns, mid-turn input, working inline permissions); kill stops it; it resumes later with full memory. This must not starve the fleet's batch concurrency.
2. **All high-value app functions are reachable from chat** via a curated, typed slash-command registry, with the long tail invoked by the agent as natural-language tool-calls. Destructive actions route through the existing Inbox approval queue.
3. **`/` opens a command autocomplete** — a keyboard-navigable, grouped, filtered palette (Portal verbs · Skills · Subagents) with argument hints.
4. **`@` opens a file/folder mention picker** scoped to the session's workspace (auto-detected from `cwd`), inserting removable attachment chips.
5. **Full-fidelity rendering** — Markdown + code highlighting, real tables, collapsible tool-call & thinking cards, live token streaming, inline permission approve/deny, a stop-generating button.

**Non-goals (v1):** binary/non-repo file uploads; inlining large file contents (path-reference only); a generic "call any of the ~120 routes" surface; multi-user.

---

## 2. Confirmed product decisions (from brainstorm)

| # | Decision | Choice |
|---|---|---|
| D1 | Session model | **Always-live process + graceful resumable fallback** (separate chat budget + idle auto-suspend). |
| D2 | Function scope | **Curated typed slash registry (~18 verbs) + NL long-tail**; mutations via Inbox. |
| D3 | Project scope for `@` | **Auto-detect workspace from session `cwd`** (git root, else gitignore-aware walk). No session schema change. |
| D4 | Rendering depth | **Full ChatGPT-grade** (markdown, tables, tool/thinking cards, live tokens, inline permissions, stop button). |
| D5 | Command catalog source | One **declarative registry** feeding dispatch + `GET /api/commands` + `/help` + the composer. |
| D6 | `/` menu contents | **Merged & grouped**: Portal verbs · Skills · Subagents. |
| D7 | `@` attach semantics | **Files = path reference** the agent reads at runtime; **folders = `--add-dir`**. |
| D8 | Engine (codex/opencode) | One-shot with **emulated resume** (reconstructed transcript), badged "one-shot · limited memory". |

---

## 3. Session lifecycle — always-live with resumable fallback (D1, the load-bearing decision)

### 3.1 States

A session has a derived state: `live · running · idle · killed`.

- **live** — a long-lived interactive Claude process is held for this session (`--input-format stream-json`, `interactive:true`), stdin open. Turns are instant; mid-turn input and inline permission approve/deny work.
- **running** — a turn is currently streaming.
- **idle (resumable)** — no held process (never started, idle-evicted, or after restart). The next message transparently re-spawns via `--resume <sessionId>` with full Claude memory (~1s spin-up). User sees no functional difference.
- **killed** — the user explicitly killed the live turn/process. Next message resumes (kill is not delete).

The transcript always renders from SQLite regardless of process state; the live process is ephemeral and re-derived.

### 3.2 Why this is safe for the fleet (the §2-reversal justification)

The prior spec rejected always-live because the fleet caps concurrent runs at 8 and a held process per chat would starve batch work. Three mechanisms remove that objection:

1. **Separate chat budget.** Live chat processes draw from a dedicated pool `CHAT_LIVE_MAX` (default 4), tracked independently from `config.maxConcurrentRuns` (the fleet/batch cap). Chat can never consume batch slots; batch can never consume chat slots. When `CHAT_LIVE_MAX` is exhausted, a newly-focused session falls back to **resumable** mode (still fully usable, just ~1s slower per turn) rather than blocking.
2. **Idle auto-suspend.** A live process idle past `CHAT_IDLE_SUSPEND_MS` (default 10 min) is evicted → session drops to **idle**. Reclaims the chat slot; next message resumes transparently.
3. **Kill / restart = resume fallback.** Explicit Kill or a server restart ends the process and marks the session resumable. State is the persisted transcript + session id, so nothing is lost.

**Net:** "always open" is true from the user's view (any session continues instantly or near-instantly) without holding 12 processes hostage. Engines (codex/opencode) never go live — one-shot + emulated resume only (D8).

### 3.3 Backend surface

- **Live manager** (`apps/server/src/chatLive.ts`, new): owns the map `sessionId → live process handle`, the `CHAT_LIVE_MAX` semaphore, idle timers, and ensure/evict logic. `ensureLive(sessionId)` returns a live handle or signals fallback-to-resumable.
- `registry.launch({ interactive:true, sessionId, … })` and `registry.resume(sessionId, msg)` already exist; the live manager chooses which.
- **Interrupt:** `POST /api/chat/sessions/:id/interrupt` → stops the current turn but keeps the process live if possible (else marks killed).
- **Kill:** `DELETE` semantics via existing `registry.stop(runId)` → session becomes killed/resumable.
- **Input:** `POST /api/chat/sessions/:id/input` → writes to the live process stdin (mid-turn input + permission decisions). Returns 409 with a clear message if the session isn't live.
- **Status:** session read derives `state` + `live:boolean` from the live manager + backing run status.

---

## 4. Transport — chat-scoped SSE (new decision D-037; fixes reload-orphaning)

New **`GET /api/chat/sessions/:id/stream`** (SSE): the client subscribes to the *session*, not a run id. The server proxies whichever run currently backs the session. This survives kill→resume (the run id changes underneath) and survives page reload (today `liveRunId` is local React state and a streaming turn is orphaned on refresh). The stream emits the full event vocabulary `live.ts` already exposes: `assistant_partial` (token deltas), `assistant_text`, `tool_use`, `tool_result`, `thinking`, `permission_request`, `subagent_spawned`, `result`, plus chat-control events (`session_state`).

---

## 5. Command registry — one declarative source of truth (D5/D6)

### 5.1 Shape

Refactor `apps/server/src/commands.ts` from a `switch` + static `HELP` string into a declarative array consumed by **both** `dispatchCommand` **and** a new `GET /api/commands`:

```ts
interface CommandDef {
  name: string;                 // 'kill'
  group: 'control' | 'project' | 'knowledge' | 'config' | 'meta';
  description: string;
  usage: string;                // '/kill <run-id>'
  args: Array<{
    name: string; required: boolean;
    type: 'string' | 'enum' | 'run-id' | 'project' | 'prompt';
    enum?: string[];
    source?: 'running-runs' | 'addons' | 'templates'; // live-value autocomplete
    hint?: string;
  }>;
  resultKind: 'text' | 'table' | 'error' | 'ack';
  danger?: boolean;             // routes through Inbox approval
  run(ctx): Promise<ChatCommandResult>;
}
```

### 5.2 v1 verb set (~18)

`/launch /resume /sessions /stop /stop-all /agents /research /search /git /files /board /task /schedule /template /memory /spend /addons /releases /help`.
The **long tail** (~100 other routes) is reachable by the agent as NL tool-calls. **Destructive** verbs (and the NL long-tail's mutations: delete project, reset-data, self-update, file-commit) route through the existing **Inbox approval queue** — no new privileged surface (preserves DC D-031).

### 5.3 `/` autocomplete data

`GET /api/commands` returns `CommandDef`s (minus `run`). The `/` menu also merges `GET /api/skills?cwd=` (SKILL.md skills + plugin commands + builtins) and `GET /api/subagents`, grouped under headers. Catalog scans are disk I/O, so the client **caches the response and debounces** keystroke filtering (filter happens client-side over the cached list). Args with a `source` fetch live values on demand (e.g. `/kill ` → suggest running run-ids).

---

## 6. `@` file/folder mentions (D3/D7)

### 6.1 Workspace resolution

New **`GET /api/files/find?cwd=&q=&limit=`** (`apps/server/src/fileview.ts`):
1. Resolve workspace root from `cwd`: if inside a git repo → repo root + `git ls-files` (fast, tracked files). Else a `.gitignore`-aware directory walk capped at `limit`.
2. If `cwd` matches a `projects.root_dir`, reuse existing project file endpoints; otherwise operate on the raw cwd.
3. Fuzzy-match files **and** folders against `q`; return `{path, kind:'file'|'dir', score}` with recents floated to the top. `safePath()` containment guard applies; paths are workspace-relative.

Large repos: `git ls-files` is fast; the fuzzy match runs server-side over the (cached per-cwd, short TTL) path list. Untracked files: optionally merge `git status` so new files appear.

### 6.2 Attach semantics

Selecting a result inserts a removable **chip** and adds to the turn's `attachments: Array<{path, kind}>`. On send:
- **file** → a path-reference token in the prompt; the agent reads it at runtime (no size cap, no inlining).
- **folder** → added to the launch/resume `--add-dir` set for that turn.

`ChatMessage` gains an optional `attachments` field (additive; old rows unaffected).

---

## 7. Rendering — full ChatGPT-grade (D4)

`ChatThread.tsx` + `LiveTurn` stop discarding events:

| Event / content | Rendering |
|---|---|
| assistant text | `MarkdownView` (react-markdown + GFM + Shiki) — replaces `<b>role:</b>{text}` |
| `assistant_partial` | live token streaming into the active bubble |
| `tool_use` / `tool_result` | collapsible **tool-call card** (name, args summary, output, status) |
| `thinking` | collapsible **thinking block** (dim, monospace) |
| `permission_request` | inline **approve / deny card** → `POST …/input` (works because the session is live) |
| `subagent_spawned` | **subagent chip** linking to its run |
| search results | compact **result cards** |
| `ChatCommandResult kind:'table'` | real `<table>` (currently discarded) |
| `kind:'text'` | markdown; `kind:'error'` | `ErrorBanner` |

A **Stop** button is shown while `state==='running'` (→ `…/interrupt`). Cards are chat-native and compact (not the heavy `Waterfall`/`Timeline`), reusing `MarkdownView`, `ShikiCode`, and existing `Badge`/`Dot`/`StatusBadge` primitives.

---

## 8. Session sidebar + scoped panel

- `ChatSessionList.tsx`: each row gains a **status dot** (live/running/idle/killed via `Dot`/`StatusBadge`), last-message preview, relative timestamp, and per-row **Kill / Resume** buttons. Rename moves off `window.prompt` to an inline edit.
- `RunningAgentsPanel.tsx`: becomes **session-scoped** — shows the active session's backing run + its subagents (from the chat-scoped stream), not the fleet-wide list. (Fleet-wide view stays available on `/fleet`.)

---

## 9. New design-system primitive (DC §32 compliance)

The locked Mission-Control HUD has **no overlay/menu primitive**. Add one HUD-canon, keyboard-navigable **`FloatingMenu` / `Combobox`** to `apps/web/components/ui.tsx`, caret-anchored, click-outside-dismiss, arrow/enter/escape nav, grouped sections. Modeled on the existing `MultiPicker.tsx` interaction patterns and styled to HUD canon (charcoal, amber `#ffb000`, status colors, Chakra Petch/JetBrains Mono). Reused by **both** `/` and `@`.

---

## 10. Component / file inventory

| File | Action | Responsibility |
|---|---|---|
| `apps/server/src/chatLive.ts` | **create** | Live-process manager: `sessionId→handle` map, `CHAT_LIVE_MAX` semaphore, idle auto-suspend, ensure/evict. |
| `apps/server/src/commands.ts` | **modify** | Declarative `CommandDef[]`; `dispatchCommand` + `listCommands()` consume it; ~18 verbs; danger→Inbox. |
| `apps/server/src/chat.ts` | **modify** | Chat-scoped SSE; `/input`, `/interrupt`; derive session `state`/`live`; attachments on turn. |
| `apps/server/src/fileview.ts` | **modify** | `GET /api/files/find` (workspace resolve + fuzzy file/folder search + recents). |
| `apps/server/src/server.ts` | **modify** | Register `GET /api/commands`, `GET /api/files/find`, chat stream/input/interrupt routes. |
| `apps/server/src/config.ts` | **modify** | `CHAT_LIVE_MAX`, `CHAT_IDLE_SUSPEND_MS`. |
| `packages/shared/src/index.ts` | **modify** | `CommandDef`, `ChatSessionState`, attachment types, find-result types, chat-stream event union. |
| `apps/web/components/ui.tsx` | **modify** | `FloatingMenu`/`Combobox` HUD primitive. |
| `apps/web/components/ChatComposer.tsx` | **rewrite** | Multiline auto-grow textarea; `/` palette; `@` picker; attachment chips; Stop button; keybindings. |
| `apps/web/components/SlashMenu.tsx` | **create** | `/` command palette (grouped, filtered, arg hints) over `FloatingMenu`. |
| `apps/web/components/MentionMenu.tsx` | **create** | `@` file/folder picker over `FloatingMenu` + `/api/files/find`. |
| `apps/web/components/ChatThread.tsx` | **rewrite** | Markdown + event-driven cards + tables + live tokens + inline permissions + Stop. |
| `apps/web/components/ChatSessionList.tsx` | **modify** | Status dot, preview, timestamp, kill/resume, inline rename. |
| `apps/web/components/RunningAgentsPanel.tsx` | **modify** | Session-scoped run + subagents. |
| `apps/web/lib/api.ts` | **modify** | Helpers: `listCommands`, `findFiles`, chat stream/input/interrupt, kill/resume. |
| `apps/web/lib/live.ts` | **modify** | Chat-scoped stream subscription surfacing the full event vocabulary. |
| `apps/web/app/chat/page.tsx` | **modify** | Wire new composer/thread/panel + session state. |

---

## 11. Data model changes

- `chat_messages`: **add** optional `attachments` (JSON, nullable) — additive, old rows null.
- No new column required for session state (derived). Optionally cache `last_state` for fast list rendering (decided during planning).
- `CommandDef.run` stays server-only; the wire shape omits it.

---

## 12. Error handling

- **Chat budget exhausted** (`CHAT_LIVE_MAX`): session silently uses resumable mode; a subtle "resumable" badge explains the ~1s spin-up. No error shown.
- **`/input` when not live**: 409 with a clear message; client re-issues as a normal turn (which resumes).
- **Resume preconditions** (existing): non-terminal → 409, engine → 409, concurrency → 429, missing cwd → 400. Surface via `ErrorBanner`; 429 shows a "fleet busy, retry" affordance (the existing no-back-pressure gap is acknowledged, basic retry only in v1).
- **Reload mid-turn**: chat-scoped stream re-attaches to the backing run; no orphaned turn.
- **`@` search on huge/non-repo dirs**: capped by `limit`; clear "showing first N" note.
- **Engine sessions**: kill/resume controls hidden or badged; resume emulated via reconstructed transcript.
- All command/stream failures → `ChatCommandResult kind:'error'` → `ErrorBanner` (the one canonical error box).

---

## 13. Testing

- **Server unit:** `chatLive` semaphore + idle eviction + fallback; `commands` registry dispatch + danger→Inbox routing + `listCommands` shape; `files/find` fuzzy match + safePath containment + workspace resolution (repo vs non-repo); chat-scoped stream proxy across a kill→resume; attachment passthrough (`--add-dir` for folders).
- **Server integration:** turn over a live session; interrupt; kill→resume keeps memory; permission `/input` round-trip.
- **Web unit (vitest):** composer `/` and `@` trigger detection + chip add/remove + keybindings; `SlashMenu`/`MentionMenu` filter + keyboard nav; `ChatThread` renders each event kind (markdown, tool card, thinking, permission, table); session-list status mapping.
- Follow existing `fn-*`/`cov-*` test conventions in `apps/server/test` and `apps/web/test`.

---

## 14. Build sequence (each phase ships independently)

1. **Backend foundations** — command registry + `GET /api/commands`; `GET /api/files/find`; chat-scoped SSE; live manager + `/input` + `/interrupt` + derived status; config knobs.
2. **Composer + FloatingMenu** — multiline composer, `/` palette, `@` picker, chips, Stop; new HUD primitive.
3. **Rendering** — Markdown + event-driven cards + tables + live tokens + inline permissions.
4. **Session UI + concurrency** — status/kill/resume, session-scoped panel, chat budget + idle auto-suspend wired end-to-end.
5. **Command coverage** — wire the ~18 verbs + NL long-tail + Inbox routing for mutations.
6. **Engine degradation, tests, polish** — codex/opencode badging + emulated resume; full test pass; HUD QA.

---

## 15. New decisions to append to DC.md

- **D-033** Chat sessions are **always-live with resumable fallback** (reverses D-029's "resume-per-turn over a live process"), made safe by **D-034**.
- **D-034** Live chat processes use a **separate budget** `CHAT_LIVE_MAX` (default 4), distinct from `maxConcurrentRuns`; exhaustion → resumable fallback; idle eviction after `CHAT_IDLE_SUSPEND_MS`.
- **D-035** A single **declarative command registry** is the source of truth for dispatch + `GET /api/commands` + `/help` + composer autocomplete.
- **D-036** Chat exposes a **curated typed verb set (~18)** + NL long-tail; mutations route through the **Inbox** (no new privileged surface; preserves D-031).
- **D-037** **Chat-scoped SSE** (`/api/chat/sessions/:id/stream`) replaces per-run subscription for chat; survives kill→resume and reload.
- **D-038** `@` mentions resolve the workspace from session **`cwd`** (git root else gitignore walk); files = path reference, folders = `--add-dir`.
- **D-039** Full-fidelity rendering consumes the complete stream event vocabulary; inline permission approve/deny enabled by the live process.
- **D-040** One new HUD-canon **`FloatingMenu`/`Combobox`** primitive in `ui.tsx`, reused by `/` and `@`.
- **D-041** Supersedes **PRD §11** ("abort and session-resume are mutually exclusive").
