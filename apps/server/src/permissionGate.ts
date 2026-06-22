/**
 * F-perm — pending PreToolUse permission requests.
 *
 * Mirrors gate.ts (the ask_human store): an in-memory Map of requests, each carrying a
 * promise that the spawned permission hook awaits (over HTTP) until the operator decides
 * in /inbox. Imports ONLY config.js to stay import-cycle-free (registry.ts + inbox.ts both
 * import this statically). Fail-closed everywhere: TTL, eviction, and reject-by-session all
 * resolve with `deny` so a missed/leaked request never silently allows a tool.
 */
import { PERMISSION_GATE_TTL_MS } from './config.js';

export interface PermissionAnswer {
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface PendingPermission {
  id: string;
  sessionId: string;
  tool: string;
  input: unknown;
  toolUseId: string;
  cwd: string;
  createdAt: number;
  answer: Promise<PermissionAnswer>;
}

interface Internal extends PendingPermission {
  resolve: (a: PermissionAnswer) => void;
  ttl: ReturnType<typeof setTimeout>;
}

const perms = new Map<string, Internal>();
const MAX_PERMISSIONS = 64; // runaway guard, mirrors gate.ts MAX_GATES
let seq = 0;

type EnqueuedCb = (p: PendingPermission) => void;
const subscribers = new Set<EnqueuedCb>();

/** Notify on each enqueue (the notifier subscribes to alert the operator). */
export function subscribePermissionEnqueued(cb: EnqueuedCb): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function toPublic(p: Internal): PendingPermission {
  return {
    id: p.id,
    sessionId: p.sessionId,
    tool: p.tool,
    input: p.input,
    toolUseId: p.toolUseId,
    cwd: p.cwd,
    createdAt: p.createdAt,
    answer: p.answer,
  };
}

export function enqueuePermission(input: {
  sessionId: string;
  tool: string;
  input: unknown;
  toolUseId: string;
  cwd: string;
}): PendingPermission {
  const id = `perm_${Date.now()}_${seq++}`;
  let resolve!: (a: PermissionAnswer) => void;
  const answer = new Promise<PermissionAnswer>((r) => (resolve = r));
  answer.catch(() => {}); // unhandled-rejection safety (we only ever resolve, never reject)

  const ttl = setTimeout(
    () => resolvePermission(id, { decision: 'deny', reason: 'permission request timed out' }),
    PERMISSION_GATE_TTL_MS,
  );
  ttl.unref?.();

  const p: Internal = {
    id,
    sessionId: input.sessionId,
    tool: input.tool,
    input: input.input,
    toolUseId: input.toolUseId,
    cwd: input.cwd,
    createdAt: Date.now(),
    answer,
    resolve,
    ttl,
  };
  perms.set(id, p);

  // Evict the oldest if we blow the cap (deny it so its hook unblocks).
  if (perms.size > MAX_PERMISSIONS) {
    const oldest = perms.keys().next().value as string | undefined;
    if (oldest && oldest !== id) {
      resolvePermission(oldest, { decision: 'deny', reason: 'evicted (too many pending permissions)' });
    }
  }

  const pub = toPublic(p);
  for (const cb of subscribers) {
    try {
      cb(pub);
    } catch {
      /* a bad subscriber must not break enqueue */
    }
  }
  return pub;
}

export function listPermissions(): PendingPermission[] {
  return [...perms.values()].map(toPublic);
}

/** Resolve a pending permission. Returns true if a live entry was resolved, false if the id was
 *  already decided/expired/evicted (idempotent no-op) — callers use this to avoid reporting a
 *  decision on a request that no longer exists. */
export function resolvePermission(id: string, answer: PermissionAnswer): boolean {
  const p = perms.get(id);
  if (!p) return false;
  clearTimeout(p.ttl);
  perms.delete(id);
  p.resolve(answer);
  return true;
}

/** Deny every pending request (called on destructive resets so the in-memory store can't outlive
 *  the wiped DB and leave orphaned, approvable inbox cards). */
export function rejectAllPermissions(reason: string): void {
  for (const p of [...perms.values()]) resolvePermission(p.id, { decision: 'deny', reason });
}

/** Deny every pending request for a session (called when its run goes terminal). */
export function rejectPermissionsForSession(sessionId: string, reason: string): void {
  for (const p of [...perms.values()]) {
    if (p.sessionId === sessionId) resolvePermission(p.id, { decision: 'deny', reason });
  }
}

export function __clearPermissionsForTests(): void {
  for (const p of [...perms.values()]) {
    clearTimeout(p.ttl);
    p.resolve({ decision: 'deny', reason: 'cleared' });
  }
  perms.clear();
}
