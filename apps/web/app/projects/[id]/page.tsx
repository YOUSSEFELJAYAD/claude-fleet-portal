'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { TriggerView, CreateTriggerRequest } from '@/lib/api';
import type { Project, Run, AgentTemplate } from '@fleet/shared';
import { statusMeta } from '@/lib/status';
import { usd, clock } from '@/lib/format';
import { Panel, Kicker, Stat, Gauge, Empty, Dot, Btn, Input, Select, ErrorBanner } from '@/components/ui';
import { ProjectTabs } from '@/components/ProjectTabs';
import { PlanModal } from '@/components/PlanModal';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

async function getProject(id: string): Promise<Project> {
  const r = await fetch(`${API}/api/projects/${id}`, { headers: { 'content-type': 'application/json' } });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<Project>;
}


// ── Triggers Panel ─────────────────────────────────────────────────────────────

interface TriggersPanelProps {
  projectId: string;
  // Note: the Project type carries no owner/repo slug (only rootDir + remoteName),
  // so the repo input starts empty — the user fills it in (finding #6).
}

function TriggersPanel({ projectId }: TriggersPanelProps) {
  const projectRepo: string | null = null; // no slug available client-side
  const [triggers, setTriggers] = useState<TriggerView[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [tErr, setTErr] = useState<string | null>(null);
  const aliveRef = useRef(true);

  // Add-form state
  const [addKind, setAddKind] = useState<'issue-label' | 'pr-opened'>('issue-label');
  const [addRepo, setAddRepo] = useState(projectRepo ?? '');
  const [addLabel, setAddLabel] = useState('');
  const [addAction, setAddAction] = useState<'card' | 'run'>('card');
  const [addTemplate, setAddTemplate] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function loadTriggers() {
    if (!aliveRef.current) return;
    api.listTriggers()
      .then((ts) => { if (aliveRef.current) setTriggers(ts.filter((t) => t.projectId === projectId)); })
      .catch(() => { /* silently ignore — polling */ });
  }

  useEffect(() => {
    aliveRef.current = true;
    loadTriggers();
    api.templates()
      .then((ts) => { if (aliveRef.current) setTemplates(ts); })
      .catch(() => {});

    function schedule() {
      if (!aliveRef.current) return;
      const t = setTimeout(() => {
        loadTriggers();
        schedule();
      }, 8000);
      return t;
    }
    const t = setTimeout(() => {
      loadTriggers();
      schedule();
    }, 8000);
    return () => {
      aliveRef.current = false;
      clearTimeout(t);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleAdd() {
    setAddErr(null);
    const body: CreateTriggerRequest = {
      repo: addRepo.trim(),
      kind: addKind,
      config: addKind === 'issue-label' ? { label: addLabel.trim() } : {},
      action: addAction,
      project_id: projectId,
      template: addAction === 'run' && addTemplate ? addTemplate : null,
      enabled: true,
    };
    setAdding(true);
    try {
      await api.createTrigger(body);
      loadTriggers();
      setAddLabel('');
      setAddRepo(projectRepo ?? '');
    } catch (e: any) {
      setAddErr(e?.message ?? 'failed to create trigger');
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(t: TriggerView) {
    try {
      await api.updateTrigger(t.id, { enabled: !t.enabled });
      loadTriggers();
    } catch (e: any) {
      setTErr(e?.message ?? 'update failed');
    }
  }

  async function handleDelete(t: TriggerView) {
    try {
      await api.deleteTrigger(t.id);
      setTriggers((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e: any) {
      setTErr(e?.message ?? 'delete failed');
    }
  }

  async function handlePoll(t: TriggerView) {
    try {
      const updated = await api.pollTrigger(t.id);
      setTriggers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e: any) {
      setTErr(e?.message ?? 'poll failed');
    }
  }

  return (
    <Panel className="overflow-hidden mb-5">
      {/* header row */}
      <div className="px-4 py-3 border-b hairline flex items-center justify-between">
        <Kicker>github triggers</Kicker>
        <span className="font-mono text-[10px] text-faint">auto-create cards or runs from issues / PRs</span>
      </div>
      <div className="p-4">
        {tErr && (
          <ErrorBanner className="mb-3">
            {tErr}{' '}
            <button onClick={() => setTErr(null)} className="underline ml-1 hover:text-ink">dismiss</button>
          </ErrorBanner>
        )}

        {/* trigger list */}
        {triggers.length > 0 && (
          <div className="mb-4 divide-y divide-white/[0.04] border border-line2">
            {triggers.map((t) => (
              <div key={t.id} className="px-3 py-2 flex items-center gap-3 text-[11px]">
                <span className="font-mono text-faint w-[80px] shrink-0">{t.kind}</span>
                <span className="font-mono text-dim truncate flex-1">{t.repo}</span>
                {t.kind === 'issue-label' && (
                  <span className="font-mono text-faint shrink-0">
                    label: <span className="text-amber">{String(t.config.label ?? '')}</span>
                  </span>
                )}
                <span className="font-mono text-faint shrink-0">
                  &rarr; <span className="text-ink">{t.action}</span>
                </span>
                {t.lastError && (
                  <span className="font-mono text-sig-failed shrink-0 max-w-[200px] truncate" title={t.lastError}>
                    ! {t.lastError}
                  </span>
                )}
                {/* enabled toggle */}
                <button
                  onClick={() => handleToggle(t)}
                  className={`shrink-0 font-mono text-[10px] px-1.5 py-0.5 border transition-colors ${
                    t.enabled ? 'text-sig-completed border-sig-completed/25' : 'text-faint border-faint/25'
                  }`}
                >
                  {t.enabled ? 'on' : 'off'}
                </button>
                {/* poll now */}
                <Btn variant="ghost" onClick={() => handlePoll(t)} className="shrink-0 !px-2 !py-0.5 !text-[10px]">
                  poll
                </Btn>
                {/* delete */}
                <button
                  onClick={() => handleDelete(t)}
                  className="shrink-0 font-mono text-[12px] text-faint hover:text-sig-failed transition-colors"
                  title="remove trigger"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {triggers.length === 0 && (
          <p className="font-mono text-[11px] text-faint mb-4">no triggers yet — add one below</p>
        )}

        {/* add form */}
        <div className="flex flex-wrap gap-2 items-end">
          {/* kind */}
          <div className="flex flex-col gap-1 w-[120px]">
            <Kicker>kind</Kicker>
            <Select
              value={addKind}
              onChange={(e) => setAddKind(e.target.value as 'issue-label' | 'pr-opened')}
              className="!text-[11px] !py-1"
            >
              <option value="issue-label">issue-label</option>
              <option value="pr-opened">pr-opened</option>
            </Select>
          </div>

          {/* repo */}
          <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
            <Kicker>repo (owner/name)</Kicker>
            <Input
              value={addRepo}
              onChange={(e) => setAddRepo(e.target.value)}
              placeholder="owner/name"
              className="!text-[11px] !py-1"
            />
          </div>

          {/* label (only for issue-label) */}
          {addKind === 'issue-label' && (
            <div className="flex flex-col gap-1 w-[120px]">
              <Kicker>label</Kicker>
              <Input
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                placeholder="e.g. agent"
                className="!text-[11px] !py-1"
              />
            </div>
          )}

          {/* action */}
          <div className="flex flex-col gap-1 w-[100px]">
            <Kicker>action</Kicker>
            <Select
              value={addAction}
              onChange={(e) => setAddAction(e.target.value as 'card' | 'run')}
              className="!text-[11px] !py-1"
            >
              <option value="card">card</option>
              <option value="run">run</option>
            </Select>
          </div>

          {/* template (only for run) */}
          {addAction === 'run' && (
            <div className="flex flex-col gap-1 w-[140px]">
              <Kicker>template</Kicker>
              <Select
                value={addTemplate}
                onChange={(e) => setAddTemplate(e.target.value)}
                className="!text-[11px] !py-1"
              >
                <option value="">none</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.name}>{tpl.name}</option>
                ))}
              </Select>
            </div>
          )}

          <Btn variant="amber" onClick={handleAdd} disabled={adding} className="self-end">
            {adding ? 'adding…' : '+ add'}
          </Btn>
        </div>

        {addErr && <ErrorBanner className="mt-2">{addErr}</ErrorBanner>}
      </div>
    </Panel>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ProjectHub({ params }: { params: { id: string } }) {
  const { id } = params;
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [spend, setSpend] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  function reload() {
    setLoading(true);
    setError(null);
    Promise.all([getProject(id), api.listRuns(), api.fleetStatus()])
      .then(([p, allRuns, fleet]) => {
        setProject(p);
        setRuns(allRuns.filter((r) => r.projectId === id));
        // server-side SUM over every run scoped to this project — the /api/agents list is capped at 500.
        setSpend(fleet.projects.find((fp) => fp.projectId === id)?.projectSpend ?? 0);
      })
      .catch((e) => setError(e.message || 'failed to load project'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) {
    return (
      <div className="font-mono text-faint text-[13px]">
        <Link href="/projects" className="text-amber">
          ← projects
        </Link>
        <div className="mt-8">loading project…</div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="font-mono text-[13px]">
        <Link href="/projects" className="text-amber">
          ← projects
        </Link>
        <ErrorBanner className="mt-8" onRetry={reload}>
          {error || 'project not found'}
        </ErrorBanner>
      </div>
    );
  }

  const p = project;
  const liveRuns = runs.filter((r) => statusMeta(r.status).live);

  return (
    <div>
      <Link href="/projects" className="font-display text-[11px] uppercase tracking-wider text-faint hover:text-amber">
        ← projects
      </Link>

      <div className="flex items-start justify-between gap-6 mt-3 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Dot color={p.paused ? '#ff7a45' : '#54e08a'} live={!p.paused && liveRuns.length > 0} size={7} />
            <h1 className="font-display text-[22px] tracking-wide text-ink">{p.name}</h1>
            {p.paused && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border text-sig-killed border-sig-killed/50">
                paused
              </span>
            )}
            {p.autoMerge && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border text-sig-failed border-sig-failed/50">
                full-auto merge
              </span>
            )}
          </div>
          <div className="font-mono text-[11px] text-faint mt-1.5 truncate">{p.rootDir}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Btn variant="amber" onClick={() => setPlanning(true)} className="!px-4 !py-2">
            ✦ Plan board
          </Btn>
          <ProjectTabs id={p.id} active="hub" />
        </div>
      </div>

      {/* spend gauge + headline stats */}
      <Panel className="p-5 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr_1fr] gap-6 items-center">
          <div>
            <Gauge value={spend} cap={p.budgetCeilingUsd} label="project spend · cumulative" />
            <div className="mt-2 font-mono tnum text-[18px] text-ink">
              {usd(spend)}
              {p.budgetCeilingUsd != null && <span className="text-faint text-[12px]"> / {usd(p.budgetCeilingUsd)}</span>}
            </div>
          </div>
          <Stat label="recent runs" value={runs.length} />
          <Stat label="live runs" value={liveRuns.length} accent={liveRuns.length ? '#ffb000' : undefined} />
          <Stat label="wip limit" value={p.wipLimit} />
        </div>
      </Panel>

      {/* settings summary */}
      <Panel className="p-5 mb-5">
        <Kicker>executor policy</Kicker>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mt-3">
          <Stat label="default branch" value={p.defaultBranch} />
          <Stat
            label="merge gate"
            value={p.autoMerge ? 'full-auto' : 'human approve'}
            accent={p.autoMerge ? '#ff5d5d' : '#54e08a'}
          />
          <Stat label="budget ceiling" value={p.budgetCeilingUsd != null ? usd(p.budgetCeilingUsd) : 'unbounded'} />
          <Stat label="status" value={p.paused ? 'paused' : 'active'} accent={p.paused ? '#ff7a45' : '#54e08a'} />
        </div>
        <div className="mt-4 pt-4 border-t hairline">
          <Kicker>default validation command</Kicker>
          <div className={`font-mono text-[12px] mt-1.5 ${p.defaultValidationCommand ? 'text-ink' : 'text-faint'}`}>
            {p.defaultValidationCommand || 'none — cards must set their own validation command'}
          </div>
        </div>
        <div className="mt-4">
          <Link
            href="/projects"
            className="font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5 inline-flex items-center"
          >
            ⚙ Manage projects
          </Link>
        </div>
      </Panel>

      {/* F1 — GitHub triggers panel */}
      <TriggersPanel projectId={id} />

      {/* scoped runs */}
      <div className="mb-3 flex items-baseline justify-between">
        <Kicker>project runs</Kicker>
        <span className="font-mono text-[10px] text-faint">most recent runs · spend aggregated across all runs</span>
      </div>
      {runs.length === 0 ? (
        <Empty>No runs scoped to this project yet. The PM spawns build runs as it picks up Ready cards.</Empty>
      ) : (
        <Panel className="overflow-hidden">
          <div className="grid grid-cols-[120px_1fr_90px_120px] gap-3 px-4 py-2.5 border-b hairline kicker">
            <span>status</span>
            <span>task</span>
            <span className="text-right">cost</span>
            <span className="text-right">started</span>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {runs.map((r) => {
              const m = statusMeta(r.status);
              return (
                <Link
                  key={r.id}
                  href={`/runs/${r.id}`}
                  className="grid grid-cols-[120px_1fr_90px_120px] gap-3 px-4 py-2.5 items-center hover:bg-amber/[0.04] transition-colors"
                >
                  <span className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: m.color }}>
                    <Dot color={m.color} live={m.live} size={6} />
                    {m.label}
                  </span>
                  <span className="text-ink text-[12px] truncate">{r.task}</span>
                  <span className="text-right font-mono tnum text-[11px] text-dim">{usd(r.costUsd)}</span>
                  <span className="text-right font-mono text-[10px] text-faint">{clock(r.startedAt)}</span>
                </Link>
              );
            })}
          </div>
        </Panel>
      )}

      {planning && <PlanModal projectId={id} onClose={() => setPlanning(false)} onApplied={reload} />}
    </div>
  );
}
