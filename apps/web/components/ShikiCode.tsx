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
}: {
  code: string;
  /** language hint: a file extension (with/without dot) or a fence info-string. */
  lang: string;
  className?: string;
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

  if (html == null) {
    // plain-monospace fallback (also the SSR / pre-hydration view)
    return <PlainCode code={code} className={className} />;
  }

  return (
    <div
      className={`shiki-code border border-line2 bg-black/40 overflow-auto font-mono text-[12px] leading-[1.55] ${className}`}
      // html is Shiki-generated token spans or our own escaped <pre><code>; never raw input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
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
