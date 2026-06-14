'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Field, Input, Toggle, Select, Dot, Badge, ErrorBanner } from '@/components/ui';
import { MultiPicker } from '@/components/MultiPicker';
import { ago } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

interface Notification {
  id: string;
  runId: string | null;
  kind: string;
  message: string;
  ts: number;
  read: boolean;
}

interface NotifConfig {
  enabled: boolean;
  onFailed: boolean;
  costThresholdUsd: number;
  durationThresholdMs: number;
  webhookUrl: string;
}

// ── F8: channel types ──────────────────────────────────────────────────────────
type ChannelKind = 'slack' | 'discord' | 'generic';
type ChannelEvent =
  | 'run-failed'
  | 'run-completed'
  | 'run-killed'
  | 'awaiting-permission'
  | 'spend-threshold';

interface Channel {
  id: string;
  kind: ChannelKind;
  url: string;
  events: ChannelEvent[];
  enabled: boolean;
  lastError: string | null;
  lastOkAt: number | null;
}

const EVENT_OPTIONS = [
  { value: 'run-failed', hint: 'fires when a run fails' },
  { value: 'run-completed', hint: 'fires when a run completes successfully' },
  { value: 'run-killed', hint: 'fires when a run is killed' },
  { value: 'awaiting-permission', hint: 'fires when a run pauses for permission' },
  { value: 'spend-threshold', hint: 'fires at 50 / 80 / 100 % of daily cap' },
];

// ── notification kind coloring ──────────────────────────────────────────────
const KIND_COLOR: Record<string, string> = {
  failed: '#ff5d5d',
  killed: '#ff5d5d',
  cost: '#ffb000',
  duration: '#54a0e0',
  test: '#54e08a',
  completed: '#39d4cf',
  'spend-threshold': '#ffb000',
};
const kindColor = (k: string) => KIND_COLOR[k] ?? '#9aa1ab';

function KindBadge({ kind }: { kind: string }) {
  return <Badge label={kind} color={kindColor(kind)} />;
}

// ── url masking helper ────────────────────────────────────────────────────────
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    if (path.length <= 8) return url;
    return `${u.protocol}//${u.host}/…${path.slice(-6)}`;
  } catch {
    if (url.length <= 24) return url;
    return url.slice(0, 8) + '…' + url.slice(-8);
  }
}

// ── blank channel form ────────────────────────────────────────────────────────
const blankForm = (): Omit<Channel, 'id' | 'lastError' | 'lastOkAt'> => ({
  kind: 'slack',
  url: '',
  events: [],
  enabled: true,
});

export default function NotificationsPage() {
  const alive = useRef(true);
  // Set true on (re)mount, not just false on cleanup: under StrictMode/HMR the effect is
  // unmounted then remounted, and a cleanup-only ref would stay false — silently gating out
  // every post-fetch setState and wedging the page on "loading…".
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const [items, setItems] = useState<Notification[]>([]);
  const [cfg, setCfg] = useState<NotifConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  // F8: channels
  const [channels, setChannels] = useState<Channel[]>([]);
  const [chLoading, setChLoading] = useState(true);
  const [chError, setChError] = useState<string | null>(null);
  const [chSaving, setChSaving] = useState(false);
  const [addForm, setAddForm] = useState<Omit<Channel, 'id' | 'lastError' | 'lastOkAt'>>(blankForm());
  const [addError, setAddError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  async function loadList() {
    try {
      const r = await fetch(API + '/api/notifications');
      if (!r.ok) throw new Error('failed to load notifications');
      if (alive.current) setItems(await r.json());
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to load');
    }
  }

  async function loadConfig() {
    try {
      const r = await fetch(API + '/api/notifications/config');
      if (!r.ok) throw new Error('failed to load config');
      if (alive.current) setCfg(await r.json());
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to load');
    }
  }

  async function loadChannels() {
    try {
      const r = await fetch(API + '/api/notifier/channels');
      if (!r.ok) throw new Error('failed to load channels');
      if (alive.current) setChannels(await r.json());
    } catch (e: any) {
      if (alive.current) setChError(e.message || 'failed to load channels');
    } finally {
      if (alive.current) setChLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([loadList(), loadConfig()]).finally(() => { if (alive.current) setLoading(false); });
    loadChannels();

    // unmount-safe polling
    let t: ReturnType<typeof setTimeout>;
    function poll() {
      if (!alive.current) return;
      loadList().finally(() => {
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
      const r = await fetch(API + '/api/notifications/config', {
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

  async function sendTest() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(API + '/api/notifications/test', { method: 'POST' });
      if (!r.ok) throw new Error('failed to send test');
      await loadList();
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to send test');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function markAllRead() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(API + '/api/notifications/read', { method: 'POST' });
      if (!r.ok) throw new Error('failed to mark read');
      await loadList();
    } catch (e: any) {
      if (alive.current) setError(e.message || 'failed to mark read');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  // ── F8: channel actions ──────────────────────────────────────────────────────

  async function saveChannels(next: Channel[]) {
    setChSaving(true);
    setChError(null);
    try {
      const r = await fetch(API + '/api/notifier/channels', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) {
        let msg = 'failed to save channels';
        try { msg = (await r.json()).error ?? msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      if (alive.current) setChannels(await r.json());
    } catch (e: any) {
      if (alive.current) setChError(e.message || 'failed to save channels');
    } finally {
      if (alive.current) setChSaving(false);
    }
  }

  async function addChannel() {
    setAddError(null);
    if (!addForm.url.trim()) { setAddError('URL is required'); return; }
    if (!addForm.url.startsWith('https://')) { setAddError('URL must start with https://'); return; }
    const newCh: Channel = {
      id: crypto.randomUUID(),
      ...addForm,
      lastError: null,
      lastOkAt: null,
    };
    const next = [...channels, newCh];
    if (next.length > 10) { setAddError('maximum 10 channels allowed'); return; }
    await saveChannels(next);
    if (alive.current) setAddForm(blankForm());
  }

  async function removeChannel(id: string) {
    await saveChannels(channels.filter((c) => c.id !== id));
  }

  async function toggleChannel(id: string, enabled: boolean) {
    await saveChannels(channels.map((c) => c.id === id ? { ...c, enabled } : c));
  }

  async function testChannel(id: string) {
    setTestingId(id);
    try {
      const r = await fetch(API + `/api/notifier/channels/${id}/test`, { method: 'POST' });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        // reload channels to show updated last_error
        await loadChannels();
        if (alive.current) setChError(`test failed: ${body.error ?? 'unknown error'}`);
      } else {
        await loadChannels();
      }
    } catch (e: any) {
      if (alive.current) setChError(e.message || 'test request failed');
    } finally {
      if (alive.current) setTestingId(null);
    }
  }

  const unread = items.filter((n) => !n.read).length;

  return (
    <div>
      <Kicker>alerts</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Notifications</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Run-terminal alerts and delivery channels — failures, cost / duration thresholds and spend gates, pushed to Slack, Discord or generic webhooks.
      </p>

      {error && (
        <ErrorBanner className="mb-4" onRetry={loadList}>{error}</ErrorBanner>
      )}

      <div className="space-y-5">
        {/* ── block 1 · recent ── */}
        <Panel ticked>
          <div className="flex items-center justify-between px-4 py-3 border-b hairline">
            <span className="flex items-center gap-2">
              <Dot color="#ffb000" live={unread > 0} size={6} />
              <Kicker>recent</Kicker>
              <span className="font-mono tnum text-[12px] text-amber ml-1">{String(items.length).padStart(2, '0')}</span>
              <span className="font-mono text-[10px] text-faint ml-1">{unread} unread</span>
            </span>
            <Btn variant="ghost" onClick={markAllRead} disabled={busy || unread === 0}>mark all read</Btn>
          </div>

          {loading ? (
            <div className="p-4 font-mono text-faint text-[12px]">loading…</div>
          ) : items.length === 0 ? (
            <div className="p-4"><Empty>No notifications yet.</Empty></div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
                {items.map((n) => (
                  <div
                    key={n.id}
                    className="flex items-start gap-3 px-4 py-3"
                    style={{ opacity: n.read ? 0.55 : 1 }}
                  >
                    <div className="mt-0.5">
                      <KindBadge kind={n.kind} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-ink text-[12.5px] leading-snug break-words">{n.message}</div>
                      <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-faint">
                        <span>{ago(n.ts)}</span>
                        {n.runId && (
                          <Link
                            href={`/runs/${n.runId}`}
                            className="text-dim hover:text-amber transition-colors"
                          >
                            view run →
                          </Link>
                        )}
                      </div>
                    </div>
                    {!n.read && <Dot color="#ffb000" size={6} />}
                  </div>
                ))}
            </div>
          )}
        </Panel>

        {/* ── block 2 · rules ── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>rules</Kicker>
          </div>
          <div className="p-4">
            {!cfg ? (
                <div className="font-mono text-faint text-[12px]">loading…</div>
              ) : (
                <div className="space-y-4">
                  <Toggle
                    on={cfg.enabled}
                    onChange={(v) => setCfg({ ...cfg, enabled: v })}
                    label="alerts enabled"
                  />
                  <Toggle
                    on={cfg.onFailed}
                    onChange={(v) => setCfg({ ...cfg, onFailed: v })}
                    label="alert on failed / killed"
                  />

                  <Field label="cost threshold" hint="usd">
                    <Input
                      type="number"
                      min={0}
                      step="0.5"
                      value={cfg.costThresholdUsd}
                      onChange={(e) =>
                        setCfg({ ...cfg, costThresholdUsd: Number(e.target.value) })
                      }
                    />
                  </Field>

                  <Field label="duration threshold" hint="minutes">
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={cfg.durationThresholdMs / 60000}
                      onChange={(e) =>
                        setCfg({
                          ...cfg,
                          durationThresholdMs: Math.max(0, Number(e.target.value)) * 60000,
                        })
                      }
                    />
                  </Field>

                  <Field label="webhook url" hint="optional">
                    <Input
                      type="text"
                      placeholder="https://…"
                      value={cfg.webhookUrl}
                      onChange={(e) => setCfg({ ...cfg, webhookUrl: e.target.value })}
                    />
                  </Field>

                  <div className="flex gap-2 pt-1">
                    <Btn variant="solid" onClick={saveConfig} disabled={saving}>
                      {saving ? 'saving…' : 'save'}
                    </Btn>
                    <Btn variant="ghost" onClick={sendTest} disabled={busy}>
                      send test
                    </Btn>
                  </div>

                  <p className="text-faint font-mono text-[10px] leading-relaxed pt-1">
                    Rules run when a run reaches a terminal state. Thresholds of 0 are disabled.
                  </p>
                </div>
              )}
            </div>
          </Panel>

        {/* ── block 3 · channels ── */}
        <Panel ticked>
          <div className="px-4 py-3 border-b hairline flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Kicker>channels</Kicker>
              <span className="font-mono text-[11px] text-faint ml-1">{channels.length}/10 configured</span>
            </span>
                {chSaving && <span className="font-mono text-[10px] text-faint animate-pulse">saving…</span>}
              </div>

              {/* body */}
              <div className="p-4 space-y-4">
                {chError && (
                  <ErrorBanner onRetry={loadChannels}>{chError}</ErrorBanner>
                )}

                {chLoading ? (
                  <div className="font-mono text-faint text-[12px]">loading…</div>
                ) : channels.length === 0 ? (
                  <div className="font-mono text-faint text-[12px]">No channels yet.</div>
                ) : (
                  <div className="space-y-2">
                    {channels.map((ch) => (
                      <div
                        key={ch.id}
                        className="border border-line2 px-3 py-2 space-y-1"
                        style={{ opacity: ch.enabled ? 1 : 0.55 }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 border text-amber border-amber/30 bg-amber/[0.06]">
                              {ch.kind}
                            </span>
                            <span className="font-mono text-[11px] text-dim truncate" title={ch.url}>
                              {maskUrl(ch.url)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Toggle on={ch.enabled} onChange={(v) => toggleChannel(ch.id, v)} />
                            <Btn
                              variant="ghost"
                              disabled={testingId === ch.id}
                              onClick={() => testChannel(ch.id)}
                              className="!px-1.5 !py-0.5 text-[11px]"
                            >
                              {testingId === ch.id ? '…' : '⚡'}
                            </Btn>
                            <Btn
                              variant="danger"
                              onClick={() => removeChannel(ch.id)}
                              className="!px-1.5 !py-0.5 text-[11px]"
                            >
                              ✕
                            </Btn>
                          </div>
                        </div>
                        {/* event chips */}
                        {ch.events.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {ch.events.map((ev) => (
                              <span
                                key={ev}
                                className="font-mono text-[9.5px] px-1 py-0.5 border"
                                style={{ borderColor: 'rgba(84,160,224,0.3)', color: '#54a0e0', background: 'rgba(84,160,224,0.06)' }}
                              >
                                {ev}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* last error */}
                        {ch.lastError && (
                          <div className="font-mono text-[10px] text-sig-failed truncate" title={ch.lastError}>
                            ✗ {ch.lastError}
                          </div>
                        )}
                        {!ch.lastError && ch.lastOkAt && (
                          <div className="font-mono text-[10px] text-faint">
                            ✓ last ok {ago(ch.lastOkAt)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* add form */}
                {channels.length < 10 && (
                  <div className="border border-line2 border-dashed p-3 space-y-3">
                    <div className="font-mono text-[10px] text-faint uppercase tracking-wide">add channel</div>

                    {addError && (
                      <div className="font-mono text-[11px] text-sig-failed">{addError}</div>
                    )}

                    <Field label="kind">
                      <Select
                        value={addForm.kind}
                        onChange={(e) => setAddForm({ ...addForm, kind: e.target.value as ChannelKind })}
                      >
                        <option value="slack">slack</option>
                        <option value="discord">discord</option>
                        <option value="generic">generic</option>
                      </Select>
                    </Field>

                    <Field label="webhook url">
                      <Input
                        type="text"
                        placeholder="https://…"
                        value={addForm.url}
                        onChange={(e) => setAddForm({ ...addForm, url: e.target.value })}
                      />
                    </Field>

                    <Field label="events">
                      <MultiPicker
                        value={addForm.events}
                        onChange={(v) => setAddForm({ ...addForm, events: v as ChannelEvent[] })}
                        options={EVENT_OPTIONS}
                        allowCustom={false}
                        placeholder="pick events…"
                      />
                    </Field>

                    <Btn variant="solid" onClick={addChannel} disabled={chSaving}>
                      add channel
                    </Btn>
                  </div>
                )}
              </div>
        </Panel>
      </div>
    </div>
  );
}
