'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Kicker, Panel, Empty, Btn, Field, Input, Toggle, Dot } from '@/components/ui';
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

const KIND_COLOR: Record<string, string> = {
  failed: '#ff5d5d',
  killed: '#ff5d5d',
  cost: '#ffb000',
  duration: '#54a0e0',
  test: '#54e08a',
};
const kindColor = (k: string) => KIND_COLOR[k] ?? '#9aa1ab';

function KindBadge({ kind }: { kind: string }) {
  const color = kindColor(kind);
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
      {kind}
    </span>
  );
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [cfg, setCfg] = useState<NotifConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function loadList() {
    try {
      const r = await fetch(API + '/api/notifications');
      if (!r.ok) throw new Error('failed to load notifications');
      setItems(await r.json());
    } catch (e: any) {
      setError(e.message || 'failed to load');
    }
  }

  async function loadConfig() {
    try {
      const r = await fetch(API + '/api/notifications/config');
      if (!r.ok) throw new Error('failed to load config');
      setCfg(await r.json());
    } catch (e: any) {
      setError(e.message || 'failed to load');
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([loadList(), loadConfig()]).finally(() => setLoading(false));
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
        try {
          msg = (await r.json()).error ?? msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      setCfg(await r.json());
    } catch (e: any) {
      setError(e.message || 'failed to save');
    } finally {
      setSaving(false);
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
      setError(e.message || 'failed to send test');
    } finally {
      setBusy(false);
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
      setError(e.message || 'failed to mark read');
    } finally {
      setBusy(false);
    }
  }

  const unread = items.filter((n) => !n.read).length;

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>alerts</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Notifications</h1>
        </div>
        <div className="text-right font-mono text-[11px] text-faint">
          <span className="text-amber tnum">{unread}</span> unread ·{' '}
          <span className="text-ink tnum">{items.length}</span> total
        </div>
      </div>

      {error && (
        <div className="mb-4 border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[12px] px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        {/* ── feed ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <Kicker>recent</Kicker>
            <div className="flex gap-2">
              <Btn variant="ghost" onClick={markAllRead} disabled={busy || unread === 0}>
                mark all read
              </Btn>
            </div>
          </div>

          {loading ? (
            <div className="font-mono text-faint text-[12px]">loading…</div>
          ) : items.length === 0 ? (
            <Empty>No notifications yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
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
            </Panel>
          )}
        </div>

        {/* ── config ── */}
        <div>
          <Kicker className="mb-3 block">rules</Kicker>
          <Panel className="p-4">
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
          </Panel>
        </div>
      </div>
    </div>
  );
}
