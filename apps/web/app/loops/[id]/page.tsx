'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Stat, Dot, ErrorBanner } from '@/components/ui';
import { ago, clock } from '@/lib/format';
import { loopsApi, type Loop } from '@/lib/loops';

export default function LoopDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [loop, setLoop] = useState<Loop | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  async function load() {
    if (aliveRef.current) setError(null);
    try {
      const l = await loopsApi.get(id);
      if (aliveRef.current) setLoop(l);
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'failed to load loop');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function promote() {
    setBusy(true);
    try {
      const l = await loopsApi.promote(id);
      if (aliveRef.current) setLoop(l);
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'promote failed');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }
  async function demote() {
    setBusy(true);
    try {
      const l = await loopsApi.demote(id);
      if (aliveRef.current) setLoop(l);
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'demote failed');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }
  async function fire() {
    setBusy(true);
    try {
      await loopsApi.fire(id);
      await load();
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'fire failed');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (loading) return <div className="font-mono text-faint text-[12px]">loading loop…</div>;
  if (!loop) return (
    <div>
      <Link href="/loops" className="font-mono text-[11px] text-faint hover:text-amber">← loops</Link>
      <ErrorBanner className="mt-3" onRetry={load}>{error ?? 'loop not found'}</ErrorBanner>
    </div>
  );

  return (
    <div>
      <Link href="/loops" className="font-mono text-[11px] text-faint hover:text-amber">← loops</Link>
      <div className="flex items-start justify-between gap-4 mt-2 mb-5">
        <div>
          <Kicker>{loop.kind} · {loop.controlPlane}</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">{loop.name}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Btn variant="ghost" onClick={fire} disabled={busy} title="run one fire now">⚡ Fire</Btn>
          {loop.mode === 'dry-run' ? (
            <Btn variant="amber" onClick={promote} disabled={busy} title="flip dry-run → apply">▲ Promote</Btn>
          ) : (
            <Btn variant="ghost" onClick={demote} disabled={busy} title="flip apply → dry-run">▼ Demote</Btn>
          )}
        </div>
      </div>

      {error && <ErrorBanner className="mb-4" onRetry={load}>{error}</ErrorBanner>}

      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px' }}>
        <div className="grid gap-4">
          {/* judge assessment — loop's own lastEval */}
          <Panel className="p-4">
            <Kicker>judge assessment</Kicker>
            {loop.lastEval ? (
              <div className="mt-2">
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <Dot color={loop.lastEval.clean ? '#54e08a' : '#ff7a45'} live={false} size={6} />
                  <span style={{ color: loop.lastEval.clean ? '#54e08a' : '#ff7a45' }} className="font-semibold">
                    {loop.lastEval.clean ? 'clean' : 'flagged'}
                  </span>
                  <span className="text-faint">· score {loop.lastEval.score.toFixed(2)}</span>
                </div>
                <div className="mt-2 font-mono text-[11px] text-dim whitespace-pre-wrap leading-snug">{loop.lastEval.notes}</div>
              </div>
            ) : (
              <Empty>no eval yet — graded after each dry-run fire</Empty>
            )}
          </Panel>

          {/* recent fires + intended-action log */}
          <Panel className="p-4">
            <Kicker>most recent fire</Kicker>
            {loop.lastRunId ? (
              <div className="mt-2 font-mono text-[11px]">
                <Link href={`/runs/${loop.lastRunId}`} className="text-amber/80 hover:text-amber">open run {loop.lastRunId.slice(0, 8)} →</Link>
                <div className="text-faint mt-1">
                  {loop.mode === 'dry-run'
                    ? 'dry-run — intended writes were logged to the run timeline, no state changed'
                    : 'apply — real writes performed'}
                </div>
              </div>
            ) : (
              <Empty>never fired</Empty>
            )}
          </Panel>
        </div>

        {/* config sidebar */}
        <Panel className="p-4 self-start grid gap-3">
          <Stat label="mode" value={loop.mode === 'apply' ? 'apply' : `dry-run ${loop.consecutiveGoodRuns}/${loop.escalationThreshold}`} accent={loop.mode === 'apply' ? '#54e08a' : '#ffb000'} />
          <Stat label="merge posture" value={loop.mergePosture} />
          <Stat label="review policy" value={loop.reviewPolicy} />
          <Stat label="routable ceiling" value={loop.routableCeiling} />
          <Stat label="enabled" value={loop.enabled ? 'on' : 'off'} accent={loop.enabled ? '#54e08a' : '#5b626d'} />
          <Stat label="created" value={ago(loop.createdAt)} />
          <div>
            <Kicker>risk rubric</Kicker>
            {loop.riskRubric.length === 0 ? (
              <div className="font-mono text-[10px] text-faint mt-1">none</div>
            ) : (
              <div className="mt-1.5 grid gap-1 font-mono text-[10px]">
                {loop.riskRubric.map((r, i) => (
                  <div key={i} className="flex items-center justify-between border border-line px-1.5 py-0.5">
                    <span className="text-dim truncate">{r.glob}</span>
                    <span className="text-amber">{r.forceRisk}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
