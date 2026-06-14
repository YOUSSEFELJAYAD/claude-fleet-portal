'use client';
import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FleetStatus } from '@/lib/api';
import type { FleetConfig } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Btn, Stat, Dot, Empty, ErrorBanner } from '@/components/ui';
import { usd } from '@/lib/format';

const POLL_MS = 5000;

export default function FleetSchedulerPage() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<FleetConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  // Poll the live allocation snapshot on an interval (NO new SSE channel — plain fetch loop).
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .fleetStatus()
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          setStatusErr(null);
        })
        .catch((e) => {
          if (alive) setStatusErr(e?.message ?? 'failed to load fleet status');
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Load the editable config ONCE (PUT-on-save, like Guardrails).
  useEffect(() => {
    api.fleetConfig().then(setCfg).catch(() => {});
  }, []);

  function patch<K extends keyof FleetConfig>(k: K, v: FleetConfig[K]) {
    setCfg((c) => (c ? { ...c, [k]: v } : c));
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setCfgErr(null);
    try {
      const next = await api.setFleetConfig(cfg);
      setCfg(next);
      // refresh the snapshot immediately so pool/quotas reflect the new reserve.
      api.fleetStatus().then(setStatus).catch(() => {});
    } catch (e: any) {
      setCfgErr(e?.message ?? 'failed to save fleet config');
    } finally {
      setBusy(false);
    }
  }

  const ceilingEmpty = cfg?.fleetSpendCeilingUsd == null;

  return (
    <div>
      <Kicker>cross-project scheduler · v2 #7</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Fleet Scheduler</h1>
      <p className="font-mono text-[11px] text-faint mb-5 leading-relaxed">
        Admission-only fair-share of the single global concurrency pool across projects by priority.
        Running runs are never preempted; a project over its fair-share quota simply has its Ready cards retried on the next tick.
      </p>

      <div className="space-y-5">
        {/* ── block 1 · fleet config ─────────────────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>fleet config</Kicker>
          </div>
          <div className="p-5">
            {!cfg ? (
              <div className="font-mono text-faint text-[12px]">loading config…</div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <Field label="reserve slots for non-PM" hint="held back from PM pool">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={cfg.reserveSlotsForNonPm}
                      onChange={(e) => patch('reserveSlotsForNonPm', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    />
                  </Field>
                  <Field label="fleet spend ceiling" hint="USD / day · blank = no cap">
                    <Input
                      type="number"
                      min={0}
                      step="0.5"
                      placeholder="no cap"
                      value={ceilingEmpty ? '' : cfg.fleetSpendCeilingUsd ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        // blank → null (no ceiling); validateFleetConfig accepts null. Don't coerce empty→0.
                        patch('fleetSpendCeilingUsd', raw === '' ? null : Number(raw));
                      }}
                    />
                  </Field>
                </div>
                <p className="font-mono text-[10px] text-faint mt-4 leading-relaxed">
                  The PM pool is <span className="text-dim">maxConcurrentRuns − reserveSlotsForNonPm</span>; campaign / non-PM
                  workers draw from the reserved slots. A null ceiling means no fleet-wide daily spend gate. Project{' '}
                  <span className="text-dim">priority</span> (which weights the fair-share split) is set per-project on the Projects page.
                </p>
                {cfgErr && <ErrorBanner className="mt-4" onRetry={save}>{cfgErr}</ErrorBanner>}
                <div className="flex items-center gap-3 pt-3">
                  <Btn variant="solid" onClick={save} disabled={busy || !cfg}>
                    {busy ? 'saving…' : '⚙ Save Fleet Config'}
                  </Btn>
                </div>
              </>
            )}
          </div>
        </Panel>

        {status?.deadlocked && (
          <ErrorBanner className="leading-relaxed">
            <span className="font-display tracking-wide">PM POOL DEADLOCKED.</span> The pool is 0
            (reserve {status.config.reserveSlotsForNonPm} ≥ maxConcurrentRuns {status.maxConcurrentRuns})
            while projects have Ready cards — nothing will launch. Lower the reserve in fleet config above,
            or raise global maxConcurrentRuns in settings.
          </ErrorBanner>
        )}

        {statusErr && <ErrorBanner>{statusErr}</ErrorBanner>}

        {/* ── block 2 · live allocation ──────────────────────────────────────── */}
        <Panel ticked>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <span className="flex items-center gap-2">
              <Dot color="#ffb000" live={(status?.pmLiveTotal ?? 0) > 0} size={6} />
              <Kicker>live allocation</Kicker>
            </span>
            <span className="font-mono text-[10px] text-faint">{POLL_MS / 1000}s poll</span>
          </div>
          <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-5">
            <Stat label="PM pool" value={status ? status.pool : '—'} accent="#ffb000" sub={status ? `${status.maxConcurrentRuns} max − ${status.config.reserveSlotsForNonPm} reserved` : undefined} />
            <Stat label="PM live runs" value={status ? status.pmLiveTotal : '—'} />
            <Stat label="spend today" value={usd(status?.spendTodayUsd)} accent={status?.spendExceeded ? '#ff5d5d' : undefined} />
            <Stat
              label="fleet ceiling"
              value={status ? (status.spendCeilingUsd == null ? 'no cap' : usd(status.spendCeilingUsd)) : '—'}
              sub={status?.spendExceeded ? 'EXCEEDED — admissions denied' : undefined}
            />
          </div>
        </Panel>

        {/* ── block 3 · per-project allocation ───────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline flex items-center justify-between">
            <Kicker>per-project allocation</Kicker>
            <span className="font-mono text-[10px] text-faint">live · {POLL_MS / 1000}s poll</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left border-b hairline">
                  {['project', 'priority', 'demanding', 'live runs', 'quota', 'in progress', 'project spend'].map((h) => (
                    <th key={h} className="kicker font-display px-4 py-2.5">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {status && status.projects.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-4">
                      <Empty>no projects yet</Empty>
                    </td>
                  </tr>
                )}
                {status?.projects.map((p) => (
                  <tr key={p.projectId} className="border-b hairline last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {p.paused && <span className="font-mono text-[9px] text-faint uppercase border border-line2 px-1">paused</span>}
                        <span className="font-mono text-[12px] text-ink">{p.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono tnum text-[12px] text-dim">{p.priority}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <Dot color={p.demanding ? '#54e08a' : '#5b626d'} live={p.demanding} size={6} />
                        <span className="font-mono text-[11px]" style={{ color: p.demanding ? '#54e08a' : '#5b626d' }}>
                          {p.demanding ? 'yes' : 'no'}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono tnum text-[12px] text-ink">{p.liveRuns}</td>
                    <td className="px-4 py-2.5 font-mono tnum text-[12px]" style={{ color: p.quota > 0 ? '#ffb000' : '#5b626d' }}>{p.quota}</td>
                    <td className="px-4 py-2.5 font-mono tnum text-[12px] text-dim">{p.inProgress} / {p.wipLimit}</td>
                    <td className="px-4 py-2.5 font-mono tnum text-[12px] text-dim">{usd(p.projectSpend)}</td>
                  </tr>
                ))}
                {!status && !statusErr && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center font-mono text-[12px] text-faint">loading…</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
