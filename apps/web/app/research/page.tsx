'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { WebResult, ResearchStatusResponse } from '@fleet/shared';
import { Kicker, Panel, Btn, Input, ErrorBanner, Empty, Dot } from '@/components/ui';

/** Only http(s) links are safe in an href — a `javascript:`/`data:` result URL is an XSS
 *  vector. Results are already scheme-filtered server-side; this is defense-in-depth. */
function safeHref(u: string): string {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? u : '#';
  } catch {
    return '#';
  }
}

export default function ResearchPage() {
  const router = useRouter();
  const [status, setStatus] = useState<ResearchStatusResponse | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WebResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [addonBusy, setAddonBusy] = useState(false);
  const [addonMsg, setAddonMsg] = useState<string | null>(null);

  useEffect(() => { api.researchStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  async function runSearch() {
    setErr(null); setBusy(true);
    try {
      const res = await api.researchSearch({ query });
      setResults(res.results);
      setSelected(new Set(res.results.map((r) => r.url))); // default: all selected
      setSearched(true);
    } catch (e: any) { setErr(e?.message ?? 'search failed'); }
    finally { setBusy(false); }
  }

  async function installAddon() {
    setErr(null); setAddonMsg(null); setAddonBusy(true);
    try {
      const r = await api.installAddon('web-research');
      setAddonMsg(r.note ?? 'install started');
    } catch (e: any) { setErr(e?.message ?? 'install failed'); }
    finally { setAddonBusy(false); }
  }

  async function registerMcp() {
    setErr(null); setAddonMsg(null); setAddonBusy(true);
    try {
      const r = await api.registerSearxngMcp();
      setAddonMsg(r.note ?? (r.ok ? 'Registered mcp__searxng' : r.output));
    } catch (e: any) { setErr(e?.message ?? 'register failed'); }
    finally { setAddonBusy(false); }
  }

  function toggle(url: string) {
    setSelected((s) => { const n = new Set(s); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }

  async function synthesize() {
    setErr(null); setBusy(true);
    try {
      const chosen = results.filter((r) => selected.has(r.url));
      const { runId } = await api.researchSynthesize({ topic: query, results: chosen });
      router.push(`/runs/${runId}`);
    } catch (e: any) { setErr(e?.message ?? 'synthesize failed'); setBusy(false); }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>web research</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Web Research</h1>
        </div>
        <div className="text-right font-mono text-[11px]">
          {status ? (
            <span className="inline-flex items-center gap-1.5" style={{ color: status.ok ? '#54e08a' : '#ff5d5d' }}>
              <Dot color={status.ok ? '#54e08a' : '#ff5d5d'} live={status.ok} size={6} />
              {status.ok ? 'searxng reachable' : `searxng ${status.state}`}
            </span>
          ) : (
            <span className="text-faint">checking…</span>
          )}
        </div>
      </div>

      {/* settings / status strip */}
      <Panel className="p-3 mb-4">
        <div className="space-y-2">
          <div className="font-mono text-[12px] text-dim">
            SearXNG: <span className="text-ink">{status?.searxngUrl ?? '…'}</span>
          </div>
          {status && !status.ok && status.detail && (
            <div className="font-mono text-[11px] text-sig-killed">{status.detail}</div>
          )}
          <div className="flex gap-2 pt-1">
            <Btn onClick={installAddon} disabled={addonBusy}>Install SearXNG (Docker)</Btn>
            <Btn onClick={registerMcp} disabled={addonBusy}>Register agent MCP tool</Btn>
          </div>
          {addonMsg && <div className="font-mono text-[11px] text-sig-completed">{addonMsg}</div>}
        </div>
      </Panel>

      {/* search box */}
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the web…"
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && runSearch()}
        />
        <Btn variant="solid" onClick={runSearch} disabled={busy || !query.trim()}>Search</Btn>
      </div>
      {err && <ErrorBanner className="mt-3">{err}</ErrorBanner>}

      {/* results */}
      {results.length > 0 && (
        <div className="mt-4 space-y-3">
          <Kicker>results · {results.length}</Kicker>
          <div className="space-y-2">
            {results.map((r) => {
              const on = selected.has(r.url);
              return (
                <label
                  key={r.url}
                  className="flex gap-2.5 items-start text-[13px] border border-line2 p-2.5 cursor-pointer transition-colors hover:border-amber/40"
                  style={{ opacity: on ? 1 : 0.6 }}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(r.url)} className="mt-1 accent-amber" />
                  <span className="min-w-0">
                    <a
                      href={safeHref(r.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-dim hover:text-amber transition-colors break-words"
                    >
                      {r.title || r.url}
                    </a>
                    <span className="font-mono text-faint text-[11px]"> · {r.engine}</span>
                    <div className="text-faint text-[12px] mt-0.5">{r.snippet}</div>
                  </span>
                </label>
              );
            })}
          </div>
          <Btn variant="solid" onClick={synthesize} disabled={busy || selected.size === 0}>
            {busy ? 'Launching…' : `Synthesize with agent (${selected.size})`}
          </Btn>
        </div>
      )}

      {searched && results.length === 0 && !busy && (
        <div className="mt-4">
          <Empty>No results for that query.</Empty>
        </div>
      )}
    </div>
  );
}
