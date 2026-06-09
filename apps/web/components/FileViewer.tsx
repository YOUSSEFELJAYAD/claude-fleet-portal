'use client';
import React, { useEffect, useState } from 'react';
import { API } from '@/lib/api';
import { ShikiCode } from '@/components/ShikiCode';
import { MarkdownView } from '@/components/MarkdownView';

/**
 * Type-aware READ-ONLY file viewer (v2 spec §4 #6 — rich rendering via Shiki + react-markdown):
 *   - code      → Shiki-highlighted block (ShikiCode), plain-mono fallback while loading / on error
 *   - markdown  → react-markdown + remark-gfm (MarkdownView); links sanitized, no raw HTML
 *   - json      → Shiki-highlighted (pretty-printed)
 *   - image     → <img src=…&raw=1>  (server sets Content-Type; png/jpg/gif/webp)
 *   - binary / too-large → fallback descriptor
 *
 * Fetches `GET /api/projects/:id/files?path=<file>&content=1` → ShowFileResult (mirrors git.ts
 * `showFile`): `{ binary, content?, truncated?, size, isImage, ext, error? }`.
 */

type ShowFileResult =
  | { binary: true; content?: undefined; truncated?: undefined; size: number | null; isImage: boolean; ext: string; error?: string }
  | { binary: false; content: string; truncated: boolean; size: number; isImage: false; ext: string; error?: string };

const MD_EXTS = new Set(['.md', '.markdown', '.mdx']);
const JSON_EXTS = new Set(['.json', '.jsonc', '.geojson']);

export function FileViewer({ projectId, path }: { projectId: string; path: string | null }) {
  const [data, setData] = useState<ShowFileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    setData(null);
    fetch(`${API}/api/projects/${projectId}/files?path=${encodeURIComponent(path)}&content=1`)
      .then((r) => r.json())
      .then((d: ShowFileResult) => {
        if (!alive) return;
        if ((d as any).error) setErr((d as any).error);
        setData(d);
      })
      .catch((e) => alive && setErr(e?.message || 'failed to load file'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, path]);

  if (!path)
    return (
      <div className="font-mono text-[12px] text-faint border border-dashed border-line2 h-full flex items-center justify-center">
        Select a file from the tree.
      </div>
    );
  if (loading) return <div className="font-mono text-[12px] text-faint p-4">loading {path}…</div>;
  if (err)
    return (
      <div className="font-mono text-[12px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2 m-2">
        {path} — {err}
      </div>
    );
  if (!data) return null;

  const ext = data.ext || extOf(path);

  // image
  if (data.binary && data.isImage) {
    return (
      <div className="p-4 overflow-auto">
        <div className="font-mono text-[10px] text-faint mb-2">{path} · {fmtBytes(data.size)} · image</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${API}/api/projects/${projectId}/files?path=${encodeURIComponent(path)}&raw=1`}
          alt={path}
          style={{ maxWidth: '100%', height: 'auto', border: '1px solid rgba(255,255,255,0.08)' }}
        />
      </div>
    );
  }
  // other binary
  if (data.binary) {
    return (
      <div className="p-4">
        <div className="font-mono text-[10px] text-faint mb-2">{path}</div>
        <div className="font-mono text-[12px] text-faint border border-line2 px-3 py-4">
          Binary file ({fmtBytes(data.size)}) — not displayed.
        </div>
      </div>
    );
  }

  const isMd = MD_EXTS.has(ext);
  const isJson = JSON_EXTS.has(ext);

  return (
    <div className="overflow-auto h-full">
      <div className="font-mono text-[10px] text-faint px-4 pt-3 pb-2 flex items-center gap-3 sticky top-0 bg-[#0d0f12]/90 backdrop-blur-sm z-10">
        <span className="text-dim">{path}</span>
        <span>{fmtBytes(data.size)}</span>
        {data.truncated && <span className="text-amber">· truncated</span>}
      </div>
      <div className="px-4 pb-6">
        {isMd ? (
          <MarkdownView source={data.content} />
        ) : isJson ? (
          <ShikiCode code={prettyJson(data.content)} lang="json" />
        ) : (
          <ShikiCode code={data.content} lang={ext || 'text'} />
        )}
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // not strictly valid (jsonc/comments) → show as-is
  }
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  const slash = p.lastIndexOf('/');
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
