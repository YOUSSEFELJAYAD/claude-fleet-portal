'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Field, Input, Toggle, Dot } from '@/components/ui';
import { ago, usd } from '@/lib/format';
import type { LearnerConfig, LearnedSkill } from '@fleet/shared';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

// ── learned-skill status coloring ───────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  ok: '#54e08a',
  skipped: '#9aa1ab',
  failed: '#ff5d5d',
};
const statusColor = (s: string) => STATUS_COLOR[s] ?? '#9aa1ab';

function StatusBadge({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      className="font-display inline-flex items-center gap-1.5 uppercase tracking-wider"
      style={{
        color,
        fontSize: 9.5,
        border: `1px solid ${color}40`,
        background: `${color}12`,
        padding: '2px 6px',
        letterSpacing: '0.12em',
      }}
    >
      <Dot color={color} size={6} />
      {status}
    </span>
  );
}

export default function LearningPage() {
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const [skills, setSkills] = useState<LearnedSkill[]>([]);
  const [cfg, setCfg] = useState<LearnerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadSkills() {
    try {
      const r = await fetch(API + '/api/learner/skills');
      if (!r.ok) throw new Error('failed to load learned skills');
      if (alive.current) setSkills(await r.json());
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to load');
    }
  }

  async function loadConfig() {
    try {
      const r = await fetch(API + '/api/learner');
      if (!r.ok) throw new Error('failed to load config');
      if (alive.current) setCfg(await r.json());
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to load');
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([loadSkills(), loadConfig()]).finally(() => { if (alive.current) setLoading(false); });

    // unmount-safe polling — new skills land autonomously on run completion
    let t: ReturnType<typeof setTimeout>;
    function poll() {
      if (!alive.current) return;
      loadSkills().finally(() => {
        if (alive.current) t = setTimeout(poll, 6000);
      });
    }
    t = setTimeout(poll, 6000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveConfig() {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(API + '/api/learner', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (!r.ok) {
        let msg = 'failed to save';
        try { msg = (await r.json()).error ?? msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      if (alive.current) setCfg(await r.json());
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to save');
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function removeSkill(id: string) {
    if (!window.confirm('Delete this learned skill? Removes its SKILL.md from ~/.claude/skills and the RAG copy.')) return;
    setDeletingId(id);
    setError(null);
    try {
      const r = await fetch(API + `/api/learner/skills/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('failed to delete');
      await loadSkills();
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to delete');
    } finally {
      if (alive.current) setDeletingId(null);
    }
  }

  const okCount = skills.filter((s) => s.status === 'ok').length;
  const enabled = !!cfg?.enabled;

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>autonomy</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 flex items-center gap-2.5">
            Skill Learning
            <span className="inline-flex items-center gap-1.5" title={enabled ? 'autonomous learning is ON' : 'disabled'}>
              <Dot color={enabled ? '#54e08a' : '#5b626d'} live={enabled} size={7} />
              <span className="font-mono text-[11px]" style={{ color: enabled ? '#54e08a' : '#5b626d' }}>
                {enabled ? 'live' : 'off'}
              </span>
            </span>
          </h1>
        </div>
        <div className="text-right font-mono text-[11px] text-faint">
          <span className="text-sig-completed tnum">{okCount}</span> learned ·{' '}
          <span className="text-ink tnum">{skills.length}</span> attempts
        </div>
      </div>

      {error && (
        <div className="mb-4 border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[12px] px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        {/* ── learned skills feed ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <Kicker>learned skills</Kicker>
            <span className="font-mono text-[10px] text-faint">→ attachable in Templates</span>
          </div>

          {loading ? (
            <div className="font-mono text-faint text-[12px]">loading…</div>
          ) : skills.length === 0 ? (
            <Empty>No skills learned yet. Enable the loop, then complete a complex run.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="divide-y divide-white/[0.04]">
                {skills.map((s) => (
                  <div key={s.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5">
                      <StatusBadge status={s.status} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-ink text-[12.5px] leading-snug break-words font-mono">
                        {s.name || <span className="text-faint">— ({s.status})</span>}
                      </div>
                      {s.error && (
                        <div className="mt-0.5 font-mono text-[10px] text-sig-failed truncate" title={s.error}>
                          {s.error}
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-faint flex-wrap">
                        <span>{ago(s.createdAt)}</span>
                        <span title="cost of the run we learned from">from {usd(s.sourceCostUsd)} run</span>
                        <Link href={`/runs/${s.sourceRunId}`} className="text-dim hover:text-amber transition-colors">
                          view run →
                        </Link>
                        {s.ragPath && <span className="text-sig-completed/70" title={s.ragPath}>· indexed</span>}
                      </div>
                    </div>
                    <Btn
                      variant="danger"
                      onClick={() => removeSkill(s.id)}
                      disabled={deletingId === s.id}
                      className="!px-1.5 !py-0.5 text-[11px] shrink-0"
                      title="delete this learned skill"
                    >
                      {deletingId === s.id ? '…' : '✕'}
                    </Btn>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        {/* ── config panel ── */}
        <div>
          <Kicker className="mb-3 block">loop config</Kicker>
          <Panel className="p-4">
            {!cfg ? (
              <div className="font-mono text-faint text-[12px]">loading…</div>
            ) : (
              <div className="space-y-4">
                <Toggle
                  on={cfg.enabled}
                  onChange={(v) => setCfg({ ...cfg, enabled: v })}
                  label="autonomous learning"
                />

                <div className="font-mono text-[10px] text-faint leading-relaxed border-l-2 border-amber/40 pl-2">
                  A completed operator run qualifies if it meets <span className="text-dim">any</span> threshold below.
                </div>

                <Field label="min cost" hint="usd">
                  <Input
                    type="number" min={0} step="0.1"
                    value={cfg.minCostUsd}
                    onChange={(e) => setCfg({ ...cfg, minCostUsd: Math.max(0, Number(e.target.value)) })}
                  />
                </Field>

                <Field label="min subagents" hint="count">
                  <Input
                    type="number" min={0} step="1"
                    value={cfg.minSubagents}
                    onChange={(e) => setCfg({ ...cfg, minSubagents: Math.max(0, Number(e.target.value)) })}
                  />
                </Field>

                <Field label="min depth" hint="tree depth">
                  <Input
                    type="number" min={0} step="1"
                    value={cfg.minDepth}
                    onChange={(e) => setCfg({ ...cfg, minDepth: Math.max(0, Number(e.target.value)) })}
                  />
                </Field>

                <Field label="min duration" hint="minutes">
                  <Input
                    type="number" min={0} step="1"
                    value={cfg.minDurationMs / 60000}
                    onChange={(e) => setCfg({ ...cfg, minDurationMs: Math.max(0, Number(e.target.value)) * 60000 })}
                  />
                </Field>

                <Field label="max per day" hint="runaway cap">
                  <Input
                    type="number" min={1} step="1"
                    value={cfg.maxPerDay}
                    onChange={(e) => setCfg({ ...cfg, maxPerDay: Math.max(1, Math.floor(Number(e.target.value))) })}
                  />
                </Field>

                <div className="flex gap-2 pt-1">
                  <Btn variant="solid" onClick={saveConfig} disabled={saving}>
                    {saving ? 'saving…' : 'save'}
                  </Btn>
                </div>

                <p className="text-faint font-mono text-[10px] leading-relaxed pt-1">
                  When on, a qualifying run is distilled into a reusable <span className="text-dim">SKILL.md</span> in
                  {' '}<span className="text-dim">~/.claude/skills</span> (auto-discovered + attachable) and copied into
                  your personal-rag notes for search. Writes are stamped <span className="text-dim">learned: true</span> and
                  deletable here; hand-authored skills are never touched.
                </p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
