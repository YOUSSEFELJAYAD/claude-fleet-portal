'use client';
import Link from 'next/link';
import { useFleet } from '@/lib/live';

const TERMINAL = new Set(['completed', 'failed', 'killed']);

export function RunningAgentsPanel() {
  // useFleet returns `runs` as a sorted array (not a Map) — filter it directly.
  const { runs } = useFleet();
  const live = runs.filter((r) => !TERMINAL.has(r.status));
  return (
    <div className="w-64 shrink-0 border-l hairline flex flex-col">
      <div className="p-2 border-b hairline"><span className="kicker">running agents · {live.length}</span></div>
      <div className="flex-1 overflow-auto">
        {live.length === 0 && <div className="p-3 font-mono text-[11px] text-faint">none running</div>}
        {live.map((r) => (
          <Link key={r.id} href={`/runs/${r.id}`}
            className="block px-2 py-2 text-[12px] border-b hairline hover:bg-white/5 transition-colors">
            <div className="font-mono text-ink">{r.id.slice(0, 8)} · {r.status}</div>
            <div className="font-mono text-[10px] text-faint truncate mt-0.5">{r.model} · {r.cwd}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
