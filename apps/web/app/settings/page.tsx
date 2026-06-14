'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SettingValue } from '@fleet/shared';
import { api } from '@/lib/api';
import { Kicker, Panel, Btn, Input, Toggle, Dot, Empty, ErrorBanner } from '@/components/ui';

const CATS: { id: SettingValue['category']; label: string }[] = [
  { id: 'derived', label: 'Live · read-only' },
  { id: 'live', label: 'Applies now' },
  { id: 'integration', label: 'Integrations · applies next launch' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingValue[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSettings((await api.settings()).settings);
    } catch (e: any) {
      setErr(e?.message ?? 'failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function save(s: SettingValue, clear = false) {
    setErr(null);
    try {
      await api.updateSetting(s.key, clear ? null : (draft[s.key] ?? s.value ?? ''));
      setDraft((d) => { const n = { ...d }; delete n[s.key]; return n; });
      await refresh();
    } catch (e: any) { setErr(`${s.key}: ${e?.message ?? 'update failed'}`); }
  }

  async function toggle(s: SettingValue) {
    setErr(null);
    try {
      await api.updateSetting(s.key, s.value === 'true' ? 'false' : 'true'); // live; persists immediately
      await refresh();
    } catch (e: any) { setErr(`${s.key}: ${e?.message ?? 'update failed'}`); }
  }

  return (
    <div className="max-w-3xl">
      <Kicker>environment</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Settings</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        Live environment, integration keys and feature gates for the portal — some apply immediately, others on next launch.
      </p>

      {err && <ErrorBanner className="mb-4">{err}</ErrorBanner>}

      <div className="space-y-5">
        {CATS.map((cat) => {
          const rows = settings.filter((s) => s.category === cat.id);
          if (rows.length === 0) return null;
          return (
            <Panel ticked className="overflow-hidden" key={cat.id}>
              <div className="flex items-center justify-between px-4 py-3 border-b hairline">
                <span className="flex items-center gap-2">
                  <Dot color="#ffb000" size={6} />
                  <Kicker>{cat.label}</Kicker>
                </span>
                <span className="font-mono tnum text-[12px] text-dim">{String(rows.length).padStart(2, '0')}</span>
              </div>
              <div className="divide-y divide-white/[0.04]">
                  {rows.map((s) => (
                    <div key={s.key} className="flex items-center gap-2 text-[13px] px-4 py-2.5">
                      <div className="w-48 shrink-0 text-dim">
                        {s.label}
                        {s.gatedBy && !s.gatedOn && <span className="text-faint"> · enable {s.gatedBy}</span>}
                        {s.pending && <span className="text-amber"> · ⏱ next launch</span>}
                      </div>
                      {!s.editable ? (
                        <span className="font-mono text-faint">{s.value ?? '—'}</span>
                      ) : s.control === 'toggle' ? (
                        <span className={s.gatedOn ? '' : 'opacity-35'}>
                          <Toggle on={s.value === 'true'} onChange={() => s.gatedOn && toggle(s)} label={s.value === 'true' ? 'on' : 'off'} />
                        </span>
                      ) : s.secret ? (
                        <>
                          <span className="font-mono text-faint">{s.set ? '••••set' : '(unset)'}</span>
                          <Input
                            placeholder="new value"
                            value={draft[s.key] ?? ''}
                            disabled={!s.gatedOn}
                            onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                            className="!text-[12px] !py-1.5"
                          />
                          <Btn disabled={!s.gatedOn || !(draft[s.key] ?? '').trim()} onClick={() => save(s)}>set</Btn>
                          <Btn disabled={!s.set} onClick={() => save(s, true)}>clear</Btn>
                        </>
                      ) : (
                        <>
                          <Input
                            value={draft[s.key] ?? s.value ?? ''}
                            disabled={!s.gatedOn}
                            onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                            className="!text-[12px] !py-1.5"
                          />
                          <Btn disabled={!s.gatedOn} onClick={() => save(s)}>save</Btn>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
          );
        })}
        {!loading && settings.length === 0 && <Empty>No settings available.</Empty>}
      </div>

      <div className="mt-5 font-mono text-[10px] text-faint leading-relaxed">
        Changes marked “next launch” take effect after you restart the portal.
      </div>
    </div>
  );
}
