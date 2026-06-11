'use client';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { PortalConfig, SpendSummary } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Select, Btn, Stat, Gauge } from '@/components/ui';
import { usd } from '@/lib/format';

const POLL_MS = 5000;

export default function GuardrailsPage() {
  const [cfg, setCfg] = useState<PortalConfig | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [stopMsg, setStopMsg] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);

  // Live gauge: poll spend on a safe setTimeout chain (alive-ref pattern from compression page).
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm() {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(loadSpend, POLL_MS);
  }

  function loadSpend() {
    api
      .spend()
      .then((s) => {
        if (!alive.current) return;
        setSpend(s);
        rearm();
      })
      .catch(() => {
        if (!alive.current) return;
        rearm();
      });
  }

  useEffect(() => {
    alive.current = true;
    api.config().then(setCfg);
    loadSpend();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patch<K extends keyof PortalConfig>(k: K, v: PortalConfig[K]) {
    setCfg((c) => (c ? { ...c, [k]: v } : c));
    setSaved(false);
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setCfgErr(null);
    try {
      const next = await api.setConfig(cfg);
      setCfg(next);
      setSaved(true);
    } catch (e: any) {
      setCfgErr(e?.message ?? 'failed to save guardrails');
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    const activeCount = spend?.activeRuns ?? 0;
    const confirmed = window.confirm(
      `Stop all ${activeCount} live run${activeCount !== 1 ? 's' : ''}? Running work is killed immediately.`,
    );
    if (!confirmed) return;
    setStopBusy(true);
    setStopMsg(null);
    try {
      const res = await api.stopAll();
      setStopMsg(`stopped ${res.stopped} run${res.stopped !== 1 ? 's' : ''}`);
      // Refresh spend strip immediately.
      api.spend().then((s) => { if (alive.current) setSpend(s); });
    } catch (e: any) {
      setStopMsg(`error: ${e?.message ?? 'stop-all failed'}`);
    } finally {
      setStopBusy(false);
    }
  }

  if (!cfg) return <div className="font-mono text-faint text-[12px]">loading config…</div>;

  const dailyCapSet = cfg.dailySpendCeilingUsd != null;
  const capReached = dailyCapSet && (spend?.todayUsd ?? 0) >= cfg.dailySpendCeilingUsd!;
  const ceilingEmpty = cfg.dailySpendCeilingUsd == null;
  const durationEmpty = cfg.maxRunMinutes == null;
  const activeCount = spend?.activeRuns ?? 0;

  return (
    <div className="max-w-3xl">
      <Kicker>cost &amp; concurrency</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-5">Guardrails</h1>

      {/* ── 1. Live status ─────────────────────────────────────────────────── */}
      <Panel className="p-0 mb-5 overflow-hidden" ticked>
        <div className="px-4 py-3 border-b hairline flex items-center justify-between">
          <Kicker>live status</Kicker>
          <span className="font-mono text-[10px] text-faint">{POLL_MS / 1000}s poll</span>
        </div>

        {capReached && (
          <div
            className="font-mono text-[11px] mx-4 mt-4 px-4 py-3 border leading-relaxed"
            style={{ color: '#ff5d5d', borderColor: '#ff5d5d55', background: '#ff5d5d12' }}
          >
            <span className="font-display tracking-wide">DAILY CAP REACHED</span> — new launches are
            refused until tomorrow (or raise the cap below)
          </div>
        )}

        <div className="p-4 grid grid-cols-2 gap-5">
          <div>
            <Gauge
              value={spend?.todayUsd ?? 0}
              cap={cfg.dailySpendCeilingUsd}
              label="spend today"
            />
            <div className="font-mono tnum text-[13px] mt-1.5" style={{ color: capReached ? '#ff5d5d' : '#ffb000' }}>
              {usd(spend?.todayUsd ?? 0)}
              {dailyCapSet && (
                <span className="text-faint text-[10px] ml-1">/ {usd(cfg.dailySpendCeilingUsd!)}</span>
              )}
            </div>
          </div>
          <div>
            <Gauge
              value={activeCount}
              cap={cfg.maxConcurrentRuns}
              label="active runs"
            />
            <div className="font-mono tnum text-[13px] mt-1.5" style={{ color: '#e9e7df' }}>
              {activeCount}
              <span className="text-faint text-[10px] ml-1">/ {cfg.maxConcurrentRuns}</span>
            </div>
          </div>
        </div>

        <div className="px-4 pb-4 grid grid-cols-2 gap-5">
          <Stat label="runs today" value={spend?.totalRunsToday ?? 0} />
          <Stat
            label="daily cap"
            value={dailyCapSet ? usd(cfg.dailySpendCeilingUsd!) : 'no cap'}
            accent={dailyCapSet ? (capReached ? '#ff5d5d' : '#ffb000') : '#5b626d'}
          />
        </div>
      </Panel>

      {/* ── 2. Limits ──────────────────────────────────────────────────────── */}
      <Panel className="p-0 mb-5 overflow-hidden">
        <div className="px-4 py-3 border-b hairline">
          <Kicker>limits</Kicker>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-2 gap-6">
            <Field label="max concurrent runs" hint="server-enforced">
              <Input
                type="number"
                min={1}
                value={cfg.maxConcurrentRuns}
                onChange={(e) => patch('maxConcurrentRuns', Number(e.target.value))}
              />
            </Field>
            <Field label="default budget ceiling" hint="USD / run">
              <Input
                type="number"
                step="0.5"
                value={cfg.defaultBudgetUsd}
                onChange={(e) => patch('defaultBudgetUsd', Number(e.target.value))}
              />
            </Field>
            <Field label="ultracode budget ceiling" hint="tighter default">
              <Input
                type="number"
                step="0.5"
                value={cfg.ultracodeBudgetUsd}
                onChange={(e) => patch('ultracodeBudgetUsd', Number(e.target.value))}
              />
            </Field>
            <Field label="default permission mode">
              <Select
                value={cfg.permissionDefault}
                onChange={(e) => patch('permissionDefault', e.target.value as PortalConfig['permissionDefault'])}
              >
                {['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
            </Field>
            <Field label="daily spend ceiling" hint="USD / day · blank = no cap">
              <Input
                type="number"
                min={0.01}
                step="0.5"
                placeholder="no cap"
                value={ceilingEmpty ? '' : cfg.dailySpendCeilingUsd ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  // blank → null (no ceiling); don't coerce empty string → 0.
                  patch('dailySpendCeilingUsd', raw === '' ? null : Number(raw));
                }}
              />
            </Field>
            <Field label="max run duration" hint="minutes · blank = unlimited">
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="unlimited"
                value={durationEmpty ? '' : cfg.maxRunMinutes ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  patch('maxRunMinutes', raw === '' ? null : Number(raw));
                }}
              />
            </Field>
          </div>

          <div className="mt-6 pt-5 border-t hairline">
            <Kicker>platform ceilings · read-only (Dynamic Workflows)</Kicker>
            <div className="grid grid-cols-2 gap-6 mt-3">
              <div className="flex items-center justify-between border border-line2 px-3 py-2.5">
                <span className="font-mono text-[11px] text-dim">max concurrent subagents</span>
                <span className="font-mono tnum text-[15px] text-amber">{cfg.subagentConcurrentCeiling}</span>
              </div>
              <div className="flex items-center justify-between border border-line2 px-3 py-2.5">
                <span className="font-mono text-[11px] text-dim">max total subagents / run</span>
                <span className="font-mono tnum text-[15px] text-amber">{cfg.subagentTotalCeiling}</span>
              </div>
            </div>
            <p className="font-mono text-[10px] text-faint mt-3 leading-relaxed">
              On budget breach the run + its whole subtree are auto-killed. ultracode runs receive the tighter ceiling by default.
              These platform limits (≤16 concurrent, 1000 total) are surfaced for awareness; they are enforced by the Claude Code runtime.
            </p>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <Btn variant="solid" onClick={save} disabled={busy}>{busy ? 'saving…' : 'Save Guardrails'}</Btn>
            {saved && <span className="font-mono text-[11px]" style={{ color: '#54e08a' }}>✓ saved</span>}
            {cfgErr && <span className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{cfgErr}</span>}
          </div>
        </div>
      </Panel>

      {/* ── 3. Danger zone ─────────────────────────────────────────────────── */}
      <Panel className="p-0 overflow-hidden">
        <div
          className="px-4 py-3 border-b"
          style={{ borderColor: '#ff5d5d40', background: 'rgba(255,93,93,0.06)' }}
        >
          <span className="kicker" style={{ color: '#ff5d5d' }}>danger zone</span>
        </div>
        <div className="p-4">
          <p className="font-mono text-[11px] text-dim leading-relaxed mb-4">
            Kill every live run immediately. Use this as a panic button — all running work is terminated
            and cannot be recovered. Individual runs can be stopped from the Fleet page.
          </p>
          <div className="flex items-center gap-3">
            <Btn
              variant="danger"
              onClick={stopAll}
              disabled={stopBusy || activeCount === 0}
            >
              {stopBusy ? 'stopping…' : `⏻ STOP ALL RUNS${activeCount > 0 ? ` (${activeCount})` : ''}`}
            </Btn>
            {stopMsg && (
              <span
                className="font-mono text-[11px]"
                style={{ color: stopMsg.startsWith('error') ? '#ff5d5d' : '#54e08a' }}
              >
                {stopMsg}
              </span>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
