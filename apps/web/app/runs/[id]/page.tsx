'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRunStream } from '@/lib/live';
import { api } from '@/lib/api';
import { statusMeta } from '@/lib/status';
import { LIVE_STATUSES } from '@fleet/shared';
import { usd, tokens, dur } from '@/lib/format';
import { Panel, Kicker, StatusBadge, Gauge, Btn, Stat, Input } from '@/components/ui';
import { Tree } from '@/components/Tree';
import { Timeline } from '@/components/Timeline';

export default function RunDetail({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const { run, nodes, tree, events, partials, connected } = useRunStream(id);
  const [selected, setSelected] = useState<string>(id);
  const [raw, setRaw] = useState(false);
  const [inputText, setInputText] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [showResume, setShowResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);

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
        <div className="mt-8">{connected ? 'loading run…' : 'connecting to control plane…'}</div>
      </div>
    );
  }

  const m = statusMeta(run.status);

  return (
    <div>
      <Link href="/" className="font-display text-[11px] uppercase tracking-wider text-faint hover:text-amber">← fleet</Link>

      {/* header */}
      <div className="flex items-start justify-between gap-6 mt-3 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusBadge status={run.status} big />
            {run.ultracode && <span className="font-display text-[10px] text-sig-failed border border-sig-failed/40 px-2 py-0.5 uppercase tracking-wider" style={{ color: '#ff5d5d' }}>⚡ ultracode</span>}
            <span className="font-mono text-[10px] text-faint">{id.slice(0, 13)}</span>
          </div>
          <h1 className="text-ink text-[17px] mt-2 leading-snug max-w-3xl">{run.task}</h1>
          <div className="font-mono text-[11px] text-faint mt-1.5 flex gap-3 flex-wrap">
            <span>{run.model}</span>
            <span>·</span>
            <span className="text-dim">effort {run.effort}{run.fastMode ? ' · fast' : ''}</span>
            <span>·</span>
            <span className="truncate">{run.cwd}</span>
          </div>
        </div>

        {/* controls */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex gap-2">
            {live && (
              <Btn variant="danger" onClick={() => act(() => api.stop(id))} disabled={busy}>
                ■ Stop
              </Btn>
            )}
            {!live && (
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
              <Btn variant="amber" onClick={() => act(() => api.permission(id, 'pending', 'approve'))}>✓ Approve</Btn>
              <Btn variant="danger" onClick={() => act(() => api.permission(id, 'pending', 'deny'))}>✕ Deny</Btn>
            </div>
          )}
        </div>
      </div>

      {showResume && !live && (
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
              {live && <span className="font-mono text-[9px] text-sig-running animate-pulseGlow" style={{ color: '#39d4cf' }}>● LIVE</span>}
              <button onClick={() => setRaw((r) => !r)} className="font-mono text-[10px] px-2 py-1 border border-line2 hover:border-amber/50" style={{ color: raw ? '#ffb000' : '#9aa1ab' }}>
                raw
              </button>
            </div>
          </div>
          <div className="px-4 py-2 max-h-[560px] overflow-y-auto">
            <Timeline events={nodeEvents} partial={partials[selected]} raw={raw} />
          </div>
          {run.status === 'awaiting-input' && (
            <div className="px-4 py-3 border-t hairline flex gap-2">
              <Input value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="send a follow-up message…" className="flex-1"
                onKeyDown={(e) => { if (e.key === 'Enter' && inputText.trim()) act(async () => { await api.input(id, inputText); setInputText(''); }); }} />
              <Btn variant="amber" disabled={busy || !inputText.trim()} onClick={() => act(async () => { await api.input(id, inputText); setInputText(''); })}>Send ▶</Btn>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
