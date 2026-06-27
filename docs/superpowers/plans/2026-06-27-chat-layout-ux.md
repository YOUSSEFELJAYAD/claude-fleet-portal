# Chat Layout + UX + Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the chat page into a persistent 20/80 two-column layout with a roomier composer, a fullscreen mode, ~15 prod-ready UX features, and an all-permissions-by-default chat agent.

**Architecture:** Server: one-line permission default in `chatRepo`. Web: rewrite `ChatSessionList` from popover→persistent panel; restructure `chat/page.tsx` into a two-column flex; add fullscreen via the existing `Shell` `window`-event pattern + native Fullscreen API; layer UX features onto `ChatComposer`/`ChatThread`/`Turn`. Client-only state (pins, drafts, widths) in `localStorage`.

**Tech Stack:** Next 14 app-router, React, Tailwind (inline hex accents), `@fleet/shared` contract, vitest + jsdom + RTL (`apps/web/test/`), Fastify + better-sqlite3 (server), vitest integration (`apps/server/test/`).

## Global Constraints

- Web tests live in `apps/web/test/` (NOT beside source); `fn-*` focused, `cov-*` coverage.
- `pnpm` only in `apps/*`/`packages/*`; `MOCK_DELAY_MS=0` for server tests.
- UI renders from the normalized contract; never parse raw CLI. Blue accent `#4f7fff`.
- `localStorage` access always try/catch (matches `Shell.tsx`).
- Verify after edits: `pnpm --filter @fleet/web typecheck` + targeted vitest.

---

### Task 0: Chat agent — all permissions by default

**Files:**
- Modify: `apps/server/src/chatRepo.ts:160`
- Test: `apps/server/test/fn-chat-permissions.test.ts` (create)

**Interfaces:**
- Produces: chat sessions created without an explicit `permissionMode` default to `'bypassPermissions'`.

- [ ] **Step 1: Failing test** — `createSession({cwd})` returns `permissionMode === 'bypassPermissions'`; an explicit `permissionMode:'default'` is still honored.
- [ ] **Step 2:** Run `pnpm --filter @fleet/server exec vitest run test/fn-chat-permissions.test.ts` — Expected: FAIL (defaults to `'default'`).
- [ ] **Step 3: Implement** — `chatRepo.ts:160`: `permission_mode: req.permissionMode ?? 'bypassPermissions'`.
- [ ] **Step 4:** Run — Expected: PASS. Also run `test/chat.test.ts` to confirm no regression.
- [ ] **Step 5: Commit** — `feat(chat): chat agent runs with all permissions (bypassPermissions) by default`.

Note: `humanGate:true` is unchanged (backstop kept); no PreToolUse hook injected.

---

### Task 1: `ChatSessionList` — popover → persistent panel

**Files:**
- Modify: `apps/web/components/ChatSessionList.tsx` (rewrite shell, keep row markup)
- Test: `apps/web/test/cov-chatsessionlist.test.tsx`, `apps/web/test/fn-chatsessionlist-engine.test.tsx` (migrate)

**Interfaces:**
- Produces: `<ChatSessionList>` renders an always-visible vertical list (no trigger/popover). Same props plus `filter`/`pins` handled internally. New optional props: `collapsed?: boolean`.

- [ ] **Step 1: Migrate failing tests** — assert the list renders all session titles directly (no click-to-open), the "+ New" control is present, and engine badge shows for engine sessions.
- [ ] **Step 2:** Run the two test files — Expected: FAIL (popover trigger gone).
- [ ] **Step 3: Implement** — strip `open`/outside-click/trigger button + popover wrapper; render `<div>` column: header ("+ New" row), then `sessions.map(...)` reusing the existing row block (dot, title, preview, meta, engine badge, hover actions). Collapsed mode renders dots only.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** — `refactor(chat): ChatSessionList is a persistent sidebar panel`.

---

### Task 2: `chat/page.tsx` — 20/80 two-column layout + chat header + taller composer

**Files:**
- Modify: `apps/web/app/chat/page.tsx`
- Modify: `apps/web/components/ChatComposer.tsx` (max-height 200→320, min ~3 rows)
- Test: `apps/web/test/fn-chat-layout.test.tsx` (create)

**Interfaces:**
- Consumes: `<ChatSessionList>` (Task 1).
- Produces: page renders `<aside w-[20%] min-w-[220px]>` + `<section flex-1>`; chat header in the right column.

- [ ] **Step 1: Failing test** — render `ChatPage` with mocked api/sessions; assert a sidebar region (`data-testid="chat-sidebar"`) and a conversation region coexist (two columns), not a popover trigger.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** — outer `flex h-[calc(100vh-106px)] min-h-0`; left `<aside data-testid="chat-sidebar" className="w-[20%] min-w-[220px] shrink-0 border-r ...">` hosting `<ChatSessionList>` + search; right `<section className="flex-1 min-w-0 flex flex-col">` with chat header (engine·model, state badge, fullscreen button placeholder), `<ChatThread>`, `<ChatComposer>`. Composer: bump `Math.min(scrollHeight, 320)` and `rows={3}` / `minHeight`.
- [ ] **Step 4:** Run `fn-chat-layout` + existing chat page tests — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): 20/80 two-column layout + taller composer`.

---

### Task 3: Fullscreen toggle (in-app chrome-hide + native)

**Files:**
- Modify: `apps/web/components/Shell.tsx` (listen for `fleet:chrome`)
- Modify: `apps/web/app/chat/page.tsx` (toggle button + dispatch + `requestFullscreen`)
- Test: `apps/web/test/fn-chat-fullscreen.test.tsx` (create)

**Interfaces:**
- Produces: clicking the header ⤢ button dispatches `window` `CustomEvent('fleet:chrome', {detail:{hidden}})` and calls `requestFullscreen()` on the chat root; `Shell` hides `<aside>`/`<header>` while hidden; unmount restores.

- [ ] **Step 1: Failing test** — clicking the fullscreen button dispatches `fleet:chrome` with `hidden:true`; clicking again `hidden:false`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** — `Shell`: `const [chrome,setChrome]=useState(true)` + `useEffect` add/remove `fleet:chrome` listener; conditionally render aside/header. Chat page: `fullscreen` state, button toggles it, `useEffect` dispatches event + calls `rootRef.current?.requestFullscreen()` / `document.exitFullscreen()` (guarded try/catch), listens to `fullscreenchange` to resync, and on unmount dispatches `hidden:false`.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): fullscreen toggle (hide app chrome + native)`.

---

### Task 4: Sidebar — filter, pin, duplicate, collapse/resize

**Files:**
- Modify: `apps/web/components/ChatSessionList.tsx`, `apps/web/app/chat/page.tsx`
- Create: `apps/web/lib/chatPrefs.ts` (localStorage helpers: pins, sidebar width, collapsed, drafts)
- Test: `apps/web/test/fn-chat-sidebar.test.tsx`, `apps/web/test/fn-chatprefs.test.ts` (create)

**Interfaces:**
- Produces: `chatPrefs` = `{ getPins(): Set<string>, togglePin(id), getWidth()/setWidth(px), getCollapsed()/setCollapsed(b), getDraft(id)/setDraft(id,text) }` — all try/catch, SSR-safe.

- [ ] **Step 1: Failing tests** — (a) `chatPrefs.togglePin` round-trips through localStorage; (b) sidebar renders a filter input that hides non-matching titles; (c) pinned sessions sort first; (d) a "duplicate" action calls `onDuplicate(session)`.
- [ ] **Step 2:** Run both files — Expected: FAIL.
- [ ] **Step 3: Implement** — `chatPrefs.ts` (one module, JSON in a single `fleet:chatPrefs` key). `ChatSessionList`: filter `<input>` (state), pin star per row (calls `chatPrefs.togglePin` + lifts via `onPinsChange` or re-reads), sort `[...pinned, ...rest]`, `duplicate` hover action → `onDuplicate`. Collapse chevron in panel header; resizable divider = a draggable handle on the page updating `chatPrefs.setWidth`. Page: `onDuplicate = (s) => api.createChatSession({cwd:s.cwd, model:s.model, engine:s.engine, effort:s.effort}).then(refresh+load)`.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): sidebar filter, pin, duplicate, collapse/resize`.

---

### Task 5: Composer — draft persistence, Cmd+Enter, wire `+` to `@`

**Files:**
- Modify: `apps/web/components/ChatComposer.tsx`
- Test: `apps/web/test/fn-composer-ux.test.tsx` (create)

**Interfaces:**
- Consumes: `chatPrefs.getDraft/setDraft` (Task 4), `sessionId` prop.

- [ ] **Step 1: Failing tests** — (a) typing persists to `chatPrefs.setDraft(sessionId,...)`; mounting with a stored draft pre-fills; submit clears it. (b) Cmd/Ctrl+Enter submits when no menu open. (c) clicking `+` inserts `@` at the caret (opens MentionMenu).
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** — load draft in a `useEffect([sessionId])`; on `setText` also `chatPrefs.setDraft`; `reset()` clears draft. `onKeyDown`: `(e.key==='Enter' && (e.metaKey||e.ctrlKey)) → submit()`. `+` button `onClick` → `setText(t=>t+'@'); setCaret(...)` + focus (reuses `detectTrigger` to open MentionMenu).
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): composer draft persistence, Cmd+Enter, working attach button`.

---

### Task 6: Thread — copy, scroll-to-bottom + N-new, auto-scroll lock, timestamp, regenerate

**Files:**
- Modify: `apps/web/components/ChatThread.tsx`, `apps/web/components/Turn.tsx`
- Modify: `apps/web/app/chat/page.tsx` (regenerate handler)
- Test: `apps/web/test/fn-thread-ux.test.tsx` (create)

**Interfaces:**
- Consumes: `ago()` from `lib/format`, `api.chatInterrupt`.
- Produces: `<Turn>` gains a hover copy button + timestamp; `ChatThread` gains a scroll-to-bottom FAB and auto-scroll-lock; page gains `regenerateLast()`.

- [ ] **Step 1: Failing tests** — (a) `<Turn>` renders a copy button that calls `navigator.clipboard.writeText` with the message text; (b) `<Turn>` shows a relative timestamp; (c) `ChatThread` shows a scroll-to-bottom button when scrolled up (not pinned); (d) page `regenerateLast` re-sends the last user message.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** — `Turn`: hover copy (`navigator.clipboard.writeText`, try/catch, brief "copied"), timestamp `<span title={absolute}>{ago(createdAt)}</span>`, copy-code button on `<pre>` blocks (in MarkdownView/ShikiCode or a wrapper). `ChatThread`: track `pinned` (scroll position), suppress auto-scroll when user scrolled up (auto-scroll-lock), show a floating "↓ N new" button when not pinned and new turns arrived; click → scroll to `endRef`. Page: `regenerateLast = () => { const last=[...turns].reverse().find(t=>t.messages.some(m=>m.role==='user')); ... sendTurn(userMsg) }`, exposed on the last turn / header.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): copy message/code, scroll-to-bottom, auto-scroll lock, timestamps, regenerate`.

---

### Task 7: Global — Cmd+K switcher, Cmd+N new, Esc-to-stop, autofocus

**Files:**
- Modify: `apps/web/app/chat/page.tsx`
- Create: `apps/web/components/ChatPalette.tsx` (lightweight session switcher)
- Test: `apps/web/test/fn-chat-shortcuts.test.tsx` (create)

**Interfaces:**
- Consumes: `sessions`, `loadSession`, `newSession`, `api.chatInterrupt`.

- [ ] **Step 1: Failing tests** — (a) Cmd/Ctrl+K opens the palette; typing filters; Enter selects → `loadSession`. (b) Cmd/Ctrl+N → `newSession`. (c) Esc while `chatState==='running'` → `api.chatInterrupt`. (d) opening a session focuses the composer textarea.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3: Implement** — page-level `useEffect` keydown listener (guard against typing in inputs except the palette): K→open palette, N→newSession, Esc→interrupt-if-running. `ChatPalette` = filtered list + keyboard nav (reuse row styling). Autofocus: pass a `focusKey`/ref to composer, focus on `activeId` change.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): Cmd+K switcher, Cmd+N new, Esc-to-stop, autofocus composer`.

---

### Task 8: Verification + green sweep

- [ ] **Step 1:** `pnpm --filter @fleet/web typecheck` + `pnpm --filter @fleet/shared typecheck` → PASS.
- [ ] **Step 2:** `pnpm --filter @fleet/web test` (jsdom suite) → PASS; re-run any failing file in isolation (flaky guidance).
- [ ] **Step 3:** `pnpm --filter @fleet/server exec vitest run test/fn-chat-permissions.test.ts test/chat.test.ts` → PASS.
- [ ] **Step 4:** Manual smoke (`pnpm dev:mock`): two-column layout, fullscreen toggle, send a turn, copy, pin, duplicate, Cmd+K. Document the check.
- [ ] **Step 5: Commit** — any test migrations; open PR.

---

## Self-Review

- **Spec coverage:** C1→Task 2; C2→Task 2; C3→Task 3; C4→Task 0; features 1-5 (sidebar/collapse/resize/filter/pin/duplicate)→Tasks 1+4; 6-8 (draft/Cmd+Enter/attach)→Task 5; 9-14 (copy/code/scroll/lock/timestamp/regenerate)→Task 6; 15-16 (Cmd+K/N, Esc/autofocus)→Task 7. ✓
- **Placeholder scan:** code sketches reference real symbols (`chatPrefs`, `detectTrigger`, `ago`, `api.createChatSession`, `api.chatInterrupt`). ✓
- **Type consistency:** `chatPrefs` interface defined in Task 4, consumed in Tasks 5/6 with matching names. ✓
- Deferred (Today/Earlier grouping, row spinner, clear-all, paste→attach, `?` overlay, MD export) — intentionally not in tasks.
