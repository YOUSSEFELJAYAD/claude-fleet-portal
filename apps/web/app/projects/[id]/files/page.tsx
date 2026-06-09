'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { API } from '@/lib/api';
import type { Project } from '@fleet/shared';
import { Kicker, Panel, Empty } from '@/components/ui';
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
  if (c === '??') return { text: 'new', color: '#54e08a' };
  if (c.includes('A')) return { text: 'added', color: '#54e08a' };
  if (c.includes('D')) return { text: 'deleted', color: '#ff5d5d' };
  if (c.includes('R')) return { text: 'renamed', color: '#ffb000' };
  if (c.includes('M')) return { text: 'modified', color: '#ffb000' };
  return { text: c || '·', color: '#9aa0a8' };
}

export default function ProjectFilesPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [project, setProject] = useState<Project | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'browse' | 'changes'>('browse');

  // browse state
  const [selected, setSelected] = useState<string | null>(null);

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
          <h1 className="font-display text-[24px] tracking-wide text-ink mt-1">{project?.name ?? 'Files'}</h1>
          {project && <div className="font-mono text-[10px] text-faint mt-0.5">{project.rootDir}</div>}
        </div>
        <ProjectTabs id={id} active="files" />
      </div>

      {projErr && (
        <div className="font-mono text-[12px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2 mb-4">
          {projErr}
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <SubTab on={tab === 'browse'} onClick={() => setTab('browse')}>
          Browse
        </SubTab>
        <SubTab on={tab === 'changes'} onClick={() => setTab('changes')}>
          Changed files
        </SubTab>
      </div>

      {tab === 'browse' ? (
        <div className="grid grid-cols-[300px_1fr] gap-3" style={{ minHeight: 560 }}>
          <Panel className="overflow-auto" style={{ maxHeight: 640 }}>
            <div className="kicker px-3 pt-2.5 pb-1">tree</div>
            <FileTree projectId={id} selected={selected} onSelect={setSelected} />
          </Panel>
          <Panel className="overflow-hidden" style={{ maxHeight: 640 }}>
            <FileViewer projectId={id} path={selected} />
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
            <div className="font-mono text-[12px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2">
              {statusErr} · <button onClick={loadStatus} className="underline">retry</button>
            </div>
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

function SubTab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`font-display uppercase tracking-wider text-[10px] px-3 py-1.5 border transition-colors ${
        on ? 'border-amber/60 text-amber bg-amber/8' : 'border-line2 text-faint hover:text-ink hover:border-amber/40'
      }`}
    >
      {children}
    </button>
  );
}
