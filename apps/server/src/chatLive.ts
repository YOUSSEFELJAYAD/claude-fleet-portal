/**
 * §3.3 / §10 — live-process manager for chat sessions. Owns the sessionId→live-handle map, the
 * CHAT_LIVE_MAX semaphore (a budget SEPARATE from maxConcurrentRuns so chat can never starve the
 * batch fleet and vice-versa), idle auto-suspend timers, and ensure/evict logic.
 *
 * ensureLive(session) returns { live:true, runId } when a slot is free (launches an interactive
 * run held open for instant turns + mid-turn input), or { live:false, runId:null } to signal
 * FALLBACK-TO-RESUMABLE when the budget is exhausted (the caller then resumes per-turn, ~1s slower).
 * Kill / server-restart / idle-eviction all drop the session to resumable without data loss
 * (the transcript lives in SQLite; the live process is ephemeral).
 */
import { registry } from './registry.js';
import { CHAT_LIVE_MAX, CHAT_IDLE_SUSPEND_MS } from './config.js';
import type { ChatSession } from '@fleet/shared';

interface LiveHandle { runId: string; idleTimer: ReturnType<typeof setTimeout> | null; }

/** Result of ensureLive: live=true means a held process (runId set); live=false = resumable fallback. */
export interface EnsureResult { live: boolean; runId: string | null; }

class ChatLiveManager {
  private handles = new Map<string, LiveHandle>();
  /** Fix 13 — in-flight launches keyed by sessionId. Two concurrent ensureLive for the same id
   *  both pass the existing-handle check, then each await registry.launch and set a handle — the
   *  second orphans the first (a leaked fleet slot). Serializing onto a single pending promise
   *  closes that window: the second caller awaits the first launch instead of spawning again. */
  private pending = new Map<string, Promise<EnsureResult>>();
  private inited = false;
  /** Fix 11 — listeners notified when a session's backing run id CHANGES (a fresh registry.launch
   *  in ensureLive). Lets an open chat SSE learn it must re-subscribe to the new run after an
   *  evict/kill → fresh-launch (claude reuses the id on plain resume, so we only fire on launch). */
  private runChangeSubs = new Set<(sessionId: string, runId: string) => void>();

  /** Subscribe to backing-run-id changes; returns an unsubscribe. */
  onBackingRunChange(cb: (sessionId: string, runId: string) => void): () => void {
    this.runChangeSubs.add(cb);
    return () => { this.runChangeSubs.delete(cb); };
  }
  private emitRunChange(sessionId: string, runId: string): void {
    for (const cb of this.runChangeSubs) { try { cb(sessionId, runId); } catch { /* dead listener */ } }
  }

  /**
   * Subscribe to run-terminal events ONCE, from server.ts boot (same pattern as
   * campaigns.init / pm.init / planboard.init / initNotifier / initMemory / initLearner).
   * Done here — NOT in the constructor — because `chatLive` is a module-level singleton, so a
   * constructor subscription would run at IMPORT time and require every test that imports chat.ts
   * (→ chatLive.ts) to stub registry.onRunTerminal. Deferring to boot keeps imports side-effect-free.
   *
   * When a held process dies on its own (crash / complete / external kill) the run is already
   * terminal → drop the handle WITHOUT calling registry.stop again (use dropHandle, not evict).
   */
  init(): void {
    if (this.inited) return;
    this.inited = true;
    registry.onRunTerminal((run) => {
      for (const [sessionId, h] of this.handles) {
        if (h.runId === run.id) { this.dropHandle(sessionId); break; }
      }
    });
  }

  /** A session is "live" iff a held interactive process is tracked for it. */
  isLive(sessionId: string): boolean { return this.handles.has(sessionId); }

  /** Run-id of the held process for a live session, else null. */
  liveRunId(sessionId: string): string | null { return this.handles.get(sessionId)?.runId ?? null; }

  /**
   * Ensure a live process for `session`. Reuses an existing handle; otherwise launches an
   * interactive run if a CHAT_LIVE_MAX slot is free; otherwise signals resumable fallback.
   */
  async ensureLive(session: ChatSession): Promise<EnsureResult> {
    // Synchronous fast paths stay OUTSIDE the pending map (no await → no race window).
    const existing = this.handles.get(session.id);
    if (existing) { this.touch(session.id); return { live: true, runId: existing.runId }; }
    if (this.handles.size >= CHAT_LIVE_MAX) return { live: false, runId: null };
    // Fix 13 — coalesce concurrent launches for one session onto a single in-flight promise so
    // a second caller awaits the first launch (and reuses its runId) instead of double-spawning.
    const inflight = this.pending.get(session.id);
    if (inflight) return inflight;
    const launch = this.launchLive(session).finally(() => { this.pending.delete(session.id); });
    this.pending.set(session.id, launch);
    return launch;
  }

  /** The actual launch path, serialized via `pending` so it runs at most once per session id. */
  private async launchLive(session: ChatSession): Promise<EnsureResult> {
    const run = await registry.launch({
      prompt: '', // held process waits on stdin; turns arrive via sendInput (no spurious turn-1)
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      allowedTools: session.allowedTools ?? undefined,
      skills: session.skills ?? undefined,
      interactive: true,
    } as any);
    const handle: LiveHandle = { runId: run.id, idleTimer: null };
    this.handles.set(session.id, handle);
    this.arm(session.id);
    // Fix 11 — a FRESH held run was minted (not the reuse/touch fast path above). Notify so any
    // open chat SSE re-subscribes to this new run id (the old one is now dead/evicted).
    this.emitRunChange(session.id, run.id);
    return { live: true, runId: run.id };
  }

  /** Mark activity on a live session — restarts its idle-suspend timer. No-op if not live. */
  touch(sessionId: string): void { if (this.handles.has(sessionId)) this.arm(sessionId); }

  /** Stop the held process and free the slot; the session drops to resumable. Idempotent. */
  evict(sessionId: string): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    this.dropHandle(sessionId);
    try { registry.stop(h.runId); } catch { /* already terminal */ }
  }

  /** Clear the idle timer + forget the handle WITHOUT stopping the run. Used when the backing
   *  run reached a terminal state on its own (calling registry.stop again would be redundant). */
  private dropHandle(sessionId: string): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    if (h.idleTimer) clearTimeout(h.idleTimer);
    this.handles.delete(sessionId);
  }

  private arm(sessionId: string): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    if (h.idleTimer) clearTimeout(h.idleTimer);
    h.idleTimer = setTimeout(() => this.evict(sessionId), CHAT_IDLE_SUSPEND_MS);
    h.idleTimer.unref?.();
  }

  /** Test-only: clear all timers + handles between cases (no process side effects beyond stop). */
  _resetForTest(): void {
    for (const h of this.handles.values()) if (h.idleTimer) clearTimeout(h.idleTimer);
    this.handles.clear();
    this.pending.clear();
    this.runChangeSubs.clear();
  }
}

export const chatLive = new ChatLiveManager();
