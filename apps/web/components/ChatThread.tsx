'use client';
import React, { useEffect, useRef, useState } from 'react';
import type { ChatTurn } from '@fleet/shared';
import type { ChatActiveTurn } from '@/lib/live';
import { api } from '@/lib/api';
import { Btn } from './ui';
import { Turn } from './Turn';

/**
 * Thin scroller: renders settled history turns (keyed by turn.id) then the live
 * activeTurn (if any). Handles cursor-paginated "load older" via api.chatTurns.
 * Scroll-to-bottom fires whenever turns/activeTurn change (within 120px of the bottom).
 */
export function ChatThread({
  sessionId, turns, activeTurn, onRetry,
}: {
  sessionId: string | null;
  turns: ChatTurn[];            // settled history, newest-last (page is data owner)
  activeTurn: ChatActiveTurn | null;
  onRetry: (turn: ChatTurn) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // ponytail: prepended holds older pages loaded on demand; page owns the initial page.
  const [prepended, setPrepended] = useState<ChatTurn[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Reset when session changes so old session's pagination doesn't bleed.
  useEffect(() => { setPrepended([]); setHasMore(true); }, [sessionId]);

  // Auto-scroll to bottom when the list grows (within 120px of bottom → keep pinned).
  useEffect(() => {
    const end = endRef.current;
    if (!end) return;
    let sc: HTMLElement | null = end.parentElement;
    while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
    if (!sc) return;
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120) sc.scrollTop = sc.scrollHeight;
  }, [turns.length, activeTurn]);

  async function loadOlder() {
    if (!sessionId || loadingOlder) return;
    // Oldest turn is the first in the combined list.
    const existingIds = new Set(turns.map((t) => t.id));
    const dedupPrepended = prepended.filter((t) => !existingIds.has(t.id));
    const allTurns = [...dedupPrepended, ...turns];
    const oldest = allTurns[0]?.createdAt;
    setLoadingOlder(true);
    try {
      const older = await api.chatTurns(sessionId, oldest);
      if (older.length > 0) {
        const knownIds = new Set(allTurns.map((t) => t.id));
        setPrepended((prev) => [...older.filter((t) => !knownIds.has(t.id)), ...prev]);
      } else {
        setHasMore(false);
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  // Deduplicate prepended against the authoritative page (page may have refetched).
  const existingIds = new Set(turns.map((t) => t.id));
  const dedupPrepended = prepended.filter((t) => !existingIds.has(t.id));
  const allTurns = [...dedupPrepended, ...turns];

  // C1/CV1: suppress the active card once its turnId has landed in settled history.
  const historyIds = existingIds;
  const showActive = activeTurn != null && !historyIds.has(activeTurn.turnId);

  return (
    <div className="flex-1 overflow-auto p-4">
      {allTurns.length > 0 && hasMore && (
        <div className="flex justify-center mb-2">
          <button
            type="button"
            onClick={loadOlder}
            disabled={loadingOlder}
            data-testid="load-older"
            className="text-[11px] text-faint hover:text-ink transition-colors disabled:opacity-40"
          >
            {loadingOlder ? 'loading…' : 'load older'}
          </button>
        </div>
      )}
      {allTurns.map((turn) => (
        <Turn key={turn.id} turn={turn} onRetry={() => onRetry(turn)} />
      ))}
      {showActive && (
        <Turn active={activeTurn} onRetry={() => onRetry(activeTurn.turn)} />
      )}
      {showActive && activeTurn.status !== 'failed' && activeTurn.status !== 'settled' && (
        <div className="sticky bottom-0 flex justify-center py-2">
          <Btn
            variant="danger"
            onClick={() => { if (sessionId) api.chatInterrupt(sessionId).catch(() => {}); }}
          >
            stop
          </Btn>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
