'use client';
import React, { useEffect, useState } from 'react';
import type { ChatAttachment, FileFindResult } from '@fleet/shared';
import { FloatingMenu, floatingOptionId, type FloatingItem } from '@/components/ui';
import { api } from '@/lib/api';

const DEBOUNCE_MS = 150;
const LIMIT = 30;
/** stable listbox id so the composer's combobox textarea can reference it (aria-controls). */
const MENTION_LISTBOX_ID = 'chat-mention-menu';

/** §6 — the `@` file/folder picker. Debounces a server-side fuzzy search whose workspace root is
 *  resolved server-side from the session's trusted cwd (fix 10B — the client passes only the
 *  sessionId, never a raw cwd); a pick becomes a removable attachment chip in the composer. */
export function MentionMenu({
  query,
  sessionId,
  onPick,
  onClose,
  onCount,
  onActiveDescendant,
}: {
  query: string;
  sessionId: string;
  onPick: (att: ChatAttachment) => void;
  onClose: () => void;
  /** §fix09 — report the count of selectable rows so the composer knows whether the
   *  menu currently "owns" Enter (an empty menu lets Enter submit). */
  onCount?: (n: number) => void;
  /** fix 10C — report this listbox's id + the active option's id so the composer's
   *  combobox textarea can wire aria-controls / aria-activedescendant. */
  onActiveDescendant?: (info: { listboxId: string; activeOptionId: string | null }) => void;
}) {
  const [results, setResults] = useState<FileFindResult[]>([]);
  const [active, setActive] = useState(0);

  // debounce the search on (query, sessionId); a trailing timer coalesces rapid keystrokes.
  // An AbortController cancels any in-flight request when the query changes; the alive flag
  // guards the state update in case the mock/transport doesn't honor the abort signal.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const rows = await api.findFiles(sessionId, query, LIMIT, ctrl.signal);
        if (alive) { setResults(rows); setActive(0); }
      } catch (err: unknown) {
        // ponytail: skip clearing on abort — the next query's results are already arriving
        if (alive && (err as { name?: string }).name !== 'AbortError') setResults([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearTimeout(t);
    };
  }, [query, sessionId]);

  const items: FloatingItem[] = results.map((r) => ({
    id: r.path,
    label: r.path,
    trailing: r.kind === 'dir' ? 'dir' : 'file',
  }));

  // §fix09 — surface the selectable-row count to the composer's Enter guard
  useEffect(() => {
    onCount?.(results.length);
    return () => onCount?.(0);
  }, [results.length, onCount]);

  // fix 10C — surface the active descendant for the composer's combobox aria wiring
  useEffect(() => {
    onActiveDescendant?.({
      listboxId: MENTION_LISTBOX_ID,
      activeOptionId: results[active] ? floatingOptionId(MENTION_LISTBOX_ID, active) : null,
    });
    return () => onActiveDescendant?.({ listboxId: MENTION_LISTBOX_ID, activeOptionId: null });
  }, [active, results, onActiveDescendant]);

  // keyboard nav at the document (the textarea keeps focus — same model as SlashMenu)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.min(a + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        if (results[active]) {
          e.preventDefault();
          e.stopPropagation();
          onPick({ path: results[active].path, kind: results[active].kind });
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [results, active, onPick, onClose]);

  return (
    <FloatingMenu
      open
      id={MENTION_LISTBOX_ID}
      items={items}
      activeIndex={active}
      onPick={(item) => {
        const hit = results.find((r) => r.path === item.id);
        if (hit) onPick({ path: hit.path, kind: hit.kind });
      }}
      onClose={onClose}
      emptyText="no files"
      footer="↑↓ navigate · ↵ attach · esc dismiss"
      className="rounded-xl border-white/[0.08]"
    />
  );
}
