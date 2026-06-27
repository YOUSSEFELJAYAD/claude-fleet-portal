'use client';
import React, { useEffect, useMemo, useState } from 'react';
import type { ChatSession } from '@fleet/shared';
import { Badge, Dot, Input } from '@/components/ui';
import { chatStateMeta } from '@/lib/chatState';
import { ago } from '@/lib/format';
import { chatPrefs } from '@/lib/chatPrefs';

const AMBER = '#ffb000';
// ponytail: blue accent; not in tailwind config — inline until a token lands
const BLUE = '#4f7fff';

/**
 * Persistent left-rail session list (was a header popover pre-v0.7.1). Always-visible
 * vertical panel: a "+ New" + filter header, then one row per session (pinned-first).
 * Row markup (dot, title, preview, meta, engine badge, hover actions) extends the
 * popover version with a pin star and a duplicate action.
 */
export function ChatSessionList({
  sessions, activeId, previews = {}, onSelect, onNew, onRename, onKill, onResume, onDelete, onDuplicate,
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
  /** clone a session (same cwd/model/engine) into a fresh one. */
  onDuplicate?: (s: ChatSession) => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  // Load pins post-hydration (not in the initializer) — localStorage is absent during SSR,
  // and seeding from it in useState would reorder the list on the client and mismatch hydration.
  const [pins, setPins] = useState<Set<string>>(new Set());
  useEffect(() => { setPins(chatPrefs.getPins()); }, []);

  useEffect(() => { setEditId(null); }, [activeId]);

  function togglePin(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    chatPrefs.togglePin(id);
    setPins(chatPrefs.getPins());
  }

  // filter by title, then pinned-first (Array.sort is stable → original order within groups)
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    return [...filtered].sort((a, b) => (pins.has(b.id) ? 1 : 0) - (pins.has(a.id) ? 1 : 0));
  }, [sessions, query, pins]);

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
    <div className="flex flex-col h-full min-h-0" data-testid="chat-session-list">
      {/* + New session + filter */}
      <div className="px-2 py-2 shrink-0 space-y-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button
          onClick={onNew}
          className="flex items-center gap-2 w-full text-left text-[12px] font-sans px-2 py-1.5 rounded-lg hover:bg-white/[0.06] transition-colors"
          style={{ color: BLUE }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M6.5 1.5v10M1.5 6.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          New session
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1 text-[12px] font-sans text-ink placeholder:text-[#5b626d] outline-none focus:border-[#4f7fff]/50"
        />
      </div>

      {/* Sessions */}
      <div className="flex-1 min-h-0 overflow-auto" role="listbox" aria-label="Sessions">
        {visible.map((s) => {
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
              onClick={() => { if (editId !== s.id) onSelect(s.id); }}
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
                <button
                  aria-label={pins.has(s.id) ? 'Unpin session' : 'Pin session'}
                  title={pins.has(s.id) ? 'Unpin' : 'Pin'}
                  onClick={(e) => togglePin(s.id, e)}
                  className={`shrink-0 text-[12px] leading-none transition-colors ${pins.has(s.id) ? '' : 'opacity-0 group-hover:opacity-100'}`}
                  style={{ color: pins.has(s.id) ? AMBER : '#5b626d' }}
                >
                  {pins.has(s.id) ? '★' : '☆'}
                </button>
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
                {onDuplicate && (
                  <button
                    className="text-[10px] font-sans px-2 py-0.5 rounded-md hover:bg-white/[0.08] transition-colors text-dim"
                    onClick={(e) => { e.stopPropagation(); onDuplicate(s); }}
                  >duplicate</button>
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
  );
}
