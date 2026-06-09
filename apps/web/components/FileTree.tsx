'use client';
import React, { useState, useCallback } from 'react';
import { API } from '@/lib/api';

/**
 * Lazy file-tree (SPEC §7). Each directory node fetches its own children on first expand via
 * `GET /api/projects/:id/files?path=<dir>` → `{ entries: LsTreeEntry[]; error? }` (non-recursive
 * `git ls-tree`, dirs-first ordering already applied server-side). No recursion up front, so a huge
 * repo never blows the payload. Selecting a blob calls `onSelect(path)`; the viewer fetches content.
 */

export interface LsTreeEntry {
  mode: string;
  type: string; // 'blob' | 'tree' | 'commit'
  oid: string;
  size: number | null;
  path: string;
  name: string;
}

async function fetchDir(projectId: string, dir: string): Promise<{ entries: LsTreeEntry[]; error?: string }> {
  const r = await fetch(`${API}/api/projects/${projectId}/files?path=${encodeURIComponent(dir)}`).catch(() => null);
  if (!r) return { entries: [], error: 'network error' };
  try {
    return (await r.json()) as { entries: LsTreeEntry[]; error?: string };
  } catch {
    return { entries: [], error: 'bad response' };
  }
}

function Row({
  entry,
  depth,
  projectId,
  selected,
  onSelect,
}: {
  entry: LsTreeEntry;
  depth: number;
  projectId: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const isDir = entry.type === 'tree';
  const isSubmodule = entry.type === 'commit';
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<LsTreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (!isDir) {
      onSelect(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      setLoading(true);
      setErr(null);
      const res = await fetchDir(projectId, entry.path);
      setLoading(false);
      if (res.error) setErr(res.error);
      else setChildren(res.entries);
    }
  }, [isDir, open, children, projectId, entry.path, onSelect]);

  const isSel = selected === entry.path;
  return (
    <div>
      <button
        onClick={toggle}
        className={`w-full text-left flex items-center gap-1.5 font-mono text-[12px] py-1 pr-2 transition-colors ${
          isSel ? 'bg-amber/[0.12] text-amber' : 'text-dim hover:text-ink hover:bg-amber/[0.04]'
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={entry.path}
      >
        <span className="select-none text-faint" style={{ width: 12, flex: '0 0 auto' }}>
          {isDir ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="select-none" style={{ flex: '0 0 auto', opacity: 0.7 }}>
          {isDir ? '▣' : isSubmodule ? '◆' : '·'}
        </span>
        <span className="truncate">{entry.name}</span>
        {entry.type === 'blob' && entry.size != null && (
          <span className="ml-auto text-faint text-[9.5px] tnum select-none">{fmtSize(entry.size)}</span>
        )}
      </button>
      {open && (
        <div>
          {loading && (
            <div className="font-mono text-[10px] text-faint py-1" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              loading…
            </div>
          )}
          {err && (
            <div className="font-mono text-[10px] text-sig-failed py-1" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              {err}
            </div>
          )}
          {children?.map((c) => (
            <Row key={c.path} entry={c} depth={depth + 1} projectId={projectId} selected={selected} onSelect={onSelect} />
          ))}
          {children && children.length === 0 && !loading && (
            <div className="font-mono text-[10px] text-faint py-1" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}k`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function FileTree({
  projectId,
  selected,
  onSelect,
}: {
  projectId: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [roots, setRoots] = useState<LsTreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const res = await fetchDir(projectId, '');
    setLoading(false);
    if (res.error) setErr(res.error);
    else setRoots(res.entries);
  }, [projectId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading && roots === null) return <div className="font-mono text-[11px] text-faint p-3">loading tree…</div>;
  if (err)
    return (
      <div className="font-mono text-[11px] text-sig-failed p-3">
        {err} · <button onClick={() => void load()} className="underline">retry</button>
      </div>
    );
  if (!roots || roots.length === 0) return <div className="font-mono text-[11px] text-faint p-3">empty repo</div>;
  return (
    <div className="py-1">
      {roots.map((e) => (
        <Row key={e.path} entry={e} depth={0} projectId={projectId} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}
