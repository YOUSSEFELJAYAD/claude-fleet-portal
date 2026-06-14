'use client';
import React, { useEffect, useState } from 'react';
import { useFleet } from '@/lib/live';
import { api } from '@/lib/api';
import { RunCard } from '@/components/RunCard';
import { Kicker, Empty, ErrorBanner, Panel, Dot, Tab, Input } from '@/components/ui';
import { RUN_STATUSES, LIVE_STATUSES } from '@fleet/shared';

type FilterKey = 'all' | 'live' | 'completed' | 'failed' | 'killed' | 'archived';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'completed', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'killed', label: 'Killed' },
  { key: 'archived', label: 'Archived' },
];

export default function FleetDashboard() {
  const { runs } = useFleet();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [q, setQ] = useState('');
  const [archivedRuns, setArchivedRuns] = useState<typeof runs>([]);
  const [archivedErr, setArchivedErr] = useState<string | null>(null);

  const visibleRuns = runs.filter((r) => !r.archivedAt);

  function reloadArchived() {
    api.listRuns({ archived: 'only' })
      .then((items) => {
        setArchivedRuns(items);
        setArchivedErr(null);
      })
      .catch((e) => setArchivedErr(e?.message ?? 'failed to load archived runs'));
  }

  useEffect(() => {
    if (filter === 'archived') reloadArchived();
  }, [filter]);

  const sourceRuns = filter === 'archived' ? archivedRuns : visibleRuns;
  const filtered = sourceRuns.filter((r) => {
    if (q && !(`${r.task} ${r.cwd}`.toLowerCase().includes(q.toLowerCase()))) return false;
    if (filter === 'all') return true;
    if (filter === 'live') return LIVE_STATUSES.includes(r.status);
    if (filter === 'archived') return !!r.archivedAt;
    return r.status === filter;
  });

  const liveCount = visibleRuns.filter((r) => LIVE_STATUSES.includes(r.status)).length;

  return (
    <div>
      <Kicker>fleet overview</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Mission Control</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Every run in your fleet, live — status, model, cost, tokens, subagent depth. Launch, monitor, steer, and approve.
      </p>

      {archivedErr && <ErrorBanner className="mb-5" onRetry={reloadArchived}>{archivedErr}</ErrorBanner>}

      <Panel ticked>
        <div className="flex items-center justify-between gap-4 px-4 py-3 border-b hairline flex-wrap">
          <span className="flex items-center gap-2">
            <Dot color="#ffb000" live={liveCount > 0} size={6} />
            <Kicker>runs</Kicker>
            <span className="font-mono tnum text-[12px] text-amber ml-1">{String(filtered.length).padStart(2, '0')}</span>
            <span className="font-mono text-[10px] text-faint ml-1">
              {liveCount} live · {visibleRuns.length} active history
            </span>
          </span>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-1">
              {FILTERS.map((f) => (
                <Tab key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </Tab>
              ))}
            </div>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter runs…" className="w-[200px] !py-1" />
          </div>
        </div>
        <div className="p-4">
          {filtered.length === 0 ? (
            <Empty>
              {filter === 'archived'
                ? 'No archived runs.'
                : visibleRuns.length === 0
                ? 'No runs yet — hit ＋ Launch Agent to spawn your first claude -p process.'
                : 'No runs match this filter.'}
            </Empty>
          ) : (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
              {filtered.map((r, i) => (
                <RunCard key={r.id} run={r} index={i} onChanged={filter === 'archived' ? reloadArchived : undefined} />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <div className="mt-5 text-faint font-mono text-[10px] flex gap-4 flex-wrap">
        {RUN_STATUSES.map((s) => (
          <span key={s} className="opacity-60">{s}</span>
        ))}
      </div>
    </div>
  );
}
