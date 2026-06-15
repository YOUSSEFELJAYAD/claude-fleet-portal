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
} from '@fleet/shared';
import { API } from './api';

/** Run statuses that mean "no turn is in flight" — a terminal turn lives in the persisted transcript. */
const TERMINAL_STATUS = new Set(['completed', 'failed', 'killed']);

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
  const [run, setRun] = useState<Run | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, RunNode>>(new Map());
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncatedBefore, setTruncatedBefore] = useState<number | undefined>(undefined);
  const partialRef = useRef<Record<string, string>>({});

  useEffect(() => {
    partialRef.current = {};
    setEvents([]);
    setNodeMap(new Map());
    setPartials({});
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
        setEvents(m.events);
        partialRef.current = {};
        setPartials({});
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
        const ev = m.event;
        if (ev.type === 'assistant_partial') {
          const text = String(ev.payload?.text ?? '');
          const cur = partialRef.current[ev.nodeId] ?? '';
          partialRef.current = { ...partialRef.current, [ev.nodeId]: cur + text };
          setPartials(partialRef.current);
        } else {
          if (ev.type === 'assistant_text') {
            // full message arrived → clear the streaming buffer for that node
            if (partialRef.current[ev.nodeId]) {
              partialRef.current = { ...partialRef.current, [ev.nodeId]: '' };
              setPartials(partialRef.current);
            }
          }
          setEvents((prev) => [...prev, ev]);
        }
      }
    };
    return () => es.close();
  }, [id]);

  // H19 — derive nodes/tree only when nodeMap actually changes (not on every render or
  // the run page's 1s force-refresh tick). buildTree mints fresh objects, so this also
  // gives React.memo'd rows stable refs to bail on.
  const nodes = useMemo(() => [...nodeMap.values()], [nodeMap]);
  const tree = useMemo(() => (nodes.length ? buildTree(nodes, id) : null), [nodes, id]);
  return { run, nodes, tree, events, partials, connected, error, truncatedBefore };
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

// ── per-chat-session live channel (§4 chat-scoped SSE) ──────────────────────
// Subscribes to the SESSION, not a run id, so it survives kill→resume (the backing
// run id changes underneath) and page reload. Re-uses the EXISTING run-event
// vocabulary (assistant_partial/text, tool_use, tool_result, thinking,
// permission_request, subagent_spawned, result) plus the chat-only `session_state`
// control envelope { state, live } owned by Unit 1's stream route.

/** A subagent chip surfaced from a subagent_spawned event (or the hello snapshot). */
export interface ChatSubagent { runId: string; name: string }

export interface ChatStreamState {
  run: Run | null;
  /** appended run events for this session's CURRENT backing run. */
  events: NormalizedEvent[];
  /** nodeId → currently-streaming assistant text (token deltas). */
  partials: Record<string, string>;
  /** §3 — derived session lifecycle from the latest session_state frame. */
  state: ChatSessionState;
  /** true iff a live interactive process is held for the session (spec §3). */
  live: boolean;
  /** id of the run currently backing the session — changes under us across kill→resume. */
  runId: string | null;
  /** subagent chips from subagent_spawned events or the hello snapshot. */
  subagents: ChatSubagent[];
  connected: boolean;
  error: string | null;
}

/** Chat-scoped SSE (spec §4): subscribe to the SESSION, not a run id, so the channel
 *  survives kill→resume (run id changes underneath) and page reload. Re-uses the run-event
 *  vocabulary plus a `session_state` chat-control frame. */
export function useChatStream(sessionId: string | null): ChatStreamState {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, string>>({});
  const [state, setState] = useState<ChatSessionState>('idle');
  const [live, setLive] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [subagents, setSubagents] = useState<ChatSubagent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const partialRef = useRef<Record<string, string>>({});
  // last seen backing-run status — used to detect a new turn (terminal → active) so the
  // prior turn's live events (already persisted as messages) are dropped from the live view.
  const prevRunStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    partialRef.current = {};
    prevRunStatusRef.current = null;
    setRun(null);
    setEvents([]);
    setPartials({});
    setState('idle');
    setLive(false);
    setRunId(null);
    setSubagents([]);
    setError(null);
    const es = new EventSource(`${API}/api/chat/sessions/${sessionId}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let m: any;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.error) {
        setError(String(m.error));
        es.close();
        return;
      }
      // chat-control envelope (Unit 1) — not a run event
      if (m.kind === 'session_state') {
        setState(m.state as ChatSessionState);
        setLive(Boolean(m.live));
        // fix 04 — the envelope now carries the real backing run id; adopt it so idle/resumable
        // sessions report their run (the agents panel resolves it) without waiting on hello/events.
        if (m.runId != null) setRunId(m.runId);
        return;
      }
      if (m.kind === 'hello') {
        setRun(m.run ?? null);
        prevRunStatusRef.current = (m.run as Run | undefined)?.status ?? null;
        setEvents(m.events ?? []);
        partialRef.current = {};
        setPartials({});
        if (m.state) setState(m.state as ChatSessionState);
        if ('live' in m) setLive(Boolean(m.live));
        if (m.runId != null) setRunId(m.runId);
        if (Array.isArray(m.subagents)) setSubagents(m.subagents);
        return;
      }
      if (m.kind === 'run') {
        const prev = prevRunStatusRef.current;
        const next = (m.run as Run | undefined)?.status ?? null;
        // new turn starting: drop the prior turn's live events; they belong to a settled
        // turn that now lives in the persisted transcript. A turn boundary is EITHER a
        // terminal state (resumable-fallback: completed → running) OR `awaiting-input`
        // (always-live held run: the held process settles to awaiting-input after each
        // turn's `result`, then sendInput flips it back to running — fix 14).
        const wasTurnBoundary = !!prev && (TERMINAL_STATUS.has(prev) || prev === 'awaiting-input');
        if (wasTurnBoundary && next && !TERMINAL_STATUS.has(next) && next !== 'awaiting-input') {
          partialRef.current = {};
          setEvents([]);
          setPartials({});
        }
        prevRunStatusRef.current = next;
        setRun(m.run);
        return;
      }
      if (m.kind === 'event') {
        const evt = m.event as NormalizedEvent;
        // follow the backing run id across kill→resume (spec §4)
        if (evt.runId) setRunId(evt.runId);
        if (evt.type === 'subagent_spawned') {
          setSubagents((prev) =>
            prev.some((s) => s.runId === evt.nodeId)
              ? prev
              : [...prev, { runId: evt.nodeId, name: String((evt.payload as any)?.label ?? evt.nodeId) }],
          );
        }
        if (evt.type === 'assistant_partial') {
          const text = String((evt.payload as any)?.text ?? '');
          const cur = partialRef.current[evt.nodeId] ?? '';
          partialRef.current = { ...partialRef.current, [evt.nodeId]: cur + text };
          setPartials(partialRef.current);
        } else {
          if (evt.type === 'assistant_text' && partialRef.current[evt.nodeId]) {
            partialRef.current = { ...partialRef.current, [evt.nodeId]: '' };
            setPartials(partialRef.current);
          }
          setEvents((prev) => [...prev, evt]);
        }
      }
    };
    return () => es.close();
  }, [sessionId]);

  return { run, events, partials, state, live, runId, subagents, connected, error };
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
