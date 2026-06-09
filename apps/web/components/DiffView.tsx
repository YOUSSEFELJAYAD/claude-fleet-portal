'use client';
import React from 'react';

/**
 * Hand-rolled unified-diff renderer (SPEC §7, ZERO new deps — no react-diff-view).
 *
 * Splits raw unified-diff text on \n and colors each line by its first char:
 *   - `+ ` additions (green)   - `- ` deletions (red)   - context (dim)
 *   - `@@ … @@` hunk headers (amber)   - `diff --git` / `index` / `+++` / `---` file headers (faint)
 * Renders line numbers parsed from each hunk header so the gutter tracks both sides.
 * Purely presentational; the server already caps the payload (~600 lines / 64KB) and appends a
 * truncation marker, so this component just needs to render whatever string it is handed.
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

export function DiffView({
  diff,
  truncated = false,
  binary = false,
  error,
}: {
  diff: string;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}) {
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
  const lines = parseDiff(diff);
  return (
    <div className="border border-line2 bg-black/40 overflow-auto">
      <pre className="font-mono text-[11.5px] leading-[1.55] m-0" style={{ tabSize: 2 }}>
        {lines.map((ln, i) => {
          const s = KIND_STYLE[ln.kind];
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
              <span style={{ color: s.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>{ln.text || ' '}</span>
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
