'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Panel, Kicker, Field, Select, Textarea, Btn, Empty } from '@/components/ui';
import { clock } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

interface Score {
  id: string;
  runId: string;
  name: string;
  value: number;
  comment: string | null;
  source: string;
  ts: number;
}

const RATING_OPTS = [
  { v: 5, label: '5 · excellent' },
  { v: 4, label: '4 · good' },
  { v: 3, label: '3 · fair' },
  { v: 2, label: '2 · poor' },
  { v: 1, label: '1 · failing' },
];

function ratingColor(v: number): string {
  if (v >= 4) return '#54e08a';
  if (v >= 3) return '#ffb000';
  return '#ff5d5d';
}

export function ScorePanel({ runId }: { runId: string }) {
  const [scores, setScores] = useState<Score[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(4);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    fetch(`${API}/api/agents/${runId}/scores`)
      .then((r) => {
        if (!r.ok) throw new Error('failed to load scores');
        return r.json();
      })
      .then((data: Score[]) => setScores(data))
      .catch((e) => setError(e.message || 'failed to load scores'))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/agents/${runId}/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rating', value: Number(rating), comment: comment.trim() || undefined }),
      });
      if (!r.ok) {
        let msg = 'failed to save score';
        try {
          msg = (await r.json()).error ?? msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      setComment('');
      setRating(4);
      load();
    } catch (e: any) {
      setError(e.message || 'failed to save score');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const r = await fetch(`${API}/api/scores/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('failed to delete score');
      setScores((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) {
      setError(e.message || 'failed to delete score');
    }
  }

  const avg = scores.length ? scores.reduce((a, s) => a + s.value, 0) / scores.length : null;

  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between mb-3">
        <Kicker>scoring &amp; annotations</Kicker>
        {avg != null && (
          <span className="font-mono tnum text-[11px]" style={{ color: ratingColor(avg) }}>
            avg {avg.toFixed(2)} · {scores.length} rating{scores.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* add-rating form */}
      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-2 items-end mb-3">
        <Field label="rating">
          <Select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
            {RATING_OPTS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="comment" hint="optional">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="note your reasoning…"
            rows={1}
          />
        </Field>
        <Btn variant="solid" type="button" disabled={busy} onClick={submit}>
          {busy ? 'saving…' : 'Add ▸'}
        </Btn>
      </div>

      {error && <div className="font-mono text-[11px] text-sig-failed mb-3">{error}</div>}

      {/* existing scores */}
      {loading ? (
        <div className="font-mono text-faint text-[12px]">loading…</div>
      ) : scores.length === 0 ? (
        <Empty>No ratings yet — score this run above.</Empty>
      ) : (
        <div className="divide-y divide-white/[0.04] border-t hairline">
          {scores.map((s) => (
            <div key={s.id} className="flex items-start gap-3 py-2.5 group">
              <span
                className="font-mono tnum text-[15px] shrink-0 w-7 text-center"
                style={{ color: ratingColor(s.value) }}
              >
                {s.value}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-display uppercase tracking-wider text-[10px] text-dim">{s.name}</span>
                  <span className="font-mono text-[9px] text-faint">{s.source}</span>
                  <span className="font-mono text-[9px] text-faint">{clock(s.ts)}</span>
                </div>
                {s.comment && (
                  <div className="text-ink text-[12px] mt-0.5 leading-relaxed whitespace-pre-wrap">{s.comment}</div>
                )}
              </div>
              <button
                title="delete rating"
                onClick={() => remove(s.id)}
                className="opacity-0 group-hover:opacity-100 text-faint hover:text-sig-failed font-mono text-[13px] transition-opacity shrink-0"
                style={{ lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
