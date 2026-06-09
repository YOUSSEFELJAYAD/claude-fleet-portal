'use client';
import React from 'react';
import type { NormalizedEvent } from '@fleet/shared';
import { Panel, Kicker, Dot } from '@/components/ui';

/**
 * H11 — surface the session/init payload claude reports at startup (model, permissionMode,
 * MCP servers, plugins, output style, version) so an operator can see what a run ACTUALLY
 * got vs what was requested (e.g. a plugin that silently failed to load). The full init
 * object already flows to the client on the init event's payload.raw; this just reads it.
 * READ-ONLY: slash_commands / output_style are shown but are NOT launch levers in headless mode.
 */
function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s.includes('connect') && !s.includes('fail')) return '#54e08a';
  if (s.includes('fail') || s.includes('error')) return '#ff5d5d';
  if (s.includes('auth') || s.includes('pending') || s.includes('need')) return '#ffb000';
  return '#5b626d';
}

export function SessionPanel({ events }: { events: NormalizedEvent[] }) {
  const init = events.find((e) => e.type === 'init');
  const raw: any = (init?.payload as any)?.raw;
  if (!raw) return null;

  const mcp: any[] = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  const plugins: any[] = Array.isArray(raw.plugins) ? raw.plugins : [];
  const pluginErrors: any[] = Array.isArray(raw.plugin_errors) ? raw.plugin_errors : [];
  const facts: [string, React.ReactNode][] = [
    ['model', raw.model],
    ['permission mode', raw.permissionMode],
    ['fast mode', raw.fast_mode_state],
    ['output style', raw.output_style],
    ['cc version', raw.claude_code_version],
    ['api key', raw.apiKeySource],
    ['tools', Array.isArray(raw.tools) ? raw.tools.length : undefined],
    ['agents', Array.isArray(raw.agents) ? raw.agents.length : undefined],
    ['skills', Array.isArray(raw.skills) ? raw.skills.length : undefined],
    ['slash cmds', Array.isArray(raw.slash_commands) ? raw.slash_commands.length : undefined],
  ];

  return (
    <Panel className="p-4 mb-4">
      <Kicker>session · what this run actually got</Kicker>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-x-5 gap-y-2 mt-2">
        {facts
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => (
            <div key={k}>
              <div className="kicker">{k}</div>
              <div className="font-mono text-[12px] text-ink mt-0.5 break-words">{String(v)}</div>
            </div>
          ))}
      </div>

      {mcp.length > 0 && (
        <div className="mt-4">
          <Kicker>mcp servers ({mcp.length})</Kicker>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {mcp.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 border border-line2 px-2 py-1 font-mono text-[10.5px]">
                <Dot color={statusColor(s.status)} size={6} />
                <span className="text-dim">{s.name}</span>
                <span className="text-faint">{s.status}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {plugins.length > 0 && (
        <div className="mt-3">
          <Kicker>plugins ({plugins.length})</Kicker>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {plugins.map((p, i) => (
              <span key={i} className="border border-line2 px-2 py-1 font-mono text-[10.5px] text-dim">
                {p.name ?? String(p)}
              </span>
            ))}
          </div>
        </div>
      )}

      {pluginErrors.length > 0 && (
        <div className="mt-3">
          <Kicker className="text-sig-failed">plugin errors ({pluginErrors.length})</Kicker>
          <pre className="mt-1 font-mono text-[10.5px] text-sig-failed whitespace-pre-wrap">{JSON.stringify(pluginErrors, null, 1)}</pre>
        </div>
      )}
    </Panel>
  );
}
