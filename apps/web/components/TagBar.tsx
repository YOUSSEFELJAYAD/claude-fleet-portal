'use client';
import React, { useEffect, useState } from 'react';
import { Kicker, Input, Btn } from '@/components/ui';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

/**
 * Run tags (Feature A8): shows a run's tags as removable chips plus an input to
 * add one. Tags are normalized server-side (trim + lowercase), so we just echo
 * whatever the server returns after each mutation.
 */
export function TagBar({ runId }: { runId: string }) {
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`${API}/api/agents/${encodeURIComponent(runId)}/tags`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((t: string[]) => {
        if (alive) setTags(Array.isArray(t) ? t : []);
      })
      .catch((e) => {
        if (alive) setErr(e.message || 'failed to load tags');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  async function addTag() {
    const tag = draft.trim().toLowerCase();
    if (!tag || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/api/agents/${encodeURIComponent(runId)}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t: string[] = await r.json();
      setTags(Array.isArray(t) ? t : []);
      setDraft('');
    } catch (e: any) {
      setErr(e.message || 'failed to add tag');
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tag: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `${API}/api/agents/${encodeURIComponent(runId)}/tags/${encodeURIComponent(tag)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTags((prev) => prev.filter((x) => x !== tag));
    } catch (e: any) {
      setErr(e.message || 'failed to remove tag');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <Kicker>tags</Kicker>
        {err && <span className="font-mono text-[9px] text-sig-failed" style={{ color: '#ff5d5d' }}>{err}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {loading ? (
          <span className="font-mono text-[11px] text-faint">loading…</span>
        ) : tags.length === 0 ? (
          <span className="font-mono text-[11px] text-faint">no tags yet</span>
        ) : (
          tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 border border-line2 bg-black/30 text-dim font-mono text-[11px] px-2 py-0.5"
            >
              <span className="text-amber/80" style={{ color: '#ffb000' }}>#</span>
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={busy}
                title={`remove ${tag}`}
                className="text-faint hover:text-sig-failed transition-colors disabled:opacity-35"
                style={{ lineHeight: 1 }}
              >
                ✕
              </button>
            </span>
          ))
        )}
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="add tag…"
            disabled={busy}
            className="w-[120px] py-1 text-[11px]"
          />
          <Btn variant="ghost" onClick={addTag} disabled={busy || !draft.trim()}>
            + add
          </Btn>
        </div>
      </div>
    </div>
  );
}
