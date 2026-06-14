'use client';
import React, { useState } from 'react';
import { Dot } from './ui';

/** Collapsible reasoning block (spec §7): dim, monospace, collapsed by default.
 *  Purple (#7b6db0) keyed to the run-debugger's `thinking` color for consistency. */
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const purple = '#7b6db0';
  return (
    <div className="border border-line2 bg-black/40 my-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-amber/[0.03] transition-colors"
      >
        <span className="font-mono text-[11px]" style={{ color: open ? '#ffb000' : '#9aa1ab' }}>{open ? '▾' : '▸'}</span>
        <Dot color={purple} size={6} />
        <span className="font-display uppercase tracking-wider text-[10px]" style={{ color: purple }}>thinking</span>
        <span className="font-mono text-[9px] text-faint ml-auto tnum">{text.length} chars</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-0.5">
          <pre className="font-mono text-[11px] leading-[1.6] text-dim whitespace-pre-wrap break-words m-0">{text}</pre>
        </div>
      )}
    </div>
  );
}
