'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { API } from '@/lib/api';
import type { Project } from '@fleet/shared';
import { Kicker, Panel, Empty, ErrorBanner, Tab } from '@/components/ui';
import { codeStatusColor } from '@/lib/status';
import { FileTree } from '@/components/FileTree';
import { FileViewer } from '@/components/FileViewer';
import { DiffView } from '@/components/DiffView';

/**
 * Read-only file browser + working-tree change view (SPEC §7, §8). Two modes:
 *   - "Browse"  → lazy FileTree (left) + type-aware FileViewer (right)
 *   - "Changes" → working-tree status (GET .../git/status) + per-file syntax-colored diff
 * Rich rendering via Shiki + react-markdown (v2 spec §4 #6); lazy-loaded, plain-text fallback.
 */

interface StatusEntry {
  code: string;
  path: string;
  origPath: string | null;
}
interface ChangedDiff {
  diff: string;
  truncated: boolean;
  binary: boolean;
  error?: string;
}

function codeLabel(code: string): { text: string; color: string } {
  const c = code.trim();
  let text: string;
  if (c === '??') text = 'new';
  else if (c.includes('A')) text = 'added';
  else if (c.includes('D')) text = 'deleted';
  else if (c.includes('R')) text = 'renamed';
  else if (c.includes('M')) text = 'modified';
  else text = c || '·';
  return { text, color: codeStatusColor(text) };
}

export default function ProjectFilesPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [project, setProject] = useState<Project | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'browse' | 'changes'>('browse');

  // browse state
  const [selected, setSelected] = useState<string | null>(null);
  // FileTree owns its own per-row child state with no external refresh hook → remount via a key
  // bump to reflect a browser commit (create/delete/rename of the working tree). v2 #1.
  const [treeKey, setTreeKey] = useState(0);
  // A pending brand-new path: when this equals the selected path, FileViewer opens straight into an
  // empty editable buffer (oid-null → Commit sends no baseOid) instead of fetching the read view of
  // a not-yet-existing file. Cleared on commit/cancel/selection change. v2 #1 CREATE.
  const [newPath, setNewPath] = useState<string | null>(null);

  const editingEnabled = project?.editingEnabled ?? false;

  const selectFromTree = useCallback((p: string) => {
    setNewPath(null); // a real tree click is never the new-file flow
    setSelected(p);
  }, []);

  const onCommitted = useCallback((info: { path: string; deleted: boolean; sha: string }) => {
    setTreeKey((k) => k + 1); // remount FileTree so the new/removed path shows
    setNewPath((cur) => (cur === info.path ? null : cur)); // the new file now exists in the tree
    if (info.deleted && selected === info.path) setSelected(null); // don't re-fetch a missing path
  }, [selected]);

  // "+ New file" (create affordance): prompt a repo-relative path, then open it as a new buffer.
  const newFile = useCallback(() => {
    const p = window.prompt('New file path (relative to the repo root)', '');
    if (p == null) return;
    const rel = p.trim().replace(/^\/+/, '');
    if (!rel) return;
    setNewPath(rel);
    setSelected(rel);
  }, []);

  // changes state
  const [status, setStatus] = useState<StatusEntry[] | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [diffCache, setDiffCache] = useState<Record<string, ChangedDiff | 'loading'>>({});

  useEffect(() => {
    fetch(`${API}/api/projects/${id}`)
      .then((r) => r.json())
      .then((p) => {
        if (p?.error) setProjErr(p.error);
        else setProject(p);
      })
      .catch((e) => setProjErr(e?.message || 'failed to load project'));
  }, [id]);

  const loadStatus = useCallback(() => {
    setStatusLoading(true);
    setStatusErr(null);
    fetch(`${API}/api/projects/${id}/git/status`)
      .then((r) => r.json())
      .then((d: { entries: StatusEntry[]; error?: string }) => {
        if (d.error) setStatusErr(d.error);
        else setStatus(d.entries);
      })
      .catch((e) => setStatusErr(e?.message || 'failed to load status'))
      .finally(() => setStatusLoading(false));
  }, [id]);

  useEffect(() => {
    if (tab === 'changes' && status === null) loadStatus();
  }, [tab, status, loadStatus]);

  const toggleDiff = useCallback(
    (p: string) => {
      if (openDiff === p) {
        setOpenDiff(null);
        return;
      }
      setOpenDiff(p);
      if (!diffCache[p]) {
        setDiffCache((c) => ({ ...c, [p]: 'loading' }));
        fetch(`${API}/api/projects/${id}/git/diff?path=${encodeURIComponent(p)}`)
          .then((r) => r.json())
          .then((d: ChangedDiff) => setDiffCache((c) => ({ ...c, [p]: d })))
          .catch((e) => setDiffCache((c) => ({ ...c, [p]: { diff: '', truncated: false, binary: false, error: e?.message || 'failed' } })));
      }
    },
    [openDiff, diffCache, id],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Kicker>project · files</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">{project?.name ?? 'Files'}</h1>
          {project && <div className="font-mono text-[10px] text-faint mt-0.5">{project.rootDir}</div>}
        </div>
        <ProjectTabs id={id} active="files" />
      </div>

      {projErr && (
        <ErrorBanner className="mb-4">{projErr}</ErrorBanner>
      )}

      <div className="flex gap-2 mb-4">
        <Tab active={tab === 'browse'} onClick={() => setTab('browse')}>
          Browse
        </Tab>
        <Tab active={tab === 'changes'} onClick={() => setTab('changes')}>
          Changed files
        </Tab>
      </div>

      {tab === 'browse' ? (
        <div className="grid grid-cols-[300px_1fr] gap-3" style={{ minHeight: 560 }}>
          <Panel className="overflow-auto" style={{ maxHeight: 640 }}>
            <div className="px-3 pt-2.5 pb-1 flex items-center justify-between">
              <span className="kicker">tree</span>
              {editingEnabled && (
                <button
                  onClick={newFile}
                  title="Create a new file under the repo root and commit it"
                  className="font-mono text-[10px] text-faint hover:text-amber underline"
                >
                  ＋ new file
                </button>
              )}
            </div>
            <FileTree key={treeKey} projectId={id} selected={selected} onSelect={selectFromTree} />
          </Panel>
          <Panel className="overflow-hidden" style={{ maxHeight: 640 }}>
            <FileViewer
              key={selected ?? 'none'}
              projectId={id}
              path={selected}
              editingEnabled={editingEnabled}
              newFile={newPath != null && newPath === selected}
              onCommitted={onCommitted}
              onCancelNew={() => {
                setNewPath(null);
                setSelected(null);
              }}
            />
          </Panel>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="kicker">working tree</span>
            <button
              onClick={() => {
                setStatus(null);
                setDiffCache({});
                setOpenDiff(null);
              }}
              className="font-mono text-[10px] text-faint hover:text-amber underline"
            >
              refresh
            </button>
          </div>
          {statusLoading && status === null ? (
            <div className="font-mono text-[12px] text-faint">scanning working tree…</div>
          ) : statusErr ? (
            <ErrorBanner onRetry={loadStatus}>{statusErr}</ErrorBanner>
          ) : !status || status.length === 0 ? (
            <Empty>Working tree clean — no uncommitted changes.</Empty>
          ) : (
            <div className="border border-line2 divide-y divide-white/[0.04]">
              {status.map((s) => {
                const lbl = codeLabel(s.code);
                const isOpen = openDiff === s.path;
                const d = diffCache[s.path];
                return (
                  <div key={s.path}>
                    <button
                      onClick={() => toggleDiff(s.path)}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${isOpen ? 'bg-amber/[0.08]' : 'hover:bg-amber/[0.04]'}`}
                    >
                      <span className="select-none text-faint" style={{ width: 10 }}>{isOpen ? '▾' : '▸'}</span>
                      <span
                        className="font-display uppercase tracking-wider text-[9px] px-1.5 py-0.5 border"
                        style={{ color: lbl.color, borderColor: `${lbl.color}50`, background: `${lbl.color}12`, flex: '0 0 auto' }}
                      >
                        {lbl.text}
                      </span>
                      <span className="font-mono text-[12px] text-ink truncate">
                        {s.origPath ? `${s.origPath} → ${s.path}` : s.path}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3 pt-1">
                        {d === 'loading' || d === undefined ? (
                          <div className="font-mono text-[11px] text-faint py-2">loading diff…</div>
                        ) : (
                          <DiffView diff={d.diff} path={s.path} truncated={d.truncated} binary={d.binary} error={d.error} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectTabs({ id, active }: { id: string; active: 'board' | 'files' | 'history' | 'hub' }) {
  const tabs: { key: string; label: string; href: string }[] = [
    { key: 'hub', label: 'Hub', href: `/projects/${id}` },
    { key: 'board', label: 'Board', href: `/projects/${id}/board` },
    { key: 'files', label: 'Files', href: `/projects/${id}/files` },
    { key: 'history', label: 'History', href: `/projects/${id}/history` },
  ];
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
