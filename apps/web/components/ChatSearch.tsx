'use client';
import React, { useState, useRef, useEffect } from 'react';
import type { ChatSearchHit } from '@fleet/shared';
import { api } from '@/lib/api';

/**
 * Cross-session and within-session chat search (Task 3.3).
 *
 * - 200ms debounce on the input; only the latest query's results land (generation counter).
 * - Cross-session by default; "this session" checkbox scopes to activeId when a session is open.
 * - Clicking a hit calls onOpenAtTurn(sessionId, turnId) → page loads the session + scrolls.
 *
 * ponytail: AbortController would cancel the inflight fetch, but since we mock at the api level
 * in tests, a generation counter achieves the same "only latest lands" guarantee without
 * requiring the server route to check the signal.
 */

/** Parse FTS5 snippet <b>…</b> markers into highlighted spans (no dangerouslySetInnerHTML). */
function SnippetHighlight({ text }: { text: string }) {
  const parts = text.split(/(<b>.*?<\/b>)/);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('<b>') && part.endsWith('</b>') ? (
          // ponytail: blue accent matches design spec; was amber-300
          <mark key={i} className="bg-transparent text-[#4f7fff] font-medium not-italic">{part.slice(3, -4)}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={className} aria-hidden>
      <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M9.2 9.2l2.8 2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

export function ChatSearch({
  activeId,
  onOpenAtTurn,
}: {
  activeId?: string | null;
  onOpenAtTurn: (sessionId: string, turnId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [scoped, setScoped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest sessionId for the debounce closure — avoids stale closure over scoped/activeId
  const scopedSidRef = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  scopedSidRef.current = scoped && activeId ? activeId : undefined;

  // Clear results when session changes
  useEffect(() => {
    setHits([]);
    setScoped(false);
    genRef.current++;
  }, [activeId]);

  // Close + clear on outside click
  useEffect(() => {
    if (!expanded) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
        setHits([]);
        setQ('');
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expanded]);

  function runSearch(val: string, sid: string | undefined) {
    genRef.current++;
    const gen = genRef.current;
    if (!val.trim()) { setHits([]); return; }
    api.searchChat(val, sid).then((results) => {
      if (gen === genRef.current) setHits(results);
    }).catch(() => {});
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQ(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!val.trim()) { setHits([]); return; }
    timerRef.current = setTimeout(() => runSearch(val, scopedSidRef.current), 200);
  }

  function handleScopeToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const nextScoped = e.target.checked;
    setScoped(nextScoped);
    if (timerRef.current) clearTimeout(timerRef.current);
    const nextSid = nextScoped && activeId ? activeId : undefined;
    runSearch(q, nextSid);
  }

  function expand() {
    setExpanded(true);
    // focus after React commits the expanded input
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function dismiss() {
    setExpanded(false);
    setHits([]);
    setQ('');
  }

  return (
    <div ref={containerRef} className="relative flex items-center">
      {expanded ? (
        /* Expanded search bar */
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl border"
          style={{ background: '#16181d', borderColor: 'rgba(255,255,255,0.08)', minWidth: 260 }}
        >
          <SearchIcon className="text-faint shrink-0" />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search chats…"
            value={q}
            onChange={handleChange}
            onKeyDown={(e) => { if (e.key === 'Escape') dismiss(); }}
            className="flex-1 bg-transparent text-[13px] font-sans text-ink placeholder:text-faint outline-none min-w-0"
            aria-label="search chats"
          />
          {activeId && (
            <label className="flex items-center gap-1 font-sans text-[11px] text-dim cursor-pointer whitespace-nowrap select-none">
              <input
                type="checkbox"
                checked={scoped}
                onChange={handleScopeToggle}
                className="w-3 h-3 accent-[#4f7fff]"
              />
              this session
            </label>
          )}
        </div>
      ) : (
        /* Collapsed: icon-button */
        <button
          onClick={expand}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-dim hover:bg-white/[0.04] hover:text-ink transition-colors"
          aria-label="search chats"
        >
          <SearchIcon />
          <span className="text-[12px] font-sans">Search</span>
        </button>
      )}

      {/* Results dropdown */}
      {hits.length > 0 && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-80 rounded-xl border overflow-hidden"
          style={{
            background: '#16181d',
            borderColor: 'rgba(255,255,255,0.08)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          }}
        >
          <ul className="max-h-72 overflow-auto py-1" role="list">
            {hits.map((hit) => (
              <li
                key={hit.messageId}
                className="px-3 py-2.5 cursor-pointer transition-colors"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                onClick={() => { onOpenAtTurn(hit.sessionId, hit.turnId); dismiss(); }}
                onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'}
                onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = ''}
              >
                {!scopedSidRef.current && (
                  <div className="text-[11px] font-sans font-medium text-[#4f7fff] truncate mb-0.5">{hit.sessionTitle}</div>
                )}
                <div className="font-mono text-[9px] text-faint uppercase mb-0.5">{hit.role}</div>
                <div className="text-[12px] font-sans text-dim truncate">
                  <SnippetHighlight text={hit.snippet} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
