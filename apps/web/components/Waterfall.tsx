'use client';
import React, { useMemo, useState } from 'react';
import { nodeStatusColor } from '@/lib/status';
import { dur } from '@/lib/format';
import { Kicker, Empty } from './ui';

// Local shapes — only the fields this component reads (cannot import from server).
interface WNode {
  id: string;
  parentId: string | null;
  nodeType: string;
  label: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  costUsd: number;
  tokensOut: number;
  depth: number;
}
interface WEvent {
  nodeId: string;
  seq: number;
  ts: number;
  type: string;
  payload: any;
}

interface ToolDur {
  name: string;
  ms: number;
  pending: boolean;
}
interface Row {
  node: WNode;
  startMs: number; // offset from runStart
  endMs: number; // offset from runStart (clamped to now for live)
  live: boolean;
  ttft: number | null;
  tools: ToolDur[];
  color: string;
}

const fmtMs = (ms: number): string => {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return dur(ms);
};

export function Waterfall({
  nodes,
  events,
  runStartedAt,
}: {
  nodes: any[];
  events: any[];
  runStartedAt: number;
}) {
  const [open, setOpen] = useState(false);

  const { rows, totalSpan } = useMemo(() => {
    const ns = (nodes ?? []) as WNode[];
    const evs = (events ?? []) as WEvent[];
    const now = Date.now();

    // Group events by nodeId once.
    const byNode = new Map<string, WEvent[]>();
    for (const e of evs) {
      const arr = byNode.get(e.nodeId);
      if (arr) arr.push(e);
      else byNode.set(e.nodeId, [e]);
    }

    const rows: Row[] = [];
    let maxEnd = 0;

    for (const node of ns) {
      const startMs = Math.max(0, node.startedAt - runStartedAt);
      const live = node.endedAt == null;
      const endRaw = (node.endedAt ?? now) - runStartedAt;
      const endMs = Math.max(startMs, endRaw);
      if (endMs > maxEnd) maxEnd = endMs;

      const nodeEvents = byNode.get(node.id) ?? [];

      // TTFT — first assistant_text (lowest seq) ts minus node start.
      let firstText: WEvent | null = null;
      for (const e of nodeEvents) {
        if (e.type === 'assistant_text' && (firstText == null || e.seq < firstText.seq)) firstText = e;
      }
      const ttft = firstText ? Math.max(0, firstText.ts - node.startedAt) : null;

      // Per-tool durations — match tool_use(payload.id) → tool_result(payload.forId).
      const uses = new Map<string, { ts: number; name: string }>();
      for (const e of nodeEvents) {
        if (e.type === 'tool_use' && e.payload?.id != null) {
          uses.set(String(e.payload.id), { ts: e.ts, name: String(e.payload.name ?? 'tool') });
        }
      }
      const tools: ToolDur[] = [];
      const matched = new Set<string>();
      for (const e of nodeEvents) {
        if (e.type !== 'tool_result' || e.payload?.forId == null) continue;
        const key = String(e.payload.forId);
        const u = uses.get(key);
        if (!u) continue;
        matched.add(key);
        tools.push({ name: u.name, ms: Math.max(0, e.ts - u.ts), pending: false });
      }
      // tool_use without a matching result → still running.
      for (const [key, u] of uses) {
        if (!matched.has(key)) tools.push({ name: u.name, ms: Math.max(0, now - u.ts), pending: true });
      }
      tools.sort((a, b) => b.ms - a.ms);

      rows.push({
        node,
        startMs,
        endMs,
        live,
        ttft,
        tools: tools.slice(0, 3),
        color: nodeStatusColor(node.status as any),
      });
    }

    // Waterfall order — earliest start first.
    rows.sort((a, b) => a.startMs - b.startMs || a.node.depth - b.node.depth);

    return { rows, totalSpan: Math.max(maxEnd, 1) };
  }, [nodes, events, runStartedAt]);

  // ~5 evenly spaced axis ticks across the span.
  const ticks = useMemo(() => {
    const n = 5;
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push((totalSpan / n) * i);
    return out;
  }, [totalSpan]);

  const empty = rows.length === 0;

  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 border hairline panel transition-colors hover:bg-amber/[0.03]"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]" style={{ color: open ? '#ffb000' : '#9aa1ab' }}>
            {open ? '▾' : '▸'}
          </span>
          <Kicker>span waterfall</Kicker>
          <span className="font-mono text-[10px] text-faint">
            {empty ? 'no spans' : `${rows.length} span${rows.length === 1 ? '' : 's'} · ${fmtMs(totalSpan)}`}
          </span>
        </div>
        <span className="font-mono text-[9px] text-faint uppercase tracking-wider">gantt · ttft · tool latency</span>
      </button>

      {open && (
        <div className="panel border-t-0 px-4 py-4">
          {empty ? (
            <Empty>No spans recorded for this run.</Empty>
          ) : (
            <>
              {/* time axis */}
              <div className="relative h-4 mb-2 ml-[200px]">
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className="absolute font-mono text-[9px] text-faint tnum -translate-x-1/2"
                    style={{ left: `${(t / totalSpan) * 100}%` }}
                  >
                    {fmtMs(t)}
                  </span>
                ))}
              </div>

              <div className="flex flex-col gap-1.5">
                {rows.map((r) => {
                  const leftPct = (r.startMs / totalSpan) * 100;
                  const rawW = ((r.endMs - r.startMs) / totalSpan) * 100;
                  const widthPct = Math.max(rawW, 0.6); // min visible width for 0-duration
                  const spanMs = r.endMs - r.startMs;
                  return (
                    <div key={r.node.id} className="flex items-stretch gap-2 group">
                      {/* label gutter */}
                      <div
                        className="w-[192px] shrink-0 min-w-0 flex items-center gap-1.5"
                        style={{ paddingLeft: r.node.depth * 12 }}
                        title={r.node.label}
                      >
                        <span
                          className="shrink-0 inline-block"
                          style={{ width: 6, height: 6, borderRadius: 999, background: r.color }}
                        />
                        <span className="truncate font-mono text-[11px]" style={{ color: r.node.nodeType === 'root' ? '#ffb000' : '#e9e7df' }}>
                          {r.node.label}
                        </span>
                      </div>

                      {/* track */}
                      <div className="relative flex-1 h-[18px]">
                        {/* gridlines */}
                        {ticks.map((t, i) => (
                          <span
                            key={i}
                            className="absolute top-0 bottom-0 border-l border-white/[0.04]"
                            style={{ left: `${(t / totalSpan) * 100}%` }}
                          />
                        ))}
                        {/* bar */}
                        <div
                          className={`absolute top-1/2 -translate-y-1/2 h-[10px] ${r.live ? 'animate-pulseGlow' : ''}`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            background: r.color,
                            opacity: 0.85,
                            boxShadow: r.live ? `0 0 8px ${r.color}` : 'none',
                          }}
                          title={`${r.node.label} · ${fmtMs(spanMs)}`}
                        />
                        {/* TTFT marker */}
                        {r.ttft != null && (
                          <span
                            className="absolute top-1/2 -translate-y-1/2"
                            style={{
                              left: `${((r.startMs + r.ttft) / totalSpan) * 100}%`,
                              width: 2,
                              height: 14,
                              background: '#ffb000',
                            }}
                            title={`TTFT ${fmtMs(r.ttft)}`}
                          />
                        )}
                        {/* trailing metrics */}
                        <span
                          className="absolute top-1/2 -translate-y-1/2 ml-1.5 font-mono text-[9px] text-faint tnum whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ left: `${Math.min(leftPct + widthPct, 100)}%` }}
                        >
                          {fmtMs(spanMs)}
                          {r.ttft != null && <span className="text-amber"> · ttft {fmtMs(r.ttft)}</span>}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* per-node tool latency breakdown */}
              <div className="mt-4 pt-3 border-t hairline">
                <Kicker>slowest tools per span</Kicker>
                <div className="mt-2 flex flex-col gap-2">
                  {rows.filter((r) => r.tools.length > 0).length === 0 ? (
                    <div className="font-mono text-[10px] text-faint">No tool calls recorded.</div>
                  ) : (
                    rows
                      .filter((r) => r.tools.length > 0)
                      .map((r) => (
                        <div key={r.node.id} className="flex items-baseline gap-2 text-[11px]">
                          <span
                            className="w-[160px] shrink-0 truncate font-mono"
                            style={{ color: r.node.nodeType === 'root' ? '#ffb000' : '#9aa1ab' }}
                            title={r.node.label}
                          >
                            {r.node.label}
                          </span>
                          <span className="flex flex-wrap gap-x-3 gap-y-0.5 min-w-0">
                            {r.tools.map((t, i) => (
                              <span key={i} className="font-mono text-[10px] whitespace-nowrap">
                                <span className="text-sig-running" style={{ color: '#39d4cf' }}>{t.name}</span>
                                <span className="tnum ml-1" style={{ color: t.pending ? '#7b828c' : '#e9e7df' }}>
                                  {fmtMs(t.ms)}
                                  {t.pending && <span className="text-faint">…</span>}
                                </span>
                              </span>
                            ))}
                          </span>
                        </div>
                      ))
                  )}
                </div>
              </div>

              {/* legend */}
              <div className="mt-3 flex gap-4 flex-wrap font-mono text-[9px] text-faint">
                <span className="flex items-center gap-1">
                  <span style={{ width: 10, height: 3, background: '#ffb000', display: 'inline-block' }} /> TTFT marker
                </span>
                <span className="flex items-center gap-1">
                  <span style={{ width: 10, height: 6, background: '#39d4cf', display: 'inline-block' }} /> running
                </span>
                <span className="flex items-center gap-1">
                  <span style={{ width: 10, height: 6, background: '#54e08a', display: 'inline-block' }} /> completed
                </span>
                <span className="opacity-70">axis = relative time from run start</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
