'use client';
import React from 'react';

/** Compact search-result card (spec §7) — title + host + snippet, read-only link. */
function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
function safe(url: string): string | null {
  return /^https?:/i.test(url.trim()) ? url.trim() : null;
}

export function SearchResultCard({ title, url, snippet }: { title: string; url: string; snippet?: string }) {
  const href = safe(url);
  return (
    <div className="border border-line2 bg-black/40 px-2.5 py-2 my-1">
      <div className="flex items-baseline gap-2">
        {href
          ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-display text-[12px] text-amber hover:underline truncate">{title}</a>
          : <span className="font-display text-[12px] text-dim truncate">{title}</span>}
        <span className="font-mono text-[9px] text-faint shrink-0">{host(url)}</span>
      </div>
      {snippet && <div className="font-mono text-[11px] text-dim mt-1 leading-[1.6] line-clamp-3">{snippet}</div>}
    </div>
  );
}
