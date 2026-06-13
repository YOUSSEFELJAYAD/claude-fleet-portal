'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRunStream } from '@/lib/live';
import { api, API } from '@/lib/api';
import { statusMeta } from '@/lib/status';
import { LIVE_STATUSES } from '@fleet/shared';
import { usd, tokens, dur } from '@/lib/format';
import { Panel, Kicker, StatusBadge, Gauge, Btn, Stat, Input, ErrorBanner } from '@/components/ui';
import { Tree } from '@/components/Tree';
import { Timeline } from '@/components/Timeline';
import { Waterfall } from '@/components/Waterfall'; // A1
import { FlowGraph } from '@/components/FlowGraph'; // A11
import { ScorePanel } from '@/components/ScorePanel'; // A7
import { TagBar } from '@/components/TagBar'; // A8
import { SessionPanel } from '@/components/SessionPanel'; // H11
import { OtelOverlay } from '@/components/OtelOverlay'; // A12

export default function RunDetail({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const { run, nodes, tree, events, partials, connected, error, truncatedBefore } = useRunStream(id);
  const [selected, setSelected] = useState<string>(id);
  const [raw, setRaw] = useState(false);
  const [inputText, setInputText] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [showResume, setShowResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  // F3 — retrieve retriedBy (the run that retried this one, if any)
  const [retriedBy, setRetriedBy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.getRun(id).then((r) => { if (alive) setRetriedBy(r.retriedBy); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);

  const live = run ? LIVE_STATUSES.includes(run.status) : false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const nodeEvents = useMemo(() => events.filter((e) => e.nodeId === selected), [events, selected]);
  const selectedNode = nodes.find((n) => n.id === selected);
  const elapsed = run ? (run.endedAt ?? Date.now()) - run.startedAt : 0;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <div className="font-mono text-faint text-[13px]">
        <Link href="/" className="text-amber">← fleet</Link>
        <div className="mt-8">
          {error ? (
            <span className="text-sig-failed">run unavailable — {error}</span>
          ) : connected ? (
            'loading run…'
          ) : (
            'connecting to control plane…'
          )}
        </div>
      </div>
    );
  }

  const m = statusMeta(run.status);
  // §24 — engine add-on runs (codex/opencode) are one-shot: resume/input/permission
  // are server-rejected 409s, so the page must not offer them.
  const isEngineRun = !!run.engine && run.engine !== 'claude';
  const permReq = [...events].reverse().find((e) => e.type === 'permission_request');
  const permReqId = String((permReq?.payload as any)?.requestId ?? 'pending');

  return (
    <div>
      <Link href="/" className="font-display text-[11px] uppercase tracking-wider text-faint hover:text-amber">← fleet</Link>

      {/* header */}
      <div className="flex items-start justify-between gap-6 mt-3 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusBadge status={run.status} big />
            {isEngineRun && (
              <span className="font-display text-[10px] border px-2 py-0.5 uppercase tracking-wider text-sig-running border-sig-running/[0.33]">
                ◍ {run.engine} engine
              </span>
            )}
            {run.killReason && (
              <span
                className="font-display text-[10px] border px-2 py-0.5 uppercase tracking-wider text-sig-failed border-sig-failed/[0.33]"
                title={run.error ?? undefined}
              >
                {run.killReason === 'timeout' ? '⏱ timed out (maxRunMinutes)' : run.killReason === 'budget' ? '$ budget kill' : '■ stopped by operator'}
              </span>
            )}
            {run.ultracode && <span className="font-display text-[10px] text-sig-failed border border-sig-failed/40 px-2 py-0.5 uppercase tracking-wider">⚡ ultracode</span>}
            <span className="font-mono text-[10px] text-faint">{id.slice(0, 13)}</span>
          </div>
          <h1 className="text-ink text-[17px] mt-2 leading-snug max-w-3xl">{run.task}</h1>
          <div className="font-mono text-[11px] text-faint mt-1.5 flex gap-3 flex-wrap">
            <span>{run.model}</span>
            {!isEngineRun && (
              <>
                <span>·</span>
                <span className="text-dim">effort {run.effort}{run.fastMode ? ' · fast' : ''}</span>
              </>
            )}
            <span>·</span>
            <span className="truncate">{run.cwd}</span>
          </div>
          {/* F3 — retry chain links */}
          {(run.retryOf || retriedBy) && (
            <div className="font-mono text-[11px] mt-1.5 flex gap-3 flex-wrap">
              {run.retryOf && (
                <Link href={`/runs/${run.retryOf}`} className="text-amber hover:underline">
                  ↩ retry of {run.retryOf.slice(0, 8)}
                </Link>
              )}
              {retriedBy && (
                <Link href={`/runs/${retriedBy}`} className="text-amber hover:underline">
                  ↪ retried as {retriedBy.slice(0, 8)}
                </Link>
              )}
            </div>
          )}
          {run.error && (run.status === 'failed' || run.status === 'killed') && (
            <ErrorBanner className="mt-2 max-w-3xl">{run.error.slice(0, 400)}</ErrorBanner>
          )}
        </div>

        {/* controls */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex gap-2">
            {live && (
              <Btn variant="danger" onClick={() => act(() => api.stop(id))} disabled={busy}>
                ■ Stop
              </Btn>
            )}
            {!live && !isEngineRun && (
              <Btn variant="amber" onClick={() => setShowResume((s) => !s)} disabled={busy}>
                ↻ Resume
              </Btn>
            )}
            {!live && (
              <Btn
                variant="danger"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    if (!confirm('Delete this run from history? This cannot be undone.')) return;
                    await api.deleteRun(id);
                    router.push('/');
                  })
                }
              >
                🗑 Delete
              </Btn>
            )}
          </div>
          {run.status === 'awaiting-permission' && (
            <div className="flex gap-2">
              <Btn variant="amber" onClick={() => act(() => api.permission(id, permReqId, 'approve'))}>✓ Approve</Btn>
              <Btn variant="danger" onClick={() => act(() => api.permission(id, permReqId, 'deny'))}>✕ Deny</Btn>
            </div>
          )}
          {/* A9 — export (anchors: Content-Disposition makes them download in place) */}
          <div className="flex gap-2">
            <a href={`${API}/api/agents/${id}/export?format=json`} className="font-display uppercase tracking-wider text-[10px] px-2 py-1 border border-line2 text-faint hover:text-amber hover:border-amber/60">↓ JSON</a>
            <a href={`${API}/api/agents/${id}/export?format=md`} className="font-display uppercase tracking-wider text-[10px] px-2 py-1 border border-line2 text-faint hover:text-amber hover:border-amber/60">↓ MD</a>
          </div>
        </div>
      </div>

      {showResume && !live && !isEngineRun && (
        <Panel className="p-3 mb-4 flex gap-2 items-center">
          <Input value={resumeText} onChange={(e) => setResumeText(e.target.value)} placeholder="follow-up instruction for the resumed session…" className="flex-1" />
          <Btn variant="solid" disabled={busy} onClick={() => act(async () => { await api.resume(id, resumeText || 'Continue.', true); setShowResume(false); setResumeText(''); })}>Resume ▶</Btn>
        </Panel>
      )}

      {/* metrics strip */}
      <Panel className="p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-5 items-center">
          <div className="md:col-span-2">
            <Gauge value={run.costUsd} cap={run.budgetUsd} label={`cost / budget${run.budgetUsd ? ' $' + run.budgetUsd : ''}`} />
            <div className="font-mono tnum text-[20px] mt-1.5" style={{ color: run.budgetUsd && run.costUsd / run.budgetUsd >= 0.8 ? '#ff5d5d' : '#ffb000' }}>
              {usd(run.costUsd)}
            </div>
          </div>
          <Stat label="tokens out" value={tokens(run.tokensOut)} sub={`${tokens(run.tokensIn)} ctx`} />
          <Stat label="elapsed" value={dur(elapsed)} accent="#e9e7df" />
          <Stat label="subagents" value={<span>{run.subagentCount}{run.liveSubagents > 0 && <span className="text-amber"> · {run.liveSubagents} live</span>}</span>} sub={`max depth ${run.maxDepth}`} />
          <Stat label="exit" value={run.exitCode == null ? '—' : run.exitCode} accent={m.color} />
        </div>
      </Panel>

      {/* result banner */}
      {run.resultText && (
        <Panel className="p-4 mb-4" ticked>
          <Kicker>final result</Kicker>
          <div className="text-ink text-[13px] mt-1.5 leading-relaxed whitespace-pre-wrap">{run.resultText}</div>
        </Panel>
      )}

      {/* H11 — session/init panel (what this run actually got) */}
      <SessionPanel events={events} />

      {/* A12 — OpenTelemetry overlay (per-source cost/tokens + tool decisions, via H6 OTLP) */}
      <OtelOverlay runId={id} live={live} />

      {/* A8 tags + A7 scoring */}
      <Panel className="p-3 mb-4">
        <TagBar runId={id} />
      </Panel>
      <div className="mb-4">
        <ScorePanel runId={id} />
      </div>

      {/* split: tree | timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <Panel className="overflow-hidden self-start">
          <div className="px-4 py-2.5 border-b hairline flex items-center justify-between">
            <Kicker>workflow tree</Kicker>
            <span className="font-mono text-[10px] text-faint">{nodes.length} node{nodes.length === 1 ? '' : 's'}</span>
          </div>
          <div className="max-h-[560px] overflow-y-auto px-2 py-1">
            <Tree root={tree} selected={selected} onSelect={setSelected} />
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <div className="px-4 py-2.5 border-b hairline flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Kicker>timeline</Kicker>
              <span className="font-mono text-[11px] text-dim truncate">
                {selectedNode ? `${selectedNode.nodeType} · ${selectedNode.label}` : 'root'}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {live && <span className="font-mono text-[9px] text-sig-running animate-pulseGlow">● LIVE</span>}
              <button onClick={() => setRaw((r) => !r)} className={`font-mono text-[10px] px-2 py-1 border border-line2 hover:border-amber/50 ${raw ? 'text-amber' : 'text-dim'}`}>
                raw
              </button>
            </div>
          </div>
          <div className="px-4 py-2 max-h-[560px] overflow-y-auto">
            {truncatedBefore != null && (
              <div className="font-mono text-[10px] text-amber/80 border border-amber/20 bg-amber/[0.04] px-2 py-1 mb-2">
                ⚠ earlier events (before seq {truncatedBefore}) omitted from this snapshot — showing the most-recent 5000
              </div>
            )}
            <Timeline events={nodeEvents} partial={partials[selected]} raw={raw} />
          </div>
          {run.status === 'awaiting-input' && (
            <div className="px-4 py-3 border-t hairline flex gap-2">
              <Input value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="send a follow-up message…" className="flex-1"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.repeat && !busy && inputText.trim()) act(async () => { await api.input(id, inputText); setInputText(''); }); }} />
              <Btn variant="amber" disabled={busy || !inputText.trim()} onClick={() => act(async () => { await api.input(id, inputText); setInputText(''); })}>Send ▶</Btn>
            </div>
          )}
        </Panel>
      </div>

      {/* A1 — span waterfall (own collapsible section) */}
      <div className="mt-4">
        <Waterfall nodes={nodes} events={events} runStartedAt={run.startedAt} />
      </div>

      {/* A11 — agent flow graph */}
      <Panel className="overflow-hidden mt-4">
        <div className="px-4 py-2.5 border-b hairline flex items-center justify-between">
          <Kicker>flow graph</Kicker>
          <span className="font-mono text-[10px] text-faint">{nodes.length} node{nodes.length === 1 ? '' : 's'}</span>
        </div>
        <div className="px-2 py-2">
          <FlowGraph nodes={nodes} />
        </div>
      </Panel>
    </div>
  );
}
