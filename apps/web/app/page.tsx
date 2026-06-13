'use client';
import React, { useEffect, useState } from 'react';
import { useFleet } from '@/lib/live';
import { api } from '@/lib/api';
import { RunCard } from '@/components/RunCard';
import { Kicker, Empty, ErrorBanner } from '@/components/ui';
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
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>fleet overview</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">
            Mission Control
          </h1>
        </div>
        <div className="text-right font-mono text-[11px] text-faint">
          <div>
            <span className="text-amber tnum">{liveCount}</span> live ·{' '}
            <span className="text-ink tnum">{visibleRuns.length}</span> active history
            {archivedRuns.length > 0 && filter === 'archived' && (
              <> · <span className="text-faint tnum">{archivedRuns.length}</span> archived</>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className="font-display text-[11px] uppercase tracking-wider px-3 py-1.5 border transition-colors"
              style={{
                borderColor: filter === f.key ? '#ffb000' : 'rgba(255,255,255,0.075)',
                color: filter === f.key ? '#ffb000' : '#9aa1ab',
                background: filter === f.key ? 'rgba(255,176,0,0.08)' : 'transparent',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter runs…"
          className="w-[240px] bg-black/40 border border-line2 text-ink font-mono text-[12px] px-3 py-1.5 focus:border-amber/60 outline-none placeholder:text-faint"
        />
      </div>

      {archivedErr && (
        <ErrorBanner className="mb-4">{archivedErr}</ErrorBanner>
      )}

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

      <div className="mt-8 text-faint font-mono text-[10px] flex gap-4 flex-wrap">
        {RUN_STATUSES.map((s) => (
          <span key={s} className="opacity-60">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
