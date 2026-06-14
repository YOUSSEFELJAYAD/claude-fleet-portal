'use client';
import React from 'react';
import Link from 'next/link';

/** The shared project sub-page tab bar (Hub · Board · Files · History) — one source of truth
 *  for the link-tab pill, replacing the per-page copies that had drifted. */
export function ProjectTabs({ id, active }: { id: string; active: 'board' | 'files' | 'history' | 'hub' }) {
  const tabs = [
    { key: 'hub', label: 'Hub', href: `/projects/${id}` },
    { key: 'board', label: 'Board', href: `/projects/${id}/board` },
    { key: 'files', label: 'Files', href: `/projects/${id}/files` },
    { key: 'history', label: 'History', href: `/projects/${id}/history` },
  ] as const;
  return (
    <div className="flex gap-1.5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`font-display uppercase tracking-wider text-[10px] px-3 py-1.5 border transition-colors ${
            active === t.key
              ? 'border-amber/60 text-amber bg-amber/8'
              : 'border-line2 text-faint hover:text-ink hover:border-amber/40'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
