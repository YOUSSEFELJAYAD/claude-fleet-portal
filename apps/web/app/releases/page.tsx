'use client';
import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ReleaseInfo, ReleaseStatus, SelfUpdateResult } from '@fleet/shared';
import { Panel, Kicker, Btn, Stat, ErrorBanner } from '@/components/ui';
import { MarkdownView } from '@/components/MarkdownView';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ReleasesPage() {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [list, setList] = useState<ReleaseInfo[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<SelfUpdateResult | null>(null);
  const [updateErr, setUpdateErr] = useState<string | null>(null);

  function load(force = false) {
    setChecking(true);
    setLoadErr(null);
    Promise.all([api.releaseStatus(force), api.releases()])
      .then(([s, l]) => {
        setStatus(s);
        setList(l.releases);
      })
      .catch((e: any) => setLoadErr(e?.message || 'failed to load release status'))
      .finally(() => setChecking(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function update() {
    if (!confirm('Update the portal from GitHub now?\n\ngit pull --ff-only + pnpm install will run in the repo. Dev watchers reload automatically.')) return;
    setUpdating(true);
    setUpdateErr(null);
    setUpdateResult(null);
    try {
      const res = await api.selfUpdate();
      setUpdateResult(res);
      load(true);
    } catch (e: any) {
      // the route returns the structured result even on failure status codes — j() throws
      // with the server message; surface it
      setUpdateErr(e?.message || 'update failed');
    } finally {
      setUpdating(false);
    }
  }

  if (loadErr) {
    return (
      <div>
        <Kicker>release</Kicker>
        <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-4">Releases & Updates</h1>
        <ErrorBanner onRetry={() => load()}>{loadErr}</ErrorBanner>
      </div>
    );
  }
  if (!status) return <div className="font-mono text-faint text-[12px]">checking version…</div>;

  const s = status;

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <Kicker>release</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Releases & Updates</h1>
        </div>
        <div className="flex items-center gap-2">
          <Btn onClick={() => load(true)} disabled={checking}>
            {checking ? 'checking…' : '↻ Check now'}
          </Btn>
          {s.updateAvailable && s.canSelfUpdate && (
            <Btn variant="solid" onClick={update} disabled={updating}>
              {updating ? 'updating…' : `⇪ Update to ${s.latest?.tag}`}
            </Btn>
          )}
        </div>
      </div>

      {/* ── version strip ── */}
      <Panel className="p-4 mb-5 grid grid-cols-2 md:grid-cols-4 gap-5">
        <Stat label="installed version" value={`v${s.currentVersion}`} />
        <Stat label="commit" value={s.currentSha ?? '—'} />
        <Stat label="latest release" value={s.latest ? s.latest.tag : '—'} accent={s.updateAvailable ? '#ffb000' : undefined} />
        <Stat
          label="status"
          value={s.repo == null ? 'not linked' : s.updateAvailable ? 'update available' : 'up to date'}
          accent={s.updateAvailable ? '#ffb000' : s.repo ? '#54e08a' : undefined}
        />
      </Panel>

      {/* ── update banner / not-linked explainer ── */}
      {s.repo == null ? (
        <Panel className="p-4 mb-5">
          <div className="font-mono text-[12px] text-dim leading-relaxed">
            No GitHub repo linked — update checks are off. Either push this repo and add an{' '}
            <span className="text-amber">origin</span> remote (
            <span className="text-ink">git remote add origin https://github.com/you/claude-fleet-portal.git</span>
            ), or set <span className="text-amber">FLEET_GITHUB_REPO=owner/repo</span> in the server environment.
            Versions are compared against the repo&apos;s GitHub Releases.
          </div>
        </Panel>
      ) : (
        <div className="mb-5 font-mono text-[11px] text-faint">
          tracking{' '}
          <a href={`https://github.com/${s.repo}/releases`} target="_blank" rel="noreferrer" className="text-amber underline">
            github.com/{s.repo}
          </a>
          {s.checkedAt && <> · last checked {new Date(s.checkedAt).toLocaleTimeString()}</>}
          {s.error && <span className="text-sig-failed"> · check failed: {s.error}</span>}
          {s.updateAvailable && !s.canSelfUpdate && (
            <span className="text-amber"> · update available, but no git origin remote — pull manually</span>
          )}
        </div>
      )}

      {/* ── macOS Gatekeeper note (the desktop app is open-source, not Apple-notarized) ── */}
      <Panel className="p-4 mb-5">
        <Kicker> macOS · first open of a downloaded app</Kicker>
        <div className="font-mono text-[11.5px] text-dim leading-relaxed mt-2">
          Gatekeeper warns once — <span className="text-ink">&quot;Apple could not verify … is free of malware&quot;</span> —
          because the desktop app is open-source and not Apple-notarized. One-time fix, either way:
          <div className="mt-2 text-[11px]">
            <span className="text-amber">$</span> <span className="text-ink">xattr -cr &quot;/Applications/Claude Fleet Portal.app&quot;</span>
            <span className="text-faint"> — then open normally</span>
          </div>
          <div className="mt-1 text-[11px]">
            or open it once → <span className="text-ink">System Settings → Privacy &amp; Security → &quot;Open Anyway&quot;</span> → launch again
          </div>
        </div>
      </Panel>

      {/* ── self-update output ── */}
      {updateErr && (
        <Panel className="p-4 mb-5">
          <Kicker>update failed</Kicker>
          <div className="font-mono text-[11.5px] mt-2 text-sig-failed">{updateErr}</div>
        </Panel>
      )}
      {updateResult && (
        <Panel className="p-4 mb-5">
          <Kicker>{updateResult.ok ? 'update applied' : 'update failed'}</Kicker>
          <div className="mt-2 space-y-2">
            {updateResult.steps.map((st, i) => (
              <div key={i}>
                <div className={`font-mono text-[11px] ${st.ok ? 'text-sig-completed' : 'text-sig-failed'}`}>
                  {st.ok ? '✓' : '✕'} {st.step}
                </div>
                {st.output && (
                  <pre className="font-mono text-[10px] text-dim whitespace-pre-wrap mt-1 px-3 py-2 border border-line2 overflow-auto" style={{ maxHeight: 160 }}>
                    {st.output}
                  </pre>
                )}
              </div>
            ))}
            <div className="font-mono text-[11px] text-dim">{updateResult.note}</div>
          </div>
        </Panel>
      )}

      {/* ── changelog ── */}
      <Kicker className="mb-3">changelog</Kicker>
      {list.length === 0 ? (
        <Panel className="p-4">
          <div className="font-mono text-[12px] text-faint">
            {s.repo ? 'No GitHub releases published yet — tag one (e.g. v0.2.0) and it appears here.' : 'Link a GitHub repo to see its releases here.'}
          </div>
        </Panel>
      ) : (
        <div className="space-y-4">
          {list.map((r) => {
            const isCurrent = r.tag.replace(/^v/i, '') === s.currentVersion;
            return (
              <Panel key={r.tag} className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="font-display text-[14px] text-ink tracking-wide">{r.name || r.tag}</span>
                    <span className="font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 border text-dim border-line">{r.tag}</span>
                    {r.prerelease && (
                      <span className="font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 border text-amber border-amber/25">
                        pre-release
                      </span>
                    )}
                    {isCurrent && (
                      <span className="font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 border text-sig-completed border-sig-completed/25">
                        installed
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-faint">
                    {fmtDate(r.publishedAt)} ·{' '}
                    <a href={r.url} target="_blank" rel="noreferrer" className="underline hover:text-amber">
                      view on GitHub ↗
                    </a>
                  </div>
                </div>
                {r.body && (
                  <div className="mt-3 border-t hairline pt-3">
                    <MarkdownView source={r.body} />
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
