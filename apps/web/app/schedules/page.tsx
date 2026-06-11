'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Field, Input, Select, Textarea, Toggle, Dot } from '@/components/ui';
import { clock, ago, dur } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

// ── local types (cannot import from apps/server) ──────────────────────────────
interface LaunchRequestLite {
  prompt: string;
  cwd: string;
  model: string;
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

interface ModelInfo {
  id: string;
  label: string;
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

    const body: any = {
      name: name.trim(),
      launch_request: { prompt: prompt.trim(), cwd: cwd.trim(), model, effort },
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

  const models = meta?.models ?? [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }];
  const efforts = meta?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];

  return (
    <div>
      <Kicker>automation</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-5">Scheduler</h1>

      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 360px' }}>
        {/* ── schedule list ─────────────────────────────────────── */}
        <div>
          {error && (
            <div className="mb-3 border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[11px] px-3 py-2">
              {error}
            </div>
          )}

          {loading ? (
            <div className="font-mono text-faint text-[12px]">loading schedules…</div>
          ) : schedules.length === 0 ? (
            <Empty>No schedules yet — create one to launch agents on a recurring or daily schedule.</Empty>
          ) : (
            <div className="panel overflow-hidden">
              <div className="grid grid-cols-[1fr_90px_160px_100px_110px] gap-3 px-4 py-2.5 border-b hairline kicker">
                <span>name / recurrence</span>
                <span>enabled</span>
                <span>next fire</span>
                <span>last run</span>
                <span className="text-right">actions</span>
              </div>
              <div className="divide-y divide-white/[0.04]">
                {schedules.map((s) => (
                  <div key={s.id} className="grid grid-cols-[1fr_90px_160px_100px_110px] gap-3 px-4 py-3 items-center">
                    <div className="min-w-0">
                      <div className="text-ink text-[13px] truncate">{s.name}</div>
                      <div className="text-faint font-mono text-[10px] mt-0.5 flex items-center gap-2">
                        <span className="text-amber/80">{recurrenceLabel(s)}</span>
                        {s.template && (
                          <span className="text-sig-completed/70 text-[9px] border border-sig-completed/30 px-1 rounded">
                            {s.template}
                          </span>
                        )}
                        <span className="truncate">{s.launchRequest?.prompt}</span>
                      </div>
                    </div>
                    <div>
                      <Toggle on={s.enabled} onChange={() => toggle(s)} label={s.enabled ? 'on' : 'off'} />
                    </div>
                    <div className="font-mono text-[10px] flex items-center gap-1.5" style={{ color: s.enabled ? '#9aa1ab' : '#5b626d' }}>
                      <Dot color={s.enabled ? '#54e08a' : '#5b626d'} live={false} size={5} />
                      {nextFireLabel(s)}
                    </div>
                    <div className="font-mono text-[10px]">
                      {s.lastRunId ? (
                        <Link href={`/runs/${s.lastRunId}`} className="text-amber/80 hover:text-amber">
                          {ago(s.lastFiredAt)}
                        </Link>
                      ) : (
                        <span className="text-faint">never</span>
                      )}
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <Btn variant="ghost" onClick={() => runNow(s)} title="run now" className="!px-2 !py-1">
                        run
                      </Btn>
                      <Btn variant="danger" onClick={() => remove(s)} title="delete" className="!px-2 !py-1">
                        ✕
                      </Btn>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── create form ───────────────────────────────────────── */}
        <Panel className="p-4 self-start">
          <Kicker>new schedule</Kicker>
          <form onSubmit={create} className="mt-3 grid gap-3.5">
            <Field label="name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly digest" />
            </Field>

            {/* F2: recurrence picker */}
            <Field label="recurrence">
              <div className="grid grid-cols-4 gap-1 mb-2">
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
                  <Input
                    type="number"
                    min={15}
                    max={10080}
                    value={everyMin}
                    onChange={(e) => setEveryMin(e.target.value)}
                    className="w-24"
                  />
                  <span className="font-mono text-[11px] text-faint">min (15–10080)</span>
                </div>
              )}

              {recurrenceKind === 'daily' && (
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={dailyAt}
                    onChange={(e) => setDailyAt(e.target.value)}
                    className="w-32"
                  />
                  <span className="font-mono text-[11px] text-faint">local time</span>
                </div>
              )}

              {recurrenceKind === 'weekly' && (
                <div className="flex items-center gap-2">
                  <Select value={weeklyDay} onChange={(e) => setWeeklyDay(e.target.value)} className="flex-1">
                    {DAYS.map((d, i) => (
                      <option key={i} value={String(i)}>{d}</option>
                    ))}
                  </Select>
                  <Input
                    type="time"
                    value={weeklyTime}
                    onChange={(e) => setWeeklyTime(e.target.value)}
                    className="w-28"
                  />
                </div>
              )}
            </Field>

            {/* F2: template select */}
            {templates.length > 0 && (
              <Field label="template" hint="optional — profile applied at fire time">
                <Select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                  <option value="">— none —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <div className="border-t hairline pt-3">
              <Kicker>launch request</Kicker>
            </div>

            <Field label="prompt">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="what should the agent do…"
              />
            </Field>

            <Field label="cwd" hint="absolute path">
              <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/project" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="model">
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="effort">
                <Select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  {efforts.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {formErr && <div className="text-sig-failed font-mono text-[11px]">{formErr}</div>}

            <Btn type="submit" variant="solid" disabled={submitting} className="w-full justify-center">
              {submitting ? 'creating…' : '＋ Create Schedule'}
            </Btn>
          </form>
        </Panel>
      </div>
    </div>
  );
}
