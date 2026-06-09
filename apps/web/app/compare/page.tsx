'use client';
import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Panel, Kicker, Empty, StatusBadge, Btn, Input, Field } from '@/components/ui';
import { usd, tokens, dur } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

// local minimal shape — we only read the fields we render (cannot import server types)
type RunStatus =
  | 'starting'
  | 'running'
  | 'awaiting-input'
  | 'awaiting-permission'
  | 'orchestrating'
  | 'completed'
  | 'failed'
  | 'killed';

interface Run {
  id: string;
  task: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  subagentCount: number;
  maxDepth: number;
  resultText: string | null;
}

interface Side {
  run: Run | null;
  loading: boolean;
  error: string | null;
}

const blank = (): Side => ({ run: null, loading: false, error: null });

const GREEN = '#54e08a';
const RED = '#ff5d5d';

// duration in ms; null while still running (no endedAt)
function runDur(r: Run): number | null {
  return r.endedAt == null ? null : r.endedAt - r.startedAt;
}

/** colorize a delta: lower=better metrics (cost/tokens/duration) → green when b<a. */
function deltaColor(a: number | null, b: number | null, lowerBetter: boolean): string {
  if (a == null || b == null || a === b) return '#9aa1ab';
  const bBetter = lowerBetter ? b < a : b > a;
  return bBetter ? GREEN : RED;
}

function pctDelta(a: number | null, b: number | null): string {
  if (a == null || b == null) return '—';
  const d = b - a;
  if (d === 0) return '±0';
  const sign = d > 0 ? '+' : '−';
  const pct = a !== 0 ? Math.round((Math.abs(d) / a) * 100) : null;
  return `${sign}${pct == null ? '' : pct + '%'}`.trim() || `${sign}`;
}

export default function ComparePage() {
  return (
    <Suspense fallback={<div className="font-mono text-faint text-[12px]">loading…</div>}>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const params = useSearchParams();
  const router = useRouter();

  const aId = params.get('a') ?? '';
  const bId = params.get('b') ?? '';

  const [draftA, setDraftA] = useState(aId);
  const [draftB, setDraftB] = useState(bId);
  const [a, setA] = useState<Side>(blank());
  const [b, setB] = useState<Side>(blank());

  // keep drafts synced when URL changes externally (back/forward, link)
  useEffect(() => setDraftA(aId), [aId]);
  useEffect(() => setDraftB(bId), [bId]);

  useEffect(() => loadSide(aId, setA), [aId]);
  useEffect(() => loadSide(bId, setB), [bId]);

  function loadSide(id: string, set: React.Dispatch<React.SetStateAction<Side>>) {
    if (!id) {
      set(blank());
      return;
    }
    set({ run: null, loading: true, error: null });
    let cancelled = false;
    fetch(`${API}/api/agents/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) {
          let msg = r.statusText;
          try {
            msg = (await r.json()).error ?? msg;
          } catch {
            /* ignore */
          }
          throw new Error(msg || `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ run: Run }>;
      })
      .then((d) => {
        if (cancelled) return;
        set({ run: d.run, loading: false, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        set({ run: null, loading: false, error: e?.message || 'fetch failed' });
      });
    return () => {
      cancelled = true;
    };
  }

  function applyDrafts(e: React.FormEvent) {
    e.preventDefault();
    const p = new URLSearchParams();
    if (draftA.trim()) p.set('a', draftA.trim());
    if (draftB.trim()) p.set('b', draftB.trim());
    const qs = p.toString();
    router.push(qs ? `/compare?${qs}` : '/compare');
  }

  function swap() {
    const p = new URLSearchParams();
    if (bId) p.set('a', bId);
    if (aId) p.set('b', aId);
    const qs = p.toString();
    router.push(qs ? `/compare?${qs}` : '/compare');
  }

  const ra = a.run;
  const rb = b.run;
  const bothLoaded = !!ra && !!rb;

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>analysis</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Run Comparison</h1>
        </div>
        <Link href="/history" className="font-mono text-[11px] text-faint hover:text-amber transition-colors">
          ← history
        </Link>
      </div>

      {/* ── id selectors ─────────────────────────────────────── */}
      <Panel className="p-4 mb-4">
        <form onSubmit={applyDrafts} className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <Field label="run A · id">
              <Input
                value={draftA}
                onChange={(e) => setDraftA(e.target.value)}
                placeholder="run id…"
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="flex-1 min-w-[200px]">
            <Field label="run B · id">
              <Input
                value={draftB}
                onChange={(e) => setDraftB(e.target.value)}
                placeholder="run id…"
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Btn type="submit" variant="amber">
              Compare
            </Btn>
            <Btn variant="ghost" onClick={swap} disabled={!aId && !bId} title="swap A and B">
              ⇄ Swap
            </Btn>
          </div>
        </form>
      </Panel>

      {!aId && !bId ? (
        <Empty>
          Pick two runs to compare — paste their ids above, or open one from{' '}
          <Link href="/history" className="text-amber hover:underline">
            History
          </Link>
          .
        </Empty>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 120px 1fr' }}>
          {/* ── column A ──────────────────────────────────────── */}
          <SideHeader label="run A" side={a} />
          <div />
          <SideHeader label="run B" side={b} />

          {/* metric rows w/ delta column */}
          {bothLoaded && (
            <>
              <MetricRow
                label="status"
                a={<StatusBadge status={ra!.status} />}
                b={<StatusBadge status={rb!.status} />}
                delta={ra!.status === rb!.status ? '=' : '≠'}
                deltaCol={ra!.status === rb!.status ? '#9aa1ab' : '#ffb000'}
              />
              <MetricRow
                label="cost"
                a={<span className="font-mono tnum text-ink text-[13px]">{usd(ra!.costUsd)}</span>}
                b={<span className="font-mono tnum text-ink text-[13px]">{usd(rb!.costUsd)}</span>}
                delta={pctDelta(ra!.costUsd, rb!.costUsd)}
                deltaCol={deltaColor(ra!.costUsd, rb!.costUsd, true)}
              />
              <MetricRow
                label="tokens in"
                a={<span className="font-mono tnum text-dim text-[13px]">{tokens(ra!.tokensIn)}</span>}
                b={<span className="font-mono tnum text-dim text-[13px]">{tokens(rb!.tokensIn)}</span>}
                delta={pctDelta(ra!.tokensIn, rb!.tokensIn)}
                deltaCol={deltaColor(ra!.tokensIn, rb!.tokensIn, true)}
              />
              <MetricRow
                label="tokens out"
                a={<span className="font-mono tnum text-dim text-[13px]">{tokens(ra!.tokensOut)}</span>}
                b={<span className="font-mono tnum text-dim text-[13px]">{tokens(rb!.tokensOut)}</span>}
                delta={pctDelta(ra!.tokensOut, rb!.tokensOut)}
                deltaCol={deltaColor(ra!.tokensOut, rb!.tokensOut, true)}
              />
              <MetricRow
                label="duration"
                a={<span className="font-mono tnum text-dim text-[13px]">{dur(runDur(ra!))}</span>}
                b={<span className="font-mono tnum text-dim text-[13px]">{dur(runDur(rb!))}</span>}
                delta={pctDelta(runDur(ra!), runDur(rb!))}
                deltaCol={deltaColor(runDur(ra!), runDur(rb!), true)}
              />
              <MetricRow
                label="subagents"
                a={<span className="font-mono tnum text-dim text-[13px]">{ra!.subagentCount}</span>}
                b={<span className="font-mono tnum text-dim text-[13px]">{rb!.subagentCount}</span>}
                delta={pctDelta(ra!.subagentCount, rb!.subagentCount)}
                deltaCol={deltaColor(ra!.subagentCount, rb!.subagentCount, false)}
              />
              <MetricRow
                label="max depth"
                a={<span className="font-mono tnum text-dim text-[13px]">{ra!.maxDepth}</span>}
                b={<span className="font-mono tnum text-dim text-[13px]">{rb!.maxDepth}</span>}
                delta={pctDelta(ra!.maxDepth, rb!.maxDepth)}
                deltaCol={deltaColor(ra!.maxDepth, rb!.maxDepth, false)}
              />

              {/* ── result text ─────────────────────────────────── */}
              <div className="col-span-3 mt-2">
                <Kicker>result text</Kicker>
              </div>
              <ResultPanel run={ra!} />
              <div />
              <ResultPanel run={rb!} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SideHeader({ label, side }: { label: string; side: Side }) {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between mb-2">
        <Kicker>{label}</Kicker>
        {side.run && <StatusBadge status={side.run.status} />}
      </div>
      {side.loading ? (
        <div className="font-mono text-faint text-[12px]">loading…</div>
      ) : side.error ? (
        <div className="font-mono text-sig-failed text-[12px]">⚠ {side.error}</div>
      ) : side.run ? (
        <div className="min-w-0">
          <Link
            href={`/runs/${side.run.id}`}
            className="text-ink text-[13px] hover:text-amber transition-colors block truncate"
            title={side.run.task}
          >
            {side.run.task}
          </Link>
          <div className="text-faint font-mono text-[10px] mt-1 truncate">
            {side.run.model} · {side.run.id}
          </div>
        </div>
      ) : (
        <div className="font-mono text-faint text-[12px]">no run selected</div>
      )}
    </Panel>
  );
}

function MetricRow({
  label,
  a,
  b,
  delta,
  deltaCol,
}: {
  label: string;
  a: React.ReactNode;
  b: React.ReactNode;
  delta: React.ReactNode;
  deltaCol: string;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-2.5 border hairline bg-black/20">
        <Kicker>{label}</Kicker>
        <div className="text-right">{a}</div>
      </div>
      <div className="flex items-center justify-center px-2 py-2.5">
        <span className="font-mono tnum text-[11px]" style={{ color: deltaCol }}>
          {delta}
        </span>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 border hairline bg-black/20">
        <Kicker>{label}</Kicker>
        <div className="text-right">{b}</div>
      </div>
    </>
  );
}

function ResultPanel({ run }: { run: Run }) {
  return (
    <Panel className="p-4">
      {run.resultText ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] text-dim leading-relaxed max-h-[420px] overflow-auto">
          {run.resultText}
        </pre>
      ) : (
        <div className="font-mono text-faint text-[12px]">no result text</div>
      )}
    </Panel>
  );
}
