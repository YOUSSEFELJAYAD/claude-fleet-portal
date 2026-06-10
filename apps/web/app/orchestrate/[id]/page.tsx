'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useCampaign } from '@/lib/live';
import { api } from '@/lib/api';
import type { CampaignTask } from '@fleet/shared';
import { campaignStatusColor, taskStatusColor } from '@/lib/status';
import { usd } from '@/lib/format';
import { Panel, Kicker, Btn, Stat, Dot } from '@/components/ui';

function RunLink({ runId, children }: { runId: string | null; children: React.ReactNode }) {
  if (!runId) return <span className="text-faint">{children}</span>;
  return <Link href={`/runs/${runId}`} className="hover:text-amber">{children}</Link>;
}

function TaskCard({ task }: { task: CampaignTask }) {
  const color = taskStatusColor(task.status);
  const live = task.status === 'running';
  return (
    <Panel className="p-3 w-[230px]" style={{ borderLeft: `2px solid ${color}` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Dot color={color} live={live} size={6} />
          <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color }}>{task.status}</span>
        </div>
        <span className="font-mono text-[9px] text-faint">#{task.id}</span>
      </div>
      <div className="text-ink text-[12px] mt-1.5 leading-snug min-h-[32px]">{task.title}</div>
      <div className="mt-2 flex items-center justify-between">
        <span className="font-mono text-[9px] text-amber border border-amber/30 px-1.5 py-0.5">{task.template}</span>
        <RunLink runId={task.runId}><span className="font-mono text-[10px]">{task.runId ? 'open run →' : 'queued'}</span></RunLink>
      </div>
      {task.dependsOn.length > 0 && (
        <div className="mt-1.5 font-mono text-[9px] text-faint">⊣ after {task.dependsOn.map((d) => '#' + d).join(', ')}</div>
      )}
    </Panel>
  );
}

/** group tasks into dependency "waves" (topological level) for a left→right DAG view */
function waves(tasks: CampaignTask[]): CampaignTask[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const calc = (t: CampaignTask, seen = new Set<string>()): number => {
    if (level.has(t.id)) return level.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const l = t.dependsOn.length === 0 ? 0 : 1 + Math.max(...t.dependsOn.map((d) => (byId.get(d) ? calc(byId.get(d)!, seen) : 0)));
    level.set(t.id, l);
    return l;
  };
  tasks.forEach((t) => calc(t));
  const max = Math.max(0, ...[...level.values()]);
  const out: CampaignTask[][] = Array.from({ length: max + 1 }, () => []);
  tasks.forEach((t) => out[level.get(t.id) ?? 0].push(t));
  return out;
}

const NodeChip = ({ label, runId, color, sub }: { label: string; runId: string | null; color: string; sub?: string }) => (
  <Panel className="p-3 w-[230px]" style={{ borderLeft: `2px solid ${color}` }}>
    <div className="flex items-center gap-1.5">
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block' }} />
      <span className="font-display text-[11px] uppercase tracking-wide" style={{ color }}>{label}</span>
    </div>
    {sub && <div className="text-dim text-[11px] mt-1.5">{sub}</div>}
    <div className="mt-2"><RunLink runId={runId}><span className="font-mono text-[10px]">{runId ? 'open run →' : '—'}</span></RunLink></div>
  </Panel>
);

export default function CampaignDetail({ params }: { params: { id: string } }) {
  const { id } = params;
  const { campaign: c, connected } = useCampaign(id);
  const [killErr, setKillErr] = useState<string | null>(null);

  if (!c) {
    return (
      <div className="font-mono text-faint text-[13px]">
        <Link href="/orchestrate" className="text-amber">← campaigns</Link>
        <div className="mt-8">{connected ? 'loading campaign…' : 'connecting…'}</div>
      </div>
    );
  }

  const color = campaignStatusColor(c.status);
  const tasks = c.tasks ?? [];
  const w = waves(tasks);
  const live = ['planning', 'spawning', 'running', 'synthesizing'].includes(c.status);
  const done = c.doneCount ?? tasks.filter((t) => ['completed', 'failed', 'skipped'].includes(t.status)).length;

  return (
    <div>
      <Link href="/orchestrate" className="font-display text-[11px] uppercase tracking-wider text-faint hover:text-amber">← campaigns</Link>

      <div className="flex items-start justify-between gap-6 mt-3 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="font-display text-[11px] uppercase tracking-wider px-2 py-0.5 border" style={{ color, borderColor: color + '50', background: color + '12' }}>
              <Dot color={color} live={live} size={6} /> {c.status}
            </span>
            {connected && live && <span className="font-mono text-[9px] text-sig-running animate-pulseGlow" style={{ color: '#39d4cf' }}>● LIVE</span>}
          </div>
          <h1 className="text-ink text-[17px] mt-2 leading-snug max-w-3xl">{c.objective}</h1>
          <div className="font-mono text-[11px] text-faint mt-1">{c.cwd} · maxParallel {c.maxParallel}</div>
        </div>
        {live && (
          <div className="flex flex-col items-end gap-1">
            <Btn
              variant="danger"
              onClick={() =>
                api.killCampaign(id).then(
                  () => setKillErr(null),
                  // 404 = already gone; SSE will reflect the terminal state
                  (e: any) => setKillErr(e?.status === 404 ? null : e?.message || 'failed to kill campaign'),
                )
              }
            >
              ■ Kill Campaign
            </Btn>
            {killErr && <span className="font-mono text-[10px]" style={{ color: '#ff5d5d' }}>{killErr}</span>}
          </div>
        )}
      </div>

      <Panel className="p-4 mb-5 grid grid-cols-2 md:grid-cols-4 gap-5">
        <Stat label="cost" value={usd(c.costUsd)} accent="#ffb000" />
        <Stat label="tasks done" value={`${done}/${c.taskCount ?? tasks.length}`} />
        <Stat label="live workers" value={c.liveWorkers ?? 0} accent={c.liveWorkers ? '#ffb000' : undefined} />
        <Stat label="synthesize" value={c.autoSynthesize ? 'on' : 'off'} />
      </Panel>

      {/* DAG: orchestrator → waves → synthesizer */}
      <div className="overflow-x-auto pb-4">
        <div className="flex items-start gap-8 min-w-max">
          <div>
            <Kicker>orchestrator</Kicker>
            <div className="mt-2"><NodeChip label="Orchestrator" runId={c.orchestratorRunId} color="#b08cff" sub={c.orchestratorTemplate} /></div>
          </div>

          {tasks.length === 0 ? (
            <div className="self-center font-mono text-[12px] text-faint pt-6">
              {c.status === 'planning' ? 'orchestrator is decomposing the objective…' : 'no tasks'}
            </div>
          ) : (
            w.map((wave, i) => (
              <div key={i}>
                <Kicker>wave {i + 1}</Kicker>
                <div className="mt-2 space-y-3">
                  {wave.map((t) => <TaskCard key={t.id} task={t} />)}
                </div>
              </div>
            ))
          )}

          {c.autoSynthesize && (
            <div>
              <Kicker>synthesizer</Kicker>
              <div className="mt-2"><NodeChip label="Synthesizer" runId={c.synthesizerRunId} color="#ffb000" sub={c.synthesizerTemplate ?? ''} /></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
