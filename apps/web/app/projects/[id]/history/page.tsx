'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { API } from '@/lib/api';
import type { Project } from '@fleet/shared';
import { Kicker, Panel, ErrorBanner } from '@/components/ui';
import { GitLog, type GitLogEntry } from '@/components/GitLog';
import { DiffView } from '@/components/DiffView';

/** Inline per-project tab nav (kept local to avoid cross-page imports; routes owned by sibling pages). */
function ProjectTabs({ id, active }: { id: string; active: 'board' | 'files' | 'history' | 'hub' }) {
  const tabs = [
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
            active === t.key ? 'border-amber/60 text-amber bg-amber/8' : 'border-line2 text-faint hover:text-ink hover:border-amber/40'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * Per-project git history (SPEC §7, §8): `GET .../git/log` → commit list (merge markers) →
 * click → `GET .../git/show` → full commit diff rendered with the same hand-rolled DiffView.
 * Read-only; zero new deps.
 */

interface GitShowResult {
  text: string;
  truncated: boolean;
  error?: string;
}

export default function ProjectHistoryPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [project, setProject] = useState<Project | null>(null);
  const [entries, setEntries] = useState<GitLogEntry[] | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [show, setShow] = useState<GitShowResult | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const latestHashRef = useRef<string | null>(null);

  useEffect(() => {
    fetch(`${API}/api/projects/${id}`)
      .then((r) => r.json())
      .then((p) => !p?.error && setProject(p))
      .catch(() => {});
  }, [id]);

  const loadLog = useCallback(() => {
    setLogLoading(true);
    setLogErr(null);
    fetch(`${API}/api/projects/${id}/git/log`)
      .then((r) => r.json())
      .then((d: { entries: GitLogEntry[]; error?: string }) => {
        if (d.error) setLogErr(d.error);
        else setEntries(d.entries);
      })
      .catch((e) => setLogErr(e?.message || 'failed to load log'))
      .finally(() => setLogLoading(false));
  }, [id]);

  useEffect(() => {
    loadLog();
  }, [loadLog]);

  const selectCommit = useCallback(
    (hash: string) => {
      latestHashRef.current = hash;
      setSelected(hash);
      setShow(null);
      setShowLoading(true);
      fetch(`${API}/api/projects/${id}/git/show?hash=${encodeURIComponent(hash)}`)
        .then((r) => r.json())
        .then((d: GitShowResult) => {
          if (latestHashRef.current === hash) setShow(d);
        })
        .catch((e) => {
          if (latestHashRef.current === hash) setShow({ text: '', truncated: false, error: e?.message || 'failed' });
        })
        .finally(() => {
          if (latestHashRef.current === hash) setShowLoading(false);
        });
    },
    [id],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Kicker>project · history</Kicker>
          <h1 className="font-display text-[24px] tracking-wide text-ink mt-1">{project?.name ?? 'History'}</h1>
          {project && <div className="font-mono text-[10px] text-faint mt-0.5">{project.rootDir}</div>}
        </div>
        <ProjectTabs id={id} active="history" />
      </div>

      <div className="grid grid-cols-[420px_1fr] gap-3" style={{ minHeight: 560 }}>
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="kicker">commits</span>
            <button onClick={loadLog} className="font-mono text-[10px] text-faint hover:text-amber underline">
              refresh
            </button>
          </div>
          {logLoading && entries === null ? (
            <div className="font-mono text-[12px] text-faint">reading git log…</div>
          ) : logErr ? (
            <ErrorBanner onRetry={loadLog}>{logErr}</ErrorBanner>
          ) : (
            <div className="overflow-auto" style={{ maxHeight: 600 }}>
              <GitLog entries={entries ?? []} selected={selected} onSelect={selectCommit} />
            </div>
          )}
        </div>

        <Panel className="overflow-auto" style={{ maxHeight: 640 }}>
          {!selected ? (
            <div className="font-mono text-[12px] text-faint h-full flex items-center justify-center">
              Select a commit to view its diff.
            </div>
          ) : showLoading ? (
            <div className="font-mono text-[12px] text-faint p-4">loading commit {selected.slice(0, 8)}…</div>
          ) : (
            <div className="p-3">
              <div className="font-mono text-[10px] text-faint mb-2">
                commit <span className="text-dim">{selected.slice(0, 12)}</span>
                {show?.truncated && <span className="text-amber"> · truncated</span>}
              </div>
              <DiffView diff={show?.text ?? ''} truncated={show?.truncated} error={show?.error} />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
