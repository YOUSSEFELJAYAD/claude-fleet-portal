'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { Run } from '@fleet/shared';
import { statusMeta } from '@/lib/status';
import { usd, tokens, dur, clock } from '@/lib/format';
import { Kicker, Empty, Dot } from '@/components/ui';

export default function HistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const h = setTimeout(() => {
      api.listRuns({ q: q || undefined, status: status || undefined }).then((r) => {
        setRuns(r);
        setLoading(false);
      });
    }, 200);
    return () => clearTimeout(h);
  }, [q, status]);

  return (
    <div>
      <Kicker>archive</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-4">History &amp; Replay</h1>

      <div className="flex gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search task, cwd, result…"
          className="flex-1 bg-black/40 border border-line2 text-ink font-mono text-[12px] px-3 py-2 focus:border-amber/60 outline-none placeholder:text-faint"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-black/40 border border-line2 text-ink font-mono text-[12px] px-3 py-2 focus:border-amber/60 outline-none cursor-pointer"
        >
          <option value="">all statuses</option>
          {['completed', 'failed', 'killed', 'running', 'orchestrating'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="font-mono text-faint text-[12px]">querying…</div>
      ) : runs.length === 0 ? (
        <Empty>No runs match.</Empty>
      ) : (
        <div className="panel overflow-hidden">
          <div className="grid grid-cols-[120px_1fr_90px_90px_90px_120px_34px] gap-3 px-4 py-2.5 border-b hairline kicker">
            <span>status</span>
            <span>task</span>
            <span className="text-right">cost</span>
            <span className="text-right">tokens</span>
            <span className="text-right">elapsed</span>
            <span className="text-right">started</span>
            <span></span>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {runs.map((r) => {
              const m = statusMeta(r.status);
              return (
                <Link key={r.id} href={`/runs/${r.id}`} className="grid grid-cols-[120px_1fr_90px_90px_90px_120px_34px] gap-3 px-4 py-2.5 items-center hover:bg-amber/[0.04] transition-colors group">
                  <span className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: m.color }}>
                    <Dot color={m.color} live={m.live} size={6} />
                    {m.label}
                  </span>
                  <span className="text-ink text-[12px] truncate">{r.task}</span>
                  <span className="text-right font-mono tnum text-[11px]" style={{ color: r.budgetUsd && r.costUsd / r.budgetUsd >= 0.8 ? '#ff5d5d' : '#e9e7df' }}>{usd(r.costUsd)}</span>
                  <span className="text-right font-mono tnum text-[11px] text-dim">{tokens(r.tokensOut)}</span>
                  <span className="text-right font-mono tnum text-[11px] text-dim">{dur((r.endedAt ?? r.startedAt) - r.startedAt)}</span>
                  <span className="text-right font-mono text-[10px] text-faint">{clock(r.startedAt)}</span>
                  {!m.live ? (
                    <button
                      title="delete run"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!confirm('Delete this run from history? This cannot be undone.')) return;
                        api.deleteRun(r.id).then(() => setRuns((prev) => prev.filter((x) => x.id !== r.id)));
                      }}
                      className="opacity-0 group-hover:opacity-100 text-faint hover:text-sig-failed font-mono text-[13px] transition-opacity"
                      style={{ lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  ) : (
                    <span />
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
