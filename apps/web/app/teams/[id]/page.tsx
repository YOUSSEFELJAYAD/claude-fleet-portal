'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { API } from '@/lib/api';
import type { TeamView, TeamTask } from '@fleet/shared';
import { Panel, Kicker, Empty } from '@/components/ui';
import { clock } from '@/lib/format';

const STATUS_COL: { key: string; label: string; color: string }[] = [
  { key: 'pending', label: 'Pending', color: '#7b828c' },
  { key: 'in_progress', label: 'In Progress', color: '#39d4cf' },
  { key: 'completed', label: 'Completed', color: '#54e08a' },
];

function TaskCard({ task }: { task: TeamTask }) {
  const col = STATUS_COL.find((c) => c.key === task.status) ?? STATUS_COL[0];
  return (
    <div className="panel p-3" style={{ borderLeft: `2px solid ${col.color}` }}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-faint">#{task.id}</span>
        {task.owner && <span className="font-mono text-[10px] text-amber">@{task.owner}</span>}
      </div>
      <div className="text-ink text-[12px] mt-1.5 leading-snug">{task.subject}</div>
      {(task.blockedBy.length > 0 || task.blocks.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[9.5px]">
          {task.blockedBy.map((b) => (
            <span key={'bb' + b} className="text-sig-failed border border-sig-failed/30 px-1" style={{ color: '#ff5d5d' }}>⊣ blocked by #{b}</span>
          ))}
          {task.blocks.map((b) => (
            <span key={'bl' + b} className="text-dim border border-line2 px-1">⊢ blocks #{b}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TeamDetail({ params }: { params: { id: string } }) {
  const { id } = params;
  const [view, setView] = useState<TeamView | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`${API}/api/teams/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.kind === 'team') setView(m.view);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [id]);

  return (
    <div>
      <Link href="/teams" className="font-display text-[11px] uppercase tracking-wider text-faint hover:text-amber">← teams</Link>
      <div className="flex items-center gap-3 mt-3 mb-1">
        <span style={{ color: '#ffb000' }}>⧉</span>
        <h1 className="font-display text-[22px] tracking-wide text-ink">{view?.name ?? id.slice(0, 8)}</h1>
        {connected && <span className="font-mono text-[9px] text-sig-completed animate-pulseGlow" style={{ color: '#54e08a' }}>● watching</span>}
      </div>
      <div className="font-mono text-[10px] text-faint mb-5 truncate">{view?.taskDir ?? id}</div>

      {!view ? (
        <div className="font-mono text-faint text-[12px]">loading task list…</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {STATUS_COL.map((col) => {
              const tasks = view.tasks.filter((t) => t.status === col.key);
              const others = col.key === 'pending' ? view.tasks.filter((t) => !STATUS_COL.some((c) => c.key === t.status)) : [];
              const all = [...tasks, ...others];
              return (
                <div key={col.key}>
                  <div className="flex items-center gap-2 mb-2.5">
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: col.color, display: 'inline-block' }} />
                    <Kicker>{col.label}</Kicker>
                    <span className="font-mono text-[10px] text-faint tnum">{all.length}</span>
                  </div>
                  <div className="space-y-2.5">
                    {all.length === 0 ? <div className="text-faint font-mono text-[11px] py-3">—</div> : all.map((t) => <TaskCard key={t.id} task={t} />)}
                  </div>
                </div>
              );
            })}
          </div>

          <Kicker>mailbox · peer messages</Kicker>
          <Panel className="mt-2 p-1">
            {view.messages.length === 0 ? (
              <div className="font-mono text-[11px] text-faint p-4">No peer-to-peer messages found for this team.</div>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {view.messages.map((msg, i) => (
                  <div key={i} className="flex gap-3 px-3 py-2 text-[12px]">
                    <span className="font-mono text-[10px] text-faint w-[58px] shrink-0">{clock(msg.ts)}</span>
                    <span className="font-mono text-[11px] text-amber shrink-0">{msg.from ?? '?'} →{msg.to ?? 'all'}</span>
                    <span className="text-dim min-w-0">{msg.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
