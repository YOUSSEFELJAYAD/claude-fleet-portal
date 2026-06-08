'use client';
import React from 'react';
import Link from 'next/link';
import type { Run } from '@fleet/shared';
import { statusMeta } from '@/lib/status';
import { usd, tokens, ago, dur } from '@/lib/format';
import { api } from '@/lib/api';
import { StatusBadge, Gauge } from './ui';

export function RunCard({ run, index = 0 }: { run: Run; index?: number }) {
  const m = statusMeta(run.status);
  const elapsed = (run.endedAt ?? Date.now()) - run.startedAt;
  return (
    <Link href={`/runs/${run.id}`} className="block group animate-riseIn" style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}>
      <div
        className="panel relative overflow-hidden transition-all duration-200 group-hover:border-amber/40"
        style={{ boxShadow: m.live ? `inset 2px 0 0 ${m.color}` : `inset 2px 0 0 ${m.color}90` }}
      >
        {/* live sweep shimmer */}
        {m.live && (
          <div className="absolute top-0 left-0 right-0 h-px overflow-hidden">
            <div className="h-full w-1/3 animate-sweep" style={{ background: `linear-gradient(90deg, transparent, ${m.color}, transparent)` }} />
          </div>
        )}
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <StatusBadge status={run.status} />
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-faint">{ago(run.lastActivity)}</span>
              {!m.live && (
                <button
                  title="delete run"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!confirm('Delete this run from history? This cannot be undone.')) return;
                    api.deleteRun(run.id).catch(() => {});
                  }}
                  className="opacity-0 group-hover:opacity-100 text-faint hover:text-sig-failed font-mono text-[12px] transition-opacity leading-none"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 text-ink text-[13px] leading-snug line-clamp-2 min-h-[34px] group-hover:text-white">
            {run.task}
          </div>

          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[10px] text-dim border border-line px-1.5 py-0.5">{run.model.replace('claude-', '')}</span>
            <span className="font-display text-[10px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: run.ultracode ? '#ff5d5d' : '#9aa1ab', borderColor: run.ultracode ? '#ff5d5d40' : 'rgba(255,255,255,0.075)' }}>
              {run.ultracode ? '⚡ultracode' : run.effort}
            </span>
            {run.subagentCount > 0 && (
              <span className="font-mono text-[10px] text-amber border border-amber/30 px-1.5 py-0.5">
                ⧉ {run.subagentCount} · d{run.maxDepth}
              </span>
            )}
            {run.liveSubagents > 0 && (
              <span className="font-mono text-[10px] text-sig-orchestrating animate-pulseGlow" style={{ color: '#ffb000' }}>
                {run.liveSubagents} live
              </span>
            )}
          </div>

          <div className="mt-3.5">
            <Gauge value={run.costUsd} cap={run.budgetUsd} />
            <div className="mt-2 grid grid-cols-3 gap-2 font-mono tnum text-[11px]">
              <div>
                <span className="text-faint">cost </span>
                <span style={{ color: run.budgetUsd && run.costUsd / run.budgetUsd >= 0.8 ? '#ff5d5d' : '#e9e7df' }}>{usd(run.costUsd)}</span>
              </div>
              <div className="text-center">
                <span className="text-faint">tok </span>
                <span className="text-dim">{tokens(run.tokensOut)}</span>
              </div>
              <div className="text-right">
                <span className="text-faint">{dur(elapsed)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
