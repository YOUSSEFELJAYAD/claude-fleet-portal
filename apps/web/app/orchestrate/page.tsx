'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { AgentTemplate, Campaign } from '@fleet/shared';
import { campaignStatusColor } from '@/lib/status';
import { usd, ago } from '@/lib/format';
import { Panel, Kicker, Field, Input, Textarea, Select, Toggle, Btn, Empty, Dot } from '@/components/ui';

/** campaign states that are still consuming budget / spawning workers */
const LIVE_CAMPAIGN_STATUSES = ['planning', 'spawning', 'running', 'synthesizing'];

function CampaignRow({ c }: { c: Campaign }) {
  const color = campaignStatusColor(c.status);
  const done = c.doneCount ?? 0;
  const total = c.taskCount ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const live = LIVE_CAMPAIGN_STATUSES.includes(c.status);
  return (
    <Link href={`/orchestrate/${c.id}`} className="block">
      <Panel className="p-4 hover:border-amber/40 transition-colors group" style={{ boxShadow: `inset 2px 0 0 ${color}` }}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Dot color={color} live={live} />
            <span className="font-display text-[10px] uppercase tracking-wider" style={{ color }}>{c.status}</span>
          </div>
          <span className="font-mono text-[10px] text-faint">{ago(c.startedAt)}</span>
        </div>
        <div className="text-ink text-[13px] mt-2 leading-snug line-clamp-2 group-hover:text-ink">{c.objective}</div>
        <div className="mt-3 flex items-center justify-between font-mono text-[11px]">
          <span className="text-dim">{done}/{total} tasks{c.liveWorkers ? <span className="text-amber"> · {c.liveWorkers} live</span> : null}</span>
          <span className="text-amber tnum">{usd(c.costUsd)}</span>
        </div>
        <div className="h-1 w-full bg-white/5 mt-2 overflow-hidden">
          <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
        </div>
      </Panel>
    </Link>
  );
}

export default function OrchestratePage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const [objective, setObjective] = useState('');
  const [cwd, setCwd] = useState('/Users/jd');
  const [orchestrator, setOrchestrator] = useState('Orchestrator');
  const [worker, setWorker] = useState('Implementer');
  const [autoSynthesize, setAutoSynthesize] = useState(true);
  const [synthesizer, setSynthesizer] = useState('Synthesizer');
  const [maxParallel, setMaxParallel] = useState(3);
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => api.campaigns().then(setCampaigns).catch(() => {});
  useEffect(() => {
    api.templates().then(setTemplates).catch(() => {});
    reload();
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, []);

  const byRole = (r: string) => templates.filter((t) => t.role === r);
  const workerTemplates = templates.filter((t) => t.role === 'worker' || t.role === 'reviewer');

  async function launch() {
    if (!objective.trim()) {
      setErr('objective required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const c = await api.createCampaign({
        objective,
        cwd,
        orchestratorTemplate: orchestrator,
        workerTemplate: worker,
        synthesizerTemplate: autoSynthesize ? synthesizer : null,
        autoSynthesize,
        maxParallel,
        budgetPerWorkerUsd: budget.trim() ? Number(budget) : null,
      });
      router.push(`/orchestrate/${c.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div>
      <Kicker>orchestration mode</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Campaigns</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Give one orchestrator agent an objective — it decomposes the work and the portal auto-spawns a fleet of worker agents to execute it.
      </p>

      <div className="space-y-5">
        {/* ── block 1 · new campaign ─────────────────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>new campaign</Kicker>
          </div>
          <div className="p-5 space-y-4">
            <Field label="objective">
              <Textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Audit the payments module for bugs and ship fixes" autoFocus />
            </Field>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Field label="working directory"><Input value={cwd} onChange={(e) => setCwd(e.target.value)} /></Field>
              <Field label="max parallel workers" hint="≤16">
                <Input type="number" min={1} max={16} value={maxParallel} onChange={(e) => setMaxParallel(Number(e.target.value))} />
              </Field>
              <Field label="orchestrator template">
                <Select value={orchestrator} onChange={(e) => setOrchestrator(e.target.value)}>
                  {byRole('orchestrator').map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </Select>
              </Field>
              <Field label="default worker template">
                <Select value={worker} onChange={(e) => setWorker(e.target.value)}>
                  {workerTemplates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </Select>
              </Field>
              <Field label="budget / worker" hint="blank = template default"><Input type="number" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="template default" /></Field>
              <div>
                <Kicker>auto-synthesize</Kicker>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle on={autoSynthesize} onChange={setAutoSynthesize} label={autoSynthesize ? 'on' : 'off'} />
                  {autoSynthesize && (
                    <Select value={synthesizer} onChange={(e) => setSynthesizer(e.target.value)} className="!py-1 text-[11px]">
                      {byRole('synthesizer').map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                    </Select>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Btn variant="solid" onClick={launch} disabled={busy}>{busy ? 'Launching…' : '⛓ Orchestrate'}</Btn>
              {err && <span className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{err}</span>}
            </div>
          </div>
        </Panel>

        {(() => {
          const liveCampaigns = campaigns.filter((c) => LIVE_CAMPAIGN_STATUSES.includes(c.status));
          const doneCampaigns = campaigns.filter((c) => !LIVE_CAMPAIGN_STATUSES.includes(c.status));
          return (
            <>
              {/* ── block 2 · live now ─────────────────────────────────────────── */}
              <Panel ticked>
                <div className="flex items-center justify-between px-4 py-3 border-b hairline">
                  <span className="flex items-center gap-2">
                    <Dot color="#ffb000" live={liveCampaigns.length > 0} size={6} />
                    <Kicker>live now</Kicker>
                  </span>
                  <span className="font-mono tnum text-[12px] text-amber">{String(liveCampaigns.length).padStart(2, '0')}</span>
                </div>
                <div className="p-4">
                  {liveCampaigns.length === 0 ? (
                    <div className="font-mono text-[11px] text-faint">nothing running — launch a campaign above</div>
                  ) : (
                    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {liveCampaigns.map((c) => <CampaignRow key={c.id} c={c} />)}
                    </div>
                  )}
                </div>
              </Panel>

              {/* ── block 3 · finished ─────────────────────────────────────────── */}
              <Panel>
                <div className="flex items-center justify-between px-4 py-3 border-b hairline">
                  <Kicker>finished</Kicker>
                  <span className="font-mono tnum text-[12px] text-dim">{String(doneCampaigns.length).padStart(2, '0')}</span>
                </div>
                <div className="p-4 overflow-auto" style={{ maxHeight: '60vh' }}>
                  {doneCampaigns.length === 0 ? (
                    <Empty>No finished campaigns yet.</Empty>
                  ) : (
                    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {doneCampaigns.map((c) => <CampaignRow key={c.id} c={c} />)}
                    </div>
                  )}
                </div>
              </Panel>
            </>
          );
        })()}
      </div>
    </div>
  );
}
