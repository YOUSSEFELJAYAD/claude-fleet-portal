'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandDef, SkillInfo, SubagentInfo } from '@fleet/shared';
import { FloatingMenu, type FloatingItem } from '@/components/ui';
import { api } from '@/lib/api';

/** §5.3 — the merged `/` catalog: typed Portal verbs (grouped by CommandDef.group),
 *  plus Skills and Subagents under their own headers. Fetched ONCE per mount and
 *  cached; the `query` prop filters CLIENT-SIDE over the cached flat list. */
interface CatalogRow extends FloatingItem {
  /** the bare command/skill/subagent name handed back to the composer. */
  name: string;
  /** lowercased haystack for the client filter (name + description + usage). */
  haystack: string;
}

export function SlashMenu({
  query,
  cwd,
  onPick,
  onClose,
}: {
  query: string;
  cwd: string;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [active, setActive] = useState(0);
  const loadedRef = useRef(false);

  // fetch + merge ONCE per mount (catalog scans are disk I/O — §5.3 says cache it)
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let alive = true;
    (async () => {
      const [cmds, sks, subs] = await Promise.all([
        api.listCommands().catch(() => [] as CommandDef[]),
        api.skills(cwd).catch(() => [] as SkillInfo[]),
        api.subagents(cwd).catch(() => [] as SubagentInfo[]),
      ]);
      if (!alive) return;
      const out: CatalogRow[] = [];
      for (const c of cmds) {
        out.push({
          id: `cmd:${c.name}`,
          name: c.name,
          label: `/${c.name}`,
          hint: c.description,
          trailing: c.args.length ? c.usage.replace(`/${c.name}`, '').trim() : undefined,
          group: c.group,
          haystack: `${c.name} ${c.description} ${c.usage}`.toLowerCase(),
        });
      }
      for (const s of sks) {
        out.push({
          id: `skill:${s.name}`,
          name: s.name,
          label: `/${s.name}`,
          hint: s.description,
          group: 'Skills',
          haystack: `${s.name} ${s.description ?? ''}`.toLowerCase(),
        });
      }
      for (const a of subs) {
        out.push({
          id: `sub:${a.name}`,
          name: a.name,
          label: `@${a.name}`,
          hint: a.description,
          group: 'Subagents',
          haystack: `${a.name} ${a.description ?? ''}`.toLowerCase(),
        });
      }
      setRows(out);
    })();
    return () => {
      alive = false;
    };
  }, [cwd]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.haystack.includes(q));
  }, [rows, query]);

  // keep the active row in range as the filter shrinks the list
  useEffect(() => {
    setActive((a) => (a >= filtered.length ? 0 : a));
  }, [filtered.length]);

  // keyboard nav: arrow/enter/escape on the document while the menu is open. The
  // trigger char lives in the composer's textarea, which keeps focus, so we listen
  // at the document (capture) and act on the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        if (filtered[active]) {
          e.preventDefault();
          onPick(filtered[active].name);
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [filtered, active, onPick, onClose]);

  return (
    <FloatingMenu
      open
      items={filtered}
      activeIndex={active}
      onPick={(item) => onPick((item as CatalogRow).name)}
      onClose={onClose}
      emptyText="no commands"
      footer="↑↓ navigate · ↵ select · esc dismiss"
    />
  );
}
