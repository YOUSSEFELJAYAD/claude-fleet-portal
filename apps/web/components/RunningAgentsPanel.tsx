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
      <div className="p-2 border-b hairline text-[12px] font-semibold">Running agents ({live.length})</div>
      <div className="flex-1 overflow-auto">
        {live.length === 0 && <div className="p-3 text-[12px] opacity-50">none running</div>}
        {live.map((r) => (
          <Link key={r.id} href={`/runs/${r.id}`}
            className="block px-2 py-2 text-[12px] border-b hairline hover:bg-white/5">
            <div className="font-mono">{r.id.slice(0, 8)} · {r.status}</div>
            <div className="opacity-60 truncate">{r.model} · {r.cwd}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
