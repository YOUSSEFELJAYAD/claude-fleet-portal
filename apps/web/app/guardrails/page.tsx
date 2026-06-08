'use client';
import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { PortalConfig, SpendSummary } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Select, Btn, Stat } from '@/components/ui';
import { usd } from '@/lib/format';

export default function GuardrailsPage() {
  const [cfg, setCfg] = useState<PortalConfig | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then(setCfg);
    api.spend().then(setSpend);
  }, []);

  function patch<K extends keyof PortalConfig>(k: K, v: PortalConfig[K]) {
    setCfg((c) => (c ? { ...c, [k]: v } : c));
    setSaved(false);
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    const next = await api.setConfig(cfg);
    setCfg(next);
    setBusy(false);
    setSaved(true);
  }

  if (!cfg) return <div className="font-mono text-faint text-[12px]">loading config…</div>;

  return (
    <div className="max-w-3xl">
      <Kicker>cost &amp; concurrency</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-5">Guardrails</h1>

      {/* spend summary */}
      <Panel className="p-4 mb-5 grid grid-cols-3 gap-5" ticked>
        <Stat label="spend today" value={usd(spend?.todayUsd ?? 0)} accent="#ffb000" />
        <Stat label="active runs" value={spend?.activeRuns ?? 0} />
        <Stat label="runs today" value={spend?.totalRunsToday ?? 0} />
      </Panel>

      <Panel className="p-6">
        <div className="grid grid-cols-2 gap-6">
          <Field label="max concurrent runs" hint="server-enforced">
            <Input type="number" min={1} value={cfg.maxConcurrentRuns} onChange={(e) => patch('maxConcurrentRuns', Number(e.target.value))} />
          </Field>
          <Field label="default budget ceiling" hint="USD / run">
            <Input type="number" step="0.5" value={cfg.defaultBudgetUsd} onChange={(e) => patch('defaultBudgetUsd', Number(e.target.value))} />
          </Field>
          <Field label="ultracode budget ceiling" hint="tighter default">
            <Input type="number" step="0.5" value={cfg.ultracodeBudgetUsd} onChange={(e) => patch('ultracodeBudgetUsd', Number(e.target.value))} />
          </Field>
          <Field label="default permission mode">
            <Select value={cfg.permissionDefault} onChange={(e) => patch('permissionDefault', e.target.value as PortalConfig['permissionDefault'])}>
              {['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
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
          {saved && <span className="font-mono text-[11px] text-sig-completed" style={{ color: '#54e08a' }}>✓ saved</span>}
        </div>
      </Panel>
    </div>
  );
}
