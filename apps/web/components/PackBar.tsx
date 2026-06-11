'use client';
import React, { useEffect, useRef, useState } from 'react';
import type { ToolPack } from '@fleet/shared';
import { api } from '@/lib/api';
import { Kicker, Btn, Input } from './ui';

/**
 * §23 — pack bar: saved tool/skill presets as one-click chips. Apply UNIONS the
 * pack into the current selection (never clears what the operator already picked);
 * "save current" snapshots the live tools+skills selection under a name.
 */
export function PackBar({
  tools,
  skills,
  onApply,
}: {
  tools: string[];
  skills: string[];
  onApply: (pack: ToolPack) => void;
}) {
  const [packs, setPacks] = useState<ToolPack[]>([]);
  const [saving, setSaving] = useState(false); // name-input visible
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .packs()
      .then((p) => alive.current && setPacks(p))
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, []);

  async function saveCurrent() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createPack({ name: name.trim(), tools, skills });
      if (!alive.current) return;
      setPacks((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)));
      setSaving(false);
      setName('');
    } catch (e: any) {
      if (alive.current) setErr(e?.message || 'failed to save pack');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function del(p: ToolPack) {
    if (!confirm(`Delete pack "${p.name}"?`)) return;
    try {
      await api.deletePack(p.id);
      if (alive.current) setPacks((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e: any) {
      if (alive.current) setErr(e?.message || 'failed to delete pack');
    }
  }

  const canSave = tools.length + skills.length > 0;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Kicker>packs · one-click presets</Kicker>
        {err && <span className="font-mono text-[10px]" style={{ color: '#ff5d5d' }}>{err}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {packs.map((p) => (
          <span key={p.id} className="inline-flex items-stretch border border-line2 group" title={`tools: ${p.tools.join(', ') || '—'}\nskills: ${p.skills.join(', ') || '—'}${p.description ? `\n${p.description}` : ''}`}>
            <button
              type="button"
              onClick={() => onApply(p)}
              className="font-mono text-[11px] px-2 py-1 text-dim hover:text-amber hover:bg-amber/5 transition-colors"
            >
              ⊞ {p.name}
              <span className="text-faint ml-1.5">{p.tools.length}t·{p.skills.length}s</span>
            </button>
            <button
              type="button"
              onClick={() => del(p)}
              className="px-1.5 font-mono text-[10px] text-faint hover:text-sig-failed border-l border-line2"
              title={`delete pack ${p.name}`}
            >
              ✕
            </button>
          </span>
        ))}
        {packs.length === 0 && !saving && (
          <span className="font-mono text-[10.5px] text-faint">none yet — pick tools/skills below, then save them as a pack</span>
        )}
        {saving ? (
          <span className="inline-flex items-center gap-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="pack name (e.g. web-dev)"
              className="!w-[180px] !py-1 !text-[11px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCurrent();
                if (e.key === 'Escape') {
                  setSaving(false);
                  setName('');
                }
              }}
            />
            <Btn variant="solid" onClick={saveCurrent} disabled={busy || !name.trim()} className="!px-2 !py-1">
              {busy ? '…' : '✓'}
            </Btn>
            <Btn onClick={() => { setSaving(false); setName(''); }} className="!px-2 !py-1">✕</Btn>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setSaving(true)}
            disabled={!canSave}
            title={canSave ? 'save the current tools+skills selection as a pack' : 'pick some tools or skills first'}
            className="font-mono text-[11px] px-2 py-1 border border-dashed border-line2 text-faint hover:text-amber hover:border-amber/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ＋ save current as pack
          </button>
        )}
      </div>
    </div>
  );
}
