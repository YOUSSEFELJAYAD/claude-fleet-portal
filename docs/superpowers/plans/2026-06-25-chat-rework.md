# Chat Page Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat page simpler, robust, searchable, and pleasant to type in by introducing a first-class `turn` abstraction (server-declared boundaries, turn-scoped SSE, thin client renderer), adding chat-transcript search, and upgrading the composer.

**Architecture:** A `turn` (stable `turnId`, independent of the backing run) becomes the unit of conversation. `chatTurn.ts` wraps — does not replace — `chatLive` + `registry` (live/resumable/engine execution) and *declares* turn boundaries. `chatStream.ts` emits turn-scoped SSE frames; the client renders a list of `<Turn>` (history from a paginated fetch + the one active turn from SSE) with no run-id/status awareness. A dedicated FTS5 index makes chat messages searchable.

**Tech Stack:** Fastify + better-sqlite3 (server), Next 14 + React 18 (web), `@fleet/shared` frozen contract, vitest (server integration + jsdom web).

## Global Constraints

- Toolchain: **pnpm** only in `apps/*`/`packages/*` (lockfile-detected). Never npm.
- Server tests are real-process integration tests; **verify via isolated file runs** (`pnpm --filter @fleet/server exec vitest run test/X.test.ts`, `MOCK_DELAY_MS=0`) — the full suite is load-flaky.
- Additive-module DB pattern: each feature owns its `CREATE TABLE IF NOT EXISTS` + idempotent `ALTER TABLE` in try/catch swallowing ONLY `/duplicate column name/i`. Never edit `db.ts` to add a feature column for chat.
- The UI renders only from `@fleet/shared` types; never parse raw CLI JSON. Cross-boundary types live in `@fleet/shared`.
- SSE handlers use the module-private `sse(reply,req)` helper (echoes validated Origin; `forceCloseConnections:true`). Order by monotonic `seq`.
- Keep `chatLive` (held-process budget/idle-suspend), the live-vs-resumable decision, `CHAT_LIVE_MAX`, and all security (`sessionRoot`/`containDirs`/`safePath`) unchanged.
- Citation-comment scheme (`§30`, `H#`, etc.) — keep using it.

---

## File Structure

**Server (split `apps/server/src/chat.ts`, 491 lines):**
- `chatRepo.ts` (new) — sessions + messages + turns persistence; turn grouping; chat FTS populate/backfill/query. Owns the `chat_sessions` + `chat_messages` tables (+ `turn_id` column) and `chat_messages_fts`.
- `chatTurn.ts` (new) — turn orchestration (live/resumable/engine dispatch), lifecycle, server-declared boundaries; a per-session turn-frame emitter.
- `chatStream.ts` (new) — turn-scoped SSE route.
- `chat.ts` (shrinks) — route registration that delegates to the three modules above (or is removed if `registerChatRoutes` moves into `chatStream`/`chatRepo`). Keep `registerChatRoutes`/`registerChatStreamRoute` export names so `server.ts` wiring is unchanged.
- `chatLive.ts` — unchanged.
- `fts.ts` (new) — shared FTS5 setup / query-sanitize / snippet helper (consumed by `search.ts` + chat search).
- `commands.ts` — add arg-source resolution endpoint.

**Web:**
- `components/Turn.tsx` (new) — renders ONE turn (user message + assistant blocks + inline permission/question). Replaces `ChatThread`'s dual render path.
- `components/ChatThread.tsx` (shrinks) — paginated list of `<Turn>` (history + active).
- `lib/live.ts` — `useChatStream` rewrite + extracted shared SSE/partials helper (also used by `useRunStream`).
- `lib/api.ts` — chat turn/search/arg-source client methods.
- `components/ChatComposer.tsx` / `SlashMenu.tsx` / `MentionMenu.tsx` — arg-completion, `@` dedupe, lazy catalog.
- `components/ChatSearch.tsx` (new) or fold into `ChatSessionList.tsx` — chat search UI.

**Shared (`packages/shared/src/index.ts`):** `ChatTurnStatus`, `ChatTurn`, `turnId` on `ChatMessage`, the `ChatStreamFrame` union, `ChatSearchHit`.

---

# Phase 1 — Server turn layer + data model

### Task 1.1: Shared turn types

**Files:**
- Modify: `packages/shared/src/index.ts` (ChatMessage + new types near the existing chat block ~1049-1167)
- Test: `apps/server/test/fn-shared.test.ts` (type-presence/shape assertions) — or skip if no runtime behavior

**Interfaces — Produces:**
```ts
export type ChatTurnStatus = 'pending' | 'streaming' | 'settled' | 'failed' | 'interrupted';

export interface ChatTurn {
  id: string;            // turnId
  sessionId: string;
  status: ChatTurnStatus;
  messages: ChatMessage[]; // user + assistant/command-result/error rows for this turn
  createdAt: number;
  settledAt: number | null;
}

// NOTE: `turnId: string` is ADDED to ChatMessage in Task 1.2 (together with the column +
// addMessage that populates it), so this task stays purely additive and ends green.

export type ChatStreamFrame =
  | { kind: 'session_state'; state: ChatSessionState }            // live | running | idle | killed; NO runId
  | { kind: 'turn:start'; turn: ChatTurn }
  | { kind: 'turn:event'; turnId: string; event: NormalizedEvent }
  | { kind: 'turn:settled'; turnId: string; assistantMessageId: string }
  | { kind: 'turn:failed'; turnId: string; error: string }
  | { kind: 'error'; error: string };

export interface ChatSearchHit {
  sessionId: string; sessionTitle: string; turnId: string;
  messageId: string; role: ChatMessage['role']; snippet: string; createdAt: number;
}
```

- [ ] **Step 1:** Add the NEW types above to `index.ts` (additive only — do NOT touch `ChatMessage` yet; `turnId` lands in Task 1.2).
- [ ] **Step 2:** `pnpm -r typecheck` — Expected: PASS (purely additive types break nothing).
- [ ] **Step 3:** Commit. `git commit -m "feat(chat): add turn types to the shared contract"`

### Task 1.2: `chat_messages.turn_id` column + backfill (chatRepo persistence)

**Files:**
- Create: `apps/server/src/chatRepo.ts` (move persistence out of `chat.ts`)
- Modify: `packages/shared/src/index.ts` (add `turnId: string` to `ChatMessage`)
- Modify: every `ChatMessage` constructor that now needs `turnId` (chat.ts/chatRepo, tests/mocks) — typecheck must end PASS
- Test: `apps/server/test/chatrepo-turns.test.ts`

**Interfaces:**
- Consumes: `repo`/`db` from `db.ts`; `ChatMessage`, `ChatTurn` from shared.
- Produces:
```ts
export const chatRepo: {
  createSession(req: CreateChatSessionRequest): ChatSession;
  getSession(id: string): ChatSession | null;        // raw row; state derived elsewhere
  addMessage(m: Omit<ChatMessage,'id'|'createdAt'> & { turnId: string }): ChatMessage;
  listTurns(sessionId: string, opts?: { before?: number; limit?: number }): ChatTurn[]; // newest-first page, ascending within
  getTurn(sessionId: string, turnId: string): ChatTurn | null;
  newTurnId(): string;
  // backfill is run once on boot (see Step)
};
export function backfillChatTurns(): void; // group legacy messages by user-message boundaries
```

- [ ] **Step 1: Failing test** — `chatrepo-turns.test.ts`: seed a session + legacy messages WITHOUT turn_id (raw insert), call `backfillChatTurns()`, assert messages got grouped: a new turnId begins at each `role:'user'` row and following non-user rows share it.
```ts
// isolate FLEET_DATA_DIR before importing src; insert 3 messages: user, assistant, user
// (simulate legacy rows with turn_id NULL via a direct db.prepare insert)
const turns = chatRepo.listTurns(sid);
expect(turns.length).toBe(2);            // two user boundaries → two turns
expect(turns[0].messages[0].role).toBe('user');
expect(turns.every(t => t.messages.every(m => m.turnId === t.id))).toBe(true);
```
- [ ] **Step 2:** Run `pnpm --filter @fleet/server exec vitest run test/chatrepo-turns.test.ts` — Expected: FAIL (module/functions missing).
- [ ] **Step 3: Implement** — in `chatRepo.ts`: move the chat tables' `CREATE TABLE IF NOT EXISTS`; add idempotent `ALTER TABLE chat_messages ADD COLUMN turn_id TEXT` (try/catch swallow `/duplicate column name/i`); add `turn_id` to the `CREATE` body, `COLS`, insert stmt, and the `rowToMessage` mapper. Implement `addMessage` (requires `turnId`), `listTurns` (SELECT messages by session ordered by createdAt, group by turn_id into `ChatTurn[]`, paginate by `before` cursor on the turn's createdAt), `newTurnId` (`randomUUID`), `backfillChatTurns` (per session, walk ordered messages; assign a fresh turnId at each `role:'user'`; UPDATE rows where turn_id IS NULL).
- [ ] **Step 4:** Run the test — Expected: PASS.
- [ ] **Step 5:** Wire `backfillChatTurns()` into boot (call it where `search.ts` backfill is called / in `chatRepo` module init after table creation). Add a test that a second backfill is a no-op (idempotent).
- [ ] **Step 6:** Commit. `git commit -m "feat(chat): turn_id column + legacy backfill + chatRepo persistence"`

### Task 1.3: Turn orchestration + server-declared boundaries (chatTurn)

**Files:**
- Create: `apps/server/src/chatTurn.ts`
- Test: `apps/server/test/chatturn.test.ts` (real-process; uses a fake CLAUDE_BIN like `retry.test.ts`/`cov-processManager.test.ts`)

**Interfaces:**
- Consumes: `chatRepo` (1.2), `chatLive` (`ensureLive`/`liveRunId`/`touch`/`notifyBackingRun`), `registry` (`launch`/`launchEngine`/`resume`/`sendInput`/`subscribeRun`), security helpers (`sessionRoot`/`containDirs`/`safePath`) moved from `chat.ts`.
- Produces:
```ts
export const chatTurns: {
  startTurn(sessionId: string, message: string, attachments?: ChatAttachment[]): Promise<{ turnId: string }>;
  // per-session turn-frame pub/sub consumed by chatStream:
  subscribe(sessionId: string, cb: (frame: ChatStreamFrame) => void): () => void;
  activeTurn(sessionId: string): ChatTurn | null;
};
```
Behavior: `startTurn` persists the user message under a new `turnId`, emits `turn:start`; dispatches via the unchanged live/resumable/engine path; subscribes the backing run and re-tags its `NormalizedEvent`s as `turn:event` frames; on the run's `result`/terminal, persists the assistant message(s) under the `turnId`, emits `turn:settled`; on failure emits `turn:failed`. Across a live-evict→resume the backing run id changes but the same `turnId` keeps emitting (run-id juggling stays here).

- [ ] **Step 1: Failing test** — claude live/resumable happy path: start a turn against a fake claude that emits assistant_text + result; assert frame sequence `turn:start` → `turn:event`(assistant_text) → `turn:settled`, and `chatRepo.listTurns` shows the user + assistant messages under one `turnId`.
- [ ] **Step 2:** Run isolated — Expected: FAIL.
- [ ] **Step 3: Implement** `chatTurn.ts` — move `startTurn`/`buildEnginePrompt`/`containDirs`/`sessionRoot` from `chat.ts`; add the turn-frame emitter; wire the backing-run subscription → frame re-tagging → settle/fail persistence.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Add tests** (each its own commit-worthy deliverable): engine session (one turn = one `launchEngine`, history replay, `turn:settled`); kill→resume mid-turn keeps the same `turnId` (stop the backing run mid-stream, resume, assert frames continue under the original turnId); interrupt → `turn:failed`/settled appropriately; daily-cap fallback (no live slot → one-shot, still one turn).
- [ ] **Step 6:** Commit. `git commit -m "feat(chat): turn orchestration with server-declared boundaries"`

### Task 1.4: Turn-scoped SSE route (chatStream) + route wiring

**Files:**
- Create: `apps/server/src/chatStream.ts`
- Modify: `apps/server/src/chat.ts` (delegate `registerChatStreamRoute` here; keep export name) and `server.ts` if import paths change.
- Test: `apps/server/test/chatstream.test.ts`

**Interfaces:**
- Consumes: `chatTurns.subscribe`/`activeTurn` (1.3), `chatRepo` (1.2), the module-private `sse()` helper.
- Produces: `export function registerChatStreamRoute(app, sse)` — `GET /api/chat/sessions/:id/stream` emitting `ChatStreamFrame`s; first frame `session_state`, then live `turn:*` for the active turn only.

- [ ] **Step 1: Failing test** — connect to the stream (via `app.inject` SSE or a real listen + EventSource as existing chat tests do), start a turn, assert the wire frames are `session_state` then `turn:start`/`turn:event`/`turn:settled` (NO `hello`, NO run-proxy events, NO runId leaked).
- [ ] **Step 2:** Run isolated — Expected: FAIL.
- [ ] **Step 3: Implement** `chatStream.ts`: on connect emit `session_state` (derive from `chatLive.isLive` + `registry` status); replay the active turn's buffered frames if mid-turn; subscribe `chatTurns.subscribe`; on disconnect unsubscribe. Resolve the active backing run server-side; the route NEVER emits a run id.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Update `GET /api/chat/sessions/:id` (in `chatRepo`/route) to return `{ session, turns }` (latest page) and add `GET /api/chat/sessions/:id/turns?before=&limit=`. Test pagination cursor.
- [ ] **Step 6:** Commit. `git commit -m "feat(chat): turn-scoped SSE + paginated turn history"`

---

# Phase 2 — Client turn renderer

### Task 2.1: Shared SSE/partials helper + `useChatStream` rewrite

**Files:**
- Modify: `apps/web/lib/live.ts`
- Test: `apps/web/test/fn-usechatstream.test.ts` (extend existing) + `apps/web/test/cov-usechatstream.test.ts`

**Interfaces:**
- Produces:
```ts
// shared: accumulate assistant_partial deltas; clear on assistant_text. Used by useRunStream + useChatStream.
function useEventAccumulator(): { events: NormalizedEvent[]; partials: Record<string,string>; push(e: NormalizedEvent): void; reset(): void };

export function useChatStream(sessionId: string | null): {
  state: ChatSessionState;
  activeTurn: { turnId: string; status: ChatTurnStatus; events: NormalizedEvent[]; partials: Record<string,string> } | null;
  error: string | null;
};
```

- [ ] **Step 1: Failing test** — feed a frame sequence (`session_state`, `turn:start`, `turn:event` partial+text, `turn:settled`) into `useChatStream` (mock EventSource) and assert `activeTurn` builds then clears on settle; `state` updates from `session_state`; NO `{runId,seq}` logic.
- [ ] **Step 2:** Run `pnpm --filter @fleet/web exec vitest run test/fn-usechatstream.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — rewrite `useChatStream` to consume `ChatStreamFrame`s; extract `useEventAccumulator` and refactor `useRunStream` to use it (verify `useRunStream` tests still pass). Delete the status-inference turn-boundary block, the hello-strip, and the run-id-change handling.
- [ ] **Step 4:** Run both `useChatStream` + `useRunStream` web tests — Expected: PASS.
- [ ] **Step 5:** Commit. `git commit -m "feat(web): turn-frame useChatStream + shared event accumulator"`

### Task 2.2: `<Turn>` component

**Files:**
- Create: `apps/web/components/Turn.tsx`
- Test: `apps/web/test/cov-turn.test.tsx`

**Interfaces:**
- Consumes: `ChatTurn`, `NormalizedEvent`; existing `MarkdownView`/`ThinkingBlock`/`ToolCallCard`/`PermissionCard`/`SubagentChip`/`QuestionCard`.
- Produces: `export function Turn(props: { turn: ChatTurn } | { active: { turnId; status; events; partials } })` — settled turns render from `messages`; the active turn renders rich live blocks.

- [ ] **Step 1: Failing test** — render a settled `ChatTurn` (user text + assistant text) → asserts both shown; render an active turn with a `tool_use`+`tool_result` event pair → asserts a ToolCallCard; streaming partial → caret text.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** `Turn.tsx` — port the per-event→component mapping from current `ChatThread.tsx` `LiveTurn`, plus the persisted-message rendering from `PersistedMessage`; keyed by `turnId`. A turn with `status:'failed'` renders an error block + a **Retry** button calling an `onRetry(turn)` prop (spec §8). An engine turn whose history was truncated shows a small "earlier turns omitted" note (spec §8) — surfaced via a message/turn flag set in `chatTurn` when `buildEnginePrompt` drops history.
- [ ] **Step 4: Failing test (retry render)** — a `status:'failed'` turn shows the error + a Retry control that fires `onRetry`. Run — Expected: PASS after Step 3.
- [ ] **Step 5:** Commit. `git commit -m "feat(web): single Turn renderer (settled + active + failed/retry)"`

### Task 2.3: `ChatThread` → paginated `<Turn>` list + page wiring

**Files:**
- Modify: `apps/web/components/ChatThread.tsx`, `apps/web/app/chat/page.tsx`, `apps/web/lib/api.ts` (add `chatTurns(sessionId, before?)`)
- Test: `apps/web/test/cov-chatthread.test.tsx` (update)

- [ ] **Step 1: Failing test** — `ChatThread` given history turns + an activeTurn renders them in order; scroll-up triggers an older-turns fetch (mock `api.chatTurns`).
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** — `ChatThread` becomes a thin scroller of `<Turn>` (history page + activeTurn); add `api.chatTurns`; page passes `activeTurn` from `useChatStream`; remove the old dual-source stitching/dedup. On `turn:settled`, append the settled turn to history (or refetch the latest page) and clear activeTurn. Wire `<Turn>`'s `onRetry(turn)` → re-send the turn's user-message text as a new turn via `api.chatTurn` (spec §8).
- [ ] **Step 4:** Run web chat tests — Expected: PASS.
- [ ] **Step 5:** Manual smoke (mock mode): `pnpm dev:mock`, open `/chat`, send a turn, verify stream + settle + reload shows history. (Document the check; not a CI gate.)
- [ ] **Step 6:** Commit. `git commit -m "feat(web): paginated Turn list; drop dual-source stitching"`

---

# Phase 3 — Chat search

### Task 3.1: Extract shared `fts.ts`

**Files:**
- Create: `apps/server/src/fts.ts`
- Modify: `apps/server/src/search.ts` (consume `fts.ts`)
- Test: `apps/server/test/fts.test.ts` + existing `search.test.ts` must still pass

**Interfaces — Produces:**
```ts
export function createFts(db, table: string, columns: string[]): void;       // CREATE VIRTUAL TABLE IF NOT EXISTS
export function sanitizeFtsQuery(q: string): string;                          // strip FTS operators that throw
export function ftsSnippet(/* row */): string;                                // shared snippet formatting
```
- [ ] **Step 1:** Failing test — `fts.test.ts`: createFts + insert + MATCH returns rows; `sanitizeFtsQuery('a"b*')` yields a safe query.
- [ ] **Step 2:** Run isolated — Expected: FAIL.
- [ ] **Step 3:** Implement `fts.ts` by lifting the setup/sanitize/snippet logic out of `search.ts`; refactor `search.ts` to call it.
- [ ] **Step 4:** Run `fts.test.ts` AND `search.test.ts` — Expected: PASS (no regression to run search).
- [ ] **Step 5:** Commit. `git commit -m "refactor(search): extract shared fts helper"`

### Task 3.2: Chat FTS index + `/api/chat/search`

**Files:**
- Modify: `apps/server/src/chatRepo.ts` (index on insert + `searchChat`), route in `chatStream.ts`/`chat.ts`
- Test: `apps/server/test/chat-search.test.ts`

**Interfaces — Produces:** `chatRepo.searchChat(q: string, sessionId?: string, limit?: number): ChatSearchHit[]`; route `GET /api/chat/search?q=[&sessionId=]`.
- [ ] **Step 1:** Failing test — add messages across two sessions; `searchChat('needle')` returns cross-session hits; `searchChat('needle', sidA)` scopes to one; snippet present.
- [ ] **Step 2:** Run isolated — Expected: FAIL.
- [ ] **Step 3:** Implement — `chat_messages_fts(session_id,turn_id,message_id,role,text)` via `createFts`; populate in `addMessage`; backfill on boot; `searchChat` MATCH (sanitized) joined to sessions for title; register the route.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit. `git commit -m "feat(chat): full-text chat search"`

### Task 3.3: Search UI

**Files:**
- Create/Modify: `apps/web/components/ChatSearch.tsx` (or fold into `ChatSessionList.tsx`), `apps/web/lib/api.ts` (`searchChat`), `apps/web/app/chat/page.tsx` (jump-to-turn by `turnId` anchor)
- Test: `apps/web/test/cov-chatsearch.test.tsx`
- [ ] **Step 1:** Failing test — typing a query renders hits (mock `api.searchChat`); clicking a hit calls the open-session + scroll-to-turn handler with `{sessionId, turnId}`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement — debounced search field; cross-session results in the session list, within-session when a session is open; `<Turn>` gets `id={turnId}` anchors for scroll.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit. `git commit -m "feat(web): chat search UI + jump-to-turn"`

---

# Phase 4 — Composer

### Task 4.1: `/` argument completion

**Files:**
- Modify: `apps/server/src/commands.ts` (arg-source resolution), `apps/web/components/SlashMenu.tsx`, `apps/web/lib/api.ts`
- Test: `apps/server/test/cov-commands.test.ts` (resolution), `apps/web/test/fn-slashmenu.test.tsx`

**Interfaces — Produces:** `GET /api/commands/:name/args?sessionId=&argIndex=` → `{ values: { value: string; label?: string }[] }` (server resolves the session cwd from `sessionId`, mirroring `findFiles`).
- [ ] **Step 1:** Failing tests — server: resolving a `running-runs` arg returns live run ids; web: after picking `/kill `, the menu shows a value list from `api.commandArgs`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement — server resolver mapping each `CommandDef.args` source kind (`running-runs`/`addons`/`templates`/…) to live values; route; `SlashMenu` second-stage value picker (static-enum args resolve client-side from the catalog).
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit. `git commit -m "feat(chat): slash-command argument completion"`

### Task 4.2: `@` in-flight dedupe + lazy `/` catalog

**Files:**
- Modify: `apps/web/components/MentionMenu.tsx` (AbortController), `apps/web/components/SlashMenu.tsx` (lazy fetch)
- Test: `apps/web/test/fn-mentionmenu.test.tsx`, `apps/web/test/fn-slashmenu.test.tsx`
- [ ] **Step 1:** Failing test — fast successive `@` queries: only the latest result is applied (earlier `findFiles` promises aborted/ignored); SlashMenu does not fetch the catalog until first open.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement — `AbortController` per `findFiles`, abort the previous on each keystroke, ignore aborted results; move the SlashMenu catalog fetch to first-open (lazy), keep the cache.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5:** Commit. `git commit -m "feat(chat): @ in-flight dedupe + lazy slash catalog"`

---

## Cross-cutting: regression gate before merge

- [ ] After each phase: `pnpm -r typecheck` (PASS) + run the touched test files **in isolation** (PASS).
- [ ] Before opening the PR: one full `pnpm test` (expect web 145+/145, server green modulo the known load-flaky tests already hardened on PR #8 — note any in the PR body).
- [ ] Manual smoke in `pnpm dev:mock`: send/stream/settle a turn, reload (history), kill→resume mid-turn (same turnId), search jumps to a turn, `/` arg-completion, `@` files.

## Out of scope (do not build)

Persisting full assistant block detail for faithful history replay; attachment replace-in-place; per-session rate-limiting; multi-line paste handling; changing the live-vs-resumable model or `CHAT_LIVE_MAX`.
