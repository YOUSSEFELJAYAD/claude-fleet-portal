'use client';
import React from 'react';
import { Dot } from './ui';

/** Compact subagent chip (spec §7) — a spawned subagent linking to its run page. */
export function SubagentChip({ label, childId }: { label: string; childId: string }) {
  return (
    <a
      href={`/agents/${childId}`}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 border border-line2 text-dim hover:border-amber/60 hover:bg-amber/5 hover:text-ink transition-colors"
    >
      <Dot color="#ffb000" size={6} />
      <span className="font-mono text-[11px]">{label}</span>
      <span className="font-mono text-[11px]">{childId.slice(0, 8)}</span>
    </a>
  );
}
