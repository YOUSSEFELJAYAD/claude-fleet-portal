# Design Spec — Chat Page Rework (turn model, search, composer)

> Date: 2026-06-25 · App: Claude Fleet Portal · Area: §30 Chat dashboard
> Status: approved design (pre-implementation). Supersedes the relevant parts of
> `2026-06-13-chat-dashboard-design.md` and `2026-06-14-chat-surface-upgrade-design.md`.

## 1. Goal

Rework the chat page so it is **simpler to reason about, robust, searchable, and pleasant to type in**. The current chat works and shipped, but its complexity is *accidental*: it makes a continuous conversation out of run primitives built for one-shot agents. This rework introduces a **first-class `turn`** as the unit of conversation and concentrates the messy run-juggling on the server behind a clean, turn-scoped interface — making the client a thin renderer. It also adds chat-transcript search and upgrades the composer.

Chosen ambition (user): **the right model, pragmatically** — build the turn abstraction (ground-up model) but *wrap* the proven `chatLive` + `registry` live/resume machinery rather than rewriting it. Engine (codex/opencode) sessions are **in scope**.

## 2. Current architecture & the problems it causes

A chat **session** = a `chat_sessions` row + persisted `chat_messages` + an *optional, shifting* backing run. Two execution modes: a **live held `claude` process** (≤`CHAT_LIVE_MAX`=4, turns via `registry.sendInput`, idle-suspended) or a **resumable one-shot chain** (each turn a fresh `launch`/`resume`, so the backing run id changes underneath). Engine sessions are always one-shot with transcript replayed into the prompt (capped ~6000 tokens).

Three pieces of "cleverness" cause most of the pain (and the scattered `fix 04/06/11/13/14` comments):

1. **Turn boundaries are *inferred*, not declared** — the client guesses a new turn from run-status transitions (`awaiting-input → running`, `live.ts:~310-327`). Fragile; source of "⟳ thinking…" hangs and duplicate renders.
2. **The transcript lives in two places** — persisted `chat_messages` *and* live SSE events — so `ChatThread` stitches them and dedupes the just-settled turn by `{runId, seq}` (`ChatThread.tsx:~144-173`).
3. **The backing run id mutates** — forcing `onBackingRunChange` signaling + SSE re-subscription, hello-event stripping, eviction signals (`chatLive.ts`, `chat.ts:~286-345`).

Plus gaps: **no chat search** (FTS5 in `search.ts` covers run transcripts only, not chat messages); **composer** over-fetches the `/` catalog, ignores `CommandDef.args` for completion, fires `@` `findFiles` per keystroke with no dedupe; **oversized/mixed files** (`chat.ts` 491 lines, `live.ts`, `ChatThread.tsx` each blend 2-3 concerns; partial-token accumulation duplicated in `useRunStream` + `useChatStream`).

## 3. Architecture — the turn model (the spine)

### 3.1 The `turn` concept
A **turn** is one user input → the assistant's full response → a terminal result. It has a stable `turnId` **independent of which run(s) back it**. The server keeps emitting under the same `turnId` even when a live process is evicted and the turn resumes on a fresh run.

New/changed shared types (`packages/shared/src/index.ts`):
```ts
export type ChatTurnStatus = 'pending' | 'streaming' | 'settled' | 'failed' | 'interrupted';

/** A turn as the client consumes it. History turns carry persisted `messages`;
 *  the single ACTIVE turn streams live via SSE (see 3.3) and persists on settle. */
export interface ChatTurn {
  id: string;            // turnId (uuid)
  sessionId: string;
  status: ChatTurnStatus;
  messages: ChatMessage[]; // user + assistant/command-result/error rows for this turn
  createdAt: number;
  settledAt: number | null;
}
```
`ChatMessage` gains `turnId: string` (DB column; see §7).

### 3.2 Server owns the mess (chatTurn.ts)
`startTurn` (moved out of `chat.ts`) mints a `turnId`, persists the user message with it, then dispatches via the **unchanged** execution machinery:
- **claude live**: `chatLive.ensureLive` → `registry.sendInput`; on no slot, one-shot `registry.launch`; subsequent turns `registry.resume`.
- **engine**: `buildEnginePrompt` (replayed history) → `registry.launchEngine` (one turn = one engine run).

The turn layer subscribes to the backing run, maps its `result`/terminal into **server-declared boundaries**, persists the assistant message(s) under the `turnId`, and emits `turn:settled`/`turn:failed`. All run-id juggling (live evict → resume → new run) stays **inside** this layer — the client never sees it.

**Kept as-is:** `chatLive.ts` (held-process budget, idle-suspend, pub/sub), the live-vs-resumable decision, security (`sessionRoot`/`containDirs`/`safePath`), `CHAT_LIVE_MAX`, attachment handling (`@`-file tokens + `--add-dir`).

### 3.3 Turn-scoped SSE (chatStream.ts) — replaces the run-proxy
`GET /api/chat/sessions/:id/stream` emits:
```ts
type ChatStreamFrame =
  | { kind: 'session_state'; state: ChatSessionState }        // live | idle | killed — NO runId
  | { kind: 'turn:start';   turn: ChatTurn }                  // pending/streaming, incl. persisted user message
  | { kind: 'turn:event';   turnId: string; event: NormalizedEvent } // streaming assistant content
  | { kind: 'turn:settled'; turnId: string; assistantMessageId: string }
  | { kind: 'turn:failed';  turnId: string; error: string }
  | { kind: 'error'; error: string };                         // fatal → close
```
The route resolves the active backing run server-side, re-tags its normalized events as `turn:event`, and re-subscribes transparently across run-id changes. **Only the active turn streams** — history is fetched separately.

### 3.4 History vs live split
- `GET /api/chat/sessions/:id` → session + the **latest page of turns** (messages grouped by `turnId`).
- `GET /api/chat/sessions/:id/turns?before=<ts>&limit=N` → older turns (cursor pagination — also fixes the "load 10k messages at once" gap).
- The SSE streams only the **active** turn.

This removes hello-event stripping (history is its own fetch) and the dual-source merge.

## 4. Client — thin turn renderer

### 4.1 `useChatStream(sessionId)` (rewritten, `lib/live.ts`)
Consumes turn frames; returns `{ state, activeTurn, error }` where `activeTurn: { turnId, status, events, partials } | null`. **Deleted:** status-transition boundary inference, `{runId, seq}` dedup, hello-stripping, run-id-change re-subscription, persisted-vs-live merge. Partial-token accumulation is extracted into a shared helper reused by `useRunStream`.

### 4.2 `<Turn>` (new, `components/Turn.tsx`)
Renders ONE turn: the user message, then the assistant content, then inline permission/question cards. Two input modes, one component:
- **Settled turn** → render from `messages` (final assistant text + command-results + errors).
- **Active turn** → render from live `events` + `partials` (rich detail: thinking, tool cards, subagent chips, streaming caret).
Turns are keyed by `turnId`, so there is **no dedup** — the active turn is distinct from history until it settles, then it joins history as a settled turn.

> Decision: history shows the conversational text + command results (today's behavior); the rich live detail (thinking/tool cards) is ephemeral. Persisting full block detail for faithful history replay is an explicit **non-goal** here (future follow-up if wanted).

### 4.3 `ChatThread` becomes a list
A thin scroller of `<Turn>` (paginated history + the `activeTurn`), with "load older on scroll-up". The page (`app/chat/page.tsx`) keeps one `useChatStream` and passes `activeTurn` down.

## 5. Search (chat history)

A dedicated chat FTS5 index, mirroring `search.ts`:
- New table `chat_messages_fts(session_id, turn_id, message_id, role, text)`, populated on message insert, **backfilled on boot**.
- Extract the shared FTS5 setup / query-sanitize / snippet logic from `search.ts` into `apps/server/src/fts.ts`; `search.ts` (run transcripts) and chat-search both consume it (two real consumers).
- `GET /api/chat/search?q=[&sessionId=]`:
  - **cross-session** (no `sessionId`) → hits across all conversations: `{ sessionId, sessionTitle, turnId, messageId, snippet, createdAt }`.
  - **within-session** (`sessionId` set) → scoped to one conversation.
- **UI**: a search field on the session list / a top bar. A cross-session hit opens the session and scrolls to the matching turn (turn anchors by `turnId`). Within-session search jumps between matches in the open thread.

## 6. Composer upgrades

Targeted at the real gaps (no speculative additions):
- **`/` argument completion** — `CommandDef.args` declares value sources (`running-runs`, `addons`, `templates`, …) but `SlashMenu` ignores them. After picking `/kill `, offer a second-stage value picker. New endpoint `GET /api/commands/:name/args?sessionId=&argIndex=` resolves the live values for a dynamic arg (server resolves the session's cwd from `sessionId`, mirroring `findFiles`' trust model — the client never supplies a path). Static-enum args resolve client-side from the catalog.
- **`@` in-flight dedupe** — `AbortController` on `findFiles`; only the latest keystroke's result is applied (cancels stale ones).
- **Lazy `/` catalog** — load commands+skills+subagents on first open (or debounced), not eagerly on every mount.
- *Not doing:* attachment "replace" — chips already have remove (remove + re-add suffices). YAGNI.

## 7. Data model & migration

- `chat_messages` gains `turn_id TEXT`. Idempotent `ALTER TABLE chat_messages ADD COLUMN turn_id` inside the chat module's own migration block (additive-module pattern; swallow only `/duplicate column name/i`), and add `turn_id` to the module's `CREATE TABLE` body + `COLS` + insert/row mappers.
- **Backfill on boot**: walk existing messages per session in order; start a new `turnId` at each `role:'user'` message; assign following non-user messages to it. Pre-existing standalone messages each get their own turn. No destructive change.
- `chat_messages_fts` created + backfilled on boot (see §5).
- The SSE frame vocabulary is internal between `chatStream.ts` and `useChatStream` — both change together, no external consumers.

## 8. Error handling

- **Turn failure** → `turn:failed` → `<Turn>` shows the error and a **Retry** affordance (re-send the user message as a new turn). Fixes today's "unclear whether to re-send".
- **Mid-turn run death / evict** → handled server-side inside `chatTurn`/`chatStream`; the turn continues on a resumed run under the same `turnId`, or ends `failed`.
- **Fatal SSE error** → `error` frame, stream closes, client stops auto-reconnect (H8 parity) and offers reconnect.
- **Engine history cap** → when `buildEnginePrompt` drops older turns past the token cap, surface a small "earlier turns omitted" note on the turn (closes the map's visibility gap).

## 9. Module / file structure

Server (split `chat.ts`):
- `chatRepo.ts` — sessions + messages + turns persistence; `chat_messages_fts` populate/backfill/query.
- `chatTurn.ts` — turn orchestration (live/resumable/engine), lifecycle, server-declared boundaries; wraps `chatLive` + `registry`.
- `chatStream.ts` — turn-scoped SSE route.
- `chatLive.ts` — unchanged.
- `fts.ts` — shared FTS5 helper (search.ts + chat-search).

Web:
- `components/Turn.tsx` — the single turn renderer (replaces `ChatThread`'s dual path).
- `components/ChatThread.tsx` — thin paginated list of `<Turn>`.
- `lib/live.ts` — `useChatStream` rewrite + shared SSE/partials helper.
- `ChatComposer.tsx` / `SlashMenu.tsx` / `MentionMenu.tsx` — composer upgrades.
- chat search UI (in `ChatSessionList.tsx` / a search bar component).

## 10. Testing (TDD; verify via ISOLATED file runs — the full suite is load-flaky)

- **Turn lifecycle** (`chatTurn`): start→stream→settle for live, resumable-fallback, and engine; kill→resume **mid-turn keeps the same `turnId`**; interrupt; daily-cap one-shot fallback; failure → `turn:failed`.
- **Persistence/backfill** (`chatRepo`): `turn_id` written; boot backfill groups legacy messages correctly; pagination cursor.
- **Chat search** (`fts.ts` + chat-search): index on insert, backfill, cross/within-session queries, query sanitization.
- **SSE** (`chatStream`): correct frame sequence; re-subscribe across backing-run change is invisible to the client.
- **Client**: `useChatStream` frame handling (jsdom); `<Turn>` settled vs active render; composer arg-completion + `@` dedupe + lazy catalog.

## 11. Rollout (independently testable phases)

1. **Server turn layer + data model** — split `chat.ts` → `chatRepo`/`chatTurn`/`chatStream`; `turn_id` column + backfill; turn-scoped SSE.
2. **Client turn renderer** — `useChatStream` rewrite, `<Turn>`, paginated `ChatThread`, shared SSE/partials hook.
3. **Chat search** — `fts.ts`, `chat_messages_fts`, `/api/chat/search`, search UI.
4. **Composer** — arg-completion, `@` dedupe, lazy catalog.

Implementation will be driven by `writing-plans` → likely a workflow given the breadth, phase by phase.

## 12. Out of scope (YAGNI)

- Persisting full assistant block detail (thinking/tool cards) for faithful history replay.
- Attachment replace-in-place; per-session turn rate-limiting; multi-line paste handling.
- Changing the live-vs-resumable execution model or `CHAT_LIVE_MAX`.
