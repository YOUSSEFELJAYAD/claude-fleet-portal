'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
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
} from '@fleet/shared';
import { API } from './api';

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
}

export function useRunStream(id: string): RunLiveState {
  const [run, setRun] = useState<Run | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, RunNode>>(new Map());
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const partialRef = useRef<Record<string, string>>({});

  useEffect(() => {
    partialRef.current = {};
    setEvents([]);
    setNodeMap(new Map());
    setPartials({});
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
      if (m.kind === 'hello') {
        setRun(m.run);
        setNodeMap(new Map(m.nodes.map((n) => [n.id, n])));
        setEvents(m.events);
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

  const nodes = [...nodeMap.values()];
  const tree = nodes.length ? buildTree(nodes, id) : null;
  return { run, nodes, tree, events, partials, connected };
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
