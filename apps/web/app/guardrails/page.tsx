'use client';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { PortalConfig, SpendSummary } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Select, Btn, Stat, Gauge, ErrorBanner } from '@/components/ui';
import { usd } from '@/lib/format';

const POLL_MS = 5000;

/** The three REQUIRED number fields edit as STRINGS — coercing per keystroke turns a
 *  cleared field into 0 (review); save() validates and converts. */
interface NumForm {
  maxConcurrentRuns: string;
  defaultBudgetUsd: string;
  ultracodeBudgetUsd: string;
}
const toNumForm = (c: PortalConfig): NumForm => ({
  maxConcurrentRuns: String(c.maxConcurrentRuns),
  defaultBudgetUsd: String(c.defaultBudgetUsd),
  ultracodeBudgetUsd: String(c.ultracodeBudgetUsd),
});

export default function GuardrailsPage() {
  const [cfg, setCfg] = useState<PortalConfig | null>(null);
  const [nums, setNums] = useState<NumForm | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [stopMsg, setStopMsg] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

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
    api.config().then((c) => {
      setCfg(c);
      setNums(toNumForm(c));
    });
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
    if (!cfg || !nums) return;
    // client-side mirror of validateConfig for the string-typed fields — readable
    // messages instead of a generic 400, and blank never silently becomes 0
    const mcr = Number(nums.maxConcurrentRuns);
    if (nums.maxConcurrentRuns.trim() === '' || !Number.isInteger(mcr) || mcr < 1) {
      setCfgErr('max concurrent runs must be an integer ≥ 1');
      return;
    }
    const dbu = Number(nums.defaultBudgetUsd);
    if (nums.defaultBudgetUsd.trim() === '' || !Number.isFinite(dbu) || dbu <= 0) {
      setCfgErr('default budget ceiling must be a positive number');
      return;
    }
    const ubu = Number(nums.ultracodeBudgetUsd);
    if (nums.ultracodeBudgetUsd.trim() === '' || !Number.isFinite(ubu) || ubu <= 0) {
      setCfgErr('ultracode budget ceiling must be a positive number');
      return;
    }
    setBusy(true);
    setCfgErr(null);
    try {
      const next = await api.setConfig({ ...cfg, maxConcurrentRuns: mcr, defaultBudgetUsd: dbu, ultracodeBudgetUsd: ubu });
      setCfg(next);
      setNums(toNumForm(next));
      setSaved(true);
    } catch (e: any) {
      setCfgErr(e?.message ?? 'failed to save guardrails');
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    // a panic button must not depend on the (possibly stale/failed) spend poll —
    // the server-side stop-all is safe at 0 runs, so always offer it (review)
    const known = spend?.activeRuns;
    const confirmed = window.confirm(
      known != null
        ? `Stop all ${known} live run${known !== 1 ? 's' : ''} (and kill active campaigns)? Running work is terminated immediately.`
        : 'Stop ALL live runs (and kill active campaigns)? Running work is terminated immediately.',
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

  async function resetData() {
    if (resetConfirm !== 'RESET') {
      setResetMsg('type RESET to enable the database wipe');
      return;
    }
    if (!window.confirm('Wipe ALL portal data and reset the local database? This stops live runs and cannot be undone.')) return;
    setResetBusy(true);
    setResetMsg(null);
    try {
      const res = await api.resetData('RESET');
      setCfg(res.config);
      setNums(toNumForm(res.config));
      setSpend({ todayUsd: 0, activeRuns: 0, totalRunsToday: 0 });
      setResetConfirm('');
      setResetMsg(`database reset · cleared ${res.clearedRuns} run${res.clearedRuns !== 1 ? 's' : ''}`);
    } catch (e: any) {
      setResetMsg(`error: ${e?.message ?? 'reset failed'}`);
    } finally {
      setResetBusy(false);
    }
  }

  if (!cfg || !nums) return <div className="font-mono text-faint text-[12px]">loading config…</div>;

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
          <ErrorBanner className="!text-[11px] mx-4 mt-4 px-4 py-3 leading-relaxed">
            <span className="font-display tracking-wide">DAILY CAP REACHED</span> — new launches are
            refused until tomorrow (or raise the cap below)
          </ErrorBanner>
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
                value={nums.maxConcurrentRuns}
                onChange={(e) => {
                  setNums({ ...nums, maxConcurrentRuns: e.target.value });
                  setSaved(false);
                }}
              />
            </Field>
            <Field label="default budget ceiling" hint="USD / run">
              <Input
                type="number"
                step="0.5"
                value={nums.defaultBudgetUsd}
                onChange={(e) => {
                  setNums({ ...nums, defaultBudgetUsd: e.target.value });
                  setSaved(false);
                }}
              />
            </Field>
            <Field label="ultracode budget ceiling" hint="tighter default">
              <Input
                type="number"
                step="0.5"
                value={nums.ultracodeBudgetUsd}
                onChange={(e) => {
                  setNums({ ...nums, ultracodeBudgetUsd: e.target.value });
                  setSaved(false);
                }}
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
            {saved && <span className="font-mono text-[11px] text-sig-completed">✓ saved</span>}
            {cfgErr && <ErrorBanner>{cfgErr}</ErrorBanner>}
          </div>
        </div>
      </Panel>

      {/* ── 3. Danger zone ─────────────────────────────────────────────────── */}
      <Panel className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-sig-failed/40 bg-sig-failed/[0.06]">
          <span className="kicker text-sig-failed">danger zone</span>
        </div>
        <div className="p-4">
          <p className="font-mono text-[11px] text-dim leading-relaxed mb-4">
            Kill every live run immediately. Use this as a panic button — all running work is terminated
            and cannot be recovered. Individual runs can be stopped from the Fleet page.
          </p>
          <div className="flex items-center gap-3">
            <Btn variant="danger" onClick={stopAll} disabled={stopBusy}>
              {stopBusy ? 'stopping…' : `⏻ STOP ALL RUNS${activeCount > 0 ? ` (${activeCount})` : ''}`}
            </Btn>
            {stopMsg && (
              <span className={`font-mono text-[11px] ${stopMsg.startsWith('error') ? 'text-sig-failed' : 'text-sig-completed'}`}>
                {stopMsg}
              </span>
            )}
          </div>

          <div className="mt-5 pt-5 border-t hairline">
            <p className="font-mono text-[11px] text-dim leading-relaxed mb-3">
              Reset the local database: runs, events, projects, Kanban cards, schedules, campaigns,
              notifications, packs, add-on config and saved filters are deleted. Built-in templates and
              default guardrails are restored.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <Input
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                placeholder="type RESET"
                className="max-w-[180px]"
              />
              <Btn variant="danger" onClick={resetData} disabled={resetBusy || resetConfirm !== 'RESET'}>
                {resetBusy ? 'resetting…' : 'Reset Database'}
              </Btn>
              {resetMsg && (
                <span className={`font-mono text-[11px] ${resetMsg.startsWith('error') || resetMsg.startsWith('type') ? 'text-sig-failed' : 'text-sig-completed'}`}>
                  {resetMsg}
                </span>
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
