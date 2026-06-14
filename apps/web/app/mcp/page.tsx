'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Kicker, Empty, Dot, Btn, Panel, ErrorBanner } from '@/components/ui';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

interface McpServer {
  name: string;
  status: string;
  detail: string;
}
interface McpResponse {
  servers: McpServer[];
  error?: string;
}

/** map a normalized status token to a signal color + display label */
function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('connect') && !s.includes('fail') && !s.includes('not') && !s.includes('disconnect')) return '#54e08a';
  if (s.includes('fail') || s.includes('error')) return '#ff5d5d';
  if (s.includes('auth') || s.includes('pending') || s.includes('connecting')) return '#ffb000';
  return '#7b828c';
}
function statusLabel(status: string): string {
  return status.replace(/-/g, ' ');
}

export default function McpHealthPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(API + '/api/mcp')
      .then((r) => r.json() as Promise<McpResponse>)
      .then((d) => {
        setServers(Array.isArray(d.servers) ? d.servers : []);
        setError(d.error ?? null);
        setFetchError(null);
      })
      .catch((e) => {
        setFetchError(e?.message || 'failed to reach control plane');
        setServers([]);
        setError(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connected = servers.filter((s) => statusColor(s.status) === '#54e08a').length;

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>integrations</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">MCP Server Health</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right font-mono text-[11px] text-faint">
            <span className="tnum text-sig-completed">
              {connected}
            </span>{' '}
            connected ·{' '}
            <span className="text-ink tnum">{servers.length}</span> total
          </div>
          <Btn variant="ghost" onClick={load} disabled={loading} title="re-run claude mcp list">
            ↻ Refresh
          </Btn>
        </div>
      </div>

      {fetchError && (
        <ErrorBanner className="mb-4" onRetry={load}>
          control plane unreachable — {fetchError}
        </ErrorBanner>
      )}

      {error && (
        <Panel className="mb-4 !border-amber/40">
          <div className="px-4 py-3 font-mono text-[12px] text-amber">
            <span className="uppercase tracking-wider text-[10px] mr-2">claude mcp list</span>
            {error}
          </div>
        </Panel>
      )}

      {loading && servers.length === 0 ? (
        <div className="font-mono text-faint text-[12px]">probing MCP servers…</div>
      ) : servers.length === 0 ? (
        <Empty>{error || fetchError ? 'No MCP servers reported.' : 'No MCP servers configured.'}</Empty>
      ) : (
        <div className="panel overflow-hidden">
          <div className="grid grid-cols-[140px_1fr_1.4fr] gap-3 px-4 py-2.5 border-b hairline kicker">
            <span>status</span>
            <span>server</span>
            <span>detail</span>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {servers.map((s) => {
              const color = statusColor(s.status);
              return (
                <div
                  key={s.name}
                  className="grid grid-cols-[140px_1fr_1.4fr] gap-3 px-4 py-2.5 items-center hover:bg-amber/[0.04] transition-colors"
                >
                  <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider" style={{ color }}>
                    <Dot color={color} live={color === '#54e08a'} size={6} />
                    {statusLabel(s.status)}
                  </span>
                  <span className="text-ink text-[12px] font-mono truncate" title={s.name}>
                    {s.name}
                  </span>
                  <span className="text-faint text-[11px] font-mono truncate" title={s.detail}>
                    {s.detail || '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
