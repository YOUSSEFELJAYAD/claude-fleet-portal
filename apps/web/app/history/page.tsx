'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, API } from '@/lib/api';
import type { Run } from '@fleet/shared';
import { statusMeta } from '@/lib/status';
import { usd, tokens, dur, clock } from '@/lib/format';
import { Kicker, Empty, Dot } from '@/components/ui';

interface SavedSearch {
  id: string;
  name: string;
  filter: { q?: string; status?: string };
}

export default function HistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]); // A8 saved searches
  const [reload, setReload] = useState(0);

  const loadSaved = () =>
    fetch(`${API}/api/saved-searches`)
      .then((r) => r.json())
      .then(setSaved)
      .catch(() => {});
  useEffect(() => {
    loadSaved();
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const h = setTimeout(() => {
      api
        .listRuns({ q: q || undefined, status: status || undefined })
        .then((r) => setRuns(r))
        .catch((e) => setError(e.message || 'failed to load history'))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(h);
  }, [q, status, reload]);

  // A9 — CSV export carrying the current filters
  const csvHref = (() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    const s = p.toString();
    return `${API}/api/agents/export.csv${s ? `?${s}` : ''}`;
  })();

  async function saveCurrent() {
    const name = prompt('Save current filter as:');
    if (!name) return;
    await fetch(`${API}/api/saved-searches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, filter: { q, status } }),
    }).catch(() => {});
    loadSaved();
  }

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
        <a
          href={csvHref}
          className="font-display uppercase tracking-wider text-[10px] px-3 py-2 border border-line2 text-faint hover:text-amber hover:border-amber/60 inline-flex items-center"
        >
          ↓ CSV
        </a>
      </div>

      {/* A8 — saved searches */}
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        {saved.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1 border border-line2 text-[10px] font-mono">
            <button
              onClick={() => { setQ(s.filter.q ?? ''); setStatus(s.filter.status ?? ''); }}
              className="px-2 py-1 text-dim hover:text-amber"
            >
              {s.name}
            </button>
            <button
              title="delete saved search"
              onClick={() => fetch(`${API}/api/saved-searches/${s.id}`, { method: 'DELETE' }).then(loadSaved).catch(() => {})}
              className="px-1.5 py-1 text-faint hover:text-sig-failed border-l border-line2"
            >
              ✕
            </button>
          </span>
        ))}
        <button onClick={saveCurrent} className="font-mono text-[10px] px-2 py-1 border border-dashed border-line2 text-faint hover:text-amber hover:border-amber/50">
          + save search
        </button>
      </div>

      {error ? (
        <div className="font-mono text-sig-failed text-[12px] border border-sig-failed/30 bg-sig-failed/5 px-3 py-2">
          {error} · <button onClick={() => setReload((n) => n + 1)} className="underline">retry</button>
        </div>
      ) : loading ? (
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
                        api.deleteRun(r.id)
                          .then(() => setRuns((prev) => prev.filter((x) => x.id !== r.id)))
                          .catch((err) => {
                            if (err?.status === 404) setRuns((prev) => prev.filter((x) => x.id !== r.id));
                            else setError(err?.message || 'failed to delete run');
                          });
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
