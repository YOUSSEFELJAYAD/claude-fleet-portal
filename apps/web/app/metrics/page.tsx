'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usd, tokens, dur } from '@/lib/format';
import { statusMeta } from '@/lib/status';
import type { RunStatus } from '@fleet/shared';
import { Kicker, Panel, Stat, Empty } from '@/components/ui';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

interface Metrics {
  dailySpend: { day: string; costUsd: number; runs: number }[];
  byModel: { model: string; runs: number; costUsd: number; tokensIn: number; tokensOut: number }[];
  byEffort: { effort: string; runs: number; costUsd: number }[];
  statusCounts: Record<string, number>;
  durations: { p50Ms: number; p95Ms: number };
  totals: { runs: number; costUsd: number; tokensIn: number; tokensOut: number };
  topCost: { id: string; task: string; costUsd: number }[];
}

const WINDOWS: { key: string; label: string; ms: number }[] = [
  { key: 'all', label: 'All time', ms: 0 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

export default function MetricsPage() {
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState('all');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const w = WINDOWS.find((x) => x.key === win)!;
    const q = w.ms > 0 ? `?since=${Date.now() - w.ms}` : '';
    fetch(API + '/api/metrics' + q)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: Metrics) => {
        if (!alive) return;
        setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || 'failed to load metrics');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [win]);

  const empty = data && data.totals.runs === 0;

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>analytics</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Metrics</h1>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className="font-display text-[11px] uppercase tracking-wider px-3 py-1.5 border transition-colors"
              style={{
                borderColor: win === w.key ? '#ffb000' : 'rgba(255,255,255,0.075)',
                color: win === w.key ? '#ffb000' : '#9aa1ab',
                background: win === w.key ? 'rgba(255,176,0,0.08)' : 'transparent',
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="font-mono text-faint text-[12px]">aggregating…</div>
      ) : error ? (
        <Empty>Failed to load metrics — {error}</Empty>
      ) : empty || !data ? (
        <Empty>No runs in this window.</Empty>
      ) : (
        <div className="flex flex-col gap-3.5">
          {/* ── totals ──────────────────────────────────────────── */}
          <Panel className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Stat label="total runs" value={<span className="tnum">{data.totals.runs}</span>} />
              <Stat label="total cost" value={usd(data.totals.costUsd)} accent="#ffb000" />
              <Stat label="tokens in" value={tokens(data.totals.tokensIn)} />
              <Stat label="tokens out" value={tokens(data.totals.tokensOut)} />
              <Stat
                label="duration p50 / p95"
                value={
                  <span className="tnum">
                    {dur(data.durations.p50Ms)} <span className="text-faint">/</span>{' '}
                    {dur(data.durations.p95Ms)}
                  </span>
                }
                sub="terminal runs"
              />
            </div>
          </Panel>

          {/* ── status counts ───────────────────────────────────── */}
          {Object.keys(data.statusCounts).length > 0 && (
            <Panel className="p-4">
              <Kicker className="mb-3">status breakdown</Kicker>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([s, n]) => {
                    const m = statusMeta(s as RunStatus);
                    return (
                      <div
                        key={s}
                        className="flex items-center gap-2 px-2.5 py-1.5 border"
                        style={{ borderColor: `${m.color}40`, background: `${m.color}12` }}
                      >
                        <span
                          className="font-display uppercase tracking-wider text-[9.5px]"
                          style={{ color: m.color, letterSpacing: '0.12em' }}
                        >
                          {m.label}
                        </span>
                        <span className="font-mono tnum text-[12px] text-ink">{n}</span>
                      </div>
                    );
                  })}
              </div>
            </Panel>
          )}

          {/* ── daily spend sparkline ───────────────────────────── */}
          <Panel className="p-4">
            <div className="flex items-baseline justify-between mb-3">
              <Kicker>daily spend</Kicker>
              <span className="font-mono text-faint text-[10px]">{data.dailySpend.length} days</span>
            </div>
            <DailyBars data={data.dailySpend} />
          </Panel>

          {/* ── tables ──────────────────────────────────────────── */}
          <div className="grid gap-3.5 md:grid-cols-2">
            <Panel className="p-4">
              <Kicker className="mb-3">by model</Kicker>
              {data.byModel.length === 0 ? (
                <Empty>no data</Empty>
              ) : (
                <div>
                  <div className="grid grid-cols-[1fr_50px_70px_70px] gap-2 pb-2 border-b hairline kicker">
                    <span>model</span>
                    <span className="text-right">runs</span>
                    <span className="text-right">cost</span>
                    <span className="text-right">tok out</span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {data.byModel.map((m) => (
                      <div key={m.model} className="grid grid-cols-[1fr_50px_70px_70px] gap-2 py-2 items-center">
                        <span className="font-mono text-[11px] text-ink truncate" title={m.model}>
                          {m.model}
                        </span>
                        <span className="text-right font-mono tnum text-[11px] text-dim">{m.runs}</span>
                        <span className="text-right font-mono tnum text-[11px] text-amber">{usd(m.costUsd)}</span>
                        <span className="text-right font-mono tnum text-[11px] text-dim">{tokens(m.tokensOut)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Panel>

            <Panel className="p-4">
              <Kicker className="mb-3">by effort</Kicker>
              {data.byEffort.length === 0 ? (
                <Empty>no data</Empty>
              ) : (
                <div>
                  <div className="grid grid-cols-[1fr_60px_80px] gap-2 pb-2 border-b hairline kicker">
                    <span>effort</span>
                    <span className="text-right">runs</span>
                    <span className="text-right">cost</span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {data.byEffort.map((e) => (
                      <div key={e.effort} className="grid grid-cols-[1fr_60px_80px] gap-2 py-2 items-center">
                        <span className="font-display uppercase tracking-wider text-[11px] text-ink">{e.effort}</span>
                        <span className="text-right font-mono tnum text-[11px] text-dim">{e.runs}</span>
                        <span className="text-right font-mono tnum text-[11px] text-amber">{usd(e.costUsd)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          </div>

          {/* ── top cost ────────────────────────────────────────── */}
          <Panel className="p-4">
            <Kicker className="mb-3">top cost runs</Kicker>
            {data.topCost.length === 0 ? (
              <Empty>no data</Empty>
            ) : (
              <div className="divide-y divide-white/[0.04]">
                {data.topCost.map((t, i) => (
                  <Link
                    key={t.id}
                    href={`/runs/${t.id}`}
                    className="grid grid-cols-[24px_1fr_80px] gap-3 py-2 items-center hover:bg-amber/[0.04] transition-colors px-1 -mx-1"
                  >
                    <span className="font-mono tnum text-[11px] text-faint">{String(i + 1).padStart(2, '0')}</span>
                    <span className="text-[12px] text-ink truncate">{t.task}</span>
                    <span className="text-right font-mono tnum text-[11px] text-amber">{usd(t.costUsd)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function DailyBars({ data }: { data: { day: string; costUsd: number; runs: number }[] }) {
  if (data.length === 0) return <Empty>no spend recorded</Empty>;
  const max = Math.max(...data.map((d) => d.costUsd), 0);
  return (
    <div>
      <div className="flex items-end gap-1 h-[120px]">
        {data.map((d) => {
          const pct = max > 0 ? (d.costUsd / max) * 100 : 0;
          return (
            <div key={d.day} className="flex-1 min-w-[3px] h-full flex flex-col justify-end group relative">
              <div
                className="w-full bg-amber/70 group-hover:bg-amber transition-colors"
                style={{ height: `${Math.max(pct, d.costUsd > 0 ? 2 : 0)}%` }}
                title={`${d.day} · ${usd(d.costUsd)} · ${d.runs} run${d.runs === 1 ? '' : 's'}`}
              />
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap font-mono text-[10px] text-amber bg-black/80 border border-line2 px-1.5 py-0.5 z-10">
                {usd(d.costUsd)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 font-mono text-[9px] text-faint">
        <span>{data[0].day}</span>
        {data.length > 1 && <span>{data[data.length - 1].day}</span>}
      </div>
    </div>
  );
}
