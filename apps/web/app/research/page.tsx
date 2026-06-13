'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { WebResult, ResearchStatusResponse } from '@fleet/shared';
import { Btn, Input } from '@/components/ui';

export default function ResearchPage() {
  const router = useRouter();
  const [status, setStatus] = useState<ResearchStatusResponse | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WebResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.researchStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  async function runSearch() {
    setErr(null); setBusy(true);
    try {
      const res = await api.researchSearch({ query });
      setResults(res.results);
      setSelected(new Set(res.results.map((r) => r.url))); // default: all selected
    } catch (e: any) { setErr(e?.message ?? 'search failed'); }
    finally { setBusy(false); }
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
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold">Web Research</h1>

      {/* settings / status strip */}
      <div className="text-[12px] rounded border hairline p-3 space-y-2">
        <div>
          SearXNG: <span className="font-mono">{status?.searxngUrl ?? '…'}</span>{' '}
          <span style={{ color: status?.ok ? '#3ad29f' : '#ff5d5d' }}>
            {status ? (status.ok ? '● reachable' : `● ${status.state}`) : ''}
          </span>
        </div>
        {status && !status.ok && <div style={{ color: '#ff8a5d' }}>{status.detail}</div>}
        <div className="flex gap-2">
          <Btn onClick={() => api.installAddon('web-research').then((r) => alert(r.note))}>Install SearXNG (Docker)</Btn>
          <Btn onClick={() => api.registerSearxngMcp().then((r) => alert(r.note ?? (r.ok ? 'Registered mcp__searxng' : r.output)))}>Register agent MCP tool</Btn>
        </div>
      </div>

      {/* search box */}
      <div className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the web…"
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && runSearch()} />
        <Btn variant="solid" onClick={runSearch} disabled={busy || !query.trim()}>Search</Btn>
      </div>
      {err && <div className="text-[12px]" style={{ color: '#ff5d5d' }}>{err}</div>}

      {/* results */}
      {results.length > 0 && (
        <>
          <div className="space-y-2">
            {results.map((r) => (
              <label key={r.url} className="flex gap-2 items-start text-[13px] rounded border hairline p-2 cursor-pointer">
                <input type="checkbox" checked={selected.has(r.url)} onChange={() => toggle(r.url)} className="mt-1" />
                <span>
                  <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline">{r.title || r.url}</a>
                  <span className="opacity-50"> · {r.engine}</span>
                  <div className="opacity-70">{r.snippet}</div>
                </span>
              </label>
            ))}
          </div>
          <Btn variant="solid" onClick={synthesize} disabled={busy || selected.size === 0}>
            {busy ? 'Launching…' : `Synthesize with agent (${selected.size})`}
          </Btn>
        </>
      )}
    </div>
  );
}
