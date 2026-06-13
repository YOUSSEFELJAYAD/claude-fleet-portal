'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFleet } from '@/lib/live';
import { api } from '@/lib/api';
import { usd } from '@/lib/format';
import type { ReleaseStatus, AddonInfo } from '@fleet/shared';
import { Gauge, Btn, Dot } from './ui';
import { LaunchModal } from './LaunchModal';
import { UpdateModal, updateDismissKey, type UpdatePhase } from './UpdateModal';

const NAV = [
  { href: '/', label: 'Fleet', glyph: '◉' },
  { href: '/inbox', label: 'Inbox', glyph: '◳' },
  { href: '/projects', label: 'Projects', glyph: '◫' },
  { href: '/fleet', label: 'Scheduler', glyph: '⚖' },
  { href: '/orchestrate', label: 'Orchestrate', glyph: '⛓' },
  { href: '/templates', label: 'Templates', glyph: '⊞' },
  { href: '/learning', label: 'Learning', glyph: '✦' },
  { href: '/schedules', label: 'Schedules', glyph: '⏱' },
  { href: '/teams', label: 'Teams', glyph: '⧉' },
  { href: '/history', label: 'History', glyph: '▤' },
  { href: '/metrics', label: 'Metrics', glyph: '▦' },
  { href: '/compare', label: 'Compare', glyph: '⊟' },
  { href: '/benchmarks', label: 'Benchmarks', glyph: '⚗' },
  { href: '/mcp', label: 'MCP', glyph: '⊕' },
  { href: '/notifications', label: 'Notifications', glyph: '◬' },
  { href: '/guardrails', label: 'Guardrails', glyph: '⊘' },
  { href: '/settings', label: 'Settings', glyph: '⚙' },
  { href: '/addons', label: 'Add-ons', glyph: '⌬' },
  { href: '/releases', label: 'Releases', glyph: '⇪' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { spend, connected, runs } = useFleet();
  const [launchOpen, setLaunchOpen] = useState(false);
  // release status drives: the amber dot on the Releases nav entry, the version line at the
  // bottom of the sidebar, and the update popup (snoozed per-version via localStorage).
  // The update itself runs in the BACKGROUND — Shell owns the phase, so the popup can be
  // closed mid-update and the sidebar chip keeps reporting until restart.
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [updatePopup, setUpdatePopup] = useState(false);
  const [updPhase, setUpdPhase] = useState<UpdatePhase>('idle');
  // §22 — an ENABLED add-on unlocks its dedicated page as a nav entry (e.g. Compression).
  // Re-fetched on route changes AND on the 'fleet:addons' event the add-on pages dispatch
  // after a toggle/config change — without the event, flipping a switch on /addons would
  // not move the rail until the next navigation.
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  useEffect(() => {
    const refresh = () => {
      api
        .addons()
        .then(setAddons)
        .catch(() => {});
    };
    refresh();
    window.addEventListener('fleet:addons', refresh);
    return () => window.removeEventListener('fleet:addons', refresh);
  }, [pathname]);
  useEffect(() => {
    api
      .releaseStatus()
      .then((s) => {
        setRelease(s);
        // popup for BOTH flavors: source installs self-update in place; packaged apps
        // (no git checkout → canSelfUpdate false) are offered the download page instead.
        if (s.updateAvailable && s.latest) {
          let snoozed = false;
          try {
            snoozed = !!localStorage.getItem(updateDismissKey(s.latest.tag));
          } catch {
            /* ignore */
          }
          if (!snoozed) setUpdatePopup(true);
        }
      })
      .catch(() => {});
  }, []);
  const updateAvailable = !!release?.updateAvailable;

  function startUpdate() {
    setUpdPhase('running');
    api
      .selfUpdate()
      .then((r) => {
        setUpdPhase(r.ok ? 'ready' : 'failed');
        setUpdatePopup(true); // resurface even if the user closed it and kept working
      })
      .catch(() => {
        setUpdPhase('failed');
        setUpdatePopup(true);
      });
  }

  function closeUpdate(snooze: boolean) {
    setUpdatePopup(false);
    if (snooze && release?.latest) {
      try {
        localStorage.setItem(updateDismissKey(release.latest.tag), '1');
      } catch {
        /* ignore */
      }
    }
  }
  const active = runs.filter((r) => ['starting', 'running', 'orchestrating', 'awaiting-input', 'awaiting-permission'].includes(r.status));
  // F6 — inbox count: runs waiting on operator (zero new polling — derived from existing useFleet runs)
  const inboxCount = runs.filter((r) => r.status === 'awaiting-permission' || r.status === 'awaiting-input').length;
  const dailyCap = 50; // soft visual reference for the daily-spend gauge

  // enabled add-ons slot their page directly under the Add-ons entry
  type NavItem = { href: string; label: string; glyph: string; addonStatus?: AddonInfo['status'] };
  const navItems: NavItem[] = [];
  for (const n of NAV) {
    navItems.push(n);
    if (n.href === '/addons') {
      for (const a of addons) {
        if (a.enabled && a.page) navItems.push({ href: a.page, label: a.name, glyph: '◍', addonStatus: a.status });
      }
    }
  }

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
          {navItems.map((n) => {
            const on =
              n.href === '/'
                ? pathname === '/' || pathname.startsWith('/runs')
                : n.href === '/addons'
                  ? // own the whole /addons tree EXCEPT sub-pages that have their own entry
                    // (a disabled add-on's page is still reachable via Details/Install)
                    pathname === '/addons' || (pathname.startsWith('/addons/') && !navItems.some((i) => i.addonStatus && pathname.startsWith(i.href)))
                  : pathname.startsWith(n.href);
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
                {n.href === '/inbox' && inboxCount > 0 && (
                  <span
                    title={`${inboxCount} waiting`}
                    className="ml-auto font-mono text-[10px] font-bold animate-pulseGlow"
                    style={{ color: '#ffb000', minWidth: 16, textAlign: 'center' }}
                  >
                    {inboxCount}
                  </span>
                )}
                {n.href === '/releases' && updateAvailable && (
                  <span
                    title="update available"
                    className="ml-auto animate-pulseGlow"
                    style={{ width: 7, height: 7, borderRadius: 999, background: '#ffb000', display: 'inline-block' }}
                  />
                )}
                {n.addonStatus && (
                  <span
                    title={n.addonStatus}
                    className={n.addonStatus === 'starting' ? 'ml-auto animate-pulseGlow' : 'ml-auto'}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      display: 'inline-block',
                      background: n.addonStatus === 'running' ? '#54e08a' : n.addonStatus === 'error' ? '#ff5d5d' : '#ffb000',
                    }}
                  />
                )}
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
          {release && (
            <Link href="/releases" className="block mt-2 font-mono text-[10px] text-faint hover:text-amber" title="releases & updates">
              v{release.currentVersion}
              {release.currentSha && <span className="opacity-60"> · {release.currentSha}</span>}
              {updPhase === 'running' ? (
                <span className="text-amber"> · updating…</span>
              ) : updPhase === 'ready' ? (
                <span className="text-amber"> · restart to apply</span>
              ) : (
                updateAvailable && release.latest && <span className="text-amber"> → {release.latest.tag} available</span>
              )}
            </Link>
          )}
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
      {updatePopup && release && (
        <UpdateModal status={release} phase={updPhase} onStart={startUpdate} onClose={closeUpdate} />
      )}
    </div>
  );
}
