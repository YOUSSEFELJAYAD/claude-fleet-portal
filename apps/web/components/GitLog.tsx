'use client';
import React from 'react';

/**
 * Commit-list renderer (SPEC §7). Consumes `GitLogEntry[]` from `GET .../git/log`
 * (`{ hash, author, time(epoch SECONDS), subject, isMerge }`). Marks merge commits (the PM's
 * `--no-ff` integrations show here) and emits the selected hash so the page can `GET .../git/show`.
 * Purely presentational — fetching/paging lives in the page.
 */

export interface GitLogEntry {
  hash: string;
  author: string;
  time: number; // epoch SECONDS
  subject: string;
  isMerge: boolean;
}

function shortClock(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, { year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function GitLog({
  entries,
  selected,
  onSelect,
}: {
  entries: GitLogEntry[];
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  if (entries.length === 0) {
    return <div className="font-mono text-[12px] text-faint border border-dashed border-line2 px-3 py-6 text-center">No commits.</div>;
  }
  return (
    <div className="border border-line2 divide-y divide-white/[0.04]">
      {entries.map((c) => {
        const isSel = selected === c.hash;
        const isPm = /fleet-pm/i.test(c.author);
        return (
          <button
            key={c.hash}
            onClick={() => onSelect(c.hash)}
            className={`w-full text-left px-3 py-2.5 transition-colors grid grid-cols-[14px_1fr_auto] gap-2.5 items-baseline ${
              isSel ? 'bg-amber/[0.10]' : 'hover:bg-amber/[0.04]'
            }`}
          >
            <span
              className="select-none text-[11px] tnum"
              style={{ color: c.isMerge ? '#ffb000' : '#5a616b' }}
              title={c.isMerge ? 'merge commit' : 'commit'}
            >
              {c.isMerge ? '⑂' : '•'}
            </span>
            <span className="min-w-0">
              <span className={`text-[12.5px] truncate block ${isSel ? 'text-amber' : 'text-ink'}`}>{c.subject || '(no subject)'}</span>
              <span className="font-mono text-[10px] text-faint flex items-center gap-2 mt-0.5">
                <span className="text-dim">{c.hash.slice(0, 8)}</span>
                <span className={isPm ? 'text-amber/80' : ''}>{c.author}</span>
                {c.isMerge && <span className="uppercase tracking-wider text-amber/70" style={{ fontSize: 9 }}>merge</span>}
              </span>
            </span>
            <span className="font-mono text-[10px] text-faint tnum whitespace-nowrap">{shortClock(c.time)}</span>
          </button>
        );
      })}
    </div>
  );
}
