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
          <mark key={i} className="bg-transparent text-amber-300 font-medium not-italic">{part.slice(3, -4)}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
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
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest sessionId for the debounce closure — avoids stale closure over scoped/activeId
  const scopedSidRef = useRef<string | undefined>(undefined);
  scopedSidRef.current = scoped && activeId ? activeId : undefined;

  // Clear results when session changes
  useEffect(() => {
    setHits([]);
    setScoped(false);
    genRef.current++;
  }, [activeId]);

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

  return (
    <div className="px-3 py-2 border-b hairline">
      <div className="flex items-center gap-1.5">
        <input
          type="search"
          placeholder="Search chats…"
          value={q}
          onChange={handleChange}
          className="flex-1 bg-transparent text-[12px] text-ink placeholder:text-faint outline-none min-w-0"
          aria-label="search chats"
        />
        {activeId && (
          <label className="flex items-center gap-1 font-mono text-[10px] text-faint cursor-pointer whitespace-nowrap select-none">
            <input
              type="checkbox"
              checked={scoped}
              onChange={handleScopeToggle}
              className="w-3 h-3"
            />
            this session
          </label>
        )}
      </div>
      {hits.length > 0 && (
        <ul className="mt-1.5 space-y-1 max-h-48 overflow-auto" role="list">
          {hits.map((hit) => (
            <li
              key={hit.messageId}
              className="px-2 py-1 rounded text-[11px] cursor-pointer hover:bg-white/[0.04] flex flex-col gap-0.5"
              onClick={() => onOpenAtTurn(hit.sessionId, hit.turnId)}
            >
              {!scopedSidRef.current && (
                <span className="font-mono text-[10px] text-amber-400 truncate">{hit.sessionTitle}</span>
              )}
              <span className="font-mono text-[9px] text-faint uppercase">{hit.role}</span>
              <span className="text-dim truncate"><SnippetHighlight text={hit.snippet} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
