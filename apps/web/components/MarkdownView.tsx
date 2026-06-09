'use client';
import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ShikiCode } from '@/components/ShikiCode';

/**
 * Markdown renderer (v2 spec §4 #6) — replaces the old hand-rolled `Markdown`/`renderInline`.
 *
 * Safety (preserves the v1 read-only contract):
 *   - NO `rehype-raw` → raw HTML in the source is NOT parsed into DOM (react-markdown drops it).
 *     `skipHtml` also strips any literal HTML so it isn't shown as text noise.
 *   - Link hrefs are whitelisted by `safeUrl` (the old `safeHref` logic): only http(s) + mailto
 *     navigate; everything else (javascript:, data:, relative/anchor) renders as inert text.
 *   - Fenced code blocks render through `ShikiCode` (lazy-loaded highlighter, plain-text fallback).
 */

/** Allow only safe link protocols; relative/anchor/other-scheme links become inert (read-only). */
function safeUrl(href: string): string | null {
  const h = (href || '').trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  return null; // javascript:/data:/vbscript:/relative/anchor → no navigation
}

/** react-markdown `urlTransform`: keep safe URLs, blank the rest (so no bad scheme ever lands in href). */
function urlTransform(url: string): string {
  return safeUrl(url) ?? '';
}

const components: Components = {
  // Links: render as <a> only for whitelisted schemes; otherwise inert styled text.
  a({ href, children }) {
    const safe = href ? safeUrl(href) : null;
    if (safe) {
      return (
        <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-amber underline">
          {children}
        </a>
      );
    }
    return (
      <span className="text-dim underline decoration-dotted" title={typeof href === 'string' ? href : undefined}>
        {children}
      </span>
    );
  },
  // Code: react-markdown v10 has no `inline` prop — detect a fence by the `language-*` class.
  // Strip `node` (from ExtraProps) so it isn't spread onto the DOM <code> (React unknown-prop warning).
  code({ node: _node, className, children, ...props }) {
    const text = String(children ?? '');
    const m = /language-(\w[\w+-]*)/.exec(className || '');
    const isFence = !!m || text.includes('\n');
    if (isFence) {
      return <ShikiCode code={text.replace(/\n$/, '')} lang={m ? m[1] : 'text'} className="my-2" />;
    }
    return (
      <code className="font-mono text-[12px] px-1 py-0.5 bg-white/[0.06] text-amber rounded-sm" {...props}>
        {children}
      </code>
    );
  },
  // The fenced-code <pre> wrapper is handled by ShikiCode itself → unwrap to avoid a double box.
  pre({ children }) {
    return <>{children}</>;
  },
  h1: ({ children }) => (
    <div className="font-display tracking-wide text-ink mt-4 mb-2 text-[22px]" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 4 }}>
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div className="font-display tracking-wide text-ink mt-4 mb-2 text-[19px]" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 4 }}>
      {children}
    </div>
  ),
  h3: ({ children }) => <div className="font-display tracking-wide text-ink mt-4 mb-2 text-[16px]">{children}</div>,
  h4: ({ children }) => <div className="font-display tracking-wide text-ink mt-4 mb-2 text-[14px]">{children}</div>,
  h5: ({ children }) => <div className="font-display tracking-wide text-ink mt-4 mb-2 text-[13px]">{children}</div>,
  h6: ({ children }) => <div className="font-display tracking-wide text-ink mt-4 mb-2 text-[12px]">{children}</div>,
  p: ({ children }) => <p className="text-[13px] leading-[1.7] text-dim my-2">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-6 my-2 space-y-1 text-[13px] text-dim">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 my-2 space-y-1 text-[13px] text-dim">{children}</ol>,
  li: ({ children }) => <li className="leading-[1.6]">{children}</li>,
  strong: ({ children }) => <strong className="text-ink font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic text-dim">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-amber/40 pl-3 my-2 text-dim text-[13px] italic">{children}</blockquote>
  ),
  hr: () => <hr className="border-line2 my-3" />,
  // GFM tables
  table: ({ children }) => (
    <div className="overflow-auto my-3">
      <table className="border-collapse text-[12px] text-dim">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="text-ink">{children}</thead>,
  th: ({ children }) => <th className="border border-line2 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-line2 px-2 py-1 align-top">{children}</td>,
  // Read-only viewer: do NOT auto-fetch remote images (a repo README could ping a tracking URL on
  // view). Render an inert placeholder with the alt text + src instead — preserves v1's no-network posture.
  img: ({ src, alt }) => (
    <span className="inline-flex items-center gap-1 rounded border border-line2 px-1.5 py-0.5 text-[11px] text-dim">
      <span aria-hidden>🖼</span>
      <span>{alt || 'image'}</span>
      {typeof src === 'string' && src ? <span className="text-faint">({src})</span> : null}
    </span>
  ),
};

export function MarkdownView({ source }: { source: string }) {
  return (
    <div className="max-w-[820px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // No rehype-raw on purpose; skipHtml strips any literal HTML in the source.
        skipHtml
        urlTransform={urlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
