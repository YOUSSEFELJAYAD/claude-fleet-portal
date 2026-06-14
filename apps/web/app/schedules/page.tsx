'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Field, Input, Select, Textarea, Toggle, Dot, ErrorBanner } from '@/components/ui';
import { ModelSelect, customModelEngine, modelEngine } from '@/components/ModelSelect';
import { clock, ago, dur } from '@/lib/format';
import type { ModelInfo, RunEngine } from '@fleet/shared';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

// ── local types (cannot import from apps/server) ──────────────────────────────
interface LaunchRequestLite {
  prompt: string;
  cwd: string;
  model: string;
  engine?: RunEngine;
  engineModel?: string | null;
  effort: string;
  permissionMode?: string;
}

interface Schedule {
  id: string;
  name: string;
  intervalMs: number | null;
  dailyAt: string | null;
  /** F2: every:<min> | daily:<HH:MM> | weekly:<0-6>:<HH:MM> | null = one-shot (legacy) */
  recurrence: string | null;
  /** F2: template name or null */
  template: string | null;
  launchRequest: LaunchRequestLite;
  enabled: boolean;
  lastRunId: string | null;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  createdAt: number;
}

interface TemplateInfo {
  id: string;
  name: string;
  model: string;
  effort: string;
}

interface MetaResponse {
  models: ModelInfo[];
  efforts: string[];
}

// F2 recurrence kind
type RecurrenceKind = 'one-shot' | 'every' | 'daily' | 'weekly';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function recurrenceLabel(s: Schedule): string {
  // F2 recurrence grammar
  if (s.recurrence) {
    if (s.recurrence.startsWith('every:')) {
      const min = Number(s.recurrence.slice(6));
      if (min % 60 === 0 && min >= 60) return `every ${min / 60}h`;
      return `every ${min}m`;
    }
    if (s.recurrence.startsWith('daily:')) return `daily @ ${s.recurrence.slice(6)}`;
    if (s.recurrence.startsWith('weekly:')) {
      const parts = s.recurrence.slice(7).split(':');
      const day = DAYS[Number(parts[0])] ?? `day ${parts[0]}`;
      return `weekly ${day} @ ${parts[1]}:${parts[2]}`;
    }
    return s.recurrence;
  }
  // Legacy trigger fields
  if (s.intervalMs != null) {
    const min = s.intervalMs / 60000;
    if (min % 60 === 0 && min >= 60) return `every ${min / 60}h`;
    return `every ${min}m`;
  }
  if (s.dailyAt != null) return `daily @ ${s.dailyAt}`;
  return 'one-shot';
}

function nextFireLabel(s: Schedule): string {
  if (!s.enabled) return 'paused';
  if (!s.nextFireAt) return s.recurrence || s.intervalMs != null || s.dailyAt ? '—' : 'done';
  const d = s.nextFireAt - Date.now();
  if (d <= 0) return 'due now';
  return `in ${dur(d)} · ${clock(s.nextFireAt)}`;
}

/** A schedule card — same shape/treatment as orchestrate's CampaignRow (inset status bar,
 *  dot+status, title, meta, footer with next-fire + actions) so Scheduler reads like Campaigns. */
function ScheduleCard({
  s, onToggle, onRun, onRemove,
}: { s: Schedule; onToggle: (s: Schedule) => void; onRun: (s: Schedule) => void; onRemove: (s: Schedule) => void }) {
  const color = s.enabled ? '#54e08a' : '#5b626d';
  return (
    <Panel className="p-4" style={{ boxShadow: `inset 2px 0 0 ${color}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Dot color={color} live={s.enabled} />
          <span className="font-display text-[10px] uppercase tracking-wider" style={{ color }}>{s.enabled ? 'active' : 'paused'}</span>
        </div>
        <span className="font-mono text-[10px] text-amber/80">{recurrenceLabel(s)}</span>
      </div>
      <div className="font-display text-[13px] tracking-wide text-ink mt-2 leading-snug line-clamp-1">{s.name}</div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-faint min-w-0">
        {s.template && (
          <span className="text-sig-completed/70 text-[9px] border border-sig-completed/30 px-1 shrink-0">{s.template}</span>
        )}
        <span className="truncate">{s.launchRequest?.prompt}</span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px]">
        <span className="flex items-center gap-1.5 min-w-0" style={{ color: s.enabled ? '#9aa1ab' : '#5b626d' }}>
          <Dot color={s.enabled ? '#54e08a' : '#5b626d'} size={5} />
          <span className="truncate">{nextFireLabel(s)}</span>
          {s.lastRunId && (
            <Link href={`/runs/${s.lastRunId}`} className="text-amber/80 hover:text-amber shrink-0">· ran {ago(s.lastFiredAt)}</Link>
          )}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <Toggle on={s.enabled} onChange={() => onToggle(s)} />
          <Btn variant="ghost" onClick={() => onRun(s)} title="run now" className="!px-2 !py-1">run</Btn>
          <Btn variant="danger" onClick={() => onRemove(s)} title="delete" className="!px-2 !py-1">✕</Btn>
        </div>
      </div>
    </Panel>
  );
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // create form
  const [name, setName] = useState('');
  // F2 recurrence
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>('every');
  const [everyMin, setEveryMin] = useState('60');
  const [dailyAt, setDailyAt] = useState('09:00');
  const [weeklyDay, setWeeklyDay] = useState('1'); // Monday
  const [weeklyTime, setWeeklyTime] = useState('09:00');
  // template
  const [templateName, setTemplateName] = useState('');
  // launch request
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('claude-opus-4-8');
  const [engineModel, setEngineModel] = useState('');
  const [enabledEngines, setEnabledEngines] = useState<RunEngine[]>([]);
  const [effort, setEffort] = useState('high');

  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // Unmount-safe polling (alive-ref pattern per house rules)
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  async function load() {
    setError(null);
    try {
      const r = await fetch(API + '/api/schedules');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      if (aliveRef.current) setSchedules(await r.json());
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'failed to load schedules');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();

    fetch(API + '/api/meta')
      .then((r) => (r.ok ? r.json() : null))
      .then((m: MetaResponse | null) => {
        if (!aliveRef.current || !m) return;
        setMeta(m);
        if (m.models?.[0]?.id) setModel((cur) => cur || m.models[0].id);
        if (m.efforts?.length && !m.efforts.includes('high')) setEffort(m.efforts[0]);
      })
      .catch(() => { /* meta optional */ });

    fetch(API + '/api/templates')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: TemplateInfo[]) => {
        if (aliveRef.current) setTemplates(list);
      })
      .catch(() => { /* templates optional */ });

    fetch(API + '/api/addons')
      .then((r) => (r.ok ? r.json() : []))
      .then((addons: Array<{ id: string; enabled: boolean }>) => {
        if (!aliveRef.current) return;
        setEnabledEngines(addons.filter((a) => (a.id === 'codex' || a.id === 'opencode') && a.enabled).map((a) => a.id as RunEngine));
      })
      .catch(() => { /* add-ons optional */ });

    // Unmount-safe setTimeout chain for countdown refresh
    let handle: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!aliveRef.current) return;
      load();
      handle = setTimeout(tick, 30_000);
    };
    handle = setTimeout(tick, 30_000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildRecurrenceString(): string | null {
    if (recurrenceKind === 'one-shot') return null;
    if (recurrenceKind === 'every') return `every:${everyMin}`;
    if (recurrenceKind === 'daily') return `daily:${dailyAt}`;
    if (recurrenceKind === 'weekly') return `weekly:${weeklyDay}:${weeklyTime}`;
    return null;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    if (!name.trim()) return setFormErr('name is required');
    if (!prompt.trim()) return setFormErr('prompt is required');
    if (!cwd.trim() || !cwd.startsWith('/')) return setFormErr('cwd must be an absolute path');

    const recurrence = buildRecurrenceString();

    // Client-side validation
    if (recurrenceKind === 'every') {
      const n = Number(everyMin);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 15 || n > 10080) {
        return setFormErr('interval must be 15–10080 minutes');
      }
    }
    if (recurrenceKind === 'daily' && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyAt)) {
      return setFormErr('daily time must be HH:MM');
    }
    if (recurrenceKind === 'weekly' && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(weeklyTime)) {
      return setFormErr('weekly time must be HH:MM');
    }

    const customEngine = customModelEngine(model);
    const launchRequest: LaunchRequestLite = customEngine
      ? { prompt: prompt.trim(), cwd: cwd.trim(), model: 'claude-opus-4-8', effort, engine: customEngine, engineModel: engineModel.trim() || null }
      : { prompt: prompt.trim(), cwd: cwd.trim(), model, effort };

    const body: any = {
      name: name.trim(),
      launch_request: launchRequest,
    };

    if (recurrence !== null) {
      body.recurrence = recurrence;
    } else {
      // one-shot: omit recurrence; the server fires once then nulls out next_fire_at.
      // A trigger field is still required — use interval_ms=60000 as the one-fire cadence.
      body.interval_ms = 60000;
    }

    if (templateName) body.template = templateName;

    setSubmitting(true);
    try {
      const r = await fetch(API + '/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      setName('');
      setPrompt('');
      setTemplateName('');
      await load();
    } catch (err: any) {
      setFormErr(err?.message ?? 'failed to create schedule');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(s: Schedule) {
    try {
      const r = await fetch(API + `/api/schedules/${s.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const updated: Schedule = await r.json();
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
    } catch (e: any) {
      setError(e?.message ?? 'failed to update schedule');
    }
  }

  async function runNow(s: Schedule) {
    try {
      const r = await fetch(API + `/api/schedules/${s.id}/run`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'failed to run schedule');
    }
  }

  async function remove(s: Schedule) {
    if (!confirm(`Delete schedule "${s.name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(API + `/api/schedules/${s.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    } catch (e: any) {
      setError(e?.message ?? 'failed to delete schedule');
    }
  }

  const models = meta?.models ?? [{ id: 'claude-opus-4-8', label: 'Opus 4.8', inputPerM: 0, outputPerM: 0, contextWindow: 0, maxOutput: 0, fastModeCapable: false }];
  const selectedEngine = modelEngine(models, model);
  const efforts = meta?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];

  const active = schedules.filter((s) => s.enabled);
  const paused = schedules.filter((s) => !s.enabled);

  return (
    <div>
      <Kicker>automation</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Scheduler</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Launch agents on a recurring or daily schedule — every-N-minutes, daily, or weekly, optionally applying an agent template at fire time.
      </p>

      <div className="space-y-5">
        {/* ── block 1 · new schedule ─────────────────────────────────────────── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>new schedule</Kicker>
          </div>
          <form onSubmit={create} className="p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly digest" />
              </Field>
              {templates.length > 0 && (
                <Field label="template" hint="optional — profile applied at fire time">
                  <Select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                    <option value="">— none —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.name}>{t.name}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>

            {/* F2: recurrence picker */}
            <Field label="recurrence">
              <div className="grid grid-cols-4 gap-1 mb-2 max-w-md">
                {(['one-shot', 'every', 'daily', 'weekly'] as RecurrenceKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setRecurrenceKind(k)}
                    className="font-display text-[10px] uppercase tracking-wider px-2 py-1.5 border transition-colors"
                    style={{
                      borderColor: recurrenceKind === k ? '#ffb000' : 'rgba(255,255,255,0.075)',
                      color: recurrenceKind === k ? '#ffb000' : '#9aa1ab',
                      background: recurrenceKind === k ? 'rgba(255,176,0,0.08)' : 'transparent',
                    }}
                  >
                    {k}
                  </button>
                ))}
              </div>

              {recurrenceKind === 'every' && (
                <div className="flex items-center gap-2">
                  <Input type="number" min={15} max={10080} value={everyMin} onChange={(e) => setEveryMin(e.target.value)} className="w-24" />
                  <span className="font-mono text-[11px] text-faint">min (15–10080)</span>
                </div>
              )}
              {recurrenceKind === 'daily' && (
                <div className="flex items-center gap-2">
                  <Input type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} className="w-32" />
                  <span className="font-mono text-[11px] text-faint">local time</span>
                </div>
              )}
              {recurrenceKind === 'weekly' && (
                <div className="flex items-center gap-2 max-w-md">
                  <Select value={weeklyDay} onChange={(e) => setWeeklyDay(e.target.value)} className="flex-1">
                    {DAYS.map((d, i) => (
                      <option key={i} value={String(i)}>{d}</option>
                    ))}
                  </Select>
                  <Input type="time" value={weeklyTime} onChange={(e) => setWeeklyTime(e.target.value)} className="w-28" />
                </div>
              )}
            </Field>

            <div className="border-t hairline pt-3">
              <Kicker>launch request</Kicker>
            </div>

            <Field label="prompt">
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="what should the agent do…" />
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="cwd" hint="absolute path">
                <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/project" />
              </Field>
              <Field label="model">
                <ModelSelect
                  models={models}
                  value={model}
                  onChange={setModel}
                  enabledEngines={enabledEngines}
                  customValue={engineModel}
                  onCustomValueChange={setEngineModel}
                />
                {selectedEngine !== 'claude' && <div className="text-faint font-mono text-[10px] mt-1.5">engine add-on run · retry/workflows unavailable</div>}
              </Field>
              <Field label="effort">
                <Select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  {efforts.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </Select>
              </Field>
            </div>

            {formErr && <ErrorBanner className="mb-4">{formErr}</ErrorBanner>}

            <div className="pt-1">
              <Btn type="submit" variant="solid" disabled={submitting}>
                {submitting ? 'creating…' : '＋ Create Schedule'}
              </Btn>
            </div>
          </form>
        </Panel>

        {error && <ErrorBanner onRetry={load}>{error}</ErrorBanner>}

        {/* ── block 2 · active ───────────────────────────────────────────────── */}
        <Panel ticked>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <span className="flex items-center gap-2">
              <Dot color="#54e08a" live={active.length > 0} size={6} />
              <Kicker>active</Kicker>
            </span>
            <span className="font-mono tnum text-[12px] text-amber">{String(active.length).padStart(2, '0')}</span>
          </div>
          <div className="p-4">
            {loading ? (
              <div className="font-mono text-[11px] text-faint">loading schedules…</div>
            ) : active.length === 0 ? (
              <div className="font-mono text-[11px] text-faint">nothing scheduled — create one above</div>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {active.map((s) => <ScheduleCard key={s.id} s={s} onToggle={toggle} onRun={runNow} onRemove={remove} />)}
              </div>
            )}
          </div>
        </Panel>

        {/* ── block 3 · paused ───────────────────────────────────────────────── */}
        <Panel>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <Kicker>paused</Kicker>
            <span className="font-mono tnum text-[12px] text-dim">{String(paused.length).padStart(2, '0')}</span>
          </div>
          <div className="p-4 overflow-auto" style={{ maxHeight: '60vh' }}>
            {!loading && schedules.length === 0 ? (
              <Empty>No schedules yet — create one above to launch agents on a recurring or daily schedule.</Empty>
            ) : paused.length === 0 ? (
              <div className="font-mono text-[11px] text-faint">no paused schedules</div>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {paused.map((s) => <ScheduleCard key={s.id} s={s} onToggle={toggle} onRun={runNow} onRemove={remove} />)}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
