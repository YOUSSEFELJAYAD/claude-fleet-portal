'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { Project, Run } from '@fleet/shared';
import { statusMeta } from '@/lib/status';
import { usd, clock } from '@/lib/format';
import { Panel, Kicker, Stat, Gauge, Empty, Dot } from '@/components/ui';
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

function Tab({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="font-display uppercase tracking-wider text-[11px] px-4 py-2 border border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5 inline-flex items-center transition-all"
    >
      {label}
    </Link>
  );
}

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
        <div
          className="mt-8 border px-3 py-2"
          style={{ color: '#ff5d5d', borderColor: '#ff5d5d30', background: 'rgba(255,93,93,0.05)' }}
        >
          {error || 'project not found'} ·{' '}
          <button onClick={reload} className="underline">
            retry
          </button>
        </div>
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
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: '#ff7a45', borderColor: '#ff7a4550' }}>
                paused
              </span>
            )}
            {p.autoMerge && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: '#ff5d5d', borderColor: '#ff5d5d50' }}>
                full-auto merge
              </span>
            )}
          </div>
          <div className="font-mono text-[11px] text-faint mt-1.5 truncate">{p.rootDir}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setPlanning(true)}
            className="font-display uppercase tracking-wider text-[11px] px-4 py-2 border border-amber/50 text-amber hover:bg-amber/10 inline-flex items-center transition-all"
          >
            ✦ Plan board
          </button>
          <Tab href={`/projects/${p.id}/board`} label="Board" />
          <Tab href={`/projects/${p.id}/files`} label="Files" />
          <Tab href={`/projects/${p.id}/history`} label="History" />
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
          <div className="font-mono text-[12px] mt-1.5" style={{ color: p.defaultValidationCommand ? '#e9e7df' : '#5b626d' }}>
            {p.defaultValidationCommand || 'none — cards must set their own validation command'}
          </div>
        </div>
        <div className="mt-4">
          <Link
            href="/projects"
            className="font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5 inline-flex items-center"
          >
            ⚙ Edit settings
          </Link>
        </div>
      </Panel>

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
