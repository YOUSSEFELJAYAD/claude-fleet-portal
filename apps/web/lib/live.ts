'use client';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type {
  Run,
  RunNode,
  NormalizedEvent,
  SpendSummary,
  FleetMessage,
  StreamMessage,
  Campaign,
  CampaignTask,
  CampaignMessage,
  ChatSessionState,
  ChatTurn,
  ChatTurnStatus,
} from '@fleet/shared';
import { API, api } from './api';
import type { QuestionData } from '@/components/QuestionCard';

// ── shared event accumulator ─────────────────────────────────────────────────
/** Accumulates assistant_partial text deltas into partials[nodeId], clears a node's
 *  partial on its full assistant_text, and appends non-partial events to events.
 *  Used by both useRunStream and useChatStream to avoid duplicating this logic. */
export function useEventAccumulator() {
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, string>>({});
  const ref = useRef<Record<string, string>>({});

  const push = useCallback((ev: NormalizedEvent) => {
    if (ev.type === 'assistant_partial') {
      const text = String((ev.payload as any)?.text ?? '');
      ref.current = { ...ref.current, [ev.nodeId]: (ref.current[ev.nodeId] ?? '') + text };
      setPartials(ref.current);
    } else {
      if (ev.type === 'assistant_text' && ref.current[ev.nodeId]) {
        ref.current = { ...ref.current, [ev.nodeId]: '' };
        setPartials(ref.current);
      }
      setEvents((prev) => [...prev, ev]);
    }
  }, []);

  const reset = useCallback((seed: NormalizedEvent[] = []) => {
    ref.current = {};
    setEvents(seed);
    setPartials({});
  }, []);

  return { events, partials, push, reset };
}

export function buildTree(nodes: RunNode[], rootId: string): RunNode | null {
  const byParent = new Map<string | null, RunNode[]>();
  const byId = new Map<string, RunNode>();
  for (const n of nodes) {
    const copy = { ...n, children: [] as RunNode[] };
    byId.set(n.id, copy);
    const list = byParent.get(n.parentId) ?? [];
    list.push(copy);
    byParent.set(n.parentId, list);
  }
  const root = byId.get(rootId) ?? nodes.find((n) => n.parentId === null && byId.get(n.id));
  if (!root) return null;
  const attach = (node: RunNode): RunNode => {
    node.children = (byParent.get(node.id) ?? []).map(attach).sort((a, b) => a.startedAt - b.startedAt);
    return node;
  };
  return attach(byId.get(root.id)!);
}

// ── fleet-wide live channel ─────────────────────────────────────────────────
export function useFleet() {
  const [runs, setRuns] = useState<Map<string, Run>>(new Map());
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`${API}/api/fleet/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let m: FleetMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.kind === 'fleet-hello') {
        setRuns(new Map(m.runs.map((r) => [r.id, r])));
        setSpend(m.spend);
      } else if (m.kind === 'run') {
        setRuns((prev) => {
          const next = new Map(prev);
          next.set(m.run.id, m.run);
          return next;
        });
      } else if (m.kind === 'run-removed') {
        setRuns((prev) => {
          const next = new Map(prev);
          next.delete(m.runId);
          return next;
        });
      } else if (m.kind === 'spend') {
        setSpend(m.spend);
      }
    };
    return () => es.close();
  }, []);

  const runList = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  return { runs: runList, spend, connected };
}

// ── notification stream (F-notify) ──────────────────────────────────────────
/** One row off GET /api/notifications/stream (mirrors the server NotificationRow). */
export interface NotificationRow {
  id: string;
  runId: string | null;
  kind: string;
  message: string;
  ts: number;
  read: boolean;
}

/** Subscribes to GET /api/notifications/stream and surfaces the newest unseen row.
 *  Mirrors useFleet()'s EventSource lifecycle. Dedupes by notification.id (the stream can
 *  replay or a StrictMode double-mount can re-deliver), so `latest` only advances to a row
 *  no consumer has seen before — letting a Shell effect fire exactly one browser Notification
 *  per new row. */
export function useNotificationStream(): { latest: NotificationRow | null } {
  const [latest, setLatest] = useState<NotificationRow | null>(null);
  // Survives re-renders so the dedupe set isn't reset on every state update.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource(`${API}/api/notifications/stream`);
    es.onmessage = (e) => {
      let m: { kind?: string; notification?: NotificationRow };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.kind !== 'notification' || !m.notification) return;
      const row = m.notification;
      if (seen.current.has(row.id)) return;
      seen.current.add(row.id);
      // Bound the dedupe set so a portal tab left open for days can't grow it without limit. The
      // server never replays history, so a recent-id window is enough to keep one-popup-per-row.
      if (seen.current.size > 1000) {
        const oldest = seen.current.values().next().value;
        if (oldest !== undefined) seen.current.delete(oldest);
      }
      setLatest(row);
    };
    return () => es.close();
  }, []);

  return { latest };
}

// ── per-run live channel ────────────────────────────────────────────────────
export interface RunLiveState {
  run: Run | null;
  nodes: RunNode[];
  tree: RunNode | null;
  events: NormalizedEvent[];
  /** nodeId → currently-streaming assistant text (token deltas). */
  partials: Record<string, string>;
  connected: boolean;
  /** set when the stream reports a permanent error (e.g. unknown/deleted run) — H8. */
  error: string | null;
  /** H18 — if the snapshot tail omitted earlier events, the seq before which they were dropped. */
  truncatedBefore?: number;
}

export function useRunStream(id: string): RunLiveState {
  const acc = useEventAccumulator();
  const [run, setRun] = useState<Run | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, RunNode>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncatedBefore, setTruncatedBefore] = useState<number | undefined>(undefined);

  useEffect(() => {
    acc.reset();
    setNodeMap(new Map());
    setError(null);
    setTruncatedBefore(undefined);
    const es = new EventSource(`${API}/api/agents/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let m: StreamMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      // H8 — server emits {error:'not found'} for an unknown/deleted run then ends the
      // stream; without this the EventSource auto-reconnects every ~3s forever. Close it.
      if ((m as any).error) {
        setError(String((m as any).error));
        es.close();
        return;
      }
      if (m.kind === 'hello') {
        setRun(m.run);
        setNodeMap(new Map(m.nodes.map((n) => [n.id, n])));
        acc.reset(m.events);
        setTruncatedBefore((m as any).truncatedBefore);
      } else if (m.kind === 'run') {
        setRun(m.run);
      } else if (m.kind === 'node') {
        setNodeMap((prev) => {
          const next = new Map(prev);
          next.set(m.node.id, m.node);
          return next;
        });
      } else if (m.kind === 'event') {
        acc.push(m.event);
      }
    };
    return () => es.close();
    // ponytail: acc.push/acc.reset are stable useCallback refs ([] deps), safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // H19 — derive nodes/tree only when nodeMap actually changes (not on every render or
  // the run page's 1s force-refresh tick). buildTree mints fresh objects, so this also
  // gives React.memo'd rows stable refs to bail on.
  const nodes = useMemo(() => [...nodeMap.values()], [nodeMap]);
  const tree = useMemo(() => (nodes.length ? buildTree(nodes, id) : null), [nodes, id]);
  return { run, nodes, tree, events: acc.events, partials: acc.partials, connected, error, truncatedBefore };
}

// ── per-campaign live channel (Orchestration Mode) ──────────────────────────
export function useCampaign(id: string): { campaign: Campaign | null; connected: boolean } {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setCampaign(null);
    const es = new EventSource(`${API}/api/campaigns/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let m: CampaignMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.kind === 'campaign-hello') {
        setCampaign(m.campaign);
      } else if (m.kind === 'campaign') {
        // merge campaign-level fields but preserve the tasks array we accumulate from 'task' msgs
        setCampaign((prev) => ({ ...(prev ?? ({} as Campaign)), ...m.campaign, tasks: prev?.tasks ?? m.campaign.tasks }));
      } else if (m.kind === 'task') {
        setCampaign((prev) => {
          if (!prev) return prev;
          const tasks: CampaignTask[] = [...(prev.tasks ?? [])];
          const i = tasks.findIndex((t) => t.id === m.task.id);
          if (i >= 0) tasks[i] = m.task;
          else tasks.push(m.task);
          tasks.sort((a, b) => a.seq - b.seq);
          return { ...prev, tasks };
        });
      }
    };
    return () => es.close();
  }, [id]);

  return { campaign, connected };
}

// ── per-chat-session live channel (§4 chat-scoped SSE, turn-scoped frames) ──────────────────────
// Subscribes to the SESSION and consumes turn-scoped ChatStreamFrame events.
// Deleted: run-status-transition turn-boundary inference, {runId,seq} dedup,
// hello-event stripping, and backing-run-id-change re-subscription.

/** A subagent chip — kept as a type for RunningAgentsPanel (Task 2.2 will wire). */
export interface ChatSubagent { runId: string; name: string }

export interface ChatActiveTurn {
  turnId: string;
  status: ChatTurnStatus;
  /** The full ChatTurn — turn.messages[0] is the user message. */
  turn: ChatTurn;
  events: NormalizedEvent[];
  partials: Record<string, string>;
}

/** Chat-scoped SSE (turn-scoped frames): subscribe to the SESSION so the channel
 *  is stable across turn boundaries. The server emits ChatStreamFrame. */
export function useChatStream(sessionId: string | null): {
  state: ChatSessionState;
  activeTurn: ChatActiveTurn | null;
  error: string | null;
  clearError: () => void;
} {
  const acc = useEventAccumulator();
  const [state, setState] = useState<ChatSessionState>('idle');
  // ponytail: activeTurnMeta holds only the non-accumulated fields; events/partials come from acc
  const [activeTurnMeta, setActiveTurnMeta] = useState<{ turnId: string; status: ChatTurnStatus; turn: ChatTurn } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ref so the onmessage closure can guard turn:event without stale state
  const activeTurnIdRef = useRef<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    if (!sessionId) return;
    acc.reset();
    activeTurnIdRef.current = null;
    setActiveTurnMeta(null);
    setState('idle');
    setError(null);
    const es = new EventSource(`${API}/api/chat/sessions/${sessionId}/stream`);
    es.onmessage = (e) => {
      let m: any;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.kind === 'session_state') {
        setState(m.state as ChatSessionState);
      } else if (m.kind === 'turn:start') {
        const t: ChatTurn = m.turn;
        activeTurnIdRef.current = t.id;
        acc.reset();
        setActiveTurnMeta({ turnId: t.id, status: t.status, turn: t });
      } else if (m.kind === 'turn:event') {
        if (activeTurnIdRef.current === m.turnId) acc.push(m.event as NormalizedEvent);
      } else if (m.kind === 'turn:settled') {
        // C1: keep activeTurnMeta visible during the network-refetch gap; ChatThread deduplicates
        // once the settled turn lands in history. The acc is NOT reset here — events stay visible
        // during the gap; turn:start for the next turn resets it.
        activeTurnIdRef.current = null;
        setActiveTurnMeta((prev) => prev ? { ...prev, status: 'settled' } : null);
      } else if (m.kind === 'turn:failed') {
        setActiveTurnMeta((prev) => prev ? { ...prev, status: 'failed' } : null);
      } else if (m.kind === 'error') {
        setError(String(m.error));
        es.close();
      }
    };
    return () => es.close();
    // ponytail: acc.push/acc.reset are stable useCallback refs ([] deps), safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return {
    state,
    activeTurn: activeTurnMeta
      ? { ...activeTurnMeta, events: acc.events, partials: acc.partials }
      : null,
    error,
    clearError,
  };
}

// ── pending ask_human questions for a session ────────────────────────────────
const POLL_MS = 4000;

/** Polls the inbox and returns the pending QuestionData items for the given sessionId.
 *  Returns empty and does not poll when sessionId is null. */
export function usePendingQuestions(sessionId: string | null): { questions: QuestionData[]; refresh: () => void } {
  const [questions, setQuestions] = useState<QuestionData[]>([]);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm() {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fetchQuestions(), POLL_MS);
  }

  function fetchQuestions() {
    api
      .inbox()
      .then((data) => {
        if (!alive.current) return;
        const filtered = data.items
          .filter((i) => i.kind === 'question' && i.question && i.question.sessionId === sessionId)
          .map((i) => i.question as QuestionData);
        setQuestions(filtered);
        rearm();
      })
      .catch(() => {
        if (!alive.current) return;
        rearm();
      });
  }

  useEffect(() => {
    if (!sessionId) return;
    alive.current = true;
    fetchQuestions();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    if (timer.current) clearTimeout(timer.current);
    fetchQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { questions, refresh };
}

// ── one-shot fetch helper for client components ─────────────────────────────
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload };
}
