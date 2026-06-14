'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { API } from '@/lib/api';
import type { Project } from '@fleet/shared';
import { Kicker, Panel, ErrorBanner, Btn } from '@/components/ui';
import { ProjectTabs } from '@/components/ProjectTabs';
import { GitLog, type GitLogEntry } from '@/components/GitLog';
import { DiffView } from '@/components/DiffView';

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
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">{project?.name ?? 'History'}</h1>
          {project && <div className="font-mono text-[10px] text-faint mt-0.5">{project.rootDir}</div>}
        </div>
        <ProjectTabs id={id} active="history" />
      </div>

      <div className="grid grid-cols-[420px_1fr] gap-3" style={{ minHeight: 560 }}>
        <Panel>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <Kicker>commits</Kicker>
            <span className="flex items-center gap-3">
              <span className="font-mono tnum text-[12px] text-dim">{String(entries?.length ?? 0).padStart(2, '0')}</span>
              <Btn variant="ghost" onClick={loadLog}>refresh</Btn>
            </span>
          </div>
          <div className="p-4">
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
        </Panel>

        <Panel>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <Kicker>commit diff</Kicker>
            {selected && (
              <span className="font-mono tnum text-[12px] text-dim">
                {selected.slice(0, 12)}
                {show?.truncated && <span className="text-amber"> · truncated</span>}
              </span>
            )}
          </div>
          <div className="overflow-auto" style={{ maxHeight: 600 }}>
            {!selected ? (
              <div className="font-mono text-[12px] text-faint h-full flex items-center justify-center p-4">
                Select a commit to view its diff.
              </div>
            ) : showLoading ? (
              <div className="font-mono text-[12px] text-faint p-4">loading commit {selected.slice(0, 8)}…</div>
            ) : (
              <div className="p-3">
                <DiffView diff={show?.text ?? ''} truncated={show?.truncated} error={show?.error} />
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
