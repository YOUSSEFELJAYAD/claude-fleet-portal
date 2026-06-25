'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandDef, SkillInfo, SubagentInfo } from '@fleet/shared';
import { FloatingMenu, floatingOptionId, type FloatingItem } from '@/components/ui';

// ─── ArgMenu — second-stage arg-value picker (Task 4.1) ──────────────────────────────────────────

const ARG_LISTBOX_ID = 'chat-arg-menu';

/** §5.3 second-stage: shown after a command is picked when the current arg has completable values.
 *  Values are pre-resolved by ChatComposer (dynamic → api.commandArgs; enum → catalog).
 *  Keyboard nav mirrors SlashMenu: ArrowUp/Down move selection, Enter picks, Escape dismisses. */
export function ArgMenu({
  values,
  query,
  onPick,
  onClose,
  onCount,
  onActiveDescendant,
}: {
  values: { value: string; label?: string }[];
  query: string;
  onPick: (value: string) => void;
  onClose: () => void;
  onCount?: (n: number) => void;
  onActiveDescendant?: (info: { listboxId: string; activeOptionId: string | null }) => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => values.filter((v) => !q || v.value.toLowerCase().includes(q) || (v.label ?? '').toLowerCase().includes(q)),
    [values, q],
  );
  const [active, setActive] = useState(0);

  useEffect(() => setActive((a) => (a >= filtered.length ? 0 : a)), [filtered.length]);

  useEffect(() => {
    onCount?.(filtered.length);
    return () => onCount?.(0);
  }, [filtered.length, onCount]);

  useEffect(() => {
    onActiveDescendant?.({
      listboxId: ARG_LISTBOX_ID,
      activeOptionId: filtered[active] ? floatingOptionId(ARG_LISTBOX_ID, active) : null,
    });
    return () => onActiveDescendant?.({ listboxId: ARG_LISTBOX_ID, activeOptionId: null });
  }, [active, filtered, onActiveDescendant]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.max(a - 1, 0)); }
      else if (e.key === 'Enter') { if (filtered[active]) { e.preventDefault(); e.stopPropagation(); onPick(filtered[active].value); } }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [filtered, active, onPick, onClose]);

  const items: FloatingItem[] = filtered.map((v, i) => ({
    id: `${ARG_LISTBOX_ID}-v-${i}`,
    label: v.label ?? v.value,
    hint: v.label ? v.value : undefined,
  }));

  return (
    <FloatingMenu
      open
      id={ARG_LISTBOX_ID}
      items={items}
      activeIndex={active}
      onPick={(_, idx) => onPick(filtered[idx].value)}
      onClose={onClose}
      emptyText="no suggestions"
      footer="↑↓ navigate · ↵ select · esc dismiss"
    />
  );
}
import { api } from '@/lib/api';

/** stable listbox id so the composer's combobox textarea can reference it (aria-controls). */
const SLASH_LISTBOX_ID = 'chat-slash-menu';

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
  onCount,
  onActiveDescendant,
}: {
  query: string;
  cwd: string;
  onPick: (name: string) => void;
  onClose: () => void;
  /** §fix09 — report the count of selectable rows so the composer knows whether the
   *  menu currently "owns" Enter (an empty menu lets Enter submit). */
  onCount?: (n: number) => void;
  /** fix 10C — report this listbox's id + the active option's id so the composer's
   *  combobox textarea can wire aria-controls / aria-activedescendant. */
  onActiveDescendant?: (info: { listboxId: string; activeOptionId: string | null }) => void;
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

  // §fix09 — surface the selectable-row count to the composer's Enter guard
  useEffect(() => {
    onCount?.(filtered.length);
    return () => onCount?.(0);
  }, [filtered.length, onCount]);

  // fix 10C — surface the active descendant for the composer's combobox aria wiring
  useEffect(() => {
    onActiveDescendant?.({
      listboxId: SLASH_LISTBOX_ID,
      activeOptionId: filtered[active] ? floatingOptionId(SLASH_LISTBOX_ID, active) : null,
    });
    return () => onActiveDescendant?.({ listboxId: SLASH_LISTBOX_ID, activeOptionId: null });
  }, [active, filtered, onActiveDescendant]);

  // keyboard nav: arrow/enter/escape on the document while the menu is open. The
  // trigger char lives in the composer's textarea, which keeps focus, so we listen
  // at the document (capture) and act on the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        if (filtered[active]) {
          e.preventDefault();
          e.stopPropagation();
          onPick(filtered[active].name);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [filtered, active, onPick, onClose]);

  return (
    <FloatingMenu
      open
      id={SLASH_LISTBOX_ID}
      items={filtered}
      activeIndex={active}
      onPick={(item) => onPick((item as CatalogRow).name)}
      onClose={onClose}
      emptyText="no commands"
      footer="↑↓ navigate · ↵ select · esc dismiss"
    />
  );
}
