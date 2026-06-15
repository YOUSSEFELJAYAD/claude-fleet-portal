'use client';
import React, { useState } from 'react';
import { Dot } from './ui';
import { ShikiCode } from './ShikiCode';
import { MarkdownView } from './MarkdownView';

/** Compact chat-native tool-call card (spec §7): collapsed = name + args summary + status dot;
 *  expanded = full args (JSON via ShikiCode) + result. Not the heavy Waterfall/Timeline row. */
function summarize(input: unknown, max = 80): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.length > max ? input.slice(0, max) + '…' : input;
  const s = JSON.stringify(input);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Heuristic: render result as code when it looks like JSON/multiline/code, else markdown. */
function looksLikeCode(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') || t.includes('\n');
}

export function ToolCallCard({
  name, input, result, isError,
}: { name: string; input: unknown; result: string | null; isError: boolean }) {
  const [open, setOpen] = useState(false);
  const statusLabel = result == null ? 'running…' : isError ? 'error' : 'done';
  const statusClass = result == null ? 'text-sig-running' : isError ? 'text-sig-failed' : 'text-sig-completed';
  const dotColor = result == null ? '#39d4cf' : isError ? '#ff5d5d' : '#54e08a';
  const argsJson = (() => {
    try { return JSON.stringify(input, null, 2); } catch { return String(input); }
  })();
  return (
    <div className="border border-line2 bg-black/40 my-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-amber/[0.03] transition-colors"
      >
        <span className="font-mono text-[11px] text-dim group-hover:text-amber transition-colors">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-[11px] text-sig-running">{name}</span>
        <span className="font-mono text-[10px] text-faint truncate min-w-0 flex-1">{summarize(input)}</span>
        <span className="inline-flex items-center gap-1 shrink-0">
          <Dot color={dotColor} live={result == null} size={6} />
          <span className={`font-mono text-[9px] uppercase tracking-wider ${statusClass}`}>{statusLabel}</span>
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-0.5 space-y-2">
          <div>
            <div className="font-display uppercase tracking-wider text-[9px] text-faint mb-1">args</div>
            <ShikiCode code={argsJson} lang="json" />
          </div>
          {result != null && (
            <div>
              <div className="font-display uppercase tracking-wider text-[9px] text-faint mb-1">{isError ? 'error' : 'result'}</div>
              {looksLikeCode(result)
                ? <ShikiCode code={result} lang="text" />
                : <MarkdownView source={result} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
