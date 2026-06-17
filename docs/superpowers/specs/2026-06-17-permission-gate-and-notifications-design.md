# Mid-Run Permission Gate + User Notification System — Design

**Date:** 2026-06-17
**Status:** Approved (defaults confirmed by operator; "just go")

## Problem

Two related gaps:

1. **Permission gate.** When a running agent is about to use a sensitive tool (Bash, Write, Edit…), the operator has no way to approve/deny it. The existing inbox "Permission" card + `decidePermission` stdin path is **dormant**: claude 2.1.178 under headless `-p` has no `--permission-prompt-tool` and never emits `can_use_tool`/`control_request` to the portal (empirically confirmed — a real run that tried `touch` was blocked by claude's internal sandbox and reported it as plain text, going to `awaiting-input`, never `awaiting-permission`).

2. **Notification.** A gate is useless if the operator isn't told. Today the portal's only proactive reach is outbound HTTP webhooks (Slack/Discord/generic) on terminal/spend events. ask_human questions fire **no** notification at all and don't even bump the nav badge. There is **no** OS/native, desktop, or browser notification anywhere.

## Feasibility (proven by spike)

A **PreToolUse hook** injected via `--settings` is a real, *enforced* permission gate under headless `-p`:

| Probe | Result |
|---|---|
| Hook fires under `-p`? | ✅ (`hook_started`/`hook_response` in stream with `--include-hook-events`) |
| Payload usable? | ✅ `session_id` (= runId), `tool_name`, `tool_input`, `tool_use_id`, `cwd` |
| Hook can block while claude waits? | ✅ claude waited through a busy-wait; per-hook `timeout` configurable |
| Decision enforced? | ✅ `deny` → file not created; claude reported "a fleet permission hook denied it" and stopped |

This is the only mechanism that *stops* an action (the MCP-tool alternative is advisory — a misbehaving agent just skips it).

---

## Feature 1 — PreToolUse Permission Gate

### Flow

```
launch (requirePermission:true, permissionTools:[Bash,Write,Edit])
  → buildArgs injects --settings { hooks: { PreToolUse: [{ matcher:"Bash|Write|Edit",
        hooks:[{ type:"command", command:"node <hook> <PORT>", timeout:900 }] }] } }
  → agent calls Bash
  → fleet-permission-hook.mjs reads PreToolUse payload from stdin
  → POST http://127.0.0.1:<PORT>/internal/permission  (BLOCKS, held open server-side)
  → permissionGate.enqueuePermission(...) → pending item → inbox "permission" card + notification
  → operator clicks Approve/Deny in /inbox
  → resolvePermission(id, {decision}) → server replies to the held POST → hook prints
        { hookSpecificOutput: { permissionDecision: "allow"|"deny", permissionDecisionReason } }
  → claude proceeds or is blocked
```

### Decisions (operator-approved)

- **Trigger:** per-run **`requirePermission`** toggle (default **false**), independent of `humanGate`. Gated tools from **`permissionTools`** (default `['Bash','Write','Edit']`). Off-by-default keeps unattended campaign/loop/manager runs from blocking — same posture as `humanGate`.
- **Fail-closed:** fleet unreachable, hook error, or TTL expiry → **deny** (with reason). It's a security gate; failing open defeats it. Enforced at two layers: the hook's own `AbortSignal.timeout` (~880s) defaults to deny, and the store TTL auto-denies.
- **TTL:** `PERMISSION_GATE_TTL_MS` = `FLEET_PERMISSION_GATE_TTL_MS` || 900_000 (15 min), matching the hook `timeout`.

### Server units

- **`apps/server/src/permissionGate.ts`** (new — mirrors `gate.ts`, imports ONLY `config.js` to stay cycle-free):
  - `interface PermissionAnswer { decision: 'allow' | 'deny'; reason?: string }`
  - `interface PendingPermission { id; sessionId; tool; input; toolUseId; cwd; createdAt; answer: Promise<PermissionAnswer> }`
  - `enqueuePermission(input): PendingPermission` — Map-backed, `MAX_PERMISSIONS=64` runaway cap + oldest-eviction, `answer.catch(()=>{})`, TTL `setTimeout(()=>resolvePermission(id,{decision:'deny',reason:'timed out'}), PERMISSION_GATE_TTL_MS).unref()`. Calls `onPermissionEnqueued` hook (Feature 2).
  - `listPermissions()`, `resolvePermission(id, answer)`, `rejectPermissionsForSession(sessionId, reason)` (resolves all matching with deny), `subscribePermissionEnqueued(cb)`, `__clearPermissionsForTests()`.
- **`apps/server/src/permissionHookServer.ts`** (new) — `registerPermissionHookRoutes(app)`:
  - `POST /internal/permission` — body = the PreToolUse payload `{session_id, tool_name, tool_input, tool_use_id, cwd}`. Enqueues, **awaits `pending.answer`**, replies `{decision, reason}`. Localhost-only path (mirrors `/mcp/:sessionId`). Bounded by store TTL so it can't hang forever.
- **`apps/server/src/inbox.ts`** — `getInboxItems()` pushes pending permissions as `kind:'permission'` items shaped for the existing card, sourced from `listPermissions()` (not the dormant status/event path): `{ run: toSlim(registry.getRun(p.sessionId) ?? synthetic), kind:'permission', request:{ id: p.id, payload:{ tool: p.tool, input: p.input } }, viaHook:true }`. New route `POST /api/inbox/permissions/:id/decide` body `{decision:'approve'|'deny'}` → `resolvePermission(id, {decision: decision==='approve'?'allow':'deny'})`.
- **`apps/server/src/processManager.ts buildArgs()`** — when `req.requirePermission`, push BEFORE the `--` separator:
  `args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: (req.permissionTools?.length?req.permissionTools:DEFAULT_PERMISSION_TOOLS).join('|'), hooks:[{ type:'command', command:\`node \${HOOK_PATH} \${PORT}\`, timeout: 900 }] }] } }))`. `HOOK_PATH` resolves relative to the server module dir (works in dev + bundle). Independent of `humanGate`/`--mcp-config`.
- **`apps/server/src/registry.ts notifyTerminal()`** — add `rejectPermissionsForSession(lr.run.sessionId, \`run \${lr.run.status}\`)` next to `rejectGatesForSession` (the single chokepoint for onExit/stop/engine-exit).
- **`apps/server/src/config.ts`** — `PERMISSION_GATE_TTL_MS`; `DEFAULT_PERMISSION_TOOLS = ['Bash','Write','Edit']`.
- **`apps/server/src/server.ts`** — `registerPermissionHookRoutes(app)` in the route block.
- **`packages/shared/src/index.ts`** — `LaunchRequest`: `requirePermission?: boolean`, `permissionTools?: string[]`.

### Web units

- **`LaunchModal.tsx`** — inside the `!isEngineRun` guard: a **"require approval"** toggle + (when on) a compact tool selector (default Bash/Write/Edit). `submit()` threads `requirePermission` + `permissionTools`.
- **`lib/api.ts`** — `decidePermissionGate(id, decision)` → POST `/api/inbox/permissions/:id/decide`. (Legacy `api.permission` untouched.)
- **`inbox/page.tsx` PermissionCard** — Approve/Deny calls `decidePermissionGate(item.request.id, …)` when `item.viaHook` (store-sourced), else the legacy route. Truncate large `tool_input` (Write content / Edit strings).

### Desktop

- **`desktop/scripts/copy-web.cjs`** (or bundle step) — copy `tools/fleet-permission-hook.mjs` into the bundle so `HOOK_PATH` resolves in the packaged app. `node` is assumed on PATH (claude itself requires it).
- **`tools/fleet-permission-hook.mjs`** (new) — reads stdin payload, single blocking `fetch` to `http://127.0.0.1:<argv PORT>/internal/permission` with `AbortSignal.timeout(880_000)`; on success prints `{hookSpecificOutput:{permissionDecision, permissionDecisionReason}}`; on any error/timeout prints a **deny** decision; exits 0.

---

## Feature 2 — User Notification System

Make the portal proactively reach the operator the moment a run needs attention.

### Triggers (new)

- **awaiting-permission** (hook gate enqueued) — new in-app row + native/browser + channel.
- **awaiting-question** (ask_human gate enqueued) — currently fires nothing.
- (Existing: completed/failed/killed, spend thresholds — unchanged.)

### Channels

1. **In-app feed + badge.** `insertNotification(...)` row on each new gate (already surfaced at `/notifications`). Update the nav **Inbox badge** (`Shell.tsx`) to also count pending questions + permissions, not just `awaiting-permission|awaiting-input` runs.
2. **Browser Notification API** (works in browser tab *and* desktop renderer). New client watcher in `Shell.tsx` subscribes to a notification stream, pops `new Notification(title,{body})`, click → focus + deep-link to `/inbox`. Permission requested via a button on `/notifications` (needs a user gesture). Dedup by notification id. Enable/disable persisted in `localStorage` (per-browser).
3. **Desktop native** (Electron, no new deps). `desktop/main.cjs`: import `Notification`, open an `http` SSE connection to the new notification stream (main-process, no IPC/preload needed), on each event `new Notification({title,body}).show()`, `app.dock.setBadge(count)` (macOS) / `win.flashFrame(true)`, click → `win.show()/focus()`. Set `app.setAppUserModelId` for Windows toasts.

### Real-time signal — a notification bus

Gates don't flip run status (the questions store never did), so the fleet stream can't carry them. Add a dedicated stream:

- **`notifier.ts`** — in-memory pub/sub `subscribeNotifications(cb)` + broadcast inside `insertNotification(...)`. New SSE route **`GET /api/notifications/stream`** (reuse the `sse()` helper) consumed by BOTH the web watcher and the desktop main process. Extend `VALID_CHANNEL_EVENTS` with `'awaiting-question'` (and `'awaiting-input'`). Wire `subscribePermissionEnqueued` + an `onGateEnqueued` hook in `gate.ts`/`gateServer.handleAskHuman` → `insertNotification(...)` + `dispatchToChannels(...)`. Each new trigger needs its own dedupe set (the subscribeFleet handler fires on every tick).
- Map `sessionId → run` for task/portal context via `registry.getRun(sessionId)` (sessionId === runId).

### Notification preferences

- Reuse `NotifConfig` (notif_config table). Add booleans: `onAwaitingPermission`, `onAwaitingQuestion` (default true). Edited on `/notifications` (raw fetch to `/api/notifications/config` — update the page's local interface + `notifier.ts` `NotifConfig`/`DEFAULT_NOTIF_CONFIG`/`validateConfig` together).
- Browser-notification enable is client-only (`localStorage`), since the grant is per-browser.

---

## Testing

- **Unit (vitest):** `permissionGate.ts` (enqueue/resolve/TTL-deny/reject-by-session/cap-eviction); inbox surfacing of pending permissions; `/api/inbox/permissions/:id/decide`; `buildArgs` injects `--settings` only when `requirePermission`; notifier emits on permission/question enqueue with dedupe; `/api/notifications/stream` broadcasts.
- **Mock E2E:** drive the inbox permission card via `fixtures/permission-gate.jsonl` (already used) — but the real path is the hook, so also a hook-level test.
- **Real E2E (Playwright + real claude):** launch with `requirePermission`, agent hits Bash → permission card appears in `/inbox` + a browser Notification fires → Approve → tool runs; repeat → Deny → tool blocked. This is the acceptance gate (no smoke).

## Out of scope (v1)

- Inline permission card on the run page (inbox is the surface; can follow once status-flip is added).
- New webhook channel *kinds* (native uses the SSE bus, not a webhook URL).
- Persisting browser-notification grant server-side.

## Risks

- **Desktop `node` on PATH** for the hook command — assumed (claude needs node); verify in packaged app.
- **`HOOK_PATH` resolution** in the esbuild bundle — must copy the hook file + resolve relative to module dir.
- **Notification spam** — every new trigger MUST carry its own dedupe set keyed by run/gate id.
- **Fail-closed correctness** — both hook-timeout and store-TTL must deny, not allow.
