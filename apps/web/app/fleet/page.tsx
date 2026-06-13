'use client';
import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FleetStatus } from '@/lib/api';
import type { FleetConfig } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Btn, Stat, Dot } from '@/components/ui';
import { usd } from '@/lib/format';

const POLL_MS = 5000;

export default function FleetSchedulerPage() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<FleetConfig | null>(null);
  const [cfgOpen, setCfgOpen] = useState(false); // config lives in a POPUP, not inline
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

  function openConfig() {
    // refetch on open — a previously cancelled edit must not leak into this session
    api.fleetConfig().then(setCfg).catch(() => {});
    setCfgErr(null);
    setCfgOpen(true);
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setCfgErr(null);
    try {
      const next = await api.setFleetConfig(cfg);
      setCfg(next);
      setCfgOpen(false); // saved → dismiss; the snapshot below reflects it live
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
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <Kicker>cross-project scheduler · v2 #7</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Fleet Scheduler</h1>
          <p className="font-mono text-[11px] text-faint leading-relaxed">
            Admission-only fair-share of the single global concurrency pool across projects by priority.
            Running runs are never preempted; a project over its fair-share quota simply has its Ready
            cards retried on the next tick.
          </p>
        </div>
        <Btn onClick={openConfig}>⚙ Fleet Config</Btn>
      </div>

      {/* ── live allocation snapshot ─────────────────────────────────────── */}
      <Panel className="p-4 mb-5 grid grid-cols-4 gap-5" ticked>
        <Stat label="PM pool" value={status ? status.pool : '—'} accent="#ffb000" sub={status ? `${status.maxConcurrentRuns} max − ${status.config.reserveSlotsForNonPm} reserved` : undefined} />
        <Stat label="PM live runs" value={status ? status.pmLiveTotal : '—'} />
        <Stat label="spend today" value={usd(status?.spendTodayUsd)} accent={status?.spendExceeded ? '#ff5d5d' : undefined} />
        <Stat
          label="fleet ceiling"
          value={status ? (status.spendCeilingUsd == null ? 'no cap' : usd(status.spendCeilingUsd)) : '—'}
          sub={status?.spendExceeded ? 'EXCEEDED — admissions denied' : undefined}
        />
      </Panel>

      {status?.deadlocked && (
        <div className="font-mono text-[11px] mb-5 px-4 py-3 border leading-relaxed border-sig-failed/40 bg-sig-failed/8 text-sig-failed">
          <span className="font-display tracking-wide">PM POOL DEADLOCKED.</span> The pool is 0
          (reserve {status.config.reserveSlotsForNonPm} ≥ maxConcurrentRuns {status.maxConcurrentRuns})
          while projects have Ready cards — nothing will launch. Lower the reserve in{' '}
          <button onClick={openConfig} className="underline text-sig-failed">⚙ Fleet Config</button>, or raise
          global maxConcurrentRuns in settings.
        </div>
      )}

      {statusErr && (
        <div className="font-mono text-[11px] text-sig-failed mb-4">
          {statusErr}
        </div>
      )}

      {/* ── per-project allocation table ─────────────────────────────────── */}
      <Panel className="p-0 mb-6 overflow-hidden">
        <div className="px-4 py-3 border-b hairline flex items-center justify-between">
          <Kicker>per-project allocation</Kicker>
          <span className="font-mono text-[10px] text-faint">live · {POLL_MS / 1000}s poll</span>
        </div>
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
                <td colSpan={7} className="px-4 py-8 text-center font-mono text-[12px] text-faint">
                  no projects
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
      </Panel>
      <p className="font-mono text-[10px] text-faint -mt-4 mb-6 leading-relaxed">
        Project <span className="text-dim">priority</span> (which weights the fair-share split) is set per-project on the Projects page,
        not here. This page edits only the fleet-wide knobs below.
      </p>

      {/* ── fleet config popup (same design language as the other portal modals) ── */}
      {cfgOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-16 px-4"
          style={{ background: 'rgba(4,5,7,0.78)' }}
          onClick={() => setCfgOpen(false)}
        >
          <Panel ticked className="w-full max-w-[520px]">
            <div onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 border-b hairline">
                <div>
                  <Kicker>scheduler settings</Kicker>
                  <div className="font-display text-[16px] text-ink tracking-wide mt-1">Fleet Config</div>
                </div>
                <button onClick={() => setCfgOpen(false)} className="text-faint hover:text-ink font-mono text-lg leading-none">✕</button>
              </div>

              <div className="p-5">
                {!cfg ? (
                  <div className="font-mono text-faint text-[12px]">loading config…</div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-5">
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
                      workers draw from the reserved slots. A null ceiling means no fleet-wide daily spend gate.
                    </p>
                    {cfgErr && (
                      <div className="font-mono text-[11px] mt-3 text-sig-failed">{cfgErr}</div>
                    )}
                  </>
                )}
              </div>

              <div className="px-5 py-4 border-t hairline flex items-center justify-end gap-2">
                <Btn onClick={() => setCfgOpen(false)}>Cancel</Btn>
                <Btn variant="solid" onClick={save} disabled={busy || !cfg}>
                  {busy ? 'saving…' : 'Save Fleet Config'}
                </Btn>
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
