/**
 * Task 1.3 — turn orchestration with server-declared boundaries.
 *
 * Wraps (does NOT replace) chatLive + registry and turns a conversation into first-class `turn`s.
 * The server DECLARES turn boundaries; the client never infers them from run ids. All backing
 * run-id juggling (live held process, no-slot one-shot, resume, engine, kill→resume) is hidden
 * here behind a single stable `turnId`:
 *
 *   startTurn → emit turn:start → (turn:event)* → turn:settled | turn:failed
 *
 * The orchestrator subscribes to whatever run currently backs a turn, re-tags its NormalizedEvents
 * as turn:event frames, accumulates assistant text, and on the run's result/terminal persists the
 * assistant message(s) under the SAME turnId. Across a backing-run change (chatLive.onBackingRunChange
 * / notifyBackingRun) it re-subscribes and keeps emitting under the original turnId — the run id never
 * routes a frame.
 */
import path from 'node:path';
import { chatRepo } from './chatRepo.js';
import { registry } from './registry.js';
import { chatLive } from './chatLive.js';
import { safePath, repoRoot } from './git.js';
import type {
  ChatAttachment, ChatMessage, ChatTurn, ChatStreamFrame, StreamMessage,
} from '@fleet/shared';

const ENGINE_PROMPT_CAP = 6_000;
const TERMINAL_RUN = new Set(['completed', 'failed', 'killed']);

/** Engines (codex/opencode) cannot resume, so reconstruct a capped transcript prefix into each
 *  turn's prompt (DC §D-030). Keeps the most recent turns when over the cap. */
export function buildEnginePrompt(history: Array<{ role: string; content: string }>, message: string): string {
  const tail = `\nUser: ${message}\nAssistant:`;
  const turns = history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  let body = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    const next = turns[i] + '\n' + body;
    if (next.length + tail.length > ENGINE_PROMPT_CAP) break;
    body = next;
  }
  return (body + tail).trimStart();
}

/**
 * Fix 07 (security) — containment-check @-attachment paths against a SERVER-TRUSTED workspace
 * `root` before they reach `--add-dir`. Each path is resolved through git.ts's realpath-containment
 * `safePath` guard (the same one fileview.ts uses): a path that stays inside `root` is KEPT as its
 * resolved ABSOLUTE path; a `..`-traversal, an absolute path, or a symlink that escapes `root` is
 * DROPPED. `root` MUST come from server state (never the client). Absolute attachment paths are
 * rebased onto `root` (a bare absolute path is treated as host-escape and dropped unless it lives
 * inside the root). Returns the contained absolute dirs, de-duplicated, order-preserved.
 */
export async function containDirs(root: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const absRoot = path.resolve(root);
  for (const p of paths ?? []) {
    if (typeof p !== 'string' || !p) continue;
    // safePath rejects absolute `rel` outright; for an absolute attachment that genuinely lives
    // inside the root, re-express it root-relative so a contained absolute path is still accepted.
    let rel = p;
    if (path.isAbsolute(p)) {
      const r = path.relative(absRoot, path.resolve(p));
      if (r === '' || r.startsWith('..') || path.isAbsolute(r)) continue; // outside root → drop
      rel = r;
    }
    const safe = await safePath(absRoot, rel);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out;
}

/** Resolve a session's server-trusted workspace root for containment: the git toplevel of its cwd
 *  when in a repo, else the raw cwd. NEVER derived from client input (mirrors fileview.ts §6.1). */
async function sessionRoot(cwd: string): Promise<string> {
  return (await repoRoot(cwd)) ?? cwd;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  runId: string;
  turn: ChatTurn;
  unsubRun: (() => void) | null;
  unsubChange: () => void;
  assistant: string;       // accumulated assistant_text payloads
  resultText: string | null; // claude `result` event text (preferred when present)
  settled: boolean;
  frames: ChatStreamFrame[]; // replay buffer for a late subscriber (chatStream connecting mid-turn)
}

class ChatTurns {
  /** per-session frame pub/sub (mirrors chatLive's Map<id, Set<cb>> style). */
  private subs = new Map<string, Set<(f: ChatStreamFrame) => void>>();
  /** the single in-flight turn per session. */
  private active = new Map<string, ActiveTurn>();

  /** Subscribe to a session's turn frames. A late subscriber (chatStream connecting mid-turn) is
   *  replayed the active turn's buffered frames so it sees turn:start + events it missed. */
  subscribe(sessionId: string, cb: (frame: ChatStreamFrame) => void): () => void {
    let set = this.subs.get(sessionId);
    if (!set) { set = new Set(); this.subs.set(sessionId, set); }
    set.add(cb);
    const at = this.active.get(sessionId);
    if (at) for (const f of at.frames) { try { cb(f); } catch { /* dead subscriber */ } }
    return () => { set!.delete(cb); if (set!.size === 0) this.subs.delete(sessionId); };
  }

  activeTurn(sessionId: string): ChatTurn | null { return this.active.get(sessionId)?.turn ?? null; }

  private emit(sessionId: string, frame: ChatStreamFrame): void {
    const at = this.active.get(sessionId);
    if (at) at.frames.push(frame);
    for (const cb of this.subs.get(sessionId) ?? []) { try { cb(frame); } catch { /* dead subscriber */ } }
  }

  /**
   * Run one chat turn. Persists the user message under a fresh turnId, declares the turn
   * (status streaming) + emits turn:start, then dispatches via the SAME execution paths as the
   * legacy chat.ts startTurn (claude live via ensureLive+sendInput; no-slot one-shot launch;
   * resume; engine via buildEnginePrompt+launchEngine) and subscribes the backing run.
   *
   * Returns { turnId, runId, userMessage } — `turnId` is the contract; runId/userMessage are kept
   * for the still-registered legacy chat SSE route + existing callers (transitional).
   */
  async startTurn(
    sessionId: string,
    message: string,
    attachments?: ChatAttachment[],
  ): Promise<{ turnId: string; runId: string; userMessage: ChatMessage }> {
    const session = chatRepo.getSession(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('message is required'), { statusCode: 400 });

    // I-1: one active turn per session; a second call while the first is streaming is a client bug.
    const existing = this.active.get(sessionId);
    if (existing && !existing.settled) throw Object.assign(new Error('a turn is already in progress for this session'), { statusCode: 409 });

    const turnId = chatRepo.newTurnId();
    const userMessage = chatRepo.addMessage({ sessionId, role: 'user', kind: 'text', content: message, runId: null, attachments, turnId });

    // §6.2 — files become path-reference tokens in the prompt; dirs become --add-dir for this turn.
    // Fix 07 — dir attachments are containment-checked against the session's SERVER-TRUSTED root.
    const root = await sessionRoot(session.cwd);
    const files = (attachments ?? []).filter((a) => a.kind === 'file').map((a) => a.path);
    const addDirs = await containDirs(root, (attachments ?? []).filter((a) => a.kind === 'dir').map((a) => a.path));
    const refSuffix = files.length ? `\n\nReferenced files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';
    const prompt = message + refSuffix;

    // Declare the turn BEFORE dispatch so turn:start + early events buffer under it.
    const turn: ChatTurn = { id: turnId, sessionId, status: 'streaming', messages: [userMessage], createdAt: userMessage.createdAt, settledAt: null };
    const at: ActiveTurn = { turnId, sessionId, runId: '', turn, unsubRun: null, unsubChange: () => {}, assistant: '', resultText: null, settled: false, frames: [] };
    this.active.set(sessionId, at);
    this.emit(sessionId, { kind: 'turn:start', turn });

    // M-1: register run-change BEFORE the async dispatch so a backing-run change fired DURING
    // dispatch (e.g. old run killed while ensureLive/launch/resume is awaited) is never missed.
    at.unsubChange = chatLive.onBackingRunChange?.((sid, newRunId) => this.onRunChange(sid, newRunId)) ?? (() => {});

    const baseOpts = {
      cwd: session.cwd, model: session.model, effort: session.effort, permissionMode: session.permissionMode,
      allowedTools: session.allowedTools ?? undefined, skills: session.skills ?? undefined,
      humanGate: true,
      ...(addDirs.length ? { addDirs } : {}),
    };

    let run: { id: string };
    if (session.engine && session.engine !== 'claude') {
      const history = chatRepo.listMessages(sessionId).slice(0, -1); // exclude the just-added user msg
      const enginePrompt = buildEnginePrompt(history.map((m) => ({ role: m.role, content: m.content })), prompt);
      run = await registry.launchEngine({ ...baseOpts, engine: session.engine, prompt: enginePrompt });
      this.subscribeBackingRun(sessionId, run.id);
    } else {
      // §3.3 — claude turns route through the HELD interactive process when a slot is free.
      const ensured = await chatLive.ensureLive(session); // claude only
      if (ensured.live && ensured.runId) {
        // Subscribe BEFORE sendInput so this turn's events arrive as live frames (no gap, no
        // replay of the held run's prior-turn history).
        this.subscribeBackingRun(sessionId, ensured.runId);
        registry.sendInput(ensured.runId, prompt);
        chatLive.touch(session.id);
        run = { id: ensured.runId };
      } else if (!session.runId) {
        run = await registry.launch({ ...baseOpts, prompt }); // budget-exhausted fallback: one-shot
        this.subscribeBackingRun(sessionId, run.id);
      } else {
        run = await registry.resume(session.runId, prompt, undefined, addDirs.length ? addDirs : undefined);
        this.subscribeBackingRun(sessionId, run.id);
      }
    }

    chatRepo.setSessionRun(sessionId, run.id);
    // Announce the backing run to the still-registered legacy chat SSE (no-op for the held/resume
    // paths it already streams; rescues a budget-exhausted one-shot). Harmless here (same-id guard).
    chatLive.notifyBackingRun?.(sessionId, run.id);

    return { turnId, runId: run.id, userMessage };
  }

  /** Subscribe the orchestrator to a backing run; tolerates a mocked-out registry (subscribeRun
   *  absent) or a vanished run (subscribeRun → null). Idempotent for the same runId: moving
   *  onBackingRunChange before the dispatch means launchLive's emitRunChange can call us first,
   *  then the dispatch calls us again with the same id — the second call is a no-op. */
  private subscribeBackingRun(sessionId: string, runId: string): void {
    const at = this.active.get(sessionId);
    if (!at) return;
    if (at.runId === runId) return; // already subscribed to this run — skip double-subscribe
    at.unsubRun?.();
    at.runId = runId;
    at.unsubRun = registry.subscribeRun?.(runId, (m: StreamMessage) => this.onRunMessage(sessionId, m)) ?? null;
  }

  /** A fresh run now backs the session's active turn → move the subscription onto it. */
  private onRunChange(sessionId: string, newRunId: string): void {
    const at = this.active.get(sessionId);
    if (!at || at.settled || newRunId === at.runId) return;
    at.unsubRun?.();
    this.subscribeBackingRun(sessionId, newRunId);
  }

  /** Re-tag a backing run's live messages as turn frames; settle on result/terminal. The `hello`
   *  snapshot's historical events are IGNORED — they belong to prior turns / are already persisted. */
  private onRunMessage(sessionId: string, m: StreamMessage): void {
    const at = this.active.get(sessionId);
    if (!at || at.settled) return;

    if (m.kind === 'event') {
      const ev = m.event;
      this.emit(sessionId, { kind: 'turn:event', turnId: at.turnId, event: ev });
      if (ev.type === 'assistant_text') at.assistant += String(ev.payload?.text ?? '');
      else if (ev.type === 'result') {
        if (typeof ev.payload?.result === 'string') at.resultText = ev.payload.result;
        this.finish(sessionId, ev.payload?.isError ? 'failed' : 'settled', ev.payload?.isError ? 'result error' : undefined);
      }
      return;
    }
    if (m.kind === 'run' && TERMINAL_RUN.has(m.run.status)) {
      // Engines (no result event on success) settle on `completed`; a crash/kill fails the turn.
      if (m.run.status === 'completed') this.finish(sessionId, 'settled');
      else this.finish(sessionId, 'failed', m.run.error ?? (m.run.status === 'killed' ? 'interrupted' : 'run failed'));
    }
    // `hello` + `node` frames carry no turn boundary → ignored.
  }

  /** Settle the active turn exactly once: persist the assistant message (success) and emit the
   *  terminal frame, then clear the active turn. */
  private finish(sessionId: string, status: 'settled' | 'failed', error?: string): void {
    const at = this.active.get(sessionId);
    if (!at || at.settled) return;
    at.settled = true;
    at.unsubRun?.();
    at.unsubChange();

    if (status === 'settled') {
      const content = at.resultText && at.resultText.trim() ? at.resultText : at.assistant;
      const msg = chatRepo.addMessage({ sessionId, role: 'assistant', kind: 'text', content, runId: at.runId, turnId: at.turnId });
      this.emit(sessionId, { kind: 'turn:settled', turnId: at.turnId, assistantMessageId: msg.id });
    } else {
      this.emit(sessionId, { kind: 'turn:failed', turnId: at.turnId, error: error ?? 'turn failed' });
    }
    this.active.delete(sessionId);
  }

  /** Test-only: drop in-flight turns + subscribers between cases. */
  _resetForTest(): void {
    for (const at of this.active.values()) { try { at.unsubRun?.(); at.unsubChange(); } catch { /* */ } }
    this.active.clear();
    this.subs.clear();
  }
}

export const chatTurns = new ChatTurns();
