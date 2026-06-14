'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Field, Input, Toggle, Dot, ErrorBanner } from '@/components/ui';
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

/** A learned-skill card — same shape/treatment as orchestrate's CampaignRow (inset status bar,
 *  dot+status, title, footer meta) so Learning reads identically to Campaigns. */
function SkillCard({ s, onDelete, deleting }: { s: LearnedSkill; onDelete: (id: string) => void; deleting: boolean }) {
  const color = statusColor(s.status);
  return (
    <Panel className="p-4" style={{ boxShadow: `inset 2px 0 0 ${color}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Dot color={color} />
          <span className="font-display text-[10px] uppercase tracking-wider" style={{ color }}>{s.status}</span>
        </div>
        <Btn
          variant="danger"
          onClick={() => onDelete(s.id)}
          disabled={deleting}
          className="!px-1.5 !py-0.5 text-[11px] shrink-0"
          title="delete this learned skill"
        >
          {deleting ? '…' : '✕'}
        </Btn>
      </div>
      <div className="text-ink text-[12.5px] mt-2 leading-snug break-words font-mono">
        {s.name || <span className="text-faint">— ({s.status})</span>}
      </div>
      {s.error && (
        <div className="mt-0.5 font-mono text-[10px] text-sig-failed truncate" title={s.error}>{s.error}</div>
      )}
      <div className="mt-3 flex items-center gap-3 font-mono text-[10px] text-faint flex-wrap">
        <span>{ago(s.createdAt)}</span>
        <span title="cost of the run we learned from">from {usd(s.sourceCostUsd)} run</span>
        <Link href={`/runs/${s.sourceRunId}`} className="text-dim hover:text-amber transition-colors">view run →</Link>
        {s.ragPath && <span className="text-sig-completed/70" title={s.ragPath}>· indexed</span>}
      </div>
    </Panel>
  );
}

export default function LearningPage() {
  const alive = useRef(true);
  // Set true on (re)mount, not just false on cleanup: under StrictMode/HMR the effect is
  // unmounted then remounted, and a cleanup-only ref would stay false — silently gating out
  // every post-fetch setState and wedging the page on "loading…".
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

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
      <Kicker>autonomy</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1 flex items-center gap-2.5">
        Skill Learning
        <span className="inline-flex items-center gap-1.5" title={enabled ? 'autonomous learning is ON' : 'disabled'}>
          <Dot color={enabled ? '#54e08a' : '#5b626d'} live={enabled} size={7} />
          <span className={enabled ? 'font-mono text-[11px] text-sig-completed' : 'font-mono text-[11px] text-faint'}>
            {enabled ? 'live' : 'off'}
          </span>
        </span>
      </h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        A qualifying operator run is distilled into a reusable SKILL.md (auto-discovered + attachable) and indexed for search — fully autonomously.
      </p>

      {error && <ErrorBanner className="mb-5">{error}</ErrorBanner>}

      <div className="space-y-5">
        {/* ── block 1 · config ───────────────────────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>config</Kicker>
          </div>
          <div className="p-5">
            {!cfg ? (
              <div className="font-mono text-faint text-[12px]">loading config…</div>
            ) : (
              <>
                <div className="flex items-center gap-4 mb-4">
                  <Toggle on={cfg.enabled} onChange={(v) => setCfg({ ...cfg, enabled: v })} label="autonomous learning" />
                  <span className="font-mono text-[10px] text-faint leading-relaxed border-l-2 border-amber/40 pl-2">
                    A completed operator run qualifies if it meets <span className="text-dim">any</span> threshold below.
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
                  <Field label="min cost" hint="usd">
                    <Input type="number" min={0} step="0.1" value={cfg.minCostUsd} onChange={(e) => setCfg({ ...cfg, minCostUsd: Math.max(0, Number(e.target.value)) })} />
                  </Field>
                  <Field label="min subagents" hint="count">
                    <Input type="number" min={0} step="1" value={cfg.minSubagents} onChange={(e) => setCfg({ ...cfg, minSubagents: Math.max(0, Number(e.target.value)) })} />
                  </Field>
                  <Field label="min depth" hint="tree depth">
                    <Input type="number" min={0} step="1" value={cfg.minDepth} onChange={(e) => setCfg({ ...cfg, minDepth: Math.max(0, Number(e.target.value)) })} />
                  </Field>
                  <Field label="min duration" hint="minutes">
                    <Input type="number" min={0} step="1" value={cfg.minDurationMs / 60000} onChange={(e) => setCfg({ ...cfg, minDurationMs: Math.max(0, Number(e.target.value)) * 60000 })} />
                  </Field>
                  <Field label="max per day" hint="runaway cap">
                    <Input type="number" min={1} step="1" value={cfg.maxPerDay} onChange={(e) => setCfg({ ...cfg, maxPerDay: Math.max(1, Math.floor(Number(e.target.value))) })} />
                  </Field>
                </div>
                <p className="text-faint font-mono text-[10px] leading-relaxed mt-4">
                  When on, a qualifying run is distilled into a reusable <span className="text-dim">SKILL.md</span> in
                  {' '}<span className="text-dim">~/.claude/skills</span> (auto-discovered + attachable) and copied into
                  your personal-rag notes for search. Writes are stamped <span className="text-dim">learned: true</span> and
                  deletable below; hand-authored skills are never touched.
                </p>
                <div className="flex gap-2 pt-3">
                  <Btn variant="solid" onClick={saveConfig} disabled={saving}>{saving ? 'saving…' : 'save'}</Btn>
                </div>
              </>
            )}
          </div>
        </Panel>

        {/* ── block 2 · learned skills ───────────────────────────────────────── */}
        <Panel ticked>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <span className="flex items-center gap-2">
              <Dot color="#54e08a" live={okCount > 0} size={6} />
              <Kicker>learned skills</Kicker>
            </span>
            <span className="font-mono tnum text-[12px] text-sig-completed">{String(okCount).padStart(2, '0')}</span>
          </div>
          <div className="p-4 overflow-auto" style={{ maxHeight: '60vh' }}>
            {loading ? (
              <div className="font-mono text-faint text-[12px]">loading…</div>
            ) : skills.length === 0 ? (
              <Empty>No skills learned yet. Enable the loop, then complete a complex run.</Empty>
            ) : (
              <>
                <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {skills.map((s) => (
                    <SkillCard key={s.id} s={s} onDelete={removeSkill} deleting={deletingId === s.id} />
                  ))}
                </div>
                <div className="font-mono text-[10px] text-faint mt-3">
                  <span className="text-sig-completed tnum">{okCount}</span> learned ·{' '}
                  <span className="text-ink tnum">{skills.length}</span> attempts · → attachable in Templates
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
