'use client';
import React from 'react';
import Link from 'next/link';
import { useChatStream } from '@/lib/live';
import { chatStateMeta } from '@/lib/chatState';
import { Dot } from '@/components/ui';

/** Session-scoped (spec §8): the active session's backing run + its subagents from the
 *  chat-scoped stream — NOT the fleet-wide list (that view stays on /fleet). */
export function RunningAgentsPanel({ sessionId }: { sessionId: string | null }) {
  const { state, live, runId, subagents } = useChatStream(sessionId);
  const meta = chatStateMeta(state ?? 'idle');
  return (
    <div className="w-64 shrink-0 border-l hairline flex flex-col">
      <div className="p-2 border-b hairline flex items-center gap-1.5">
        <span className="kicker">session agents</span>
        {sessionId && <Dot color={meta.color} live={meta.live} size={6} />}
      </div>
      <div className="flex-1 overflow-auto">
        {!sessionId && <div className="p-3 font-mono text-[11px] text-faint">no active session</div>}
        {sessionId && !runId && <div className="p-3 font-mono text-[11px] text-faint">none running</div>}
        {sessionId && runId && (
          <Link href={`/runs/${runId}`}
            className="block px-2 py-2 text-[12px] border-b hairline hover:bg-white/5 transition-colors">
            <div className="font-mono text-ink">{runId.slice(0, 8)} · {meta.label.toLowerCase()}{live ? ' · live' : ''}</div>
            <div className="font-mono text-[10px] text-faint mt-0.5">backing run</div>
          </Link>
        )}
        {subagents.map((s) => (
          <Link key={s.runId} href={`/runs/${s.runId}`}
            className="block px-2 py-1.5 text-[12px] border-b hairline hover:bg-white/5 transition-colors">
            <div className="font-mono text-dim">↳ {s.name}</div>
            <div className="font-mono text-[10px] text-faint truncate mt-0.5">{s.runId}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
