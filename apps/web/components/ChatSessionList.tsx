'use client';
import React, { useEffect, useState, useRef } from 'react';
import type { ChatSession } from '@fleet/shared';
import { Badge, Dot, Input } from '@/components/ui';
import { chatStateMeta } from '@/lib/chatState';
import { ago } from '@/lib/format';

const AMBER = '#ffb000';
// ponytail: blue accent; not in tailwind config — inline until a token lands
const BLUE = '#4f7fff';

export function ChatSessionList({
  sessions, activeId, previews = {}, onSelect, onNew, onRename, onKill, onResume, onDelete,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  /** sessionId → last-message preview text (supplied by the page). */
  previews?: Record<string, string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onKill: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const active = sessions.find((s) => s.id === activeId);
  const activeMeta = active ? chatStateMeta(active.state ?? 'idle') : null;

  useEffect(() => { setEditId(null); }, [activeId]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function startRename(s: ChatSession, e: React.MouseEvent) {
    e.stopPropagation();
    setEditId(s.id); setDraft(s.title);
  }
  function commitRename(id: string) {
    const t = draft.trim();
    setEditId(null);
    if (t) onRename(id, t);
  }

  return (
    // ponytail: flex-none + relative so the popover anchors; page layout keeps this as a flex
    // child in the horizontal shell — a top-bar refactor of page.tsx is needed to fully move it.
    <div ref={containerRef} className="relative flex-none self-stretch flex items-stretch">
      {/* Trigger: active session title + chevron */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-4 text-[13px] font-sans text-ink hover:bg-white/[0.04] transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {activeMeta && <Dot color={activeMeta.color} live={activeMeta.live} size={6} />}
        <span className="max-w-[160px] truncate">{active?.title ?? 'Select session'}</span>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          className={`text-faint transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Popover: session list + new action */}
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 w-80 rounded-xl border overflow-hidden"
          style={{
            background: '#16181d',
            borderColor: 'rgba(255,255,255,0.08)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          }}
        >
          {/* + New session */}
          <div className="px-2 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              onClick={() => { onNew(); setOpen(false); }}
              className="flex items-center gap-2 w-full text-left text-[12px] font-sans px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors"
              style={{ color: BLUE }}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 1.5v10M1.5 6.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              New session
            </button>
          </div>

          {/* Sessions */}
          <div className="max-h-[420px] overflow-auto">
            {sessions.map((s) => {
              const meta = chatStateMeta(s.state ?? 'idle');
              const isActive = s.id === activeId;
              /** Engine sessions (codex/opencode) are one-shot and never hold a live process. */
              const isEngine = s.engine !== 'claude';
              return (
                <div
                  key={s.id}
                  role="option"
                  aria-selected={isActive}
                  className="group px-3 py-2.5 cursor-pointer transition-colors border-b last:border-0"
                  style={{
                    borderColor: 'rgba(255,255,255,0.05)',
                    background: isActive ? `${BLUE}0f` : undefined,
                  }}
                  onClick={() => { if (editId !== s.id) { onSelect(s.id); setOpen(false); } }}
                  onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.025)'; }}
                  onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = ''; }}
                >
                  {/* Title row */}
                  <div className="flex items-center gap-2 min-w-0">
                    <Dot color={meta.color} live={meta.live} size={6} />
                    {editId === s.id ? (
                      <Input
                        autoFocus value={draft}
                        className="!py-0.5 !text-[12px] flex-1"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id); }
                          if (e.key === 'Escape') { e.preventDefault(); setEditId(null); }
                        }}
                        onBlur={() => commitRename(s.id)}
                      />
                    ) : (
                      <span className="truncate flex-1 text-[13px] font-sans text-ink">{s.title}</span>
                    )}
                    {isActive && (
                      <span className="text-[10px] font-sans shrink-0" style={{ color: BLUE }}>active</span>
                    )}
                  </div>

                  {/* Preview */}
                  {previews[s.id] && (
                    <div className="truncate text-[11px] font-sans text-dim mt-0.5 ml-4">{previews[s.id]}</div>
                  )}

                  {/* Meta line */}
                  <div className="flex items-center justify-between mt-0.5 ml-4 font-mono text-[10px] text-faint">
                    <span>{s.engine} · {s.model}</span>
                    <span>{ago(s.updatedAt)}</span>
                  </div>

                  {/* Engine badge: one-shot engines cannot hold a live process (spec §12, D8). */}
                  {isEngine && (
                    <div className="mt-1 ml-4">
                      <Badge label="one-shot · limited memory" color={AMBER} />
                    </div>
                  )}

                  {/* Action row — revealed on hover via group */}
                  <div
                    className="flex gap-1 mt-1.5 ml-4 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {editId !== s.id && (
                      <button
                        className="text-[10px] font-sans px-2 py-0.5 rounded-md hover:bg-white/[0.08] transition-colors text-dim"
                        onClick={(e) => startRename(s, e)}
                      >rename</button>
                    )}
                    {/* Kill is only relevant when a live process exists; resume only when idle/killed.
                        Both are meaningless for one-shot engines (spec §12, D8). */}
                    {!isEngine && (s.state === 'live' || s.state === 'running') && (
                      <button
                        className="text-[10px] font-sans px-2 py-0.5 rounded-md hover:bg-white/[0.08] transition-colors text-sig-failed"
                        onClick={(e) => { e.stopPropagation(); onKill(s.id); }}
                      >kill</button>
                    )}
                    {!isEngine && (s.state === 'idle' || s.state === 'killed') && (
                      <button
                        className="text-[10px] font-sans px-2 py-0.5 rounded-md hover:bg-white/[0.08] transition-colors text-amber"
                        onClick={(e) => { e.stopPropagation(); onResume(s.id); }}
                      >resume</button>
                    )}
                    <button
                      className="text-[10px] font-sans px-2 py-0.5 rounded-md hover:bg-white/[0.08] transition-colors text-sig-failed"
                      onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                    >delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
