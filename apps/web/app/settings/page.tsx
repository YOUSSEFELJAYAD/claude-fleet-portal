'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SettingValue } from '@fleet/shared';
import { api } from '@/lib/api';
import { Btn, Input } from '@/components/ui';

const CATS: { id: SettingValue['category']; label: string }[] = [
  { id: 'derived', label: 'Live · read-only' },
  { id: 'live', label: 'Applies now' },
  { id: 'integration', label: 'Integrations · applies next launch' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingValue[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => { setSettings((await api.settings()).settings); }, []);
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
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <h1 className="text-lg font-semibold">Environment &amp; Settings</h1>
      {err && <div className="text-[12px]" style={{ color: '#ff5d5d' }}>{err}</div>}
      {CATS.map((cat) => (
        <div key={cat.id} className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide opacity-50">{cat.label}</div>
          {settings.filter((s) => s.category === cat.id).map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[13px] border-b hairline py-2">
              <div className="w-48 shrink-0">
                {s.label}
                {s.gatedBy && !s.gatedOn && <span className="opacity-50"> · enable {s.gatedBy}</span>}
                {s.pending && <span style={{ color: '#ffb000' }}> · ⏱ next launch</span>}
              </div>
              {!s.editable ? (
                <span className="font-mono opacity-80">{s.value ?? '—'}</span>
              ) : s.control === 'toggle' ? (
                <Btn disabled={!s.gatedOn} variant={s.value === 'true' ? 'solid' : 'ghost'} onClick={() => toggle(s)}>
                  {s.value === 'true' ? '● ON' : '○ OFF'}
                </Btn>
              ) : s.secret ? (
                <>
                  <span className="font-mono opacity-60">{s.set ? '••••set' : '(unset)'}</span>
                  <Input placeholder="new value" value={draft[s.key] ?? ''} disabled={!s.gatedOn}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
                  <Btn disabled={!s.gatedOn || !(draft[s.key] ?? '').trim()} onClick={() => save(s)}>set</Btn>
                  <Btn disabled={!s.set} onClick={() => save(s, true)}>clear</Btn>
                </>
              ) : (
                <>
                  <Input value={draft[s.key] ?? s.value ?? ''} disabled={!s.gatedOn}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
                  <Btn disabled={!s.gatedOn} onClick={() => save(s)}>save</Btn>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="text-[11px] opacity-50">Changes marked “next launch” take effect after you restart the portal.</div>
    </div>
  );
}
