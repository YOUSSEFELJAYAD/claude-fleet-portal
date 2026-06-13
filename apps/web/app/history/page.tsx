'use client';
import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { api, API } from '@/lib/api';
import type { Run } from '@fleet/shared';
import { statusMeta } from '@/lib/status';
import { usd, tokens, dur, clock } from '@/lib/format';
import { Kicker, Empty, Dot, Panel, Toggle, Field, Input, Select, Btn, ErrorBanner } from '@/components/ui';

interface SavedSearch {
  id: string;
  name: string;
  filter: { q?: string; status?: string };
}

interface SearchHit {
  runId: string;
  seq: number;
  nodeId: string;
  snippet: string;
  run: { id: string; task: string; status: string; startedAt: number; model: string };
}

export default function HistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]); // A8 saved searches
  const [reload, setReload] = useState(0);

  // F7 — deep search state
  const [deepQ, setDeepQ] = useState('');
  const [deepHits, setDeepHits] = useState<SearchHit[] | null>(null);
  const [deepAvailable, setDeepAvailable] = useState<boolean | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const deepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  // F9 — fleet memory panel state
  const [memEnabled, setMemEnabled] = useState(false);
  const [memDir, setMemDir] = useState('');
  const [memStats, setMemStats] = useState<{ entries: number; bytes: number; dir: string } | null>(null);
  const [memSaving, setMemSaving] = useState(false);
  const [memErr, setMemErr] = useState<string | null>(null);
  // Dirty flag: while the user has unsaved changes (dir input typed or toggle changed),
  // the poll must not overwrite form state — only stats get refreshed.
  const memDirtyRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // F9 — load memory config + stats on mount (unmount-safe)
  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      // Initial load: fetch config + stats, populate form state.
      Promise.all([api.memoryConfig(), api.memoryStats()])
        .then(([cfg, stats]) => {
          if (!alive) return;
          setMemEnabled(cfg.enabled);
          setMemDir(cfg.dir);
          setMemStats(stats);
        })
        .catch(() => {});
    };
    const loadStatsOnly = () => {
      // Polling: only refresh stats if the user has unsaved edits (dirty) so the
      // poll never clobbers in-progress dir or toggle changes.
      if (memDirtyRef.current) {
        api.memoryStats().then((stats) => { if (alive) setMemStats(stats); }).catch(() => {});
      } else {
        Promise.all([api.memoryConfig(), api.memoryStats()])
          .then(([cfg, stats]) => {
            if (!alive) return;
            setMemEnabled(cfg.enabled);
            setMemDir(cfg.dir);
            setMemStats(stats);
          })
          .catch(() => {});
      }
    };
    loadAll();
    // poll every 10s to keep stats fresh
    const t = setTimeout(function tick() {
      if (!alive) return;
      loadStatsOnly();
      setTimeout(tick, 10000);
    }, 10000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // F7 — debounced deep search (300ms) with stale-response guard + per-run dedupe
  const deepGenRef = useRef(0);
  useEffect(() => {
    if (deepTimerRef.current) clearTimeout(deepTimerRef.current);
    if (!deepQ.trim()) {
      setDeepHits(null);
      setDeepLoading(false);
      return;
    }
    setDeepLoading(true);
    // Increment generation token so in-flight responses for older queries are discarded.
    const gen = ++deepGenRef.current;
    deepTimerRef.current = setTimeout(() => {
      api
        .search(deepQ.trim())
        .then((res) => {
          if (!aliveRef.current) return;
          if (gen !== deepGenRef.current) return; // stale response — a newer query is in flight
          setDeepAvailable(res.available);
          // Dedupe: keep only the best (first) hit per runId (PRD F7: one hit per run shown).
          const seen = new Set<string>();
          const deduped = res.hits.filter((h) => {
            if (seen.has(h.runId)) return false;
            seen.add(h.runId);
            return true;
          });
          setDeepHits(deduped);
        })
        .catch(() => {
          if (!aliveRef.current) return;
          if (gen !== deepGenRef.current) return;
          setDeepHits([]);
        })
        .finally(() => {
          if (aliveRef.current && gen === deepGenRef.current) setDeepLoading(false);
        });
    }, 300);
    return () => {
      if (deepTimerRef.current) clearTimeout(deepTimerRef.current);
    };
  }, [deepQ]);

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

  const showDeepResults = deepQ.trim().length > 0;

  return (
    <div>
      <Kicker>archive</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-4">History &amp; Replay</h1>

      {/* F7 — deep search input */}
      <div className="panel mb-4">
        <div className="px-4 py-3 border-b hairline flex items-center gap-2">
          <span className="kicker">deep search</span>
          <span className="text-faint font-mono text-[10px] ml-1">· full transcripts</span>
        </div>
        <div className="p-4">
          <Input
            value={deepQ}
            onChange={(e) => setDeepQ(e.target.value)}
            placeholder="search full transcript text, tool calls, results…"
            className="w-full"
          />
          {deepAvailable === false && (
            <p className="font-mono text-[10px] text-faint mt-2">
              Full-text search is unavailable (SQLite FTS5 not compiled in).
            </p>
          )}
        </div>

        {/* Deep search results */}
        {showDeepResults && (
          <div className="border-t hairline">
            {deepLoading ? (
              <div className="px-4 py-3 font-mono text-faint text-[12px]">searching…</div>
            ) : deepHits && deepHits.length === 0 ? (
              <div className="px-4 py-3 font-mono text-faint text-[12px]">No transcript matches.</div>
            ) : deepHits && deepHits.length > 0 ? (
              <div className="divide-y divide-white/[0.04]">
                {deepHits.map((hit) => {
                  const m = statusMeta(hit.run.status as any);
                  return (
                    <div key={`${hit.runId}-${hit.seq}`} className="px-4 py-3 group">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="flex items-center gap-1 font-mono text-[10px]" style={{ color: m.color }}>
                          <Dot color={m.color} live={m.live} size={6} />
                          {m.label}
                        </span>
                        <span className="text-ink text-[12px] truncate flex-1">{hit.run.task}</span>
                        <span className="font-mono text-[10px] text-faint">{clock(hit.run.startedAt)}</span>
                        <Link
                          href={`/runs/${hit.runId}`}
                          className="font-mono text-[10px] text-amber hover:underline whitespace-nowrap"
                        >
                          jump to run →
                        </Link>
                      </div>
                      <p
                        className="font-mono text-[11px] text-dim leading-relaxed pl-0"
                        // Escape all HTML first, then restore only the known-safe <b>/<\/b>
                        // markers inserted by SQLite's snippet() function — prevents XSS from
                        // transcript content while still highlighting the matched terms.
                        dangerouslySetInnerHTML={{
                          __html: hit.snippet
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/&lt;b&gt;/g, '<b>')
                            .replace(/&lt;\/b&gt;/g, '</b>'),
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex gap-2 mb-4">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search task, cwd, result…"
          className="flex-1"
        />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">all statuses</option>
          {['completed', 'failed', 'killed', 'running', 'orchestrating'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
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

      {/* Hide the regular runs list while a deep search query is active (PRD F7: swap). */}
      {!showDeepResults && (error ? (
        <ErrorBanner onRetry={() => setReload((n) => n + 1)}>{error}</ErrorBanner>
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
      ))}

      {/* F9 — fleet memory panel */}
      <div className="mt-8">
        <Panel>
          <div className="px-4 py-3 border-b hairline flex items-center justify-between">
            <div>
              <Kicker>fleet memory</Kicker>
              <div className="font-mono text-[10px] text-faint mt-0.5">compounding knowledge · past runs indexed for recall</div>
            </div>
            <Toggle
              on={memEnabled}
              onChange={(v) => {
                memDirtyRef.current = true;
                setMemEnabled(v);
                setMemSaving(true);
                setMemErr(null);
                api.setMemoryConfig({ enabled: v, dir: memDir })
                  .then((cfg) => { memDirtyRef.current = false; setMemEnabled(cfg.enabled); setMemDir(cfg.dir); })
                  .catch((e: any) => setMemErr(e?.message || 'save failed'))
                  .finally(() => setMemSaving(false));
              }}
              label={memSaving ? 'saving…' : (memEnabled ? 'enabled' : 'disabled')}
            />
          </div>
          <div className="p-4 grid gap-3">
            <Field
              label="memory directory"
              hint="point your RAG indexer (personal-rag MCP) at this path"
            >
              <div className="flex gap-2">
                <Input
                  value={memDir}
                  onChange={(e) => { memDirtyRef.current = true; setMemDir(e.target.value); }}
                  placeholder="absolute path — blank = default"
                  className="flex-1"
                />
                <Btn
                  onClick={() => {
                    setMemSaving(true);
                    setMemErr(null);
                    api.setMemoryConfig({ enabled: memEnabled, dir: memDir })
                      .then((cfg) => { memDirtyRef.current = false; setMemEnabled(cfg.enabled); setMemDir(cfg.dir); })
                      .catch((e: any) => setMemErr(e?.message || 'save failed'))
                      .finally(() => setMemSaving(false));
                  }}
                  disabled={memSaving}
                >
                  Save
                </Btn>
              </div>
            </Field>
            {memErr && (
              <div className="font-mono text-[11px] text-sig-failed">{memErr}</div>
            )}
            {memStats && (
              <div className="font-mono text-[11px] text-faint">
                {memStats.entries} {memStats.entries === 1 ? 'entry' : 'entries'} ·{' '}
                {(memStats.bytes / 1024).toFixed(1)} KB · {memStats.dir}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
