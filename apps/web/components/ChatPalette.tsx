'use client';
import React, { useState } from 'react';
import type { ChatSession } from '@fleet/shared';

/**
 * Cmd/Ctrl+K session switcher: a centered overlay with a filter + keyboard-navigable
 * session list. Enter picks the highlighted row; Esc/backdrop click closes.
 */
export function ChatPalette({
  sessions, onSelect, onClose,
}: {
  sessions: ChatSession[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);

  const filtered = sessions.filter((s) => s.title.toLowerCase().includes(q.trim().toLowerCase()));
  const active = Math.min(idx, Math.max(0, filtered.length - 1));

  function pick(i: number) {
    const s = filtered[i];
    if (s) { onSelect(s.id); onClose(); }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center pt-[15vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[90vw] rounded-xl border border-white/[0.1] bg-[#16181d] overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          placeholder="Switch session…"
          aria-label="Switch session"
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          className="w-full bg-transparent px-4 py-3 text-[14px] font-sans text-ink placeholder:text-[#5b626d] outline-none border-b border-white/[0.06]"
        />
        <div className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-3 text-[12px] text-faint font-sans">No sessions</div>
          ) : filtered.map((s, i) => (
            <button
              key={s.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setIdx(i)}
              onClick={() => pick(i)}
              className="block w-full text-left px-4 py-2 text-[13px] font-sans text-ink truncate transition-colors"
              style={{ background: i === active ? 'rgba(79,127,255,0.12)' : undefined }}
            >
              {s.title}
              <span className="ml-2 font-mono text-[10px] text-faint">{s.engine} · {s.model}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
