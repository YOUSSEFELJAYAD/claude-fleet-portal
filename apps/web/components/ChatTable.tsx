'use client';
import React from 'react';

/** Real table for ChatCommandResult kind:'table' (spec §7) — HUD-styled, replaces the
 *  discarded result. columns/rows come straight off ChatCommandResult. */
export function ChatTable({ columns, rows }: { columns?: string[]; rows?: string[][] }) {
  const cols = columns ?? [];
  const data = rows ?? [];
  if (data.length === 0) {
    return <div className="font-mono text-[11px] text-faint my-1.5 border border-dashed border-line2 px-2.5 py-2">no rows</div>;
  }
  return (
    <div className="overflow-auto my-2 border border-line2 bg-black/40">
      <table className="border-collapse text-[12px] text-dim w-full">
        <thead className="text-ink">
          <tr>
            {cols.map((c, i) => (
              <th key={i} className="border-b border-line2 px-2 py-1 text-left font-display uppercase tracking-wider text-[10px] text-amber">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, ri) => (
            <tr key={ri} className="hover:bg-amber/[0.03]">
              {row.map((cell, ci) => (
                <td key={ci} className="border-t border-white/[0.04] px-2 py-1 align-top font-mono">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
