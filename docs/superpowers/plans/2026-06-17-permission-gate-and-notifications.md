# Permission Gate + Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add an enforced PreToolUse permission gate (operator approve/deny of sensitive tool calls under headless `-p`) and a proactive notification system (in-app + browser + desktop-native) that alerts the operator when a run is awaiting permission, awaiting a question, or terminal.

**Architecture:** Reuse the `gate.ts` store pattern for a `permissionGate.ts`. A portal-injected `--settings` PreToolUse hook (`tools/fleet-permission-hook.mjs`) blocks on a localhost callback (`/internal/permission`) that resolves when the operator decides in `/inbox`. A notification bus in `notifier.ts` (+ `/api/notifications/stream` SSE) feeds the existing in-app feed, a new browser-Notification watcher in the web `Shell`, and Electron-native notifications in `desktop/main.cjs`.

**Tech Stack:** Fastify, better-sqlite3, TypeScript, Next.js (App Router), Electron, vitest, Playwright. Ground truth: spec `docs/superpowers/specs/2026-06-17-permission-gate-and-notifications-design.md`.

**Conventions:** `pnpm -r typecheck` and `pnpm -r test` must stay green. ESM (`.js` import suffixes in server). `sessionId === runId`. New server stores import ONLY `config.js`. New flags pushed in `buildArgs` BEFORE the `args.push('--', req.prompt)` line.

---

## Phase A — Permission Gate

### Task 1: shared types + config constants

**Files:** Modify `packages/shared/src/index.ts`; modify `apps/server/src/config.ts`; Test `apps/server/test/cov-config.test.ts` (or nearest config test).

- [ ] **Step 1:** In `packages/shared/src/index.ts` `LaunchRequest`, add near `humanGate`:
```ts
  /** F-perm — inject the PreToolUse permission-gate hook so the operator approves gated tools. Default false. */
  requirePermission?: boolean;
  /** F-perm — tools the permission gate intercepts (matcher alternation). Default ['Bash','Write','Edit']. */
  permissionTools?: string[];
```
- [ ] **Step 2:** In `apps/server/src/config.ts`, after `GATE_TTL_MS`:
```ts
export const PERMISSION_GATE_TTL_MS = Number(process.env.FLEET_PERMISSION_GATE_TTL_MS || 900_000);
export const DEFAULT_PERMISSION_TOOLS = ['Bash', 'Write', 'Edit'] as const;
```
- [ ] **Step 3:** `pnpm --filter @fleet/shared build && pnpm -r typecheck` → PASS. Commit `feat(perm): launch fields + config constants`.

### Task 2: `permissionGate.ts` store (mirror gate.ts)

**Files:** Create `apps/server/src/permissionGate.ts`; Test `apps/server/test/permission-gate.test.ts`.

- [ ] **Step 1: Write failing tests** covering: enqueue returns id+promise; resolve fulfills the promise; TTL auto-denies; reject-by-session denies all matching; cap eviction at MAX_PERMISSIONS; `subscribePermissionEnqueued` fires on enqueue. Use fake timers for TTL.
- [ ] **Step 2: Implement** (mirror `gate.ts` exactly):
```ts
import { PERMISSION_GATE_TTL_MS } from './config.js';

export interface PermissionAnswer { decision: 'allow' | 'deny'; reason?: string }
export interface PendingPermission {
  id: string; sessionId: string; tool: string; input: unknown;
  toolUseId: string; cwd: string; createdAt: number; answer: Promise<PermissionAnswer>;
}
interface Internal extends PendingPermission { resolve: (a: PermissionAnswer) => void; ttl: NodeJS.Timeout }

const perms = new Map<string, Internal>();
const MAX_PERMISSIONS = 64;
let seq = 0;
type EnqueuedCb = (p: PendingPermission) => void;
const subscribers = new Set<EnqueuedCb>();

export function subscribePermissionEnqueued(cb: EnqueuedCb): () => void {
  subscribers.add(cb); return () => subscribers.delete(cb);
}

export function enqueuePermission(input: {
  sessionId: string; tool: string; input: unknown; toolUseId: string; cwd: string;
}): PendingPermission {
  const id = `perm_${Date.now()}_${seq++}`;
  let resolve!: (a: PermissionAnswer) => void;
  const answer = new Promise<PermissionAnswer>((r) => (resolve = r));
  answer.catch(() => {});
  const ttl = setTimeout(
    () => resolvePermission(id, { decision: 'deny', reason: 'permission request timed out' }),
    PERMISSION_GATE_TTL_MS,
  );
  ttl.unref?.();
  const p: Internal = { id, sessionId: input.sessionId, tool: input.tool, input: input.input,
    toolUseId: input.toolUseId, cwd: input.cwd, createdAt: Date.now(), answer, resolve, ttl };
  perms.set(id, p);
  if (perms.size > MAX_PERMISSIONS) {
    const oldest = perms.keys().next().value as string | undefined;
    if (oldest) resolvePermission(oldest, { decision: 'deny', reason: 'evicted (too many pending)' });
  }
  const pub: PendingPermission = { id, sessionId: p.sessionId, tool: p.tool, input: p.input,
    toolUseId: p.toolUseId, cwd: p.cwd, createdAt: p.createdAt, answer };
  for (const cb of subscribers) { try { cb(pub); } catch {} }
  return pub;
}

export function listPermissions(): PendingPermission[] {
  return [...perms.values()].map((p) => ({ id: p.id, sessionId: p.sessionId, tool: p.tool,
    input: p.input, toolUseId: p.toolUseId, cwd: p.cwd, createdAt: p.createdAt, answer: p.answer }));
}

export function resolvePermission(id: string, answer: PermissionAnswer): void {
  const p = perms.get(id); if (!p) return;
  clearTimeout(p.ttl); perms.delete(id); p.resolve(answer);
}

export function rejectPermissionsForSession(sessionId: string, reason: string): void {
  for (const p of [...perms.values()]) {
    if (p.sessionId === sessionId) resolvePermission(p.id, { decision: 'deny', reason });
  }
}

export function __clearPermissionsForTests(): void {
  for (const p of [...perms.values()]) { clearTimeout(p.ttl); p.resolve({ decision: 'deny', reason: 'cleared' }); }
  perms.clear();
}
```
- [ ] **Step 3:** Tests PASS. `pnpm --filter @fleet/server typecheck`. Commit `feat(perm): pending-permission store`.

### Task 3: hook callback route

**Files:** Create `apps/server/src/permissionHookServer.ts`; modify `apps/server/src/server.ts`; Test `apps/server/test/permission-hook-route.test.ts`.

- [ ] **Step 1: Failing test:** POST `/internal/permission` with a payload; in another tick `resolvePermission` the only pending entry with allow; assert the response body is `{decision:'allow'}`.
- [ ] **Step 2: Implement:**
```ts
import type { FastifyInstance } from 'fastify';
import { enqueuePermission } from './permissionGate.js';

export function registerPermissionHookRoutes(app: FastifyInstance) {
  app.post('/internal/permission', async (req) => {
    const b = (req.body as any) ?? {};
    const sessionId = b.session_id ?? b.sessionId ?? '';
    const p = enqueuePermission({
      sessionId,
      tool: b.tool_name ?? b.tool ?? 'unknown',
      input: b.tool_input ?? b.input ?? null,
      toolUseId: b.tool_use_id ?? b.toolUseId ?? '',
      cwd: b.cwd ?? '',
    });
    const answer = await p.answer; // bounded by store TTL
    return { decision: answer.decision, reason: answer.reason ?? '' };
  });
}
```
- [ ] **Step 3:** Register in `server.ts` route block (near `registerGateRoutes(app)`): import + `registerPermissionHookRoutes(app);`.
- [ ] **Step 4:** Tests PASS, typecheck. Commit `feat(perm): blocking hook callback route`.

### Task 4: the hook script

**Files:** Create `tools/fleet-permission-hook.mjs`.

- [ ] **Step 1: Implement** (fail-closed):
```js
#!/usr/bin/env node
/** Fleet PreToolUse permission gate hook. Reads the PreToolUse payload from stdin,
 *  blocks on the fleet for an operator decision, prints allow/deny. Fail-closed. */
import { readFileSync } from 'node:fs';
const PORT = process.argv[2] || '4319';
function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } }) + '\n');
  process.exit(0);
}
let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {}
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/internal/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(880_000),
  });
  if (!res.ok) decide('deny', `fleet permission gate error (${res.status})`);
  const j = await res.json();
  decide(j.decision === 'allow' ? 'allow' : 'deny', j.reason || 'operator decision');
} catch (e) {
  decide('deny', `fleet permission gate unreachable: ${e?.message || e}`);
}
```
- [ ] **Step 2:** `chmod +x tools/fleet-permission-hook.mjs`. Commit `feat(perm): PreToolUse hook script`.

### Task 5: inject `--settings` in buildArgs

**Files:** Modify `apps/server/src/processManager.ts`; Test `apps/server/test/cov-process-args.test.ts` (or nearest buildArgs test).

- [ ] **Step 1: Failing test:** `buildArgs({...,requirePermission:true,permissionTools:['Bash']}, sid, true)` contains `--settings` followed by JSON with `hooks.PreToolUse[0].matcher === 'Bash'`; and a request WITHOUT `requirePermission` contains NO `--settings`.
- [ ] **Step 2: Implement.** At top, resolve hook path relative to module dir:
```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'fleet-permission-hook.mjs');
```
(Adjust the relative depth so it resolves from `apps/server/src` to repo `tools/`; in the bundle, Task 12 copies the hook adjacent — resolve via an env override `FLEET_PERMISSION_HOOK_PATH` if set.)
Then in `buildArgs`, BEFORE the `--` push:
```ts
if (req.requirePermission) {
  const tools = req.permissionTools?.length ? req.permissionTools : [...DEFAULT_PERMISSION_TOOLS];
  const hookPath = process.env.FLEET_PERMISSION_HOOK_PATH || HOOK_PATH;
  args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [
    { matcher: tools.join('|'), hooks: [{ type: 'command', command: `node ${hookPath} ${PORT}`, timeout: 900 }] },
  ] } }));
}
```
Import `DEFAULT_PERMISSION_TOOLS` from `config.js`.
- [ ] **Step 3:** Tests PASS, typecheck. Commit `feat(perm): inject PreToolUse hook via --settings`.

### Task 6: inbox surfacing + decide route

**Files:** Modify `apps/server/src/inbox.ts`; Test `apps/server/test/cov-inbox.test.ts` (or nearest).

- [ ] **Step 1: Failing test:** enqueue a permission, call `getInboxItems()`, assert one `kind:'permission'` item with `request.payload.tool` and `request.id` and `viaHook:true`; POST `/api/inbox/permissions/:id/decide {decision:'deny'}` resolves the pending answer to `{decision:'deny'}`.
- [ ] **Step 2: Implement.** Add to `InboxItem` interface: `viaHook?: boolean`. Import `listPermissions, resolvePermission` from `./permissionGate.js`. In `getInboxItems()` after the gates loop:
```ts
for (const p of listPermissions()) {
  const run = registry.getRun(p.sessionId);
  items.push({
    run: run ? toSlim(run) : { id: p.sessionId, task: '(permission)', cwd: p.cwd, model: '', status: 'awaiting-permission', startedAt: p.createdAt, costUsd: 0 },
    kind: 'permission', viaHook: true,
    request: { id: p.id, payload: { tool: p.tool, input: p.input } },
  });
}
```
In `registerInboxRoutes`:
```ts
app.post('/api/inbox/permissions/:id/decide', async (req) => {
  const { id } = req.params as { id: string };
  const { decision } = (req.body as any) ?? {};
  if (decision !== 'approve' && decision !== 'deny') { /* reply 400 */ }
  resolvePermission(id, { decision: decision === 'approve' ? 'allow' : 'deny', reason: `operator ${decision}` });
  return { ok: true };
});
```
- [ ] **Step 3:** Tests PASS, typecheck. Commit `feat(perm): surface permission gates in inbox + decide route`.

### Task 7: terminal cleanup

**Files:** Modify `apps/server/src/registry.ts`; Test extend permission-gate or registry test.

- [ ] **Step 1:** In `notifyTerminal()` (~registry.ts:137) add after `rejectGatesForSession(...)`:
```ts
rejectPermissionsForSession(lr.run.sessionId, `run ${lr.run.status}`);
```
Import `rejectPermissionsForSession` from `./permissionGate.js`.
- [ ] **Step 2: Test:** enqueue a permission for a session, simulate terminal (or call the exported reject), assert the pending answer resolves to deny.
- [ ] **Step 3:** Typecheck + tests. Commit `feat(perm): deny pending permissions when run goes terminal`.

### Task 8: web — launch toggle, api, card wiring

**Files:** Modify `apps/web/components/LaunchModal.tsx`, `apps/web/lib/api.ts`, `apps/web/app/inbox/page.tsx`.

- [ ] **Step 1:** `api.ts`: `decidePermissionGate: (id: string, decision: 'approve'|'deny') => j('/api/inbox/permissions/'+id+'/decide', { method:'POST', body: JSON.stringify({decision}) })`.
- [ ] **Step 2:** `LaunchModal.tsx`: add `const [requirePermission, setRequirePermission] = useState(false)` and `permissionTools` state (default `['Bash','Write','Edit']`); render a toggle + tool checkboxes inside `{!isEngineRun && ...}`; include both in the `submit()` LaunchRequest.
- [ ] **Step 3:** `inbox/page.tsx` PermissionCard: when `item.viaHook`, Approve/Deny → `api.decidePermissionGate(item.request.id, decision)`; truncate large `tool_input` display.
- [ ] **Step 4:** `pnpm --filter @fleet/web typecheck` PASS. Commit `feat(perm): launch toggle + inbox decide wiring`.

---

## Phase B — Notifications

### Task 9: notification bus + stream + config + events

**Files:** Modify `apps/server/src/notifier.ts`; Test `apps/server/test/cov-notifier.test.ts`.

- [ ] **Step 1:** Add a module pub/sub:
```ts
type NotifCb = (row: NotificationRow) => void;
const notifSubs = new Set<NotifCb>();
export function subscribeNotifications(cb: NotifCb): () => void { notifSubs.add(cb); return () => notifSubs.delete(cb); }
```
Broadcast at the end of `insertNotification(...)`: `for (const cb of notifSubs) { try { cb(row); } catch {} }`.
- [ ] **Step 2:** Extend `VALID_CHANNEL_EVENTS` with `'awaiting-question'` and `'awaiting-input'`. Add `onAwaitingPermission`, `onAwaitingQuestion` booleans to `NotifConfig` + `DEFAULT_NOTIF_CONFIG` (default true) + `validateConfig`.
- [ ] **Step 3:** Add SSE route in `registerNotifierRoutes`:
```ts
app.get('/api/notifications/stream', (req, reply) => {
  const s = sse(reply, req); if (!s) return;
  const off = subscribeNotifications((row) => s.send({ kind: 'notification', notification: row }));
  req.raw.on('close', off);
});
```
(Import/replicate the `sse` helper access used by `/api/fleet/stream`; if `sse` is private to server.ts, expose a small helper or register this route in server.ts instead.)
- [ ] **Step 4:** Tests for broadcast + new config fields. Typecheck. Commit `feat(notify): notification bus + SSE stream + config`.

### Task 10: fire notifications on permission + question enqueue

**Files:** Modify `apps/server/src/notifier.ts` (`initNotifier`), `apps/server/src/gate.ts` (add `subscribeGateEnqueued`), `apps/server/src/permissionGate.ts` (already has `subscribePermissionEnqueued`). Test `cov-notifier.test.ts`.

- [ ] **Step 1:** In `gate.ts`, mirror the permission subscriber: `subscribeGateEnqueued(cb)` fired inside `enqueueGate` after `gates.set`.
- [ ] **Step 2:** In `initNotifier()`:
```ts
subscribePermissionEnqueued((p) => {
  const cfg = getNotifConfig(); if (!cfg.enabled || !cfg.onAwaitingPermission) return;
  const run = registry.getRun(p.sessionId);
  const msg = `Permission requested: ${p.tool} — ${run?.task ?? p.sessionId}`;
  insertNotification('awaiting-permission', msg, p.sessionId);
  if (run) dispatchToChannels('awaiting-permission', run);
});
subscribeGateEnqueued((g) => {
  const cfg = getNotifConfig(); if (!cfg.enabled || !cfg.onAwaitingQuestion) return;
  const run = registry.getRun(g.sessionId);
  insertNotification('awaiting-question', `Agent question: ${g.question.slice(0,80)}`, g.sessionId);
  if (run) dispatchToChannels('awaiting-question', run);
});
```
(No extra dedupe set needed — these fire once per enqueue, not per fleet tick.)
- [ ] **Step 3:** Tests: enqueue → insertNotification called once; disabled config → not called. Typecheck. Commit `feat(notify): alert on awaiting-permission + awaiting-question`.

### Task 11: web — browser notifications + badge + settings

**Files:** Modify `apps/web/components/Shell.tsx`, `apps/web/lib/live.ts`, `apps/web/app/notifications/page.tsx`.

- [ ] **Step 1:** `live.ts`: `useNotificationStream()` — EventSource to `/api/notifications/stream`, returns latest events; dedupe by row id.
- [ ] **Step 2:** `Shell.tsx`: mount a client effect using `useNotificationStream()` that, if `localStorage.fleetBrowserNotif==='on'` and `Notification.permission==='granted'`, pops `new Notification(title,{body})`; click → `window.focus()` + route to `/inbox`. Update `inboxCount` to also include pending questions + permissions (poll `api.inbox()` or count from the stream).
- [ ] **Step 3:** `notifications/page.tsx`: add an "Enable browser notifications" button → `Notification.requestPermission()` + set `localStorage`; add toggles for `onAwaitingPermission`/`onAwaitingQuestion` (extend the local NotifConfig interface + the raw `/api/notifications/config` PUT body).
- [ ] **Step 4:** `pnpm --filter @fleet/web typecheck` + `pnpm --filter @fleet/web build`. Commit `feat(notify): browser notifications + inbox badge + settings`.

### Task 12: desktop native notifications

**Files:** Modify `desktop/main.cjs`; modify `desktop/scripts/copy-web.cjs` (or bundle script) to copy `tools/fleet-permission-hook.mjs`.

- [ ] **Step 1:** In `main.cjs`, destructure `Notification` from electron; after the window loads + server is up, open `http.get('http://127.0.0.1:'+API_PORT+'/api/notifications/stream')`, parse `data:` lines, and for each `{kind:'notification'}` call `new Notification({ title:'Claude Fleet', body: row.message }).show()`, `app.dock?.setBadge?.(...)` (macOS) / `win.flashFrame(true)`; `notif.on('click', () => { win.show(); win.focus(); })`. Set `app.setAppUserModelId('com.youssefeljayad.claude-fleet-portal')` early.
- [ ] **Step 2:** Bundle: copy `tools/fleet-permission-hook.mjs` into the bundle dir and set `FLEET_PERMISSION_HOOK_PATH` for the bundled server (in `main.cjs` server fork env) to the copied path.
- [ ] **Step 3:** `node -c desktop/main.cjs` (syntax) + `pnpm --filter ...desktop prepare:app` smoke if feasible. Commit `feat(notify): Electron native notifications + bundle hook`.

---

## Phase C — Verification

### Task 13: full test + real E2E

- [x] **Step 1:** `pnpm -r typecheck && pnpm -r test` → GREEN (typecheck all 3 projects; server 150 files / 1775 tests; web build OK).
- [~] **Step 2:** Real E2E (real claude + Playwright approve/deny) — **DEFERRED to manual QA** (needs a real `claude` binary + Playwright harness not in CI). The fail-closed enforcement round-trip is instead covered by an automated process-level test, `apps/server/test/fn-permission-hook-script.test.ts`, which spawns the real `tools/fleet-permission-hook.mjs` and asserts DENY on unreachable / non-2xx / non-JSON / non-allow and ALLOW only on explicit `{decision:'allow'}`.
- [x] **Step 3:** Final adversarial review (two-pass workflow, 33 agents): correctness (fail-closed, dedupe, terminal/reset cleanup), security (matcher escaping, localhost-only callback, no allow-on-error), desktop path resolution. All confirmed findings fixed (see review pass 2026-06-17).
- [ ] **Step 4:** Commit + open PR.

## Self-review notes
- Type consistency: `PermissionAnswer.decision` is `'allow'|'deny'` everywhere (store, hook, route); the web/inbox uses `'approve'|'deny'` and maps to allow/deny at the decide route — single mapping point.
- `subscribePermissionEnqueued`/`subscribeGateEnqueued` named consistently.
- Fail-closed verified at hook (timeout/error→deny) and store (TTL→deny) and terminal (reject→deny).
