'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFleet } from '@/lib/live';
import { usd } from '@/lib/format';
import { Gauge, Btn, Dot } from './ui';
import { LaunchModal } from './LaunchModal';

const NAV = [
  { href: '/', label: 'Fleet', glyph: '◉' },
  { href: '/projects', label: 'Projects', glyph: '◫' },
  { href: '/fleet', label: 'Scheduler', glyph: '⚖' },
  { href: '/orchestrate', label: 'Orchestrate', glyph: '⛓' },
  { href: '/templates', label: 'Templates', glyph: '⊞' },
  { href: '/schedules', label: 'Schedules', glyph: '⏱' },
  { href: '/teams', label: 'Teams', glyph: '⧉' },
  { href: '/history', label: 'History', glyph: '▤' },
  { href: '/metrics', label: 'Metrics', glyph: '▦' },
  { href: '/compare', label: 'Compare', glyph: '⊟' },
  { href: '/mcp', label: 'MCP', glyph: '⊕' },
  { href: '/notifications', label: 'Notifications', glyph: '◬' },
  { href: '/guardrails', label: 'Guardrails', glyph: '⊘' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { spend, connected, runs } = useFleet();
  const [launchOpen, setLaunchOpen] = useState(false);
  const active = runs.filter((r) => ['starting', 'running', 'orchestrating', 'awaiting-input', 'awaiting-permission'].includes(r.status));
  const dailyCap = 50; // soft visual reference for the daily-spend gauge

  return (
    <div className="min-h-screen flex">
      {/* ── nav rail ─────────────────────────────────────────── */}
      <aside className="w-[210px] shrink-0 border-r hairline flex flex-col sticky top-0 h-screen">
        <div className="px-5 py-5 border-b hairline">
          <div className="flex items-center gap-2.5">
            <div className="relative w-7 h-7 grid place-items-center border border-amber/50" style={{ boxShadow: '0 0 16px -4px rgba(255,176,0,0.6)' }}>
              <span className="text-amber font-display text-[15px] leading-none">F</span>
              <span className="absolute inset-0 animate-pulseGlow" style={{ color: '#ffb000' }} />
            </div>
            <div>
              <div className="font-display text-[13px] tracking-wide text-ink leading-none">FLEET</div>
              <div className="kicker mt-1">control plane</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3">
          {NAV.map((n) => {
            const on = n.href === '/' ? pathname === '/' || pathname.startsWith('/runs') : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className="group flex items-center gap-3 px-5 py-2.5 relative transition-colors"
                style={{ color: on ? '#e9e7df' : '#9aa1ab' }}
              >
                {on && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-amber" style={{ boxShadow: '0 0 8px #ffb000' }} />}
                <span className="text-[13px]" style={{ color: on ? '#ffb000' : '#5b626d' }}>
                  {n.glyph}
                </span>
                <span className="font-display text-[12px] tracking-wide uppercase group-hover:text-ink">{n.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t hairline">
          <Gauge value={spend?.todayUsd ?? 0} cap={dailyCap} label="spend · today" />
          <div className="mt-2 font-mono tnum text-[18px] text-ink">{usd(spend?.todayUsd ?? 0)}</div>
          <div className="flex items-center gap-2 mt-3">
            <Dot color={connected ? '#54e08a' : '#ff5d5d'} live={connected} size={6} />
            <span className="font-mono text-[10px] text-faint uppercase tracking-wider">
              {connected ? 'telemetry live' : 'reconnecting'}
            </span>
          </div>
        </div>
      </aside>

      {/* ── main column ──────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-[58px] shrink-0 border-b hairline flex items-center justify-between px-6 sticky top-0 z-20 backdrop-blur-sm" style={{ background: 'rgba(10,11,14,0.78)' }}>
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <span className="kicker">active</span>
              <span className="font-mono tnum text-[15px] text-amber">{String(active.length).padStart(2, '0')}</span>
            </div>
            <div className="w-px h-5 bg-line" />
            <div className="flex items-center gap-2">
              <span className="kicker">runs today</span>
              <span className="font-mono tnum text-[15px] text-ink">{spend?.totalRunsToday ?? 0}</span>
            </div>
          </div>
          <Btn variant="solid" onClick={() => setLaunchOpen(true)} className="!px-4 !py-2">
            ＋ Launch Agent
          </Btn>
        </header>

        <main className="flex-1 min-w-0 p-6">{children}</main>
      </div>

      {launchOpen && <LaunchModal onClose={() => setLaunchOpen(false)} />}
    </div>
  );
}
