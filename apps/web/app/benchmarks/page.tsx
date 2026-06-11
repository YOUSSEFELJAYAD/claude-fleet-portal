'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type Benchmark, type BenchmarkDetail, type BenchmarkVariant, type CreateBenchmarkRequest } from '@/lib/api';
import { usd, ago, dur } from '@/lib/format';
import { Panel, Kicker, Field, Input, Textarea, Select, Toggle, Btn, Empty, Dot } from '@/components/ui';
import type { AgentTemplate } from '@fleet/shared';

// ── thinking level option sets (mirrors LaunchModal) ──────────────────────────

const CLAUDE_THINKING_LEVELS = [
  { value: '', label: 'default (adaptive)' },
  { value: 'off', label: 'off — no thinking' },
  { value: 'think', label: 'think · 4K budget' },
  { value: 'megathink', label: 'megathink · 10K' },
  { value: 'ultrathink', label: 'ultrathink · 32K' },
];

const ENGINE_THINKING_LEVELS: Record<string, Array<{ value: string; label: string }>> = {
  codex: [
    { value: '', label: 'engine default' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
  ],
  opencode: [
    { value: '', label: 'engine default' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'max', label: 'max' },
  ],
};

// ── types (mirrors benchmarks.ts server types) ────────────────────────────────


// ── helpers ───────────────────────────────────────────────────────────────────

function statusColor(s: string): string {
  if (s === 'completed') return '#54e08a';
  if (s === 'running' || s === 'judging') return '#ffb000';
  if (s === 'failed') return '#ff5d5d';
  if (s === 'killed') return '#9aa1ab';
  return '#5b626d';
}

function runStatusColor(s: string): string {
  if (s === 'completed') return '#54e08a';
  if (s === 'running' || s === 'starting' || s === 'orchestrating') return '#ffb000';
  if (s === 'failed') return '#ff5d5d';
  if (s === 'killed') return '#9aa1ab';
  return '#5b626d';
}

const ENGINES = ['claude', 'codex', 'opencode'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_VARIANT: BenchmarkVariant = { engine: 'claude', model: 'claude-opus-4-8', effort: 'high' };

// ── BenchmarkCard ─────────────────────────────────────────────────────────────
// Deliberately NOT wrapped in <Link> — there is no /benchmarks/:id page.
// Clicking a card triggers in-page selection (pollDetail) via the parent div's onClick.

function BenchmarkCard({ b }: { b: Benchmark }) {
  const live = b.status === 'running' || b.status === 'judging';
  const color = statusColor(b.status);
  return (
    <Panel className="p-4 hover:border-amber/40 transition-colors group cursor-pointer" style={{ boxShadow: `inset 2px 0 0 ${color}` }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Dot color={color} live={live} />
          <span className="font-display text-[10px] uppercase tracking-wider" style={{ color }}>{b.status}</span>
        </div>
        <span className="font-mono text-[10px] text-faint">{ago(b.createdAt)}</span>
      </div>
      <div className="text-ink text-[13px] mt-2 leading-snug line-clamp-2 group-hover:text-white">{b.prompt}</div>
      <div className="mt-3 flex items-center justify-between font-mono text-[11px]">
        <span className="text-dim">{b.mode} · {b.variants.length} variants</span>
        {b.winnerRunId && <span className="text-amber">winner decided</span>}
      </div>
    </Panel>
  );
}

// ── VariantRow ────────────────────────────────────────────────────────────────

function VariantRow({
  variant,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  variant: BenchmarkVariant;
  index: number;
  onChange: (v: BenchmarkVariant) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="border hairline p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-dim">variant {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} className="font-mono text-[11px] text-faint hover:text-red-400">✕</button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <Field label="label">
          <Input
            value={variant.label ?? ''}
            placeholder={`variant-${index + 1}`}
            onChange={(e) => onChange({ ...variant, label: e.target.value || undefined })}
          />
        </Field>
        <Field label="engine">
          <Select value={variant.engine} onChange={(e) => onChange({ ...variant, engine: e.target.value as any })}>
            {ENGINES.map((eng) => <option key={eng} value={eng}>{eng}</option>)}
          </Select>
        </Field>
        <Field label="effort">
          <Select value={variant.effort ?? 'high'} onChange={(e) => onChange({ ...variant, effort: e.target.value })}>
            {EFFORTS.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
          </Select>
        </Field>
        {variant.engine === 'claude' ? (
          <Field label="model">
            <Input
              value={variant.model ?? ''}
              placeholder="claude-opus-4-8"
              onChange={(e) => onChange({ ...variant, model: e.target.value || undefined })}
            />
          </Field>
        ) : (
          <Field label="engine model">
            <Input
              value={variant.engineModel ?? ''}
              placeholder="engine default"
              onChange={(e) => onChange({ ...variant, engineModel: e.target.value || undefined })}
            />
          </Field>
        )}
        <Field label="thinking level">
          {variant.engine === 'claude' ? (
            <Select
              value={variant.thinkingLevel ?? ''}
              onChange={(e) => onChange({ ...variant, thinkingLevel: e.target.value || undefined })}
            >
              {CLAUDE_THINKING_LEVELS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          ) : (
            <Select
              value={variant.thinkingLevel ?? ''}
              onChange={(e) => onChange({ ...variant, thinkingLevel: e.target.value || undefined })}
            >
              {(ENGINE_THINKING_LEVELS[variant.engine] ?? ENGINE_THINKING_LEVELS['codex']).map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </div>
  );
}

// ── ResultsTable ──────────────────────────────────────────────────────────────

function ResultsTable({ detail }: { detail: BenchmarkDetail }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr className="text-left text-faint border-b hairline">
            <th className="pb-2 pr-4">variant</th>
            <th className="pb-2 pr-4">engine</th>
            <th className="pb-2 pr-4">status</th>
            <th className="pb-2 pr-4">duration</th>
            <th className="pb-2 pr-4">tokens</th>
            <th className="pb-2 pr-4">cost</th>
            <th className="pb-2">result preview</th>
          </tr>
        </thead>
        <tbody>
          {detail.rollups.map((r) => (
            <tr key={r.runId} className="border-b hairline/50 hover:bg-white/[.03]">
              <td className="py-2 pr-4">
                <Link href={`/runs/${r.runId}`} className="hover:text-amber">
                  {r.isWinner ? '⭐ ' : ''}{r.label}
                </Link>
              </td>
              <td className="py-2 pr-4 text-dim">{r.engine}{r.model ? `·${r.model.slice(0, 16)}` : ''}</td>
              <td className="py-2 pr-4">
                <span style={{ color: runStatusColor(r.status) }}>{r.status}</span>
              </td>
              <td className="py-2 pr-4 tnum text-dim">{r.durationMs != null ? dur(r.durationMs) : '—'}</td>
              <td className="py-2 pr-4 tnum text-dim">{r.tokensIn + r.tokensOut > 0 ? (r.tokensIn + r.tokensOut).toLocaleString() : '—'}</td>
              <td className="py-2 pr-4 tnum text-amber">{r.costUsd > 0 ? usd(r.costUsd) : '—'}</td>
              <td className="py-2 text-faint max-w-[300px] truncate">{r.resultPreview ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function BenchmarksPage() {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [benchmarkList, setBenchmarkList] = useState<Benchmark[]>([]);

  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('/Users/jd');
  const [mode, setMode] = useState<'matrix' | 'best-of-n'>('matrix');
  const [variants, setVariants] = useState<BenchmarkVariant[]>([
    { ...DEFAULT_VARIANT },
    { ...DEFAULT_VARIANT, model: 'claude-haiku-4-5' },
  ]);
  const [judgeTemplate, setJudgeTemplate] = useState('');
  const [budgetStr, setBudgetStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // selected benchmark detail
  const [selected, setSelected] = useState<BenchmarkDetail | null>(null);

  const aliveRef = useRef(true);
  // ── #28: generation token — incremented on each pollDetail call, cancels prior chain ──
  const pollGenRef = useRef(0);

  const reload = () =>
    api.benchmarks().then((list) => {
      if (aliveRef.current) setBenchmarkList(list);
    }).catch(() => {});

  const pollDetail = (id: string) => {
    if (!aliveRef.current) return;
    // Mint a new generation token; any in-flight chain from a previous id or call
    // will see a stale token and stop applying results / scheduling further polls.
    const gen = ++pollGenRef.current;
    const tick = () => {
      if (!aliveRef.current || pollGenRef.current !== gen) return;
      api.getBenchmark(id).then((d) => {
        if (!aliveRef.current || pollGenRef.current !== gen) return;
        setSelected(d);
        if (d.status === 'running' || d.status === 'judging') {
          setTimeout(tick, 2000);
        } else {
          reload();
        }
      }).catch(() => {});
    };
    tick();
  };

  useEffect(() => {
    aliveRef.current = true;
    api.templates().then(setTemplates).catch(() => {});
    reload();
    const t = setTimeout(function tick() {
      if (!aliveRef.current) return;
      reload();
      setTimeout(tick, 3000);
    }, 3000);
    return () => {
      aliveRef.current = false;
      clearTimeout(t);
    };
  }, []);

  function addVariant() {
    if (variants.length >= 4) return;
    setVariants([...variants, { ...DEFAULT_VARIANT }]);
  }

  function removeVariant(i: number) {
    if (variants.length <= 2) return;
    setVariants(variants.filter((_, idx) => idx !== i));
  }

  function updateVariant(i: number, v: BenchmarkVariant) {
    const next = [...variants];
    next[i] = v;
    setVariants(next);
  }

  async function launch() {
    if (!prompt.trim()) { setErr('prompt required'); return; }
    setBusy(true);
    setErr(null);
    try {
      const body: CreateBenchmarkRequest = {
        prompt,
        cwd,
        mode,
        variants,
        ...(mode === 'best-of-n' && judgeTemplate ? { judgeTemplate } : {}),
        ...(budgetStr.trim() ? { budgetPerRunUsd: Number(budgetStr) } : {}),
      };
      const b = await api.createBenchmark(body);
      setBenchmarkList((prev) => [b, ...prev]);
      pollDetail(b.id);
      setSelected({ ...b, rollups: [] });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function killBenchmark(id: string) {
    try {
      await api.killBenchmark(id);
      reload();
      if (selected?.id === id) {
        api.getBenchmark(id).then(setSelected).catch(() => {});
      }
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const liveBenchmarks = benchmarkList.filter((b) => b.status === 'running' || b.status === 'judging');
  const doneBenchmarks = benchmarkList.filter((b) => b.status !== 'running' && b.status !== 'judging');

  return (
    <div>
      <Kicker>F4+F5</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Benchmarks</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Run the same prompt across multiple engine/model variants and compare results. Best-of-N mode uses a judge agent to pick a winner.
      </p>

      <div className="space-y-5">
        {/* ── block 1 · new benchmark ───────────────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>new benchmark</Kicker>
          </div>
          <div className="p-4 space-y-4">
            <Field label="prompt">
              <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Task to run across all variants…" autoFocus />
            </Field>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Field label="working directory">
                <Input value={cwd} onChange={(e) => setCwd(e.target.value)} />
              </Field>
              <div>
                <Kicker>mode</Kicker>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    on={mode === 'best-of-n'}
                    onChange={(v) => setMode(v ? 'best-of-n' : 'matrix')}
                    label={mode === 'best-of-n' ? 'best-of-N' : 'matrix'}
                  />
                </div>
              </div>
              {mode === 'best-of-n' && (
                <Field label="judge template" hint="optional">
                  <Select value={judgeTemplate} onChange={(e) => setJudgeTemplate(e.target.value)}>
                    <option value="">— model default —</option>
                    {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="budget / variant" hint="blank = no limit">
                <Input type="number" step="0.5" value={budgetStr} onChange={(e) => setBudgetStr(e.target.value)} placeholder="no limit" />
              </Field>
            </div>

            {/* variants */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Kicker>variants ({variants.length}/4)</Kicker>
                {variants.length < 4 && (
                  <button onClick={addVariant} className="font-mono text-[11px] text-amber hover:text-white">+ add variant</button>
                )}
              </div>
              <div className="space-y-2">
                {variants.map((v, i) => (
                  <VariantRow
                    key={i}
                    variant={v}
                    index={i}
                    onChange={(updated) => updateVariant(i, updated)}
                    onRemove={() => removeVariant(i)}
                    canRemove={variants.length > 2}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <Btn variant="solid" onClick={launch} disabled={busy}>{busy ? 'Launching…' : '⚗ Run Benchmark'}</Btn>
              {err && <span className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{err}</span>}
            </div>
          </div>
        </Panel>

        {/* ── block 2 · live now ────────────────────────────────────────────── */}
        <Panel ticked>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <span className="flex items-center gap-2">
              <Dot color="#ffb000" live={liveBenchmarks.length > 0} size={6} />
              <Kicker>live now</Kicker>
            </span>
            <span className="font-mono tnum text-[12px] text-amber">{String(liveBenchmarks.length).padStart(2, '0')}</span>
          </div>
          <div className="p-4">
            {liveBenchmarks.length === 0 ? (
              <div className="font-mono text-[11px] text-faint">nothing running — launch a benchmark above</div>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {liveBenchmarks.map((b) => (
                  <div key={b.id} onClick={() => pollDetail(b.id)} className="cursor-pointer">
                    <BenchmarkCard b={b} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        {/* ── block 3 · results ─────────────────────────────────────────────── */}
        {selected && (
          <Panel ticked>
            <div className="flex items-center justify-between px-4 py-3 border-b hairline">
              <div className="flex items-center gap-2">
                <Dot color={statusColor(selected.status)} live={selected.status === 'running' || selected.status === 'judging'} size={6} />
                <Kicker>{selected.mode} · {selected.status}</Kicker>
              </div>
              <div className="flex items-center gap-3">
                {(selected.status === 'running' || selected.status === 'judging') && (
                  <button onClick={() => killBenchmark(selected.id)} className="font-mono text-[11px] text-faint hover:text-red-400">✕ kill</button>
                )}
                <button onClick={() => setSelected(null)} className="font-mono text-[11px] text-faint hover:text-ink">dismiss</button>
              </div>
            </div>
            <div className="p-4 space-y-3">
              <div className="font-mono text-[11px] text-dim line-clamp-2">{selected.prompt}</div>
              {selected.judgeRunId && (
                <div className="font-mono text-[11px] text-dim">
                  judge: <Link href={`/runs/${selected.judgeRunId}`} className="text-amber hover:underline">{selected.judgeRunId.slice(0, 8)}…</Link>
                </div>
              )}
              {selected.rollups.length > 0 ? (
                <ResultsTable detail={selected} />
              ) : (
                <div className="font-mono text-[11px] text-faint">waiting for runs…</div>
              )}
            </div>
          </Panel>
        )}

        {/* ── past benchmarks ───────────────────────────────────────────────── */}
        <Panel>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <Kicker>finished</Kicker>
            <span className="font-mono tnum text-[12px] text-dim">{String(doneBenchmarks.length).padStart(2, '0')}</span>
          </div>
          <div className="p-4 overflow-auto" style={{ maxHeight: '50vh' }}>
            {doneBenchmarks.length === 0 ? (
              <Empty>No finished benchmarks yet.</Empty>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {doneBenchmarks.map((b) => (
                  <div key={b.id} onClick={() => pollDetail(b.id)} className="cursor-pointer">
                    <BenchmarkCard b={b} />
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
