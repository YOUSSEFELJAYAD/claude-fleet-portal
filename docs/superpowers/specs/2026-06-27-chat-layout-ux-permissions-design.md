# Chat page — 20/80 layout, fullscreen, UX pass, all-permissions

**Date:** 2026-06-27
**Branch:** `feat/chat-layout-ux`
**Status:** design — awaiting spec review

## Problem

The v0.7.0 chat redesign moved sessions into a header **popover** and centred the
conversation in a `max-w-800` column. The user wants the persistent two-column shape
back, a roomier composer, a fullscreen mode, a batch of UX improvements, and the chat
agent to run with all tool permissions by default.

## Goals

1. **20 / 80 two-column layout** — always-visible sessions sidebar (left) + chat (right).
2. **Taller composer** input.
3. **Fullscreen toggle** in the chat header (hide app chrome **and** native fullscreen).
4. **~15 strong UX features**, each production-ready (core + strong-15; ~6 deferred).
5. **Chat agent gets all tool permissions by default** (`bypassPermissions`), gate infra kept.

## Non-goals

- Changing permissions for non-chat runs (Fleet/PM/loops keep their guardrails).
- Server-synced pins/drafts (client localStorage is sufficient; ceiling noted).
- The deferred ~6 features (listed at the end) — separate follow-up.

---

## Architecture

### Layout (`apps/web/app/chat/page.tsx`)

Replace the top-bar/popover shell with a horizontal flex:

```
┌─────────────────────────────────────────────────────────┐
│ [⤢ fullscreen]  Chat · engine·model · LIVE/RESUMABLE      │  chat header (right col)
├──────────────┬──────────────────────────────────────────┤
│ sidebar 20%  │ thread (centred column inside 80%)         │
│ ▸ filter     │                                            │
│ ▸ + New      │                                            │
│ ▸ sessions   │                                            │
│   (pinned ↑) ├──────────────────────────────────────────┤
│              │ composer (taller)                          │
└──────────────┴──────────────────────────────────────────┘
```

- Outer: `flex h-[calc(100vh-106px)]` (normal) → `fixed inset-0` when fullscreen.
- Left column: `w-[20%] min-w-[220px]` (collapsible to a thin rail, resizable divider).
- Right column: `flex-1 flex flex-col` — chat header, `<ChatThread>` (keeps its centred
  `max-w-800` inside the column), `<ChatComposer>`.

### `ChatSessionList` — popover → persistent panel

Rewrite from a dropdown trigger into an always-visible vertical list. **Reuse** the
existing per-session row markup (dot, title, preview, meta line, engine badge, hover
actions); **drop** the `open` state, trigger button, outside-click handler, popover
wrapper. Add: a filter input at top, pin toggle, duplicate action, "+ New" row.

### Fullscreen (`Shell.tsx` + chat page)

`Shell` already listens for a `window` event (`fleet:addons`). Add the same pattern:
the chat page dispatches `fleet:chrome` with `{hidden:boolean}`; `Shell` hides its
`<aside>` nav and top `<header>` while hidden. Native fullscreen = `requestFullscreen()`
on the chat root element; `fullscreenchange` keeps the toggle state in sync. Leaving the
page restores chrome on unmount.

### Permissions (`apps/server/src/chatRepo.ts:160`)

```ts
permission_mode: req.permissionMode ?? 'bypassPermissions',  // was: ?? 'default'
```

- This is the same mode PM/loop workers already use (`pm.ts:7`). It grants every tool
  with no prompt — the literal "all\*". No arg-builder change needed.
- **`humanGate: true` stays** (chatTurn/chatLive) — the `ask_human` MCP escalation valve
  remains the non-blocking backstop. The blocking PreToolUse permission hook is **not**
  forced on chat (forcing it would prompt on every tool, contradicting "all by default").
- **Scope:** new sessions only; existing rows keep their stored mode.
- ⚠️ **Blast radius:** chat runs in the user's **real cwd** (not an isolated worktree),
  so the agent can edit/delete real files unprompted. Explicitly requested.

---

## Features

### Core (always)
- **C1** 20/80 two-column layout, always-visible sidebar.
- **C2** Taller composer (min ~3 rows, max-height 200→320px; auto-grow kept).
- **C3** Fullscreen toggle — hide app chrome (event) + native Fullscreen API.
- **C4** `bypassPermissions` default for chat (above).

### Strong 15 (build now)
| # | Feature | Where / reuse |
|---|---------|---------------|
| 1 | Collapsible sidebar (rail), persisted | page + ChatSessionList; localStorage |
| 2 | Resizable split divider, persisted | page; pointer drag → localStorage width |
| 3 | Session filter (by title) | ChatSessionList; client filter |
| 4 | Pin/favorite sessions (float to top) | ChatSessionList; localStorage set |
| 5 | Duplicate session | reuse `api.createChatSession({cwd,model,engine,effort})` |
| 6 | Per-session composer draft persistence | ChatComposer; localStorage keyed by sessionId |
| 7 | Cmd/Ctrl+Enter to send | ChatComposer onKeyDown |
| 8 | Wire the dead `+` attach button → `@` picker | ChatComposer (insert `@` to open MentionMenu) |
| 9 | Copy-message button (hover) | Turn.tsx; `navigator.clipboard` |
| 10 | Copy code-block button | ShikiCode/MarkdownView; per `<pre>` |
| 11 | Scroll-to-bottom + "N new" indicator | ChatThread |
| 12 | Auto-scroll lock while reading history | ChatThread (track user scroll-up) |
| 13 | Per-turn timestamp (relative; title=absolute) | Turn.tsx; reuse `ago()` |
| 14 | Regenerate last turn | page; reuse `sendTurn(lastUserMsg)` |
| 15 | Cmd/Ctrl+K session switcher + Cmd/Ctrl+N new | page; lightweight palette over the filter |
| 16 | Esc-to-stop while streaming + auto-focus composer on open | page/composer |

(16 listed — "~15"; trims to 15 if any proves redundant during build.)

### Deferred (~6, follow-up)
Today/Earlier session grouping · running-spinner on session row · clear-all
attachments/text buttons · large-paste→attach offer · `?` shortcuts overlay ·
export conversation as Markdown.

---

## Error handling

- localStorage reads/writes wrapped in try/catch (private-mode / quota) — silent ignore,
  matching `Shell.tsx`'s existing `localStorage` pattern.
- Clipboard `writeText` rejection → no-op (button shows a brief "copied"/nothing).
- Fullscreen `requestFullscreen()` can reject (no user gesture) → fall back to in-app
  chrome-hide only.
- Permission default change is server-side; no new failure path (mode is a known enum).

## Testing (jsdom + RTL in `apps/web/test/`, vitest)

- `fn-*` focused tests for logic: draft persistence round-trip, Cmd/Enter send,
  pin-sort ordering, filter, scroll-lock decision, copy handler, regenerate picks last
  user msg, Cmd+K/Cmd+N handlers.
- `cov-chatsessionlist.test.tsx` / `fn-chatsessionlist-engine.test.tsx` migrated to the
  persistent-panel markup (no popover trigger).
- Server: a `fn-chat-*` test asserting a chat session defaults to `bypassPermissions`
  (chatRepo) and that the launch opts carry it (no PreToolUse hook injected).
- Layout/CSS: light presence assertions (sidebar rendered, fullscreen toggle present).

## Risks

| Risk | Mitigation |
|------|------------|
| `bypassPermissions` in real cwd = unprompted file mutation | Explicitly requested; flagged in PR; gate infra kept for opt-in |
| ChatSessionList rewrite breaks existing tests | Migrate the 2 affected test files alongside |
| 16 features = wide surface / regressions | TDD per feature; each lands green before next |
| localStorage pins/drafts are per-browser | Acceptable ceiling; noted; server-sync deferred |
