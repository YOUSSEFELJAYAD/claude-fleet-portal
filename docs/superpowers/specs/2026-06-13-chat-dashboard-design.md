# Chat Dashboard — multi-session agent control-plane — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Decisions log:** DC.md §30 (D-029…D-032 + DEFERRED)
**Scope:** v1 builds the full superset in one cycle — ① multi-session live chat, ② running-agents panel, ③ slash-command control-plane, ④ engine add-on chat.

## 1. Goal

A conversational `/chat` dashboard that is both a **live agent chat** (talk turn-by-turn with a Claude session, like Codex's interactive mode) and a **fleet control-plane** (slash-commands drive the app's existing functions; a live panel shows running agents). Multiple sessions run side-by-side. Each session exposes all of the app's launch options. Sessions can also run on an engine add-on (codex/opencode).

## 2. Transport (key architectural decision — DC §D-029)

A chat **session maps to one run id**, advanced **resume-per-turn**:

- **Turn 1:** `POST /api/agents` with the user's message as `prompt` and the session's launch options. Returns a run id, stored on the session.
- **Turn N:** `POST /api/agents/:id/resume` with the next message (`registry.resume(id, prompt, interactive)` already exists).
- **Streaming:** the assistant's output streams over the run's existing SSE (`GET /api/agents/:id/stream`); on terminal status the final result text is persisted as the assistant message.

**Why not a long-lived interactive process:** the fleet caps concurrent runs at 8 (`config.maxConcurrentRuns`). A live `interactive:true` process per open chat would starve the fleet, can't survive a server restart, and is Claude-only. Resume-per-turn holds a slot only during a turn, survives restarts (state is the persisted transcript + session id), and unifies Claude and engine sessions. (Long-lived interactive + `/api/agents/:id/input` is noted as the snappier-but-rejected alternative.)

## 3. Architecture

### Components (isolated, single-purpose)

| Component | Action | Responsibility |
|---|---|---|
| `apps/server/src/chat.ts` | create | Session + message persistence, turn orchestration (launch/resume; engine context reconstruction), routes. |
| `apps/server/src/commands.ts` | create | Slash-command registry + dispatch to existing routes/registry; returns structured command results. |
| `apps/server/src/db.ts` | modify | `chat_sessions`, `chat_messages` tables. |
| `apps/server/src/server.ts` | modify | `registerChatRoutes(app)`. |
| `packages/shared/src/index.ts` | modify | `ChatSession`, `ChatMessage`, `ChatTurnRequest/Response`, `ChatCommandResult`, message-role/kind unions. |
| `apps/web/app/chat/page.tsx` | create | 3-pane dashboard wiring the components below. |
| `apps/web/components/ChatSessionList.tsx` | create | Left pane: session switcher (new/rename/delete/select). |
| `apps/web/components/ChatThread.tsx` | create | Center: message list + streaming assistant output. |
| `apps/web/components/ChatComposer.tsx` | create | Center bottom: input + options popover (reuses `ModelSelect`, tool/skill pickers) + slash `CommandMenu`. |
| `apps/web/components/RunningAgentsPanel.tsx` | create | Right pane: live running runs via `/api/fleet/stream`. |
| `apps/web/lib/api.ts` | modify | Chat client helpers. |
| `apps/web/components/Shell.tsx` | modify | `/chat` nav entry. |

### Data model (sqlite)

- `chat_sessions(id, title, engine, model, effort, permission_mode, cwd, allowed_tools, skills, run_id, created_at, updated_at)` — `run_id` is the current backing run (null until the first turn); launch options are the session defaults.
- `chat_messages(id, session_id, role, kind, content, run_id, created_at)` — `role` ∈ {user, assistant, system}; `kind` ∈ {text, command, command-result, error}; `run_id` links an assistant turn to the run that produced it.

## 4. Data flow

- **Create session** → row in `chat_sessions` with default options → appears in the switcher.
- **Send a text message:**
  1. Persist the user message.
  2. Orchestrate the turn — **Claude:** turn 1 `POST /api/agents`, turn N `POST /api/agents/:id/resume`; **engine:** a fresh one-shot launch whose prompt is a capped reconstruction of the transcript + new message (engines can't resume — DC §D-030).
  3. The web client streams the backing run's SSE into `ChatThread`; on terminal, persist the assistant message (final result text) and link its `run_id`.
- **Send a slash-command** (message starts with `/`): the composer routes it to `POST /api/chat/commands` → `commands.ts` parses + dispatches to the existing route/registry → returns a `ChatCommandResult` rendered as a `command-result` message (e.g. `/agents` → a running-runs table; `/launch …` → "started run X" with a link).
- **Running-agents panel** subscribes to `/api/fleet/stream` and lists non-terminal runs with quick links/actions (open run, kill).

## 5. Slash-command control-plane (DC §D-031)

A registry maps `/<name>` → handler. v1 set:

| Command | Dispatches to |
|---|---|
| `/launch <opts> <prompt>` | `registry.launch` (a one-off agent, not a chat turn) |
| `/agents` | list non-terminal runs |
| `/kill <id>` | `POST /api/agents/:id` DELETE / stop |
| `/addons` | `GET /api/addons` |
| `/addon enable|disable <id>` | `POST /api/addons/:id/{enable,disable}` |
| `/campaign <objective>` | `campaigns.create` |
| `/schedule …` | schedule routes |
| `/help` | the registry's own list |

Autocomplete in `CommandMenu` is driven by the registry. Commands inherit the auth/permission posture of the routes they call — no new privileged surface.

## 6. Engine add-on chat (DC §D-030)

`session.engine` selects the backing engine. Engine turns are one-shot with a capped reconstructed transcript prefix and a visible "one-shot per turn · limited memory" badge. Engine sessions are only offered when the matching add-on is enabled (reuses the existing engine-gating).

## 7. Layout

3-pane `/chat`: left = `ChatSessionList`; center = `ChatThread` + `ChatComposer` (with the options popover = model/engine/effort/tools/skills/permission-mode/cwd); right = `RunningAgentsPanel` + `CommandMenu`.

## 8. Error handling

Turn-launch failure, concurrency cap (429), engine-disabled, SSE disconnect (reconnect via `Last-Event-ID`), and command errors are all surfaced as inline `error`/`system` messages in the thread — never a crash or blank state. Reopening a session always renders the persisted transcript even if the backing run is gone.

## 9. Security

Commands run with the same auth/permission posture as the routes they invoke; command arguments are validated before dispatch. Chat prompts are user-authored (no untrusted-content injection surface as in web-research). Reuses the existing Host-allowlist and CORS guards. No secrets stored.

## 10. Testing (vitest + build)

- `chat.test.ts`: session CRUD; turn orchestration (mock `registry.launch`/`registry.resume`, assert turn 1 launches and turn N resumes the stored run id); engine turn reconstructs a capped transcript prompt; assistant message persisted on terminal.
- `commands.test.ts`: each command parses + dispatches to the correct route/registry call; unknown command and bad args return a clear `command-result`/error.
- Web: `pnpm -r typecheck`, `pnpm --filter @fleet/web build` (with `/chat` route present).

## 11. Out of scope / deferred (DC §30 DEFERRED — "need to be installed" later)

- **Voice** (speech in/out).
- **File uploads / attachments** into a chat turn.
- **Multi-user** — single-operator portal; no per-user sessions/auth.
- **In-chat transcript search** — the FTS5 transcript index already exists (`search.ts`, F7) and can be layered onto chat history later; not wired into the chat UI in this build.
