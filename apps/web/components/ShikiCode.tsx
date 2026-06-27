'use client';
import React, { useEffect, useState } from 'react';

/**
 * Syntax-highlighted code block (v2 spec §4 #6).
 *
 * Renders `code` with the shared Shiki highlighter, which is pulled in via a DYNAMIC import
 * inside the effect — so the heavy highlighter never lands in the initial page chunk and never
 * blocks first paint. While the highlighter loads (or if it fails / the lang is unknown) we
 * render a safe plain-monospace fallback with the same gutter, so content is always visible.
 *
 * Shiki output is sanitized by construction: `highlightToHtml` returns either Shiki-generated
 * token spans or our own HTML-escaped text — the raw `code` is never injected unescaped.
 */
export function ShikiCode({
  code,
  lang,
  className = '',
  copyable = false,
}: {
  code: string;
  /** language hint: a file extension (with/without dot) or a fence info-string. */
  lang: string;
  className?: string;
  /** show a hover copy-to-clipboard button (chat/markdown opt-in; off for tool cards/diffs). */
  copyable?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    import('@/lib/shiki')
      .then(({ highlightToHtml }) => highlightToHtml(code, lang))
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        // leave html null → plain-text fallback stays mounted
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const body = html == null
    // plain-monospace fallback (also the SSR / pre-hydration view)
    ? <PlainCode code={code} className={copyable ? '' : className} />
    : (
      <div
        className={`shiki-code border border-line2 bg-black/40 overflow-auto font-mono text-[12px] leading-[1.55] ${copyable ? '' : className}`}
        // html is Shiki-generated token spans or our own escaped <pre><code>; never raw input.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );

  if (!copyable) return body;
  return (
    <div className={`relative group ${className}`}>
      <CopyCodeButton code={code} />
      {body}
    </div>
  );
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy code"
      title={copied ? 'Copied!' : 'Copy code'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable */ }
      }}
      className="absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded text-[10px] font-sans bg-[#16181d]/80 border border-white/[0.1] text-faint hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
    >
      {copied ? '✓' : 'copy'}
    </button>
  );
}

function PlainCode({ code, className = '' }: { code: string; className?: string }) {
  const lines = code.split('\n');
  return (
    <div className={`border border-line2 bg-black/40 overflow-auto ${className}`}>
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
