'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Project } from '@fleet/shared';
import { Kicker, Panel, Empty, Btn, Field, Input, Select, Toggle, Dot } from '@/components/ui';
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

  return (
    <div>
      <Kicker>loop engineering</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-5">Loops</h1>

      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
        {/* ── loop list ─────────────────────────────────────────── */}
        <div>
          {error && (
            <div className="mb-3 border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[11px] px-3 py-2">{error}</div>
          )}
          {loading ? (
            <div className="font-mono text-faint text-[12px]">loading loops…</div>
          ) : loops.length === 0 ? (
            <Empty>No loops yet — define a Manager (triage) or Worker loop with a six-field contract to run agents on a schedule.</Empty>
          ) : (
            <div className="grid gap-3">
              {loops.map((l) => (
                <Panel key={l.id} className="p-4" style={{ borderLeft: `2px solid ${l.enabled ? KIND_COLOR[l.kind] : '#5b626d'}` }}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <Link href={`/loops/${l.id}`} className="font-display text-[14px] tracking-wide text-ink hover:text-amber">{l.name}</Link>
                        <Badge text={l.kind} color={KIND_COLOR[l.kind]} />
                        <Badge text={l.controlPlane} color={CP_COLOR[l.controlPlane]} />
                        <Badge text={modeLabel(l)} color={l.mode === 'apply' ? '#54e08a' : '#ffb000'} />
                      </div>
                      <div className="font-mono text-[11px] text-faint mt-1.5 flex items-center gap-2">
                        {l.lastEval ? (
                          <span style={{ color: l.lastEval.clean ? '#54e08a' : '#ff7a45' }}>
                            eval {l.lastEval.clean ? 'clean' : 'flagged'} · {l.lastEval.score.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-faint">no eval yet</span>
                        )}
                        {l.lastError && <span className="text-sig-failed truncate">⚠ {l.lastError}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Toggle on={l.enabled} onChange={() => toggle(l)} label={l.enabled ? 'on' : 'off'} />
                      <Link
                        href={`/loops/${l.id}`}
                        className="font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5 inline-flex items-center"
                      >
                        Detail →
                      </Link>
                      <Btn variant="danger" onClick={() => remove(l)} title="delete" className="!px-2 !py-1">✕</Btn>
                    </div>
                  </div>
                </Panel>
              ))}
            </div>
          )}
        </div>

        {/* ── create form ───────────────────────────────────────── */}
        <Panel className="p-4 self-start">
          <Kicker>new loop</Kicker>
          <div className="mt-3 grid gap-3.5">
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
            <div className="grid grid-cols-2 gap-3">
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
      </div>
    </div>
  );
}
