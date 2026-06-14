'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Project } from '@fleet/shared';
import { Kicker, Panel, Empty, Btn, Field, Input, Select, Toggle, Dot, ErrorBanner } from '@/components/ui';
import { ContractEditor, DEFAULT_DRAFT, type ContractDraft } from '@/components/ContractEditor';
import { loopsApi, type Loop, type LoopKind, type ControlPlaneKind, type CreateLoopRequest } from '@/lib/loops';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

const KIND_COLOR: Record<LoopKind, string> = { manager: '#7aa2ff', worker: '#54e08a' };
const CP_COLOR: Record<ControlPlaneKind, string> = { board: '#ffb000', github: '#c792ea' };

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border"
      style={{ color, borderColor: `${color}50`, background: `${color}10` }}
    >
      {text}
    </span>
  );
}

function modeLabel(l: Loop): string {
  return l.mode === 'apply' ? 'apply' : `dry-run ${l.consecutiveGoodRuns}/${l.escalationThreshold}`;
}

/** A loop card — same shape/treatment as orchestrate's CampaignRow (inset status bar, dot+status,
 *  title, meta badges, footer with grade + actions) so Loops reads identically to Campaigns. */
function LoopRow({ l, onToggle, onRemove }: { l: Loop; onToggle: (l: Loop) => void; onRemove: (l: Loop) => void }) {
  const color = l.enabled ? KIND_COLOR[l.kind] : '#5b626d';
  return (
    <Panel className="p-4 group" style={{ boxShadow: `inset 2px 0 0 ${color}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Dot color={color} live={l.enabled} />
          <span className="font-display text-[10px] uppercase tracking-wider" style={{ color }}>
            {l.enabled ? 'live' : 'paused'}
          </span>
        </div>
        <span className="font-mono text-[10px] text-faint">{modeLabel(l)}</span>
      </div>
      <Link
        href={`/loops/${l.id}`}
        className="block font-display text-[13px] tracking-wide text-ink mt-2 leading-snug hover:text-amber line-clamp-1"
      >
        {l.name}
      </Link>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <Badge text={l.kind} color={KIND_COLOR[l.kind]} />
        <Badge text={l.controlPlane} color={CP_COLOR[l.controlPlane]} />
      </div>
      <div className="mt-3 flex items-center justify-between font-mono text-[11px]">
        <span className="text-dim">
          {l.lastEval ? (
            <span style={{ color: l.lastEval.clean ? '#54e08a' : '#ff7a45' }}>
              eval {l.lastEval.clean ? 'clean' : 'flagged'} · {l.lastEval.score.toFixed(2)}
            </span>
          ) : (
            <span className="text-faint">no eval yet</span>
          )}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle on={l.enabled} onChange={() => onToggle(l)} />
          <Btn variant="danger" onClick={() => onRemove(l)} title="delete" className="!px-2 !py-1">✕</Btn>
        </div>
      </div>
      {l.lastError && (
        <div className="mt-2 font-mono text-[10px] text-sig-failed truncate" title={l.lastError}>⚠ {l.lastError}</div>
      )}
    </Panel>
  );
}

export default function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // create form
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<LoopKind>('manager');
  const [controlPlane, setControlPlane] = useState<ControlPlaneKind>('board');
  const [draft, setDraft] = useState<ContractDraft>(DEFAULT_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  async function load() {
    setError(null);
    try {
      const list = await loopsApi.list();
      if (aliveRef.current) setLoops(list);
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'failed to load loops');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    fetch(API + '/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Project[]) => {
        if (!aliveRef.current) return;
        setProjects(list);
        if (list[0]?.id) setProjectId((cur) => cur || list[0].id);
      })
      .catch(() => { /* projects optional */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setFormErr(null);
    if (!name.trim()) return setFormErr('name is required');
    if (!projectId) return setFormErr('project is required');
    if (!draft.contract.evaluation.trim()) return setFormErr('contract evaluation is required');
    const body: CreateLoopRequest = {
      name: name.trim(),
      projectId,
      kind,
      controlPlane,
      contract: draft.contract,
      escalationThreshold: draft.escalationThreshold,
      mergePosture: draft.mergePosture,
      reviewPolicy: draft.reviewPolicy,
      routableCeiling: draft.routableCeiling,
      riskRubric: draft.riskRubric,
    };
    setSubmitting(true);
    try {
      await loopsApi.create(body);
      setName('');
      setDraft(DEFAULT_DRAFT);
      await load();
    } catch (e: any) {
      setFormErr(e?.message ?? 'failed to create loop');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(l: Loop) {
    try {
      const updated = await loopsApi.update(l.id, { enabled: !l.enabled });
      setLoops((prev) => prev.map((x) => (x.id === l.id ? updated : x)));
    } catch (e: any) {
      setError(e?.message ?? 'failed to update loop');
    }
  }

  async function remove(l: Loop) {
    if (!confirm(`Delete loop "${l.name}"? This cannot be undone.`)) return;
    try {
      await loopsApi.remove(l.id);
      setLoops((prev) => prev.filter((x) => x.id !== l.id));
    } catch (e: any) {
      setError(e?.message ?? 'failed to delete loop');
    }
  }

  const liveLoops = loops.filter((l) => l.enabled);
  const pausedLoops = loops.filter((l) => !l.enabled);

  return (
    <div>
      <Kicker>loop engineering</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Loops</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Define a Manager (triage) or Worker loop with a six-field contract — the portal runs it on a schedule and grades every run against its evaluation.
      </p>

      <div className="space-y-5">
        {/* ── block 1 · new loop ─────────────────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>new loop</Kicker>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Field label="name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="backlog triage" />
              </Field>
              <Field label="project">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">— select —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value as LoopKind)}>
                  <option value="manager">manager</option>
                  <option value="worker">worker</option>
                </Select>
              </Field>
              <Field label="control plane">
                <Select value={controlPlane} onChange={(e) => setControlPlane(e.target.value as ControlPlaneKind)}>
                  <option value="board">board</option>
                  <option value="github">github</option>
                </Select>
              </Field>
            </div>
            <div className="border-t hairline pt-3">
              <ContractEditor draft={draft} onChange={setDraft} onSave={create} saving={submitting} saveLabel="＋ Create Loop" />
            </div>
            {formErr && <div className="text-sig-failed font-mono text-[11px]">{formErr}</div>}
          </div>
        </Panel>

        {error && <ErrorBanner onRetry={load}>{error}</ErrorBanner>}

        {/* ── block 2 · live now ─────────────────────────────────────────── */}
        <Panel ticked>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <span className="flex items-center gap-2">
              <Dot color="#ffb000" live={liveLoops.length > 0} size={6} />
              <Kicker>live now</Kicker>
            </span>
            <span className="font-mono tnum text-[12px] text-amber">{String(liveLoops.length).padStart(2, '0')}</span>
          </div>
          <div className="p-4">
            {loading ? (
              <div className="font-mono text-[11px] text-faint">loading loops…</div>
            ) : liveLoops.length === 0 ? (
              <div className="font-mono text-[11px] text-faint">nothing live — enable a loop below to put it on schedule</div>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {liveLoops.map((l) => <LoopRow key={l.id} l={l} onToggle={toggle} onRemove={remove} />)}
              </div>
            )}
          </div>
        </Panel>

        {/* ── block 3 · paused ───────────────────────────────────────────── */}
        <Panel>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <Kicker>paused</Kicker>
            <span className="font-mono tnum text-[12px] text-dim">{String(pausedLoops.length).padStart(2, '0')}</span>
          </div>
          <div className="p-4 overflow-auto" style={{ maxHeight: '60vh' }}>
            {!loading && loops.length === 0 ? (
              <Empty>No loops yet — define a Manager (triage) or Worker loop above.</Empty>
            ) : pausedLoops.length === 0 ? (
              <div className="font-mono text-[11px] text-faint">no paused loops</div>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {pausedLoops.map((l) => <LoopRow key={l.id} l={l} onToggle={toggle} onRemove={remove} />)}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
