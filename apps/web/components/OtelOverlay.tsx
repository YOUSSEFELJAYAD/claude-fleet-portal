'use client';
import React, { useEffect, useState } from 'react';
import { API } from '@/lib/api';
import { Panel, Kicker, Stat } from '@/components/ui';
import { usd, tokens } from '@/lib/format';

/**
 * A12 — OpenTelemetry overlay (depends on H6's OTLP receiver). Shows what stream-json can't:
 * cost/tokens split by query_source (main/subagent/auxiliary) + model, lines added/removed,
 * and tool_decision (accept/reject) events. Polls while the run may still be emitting.
 */
interface Otel {
  sessionId: string;
  empty?: boolean;
  costUsd?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  bySource?: Record<string, { costUsd: number; tokens: number }>;
  byModel?: Record<string, { costUsd: number; tokens: number }>;
  linesAdded?: number;
  linesRemoved?: number;
  toolDecisions?: { tool: string; decision: string; source: string }[];
}

export function OtelOverlay({ runId, live }: { runId: string; live: boolean }) {
  const [otel, setOtel] = useState<Otel | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/api/agents/${runId}/otel`)
        .then((r) => r.json())
        .then((d) => alive && setOtel(d))
        .catch(() => {});
    load();
    if (!live) return;
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId, live]);

  // Nothing received yet (telemetry disabled, or not emitted) → render nothing (additive).
  if (!otel || otel.empty || (!otel.costUsd && !otel.toolDecisions?.length)) return null;

  const sources = Object.entries(otel.bySource ?? {});
  const models = Object.entries(otel.byModel ?? {});
  const decisions = otel.toolDecisions ?? [];

  return (
    <Panel className="p-4 mb-4">
      <Kicker>opentelemetry · per-source truth (otlp)</Kicker>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mt-2">
        <Stat label="otel cost" value={usd(otel.costUsd ?? 0)} accent="#ffb000" />
        <Stat label="tokens in/out" value={`${tokens(otel.tokens?.input ?? 0)} / ${tokens(otel.tokens?.output ?? 0)}`} />
        <Stat label="cache r/c" value={`${tokens(otel.tokens?.cacheRead ?? 0)} / ${tokens(otel.tokens?.cacheCreation ?? 0)}`} />
        <Stat label="lines +/−" value={`${otel.linesAdded ?? 0} / ${otel.linesRemoved ?? 0}`} />
      </div>

      {sources.length > 0 && (
        <div className="mt-3">
          <Kicker>by source</Kicker>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {sources.map(([src, v]) => (
              <span key={src} className="border border-line2 px-2 py-1 font-mono text-[10.5px] text-dim">
                {src}: <span className="text-amber">{usd(v.costUsd)}</span> · {tokens(v.tokens)} tok
              </span>
            ))}
          </div>
        </div>
      )}

      {models.length > 1 && (
        <div className="mt-2">
          <Kicker>by model</Kicker>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {models.map(([m, v]) => (
              <span key={m} className="border border-line2 px-2 py-1 font-mono text-[10.5px] text-dim">
                {m}: <span className="text-amber">{usd(v.costUsd)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {decisions.length > 0 && (
        <div className="mt-3">
          <Kicker>tool decisions ({decisions.length})</Kicker>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {decisions.slice(-30).map((d, i) => (
              <span
                key={i}
                className="font-mono text-[10px] px-1.5 py-0.5 border"
                style={{
                  borderColor: d.decision === 'accept' ? 'rgba(84,224,138,0.4)' : 'rgba(255,93,93,0.4)',
                  color: d.decision === 'accept' ? '#54e08a' : '#ff5d5d',
                }}
                title={`${d.decision} · ${d.source}`}
              >
                {d.tool} {d.decision === 'accept' ? '✓' : '✕'}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
