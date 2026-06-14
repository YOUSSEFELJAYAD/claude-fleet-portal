'use client';
import React, { useEffect, useState } from 'react';
import type { ChatAttachment, FileFindResult } from '@fleet/shared';
import { FloatingMenu, type FloatingItem } from '@/components/ui';
import { api } from '@/lib/api';

const DEBOUNCE_MS = 150;
const LIMIT = 30;

/** §6 — the `@` file/folder picker. Debounces a server-side fuzzy search scoped to the
 *  session `cwd`; a pick becomes a removable attachment chip in the composer. */
export function MentionMenu({
  query,
  cwd,
  onPick,
  onClose,
}: {
  query: string;
  cwd: string;
  onPick: (att: ChatAttachment) => void;
  onClose: () => void;
}) {
  const [results, setResults] = useState<FileFindResult[]>([]);
  const [active, setActive] = useState(0);

  // debounce the search on (query, cwd); a trailing timer coalesces rapid keystrokes
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const rows = await api.findFiles(cwd, query, LIMIT);
        if (alive) {
          setResults(rows);
          setActive(0);
        }
      } catch {
        if (alive) setResults([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, cwd]);

  const items: FloatingItem[] = results.map((r) => ({
    id: r.path,
    label: r.path,
    trailing: r.kind === 'dir' ? 'dir' : 'file',
  }));

  // keyboard nav at the document (the textarea keeps focus — same model as SlashMenu)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        if (results[active]) {
          e.preventDefault();
          onPick({ path: results[active].path, kind: results[active].kind });
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [results, active, onPick, onClose]);

  return (
    <FloatingMenu
      open
      items={items}
      activeIndex={active}
      onPick={(item) => {
        const hit = results.find((r) => r.path === item.id);
        if (hit) onPick({ path: hit.path, kind: hit.kind });
      }}
      onClose={onClose}
      emptyText="no files"
      footer="↑↓ navigate · ↵ attach · esc dismiss"
    />
  );
}
