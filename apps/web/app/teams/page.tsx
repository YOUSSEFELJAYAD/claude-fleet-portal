'use client';
import React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/live';
import { ago } from '@/lib/format';
import { Panel, Kicker, Empty } from '@/components/ui';

export default function TeamsPage() {
  const { data: teams, loading } = useAsync(() => api.teams(), []);

  return (
    <div>
      <Kicker>agent teams</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Coordination</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Shared task lists watched from <span className="text-dim">~/.claude/tasks/</span> — task ownership, dependencies, peer messages.
      </p>

      {loading ? (
        <div className="font-mono text-faint text-[12px]">scanning task directories…</div>
      ) : !teams || teams.length === 0 ? (
        <Empty>No team task-lists found in ~/.claude/tasks/</Empty>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {teams.map((t, i) => (
            <Link key={t.id} href={`/teams/${t.id}`} className="block animate-riseIn" style={{ animationDelay: `${i * 40}ms` }}>
              <Panel ticked className="p-4 hover:border-amber/40 transition-colors group">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-amber">⧉</span>
                  <span className="font-mono text-[10px] text-faint">{ago(t.updatedAt)}</span>
                </div>
                <div className="font-mono text-[13px] text-ink mt-2 group-hover:text-ink">{t.name}</div>
                <div className="font-mono text-[10px] text-faint mt-0.5 truncate">{t.id}</div>
                <div className="mt-3 font-mono text-[11px] text-dim">
                  <span className="text-amber tnum">{t.taskCount}</span> task{t.taskCount === 1 ? '' : 's'}
                </div>
              </Panel>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
