'use client';
import React, { useEffect, useState } from 'react';
import type { ColorToken } from '@/lib/shiki';

/**
 * Unified-diff renderer (v2 spec §4 #6).
 *
 * Parsing is unchanged from v1: split raw unified-diff text on \n and classify each line by its
 * leading char (add / del / context / hunk header / file-meta / truncation), tracking the
 * old/new line numbers parsed from each `@@` hunk header.
 *
 * NEW in v2: per-line SYNTAX COLORING. The changed file's extension (`path`) is mapped to a Shiki
 * language (fallback `text`); each add/del/context line's TEXT is tokenized with the shared Shiki
 * highlighter (lazy dynamic import — never blocks paint) and rendered as colored token spans.
 * The add/del row BACKGROUND tint and the +/- sign column stay exactly as before; Shiki supplies
 * only the per-token foreground colors. While the highlighter loads, or on any failure, every line
 * renders as plain text in its kind color — a safe fallback that is always legible.
 */

type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta' | 'trunc';

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  // `git show <hash>` prefixes a commit/Author/Date/<message> preamble before the first `diff --git`.
  // Render it as header (meta) lines with no gutter numbers, rather than mis-numbering it as context.
  let inPatch = false;
  for (const raw of diff.split('\n')) {
    const line = raw;
    if (!inPatch) {
      if (line.startsWith('diff --git') || line.startsWith('@@')) {
        inPatch = true;
      } else {
        out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const m = line.match(HUNK_RE);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('rename ') ||
      line.startsWith('similarity ') ||
      line.startsWith('Binary files')
    ) {
      out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith('… ') || line.startsWith('[truncated') || line.includes('… truncated')) {
      out.push({ kind: 'trunc', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
      continue;
    }
    if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
      continue;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      continue;
    }
    // context line (leading space, or empty inside a hunk)
    out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
  }
  // git diffs end with a trailing newline → drop the empty tail line we created
  while (out.length && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop();
  return out;
}

const KIND_STYLE: Record<LineKind, { bg: string; fg: string; sign: string }> = {
  add: { bg: 'rgba(84,224,138,0.08)', fg: '#9ff0bd', sign: '+' },
  del: { bg: 'rgba(255,93,93,0.08)', fg: '#ffb3b3', sign: '-' },
  ctx: { bg: 'transparent', fg: '#9aa0a8', sign: ' ' },
  hunk: { bg: 'rgba(255,176,0,0.07)', fg: '#ffb000', sign: ' ' },
  meta: { bg: 'transparent', fg: '#6b727c', sign: ' ' },
  trunc: { bg: 'rgba(255,176,0,0.05)', fg: '#7b828c', sign: ' ' },
};

/** Lines whose code content we syntax-color (headers/meta/trunc keep their flat kind color). */
const CODE_KINDS = new Set<LineKind>(['add', 'del', 'ctx']);

/** Derive a Shiki lang hint from the changed file path (fallback handled downstream → `text`). */
function extFromPath(p: string | null | undefined): string {
  if (!p) return 'text';
  const clean = p.split(' → ').pop() || p; // rename "old → new" → use the new path
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  return dot > slash ? clean.slice(dot + 1).toLowerCase() : 'text';
}

export function DiffView({
  diff,
  path,
  truncated = false,
  binary = false,
  error,
}: {
  diff: string;
  /** changed file path → per-line syntax language (optional; falls back to plain text). */
  path?: string | null;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}) {
  const lang = extFromPath(path);
  const lines = React.useMemo(() => (diff && diff.trim() ? parseDiff(diff) : []), [diff]);

  // Per-line token map: index → colored tokens. Populated lazily once the highlighter loads.
  const [tokenMap, setTokenMap] = useState<Record<number, ColorToken[]> | null>(null);

  useEffect(() => {
    if (!lines.length || lang === 'text') {
      setTokenMap(null);
      return;
    }
    let alive = true;
    setTokenMap(null);
    import('@/lib/shiki')
      .then(async ({ highlightLineTokens }) => {
        const map: Record<number, ColorToken[]> = {};
        await Promise.all(
          lines.map(async (ln, i) => {
            if (CODE_KINDS.has(ln.kind) && ln.text) {
              map[i] = await highlightLineTokens(ln.text, lang);
            }
          }),
        );
        if (alive) setTokenMap(map);
      })
      .catch(() => {
        // leave tokenMap null → plain-text fallback per kind color
      });
    return () => {
      alive = false;
    };
  }, [lines, lang]);

  if (error) {
    return (
      <div className="font-mono text-[12px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2">
        git error — {error}
      </div>
    );
  }
  if (binary) {
    return <div className="font-mono text-[12px] text-faint border border-line2 px-3 py-3">Binary file — diff not shown.</div>;
  }
  if (!diff || !diff.trim()) {
    return <div className="font-mono text-[12px] text-faint border border-dashed border-line2 px-3 py-3">No changes.</div>;
  }
  return (
    <div className="border border-line2 bg-black/40 overflow-auto">
      <pre className="font-mono text-[11.5px] leading-[1.55] m-0" style={{ tabSize: 2 }}>
        {lines.map((ln, i) => {
          const s = KIND_STYLE[ln.kind];
          const toks = tokenMap?.[i];
          return (
            <div key={i} className="flex" style={{ background: s.bg }}>
              <span
                className="select-none text-right tnum"
                style={{ width: 44, paddingRight: 8, color: '#5a616b', flex: '0 0 auto' }}
              >
                {ln.oldNo ?? ''}
              </span>
              <span
                className="select-none text-right tnum"
                style={{ width: 44, paddingRight: 8, color: '#5a616b', flex: '0 0 auto' }}
              >
                {ln.newNo ?? ''}
              </span>
              <span className="select-none" style={{ width: 14, color: s.fg, flex: '0 0 auto', textAlign: 'center' }}>
                {ln.kind === 'add' || ln.kind === 'del' ? s.sign : ''}
              </span>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                {toks && CODE_KINDS.has(ln.kind) ? (
                  toks.map((t, j) => (
                    <span key={j} style={{ color: t.color ?? s.fg }}>
                      {t.content}
                    </span>
                  ))
                ) : (
                  <span style={{ color: s.fg }}>{ln.text || ' '}</span>
                )}
              </span>
            </div>
          );
        })}
      </pre>
      {truncated && (
        <div className="font-mono text-[10px] text-faint border-t border-line2 px-3 py-1.5 bg-amber/[0.04]">
          … diff truncated (server cap reached)
        </div>
      )}
    </div>
  );
}
