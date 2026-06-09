'use client';
import React, { useEffect, useState } from 'react';
import { API } from '@/lib/api';

/**
 * Type-aware READ-ONLY file viewer (SPEC §7, ZERO new deps):
 *   - code      → plain monospace <pre>
 *   - markdown  → MINIMAL hand-rolled renderer (headings/bold/italic/code/lists/fences/links),
 *                 links sanitized (http/https/mailto + same-origin relative only)
 *   - json      → pretty-printed <pre>
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
          <Markdown source={data.content} />
        ) : isJson ? (
          <pre className="font-mono text-[12px] leading-[1.6] text-ink whitespace-pre-wrap break-words m-0">
            {prettyJson(data.content)}
          </pre>
        ) : (
          <CodeBlock content={data.content} />
        )}
      </div>
    </div>
  );
}

function CodeBlock({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="border border-line2 bg-black/40 overflow-auto">
      <pre className="font-mono text-[12px] leading-[1.55] m-0 p-0">
        {lines.map((l, i) => (
          <div key={i} className="flex">
            <span
              className="select-none text-right tnum text-faint"
              style={{ width: 48, paddingRight: 12, flex: '0 0 auto', opacity: 0.6 }}
            >
              {i + 1}
            </span>
            <span className="text-ink" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
              {l || ' '}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}

// ── minimal hand-rolled markdown (SPEC §7, no react-markdown) ────────────────────

/** Allow only safe link protocols; relative links are kept but rendered inert (read-only viewer). */
function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  // reject javascript:, data:, vbscript:, etc. relative links → inert
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  return null; // relative/anchor links: keep text, drop navigation (read-only)
}

/** Inline formatting: `code`, **bold**, *italic*, [text](url). Escapes everything else as text. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // tokenization order matters: code first (so ** inside code is literal)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`${keyBase}-t${k++}`}>{text.slice(last, m.index)}</React.Fragment>);
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <code key={`${keyBase}-c${k++}`} className="font-mono text-[12px] px-1 py-0.5 bg-white/[0.06] text-amber rounded-sm">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b${k++}`} className="text-ink font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={`${keyBase}-i${k++}`} className="italic text-dim">{tok.slice(1, -1)}</em>);
    } else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        const href = safeHref(lm[2]);
        if (href) {
          out.push(
            <a key={`${keyBase}-l${k++}`} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-amber underline">
              {lm[1]}
            </a>,
          );
        } else {
          out.push(<span key={`${keyBase}-l${k++}`} className="text-dim underline decoration-dotted" title={lm[2]}>{lm[1]}</span>);
        }
      } else {
        out.push(<React.Fragment key={`${keyBase}-x${k++}`}>{tok}</React.Fragment>);
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<React.Fragment key={`${keyBase}-t${k++}`}>{text.slice(last)}</React.Fragment>);
  return out;
}

function Markdown({ source }: { source: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = source.split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre key={key++} className="font-mono text-[12px] leading-[1.5] bg-black/50 border border-line2 px-3 py-2.5 my-2 overflow-auto whitespace-pre-wrap break-words">
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const sizes = ['text-[22px]', 'text-[19px]', 'text-[16px]', 'text-[14px]', 'text-[13px]', 'text-[12px]'];
      blocks.push(
        <div
          key={key++}
          className={`font-display tracking-wide text-ink mt-4 mb-2 ${sizes[lvl - 1]}`}
          style={{ borderBottom: lvl <= 2 ? '1px solid rgba(255,255,255,0.08)' : undefined, paddingBottom: lvl <= 2 ? 4 : 0 }}
        >
          {renderInline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }
    // horizontal rule
    if (/^(\*\*\*|---|___)\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="border-line2 my-3" />);
      i++;
      continue;
    }
    // unordered / ordered list (consume a contiguous block)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: { text: string; ordered: boolean }[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const lm = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (lm) items.push({ text: lm[2], ordered: /\d+\./.test(lm[1]) });
        i++;
      }
      const ordered = items.length > 0 && items[0].ordered;
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        React.createElement(
          ListTag,
          { key: key++, className: `${ordered ? 'list-decimal' : 'list-disc'} pl-6 my-2 space-y-1 text-[13px] text-dim` },
          items.map((it, idx) => (
            <li key={idx} className="leading-[1.6]">
              {renderInline(it.text, `li${key}-${idx}`)}
            </li>
          )),
        ),
      );
      continue;
    }
    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="border-l-2 border-amber/40 pl-3 my-2 text-dim text-[13px] italic">
          {renderInline(buf.join(' '), `bq${key}`)}
        </blockquote>,
      );
      continue;
    }
    // blank line
    if (line.trim() === '') {
      i++;
      continue;
    }
    // paragraph (join following non-blank, non-structural lines)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s+|(\*\*\*|---|___)\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-[13px] leading-[1.7] text-dim my-2">
        {renderInline(buf.join(' '), `p${key}`)}
      </p>,
    );
  }
  return <div className="max-w-[820px]">{blocks}</div>;
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
