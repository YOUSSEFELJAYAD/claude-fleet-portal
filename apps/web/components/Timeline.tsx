'use client';
import React, { useEffect, useRef } from 'react';
import type { NormalizedEvent } from '@fleet/shared';
import { clock } from '@/lib/format';

const META: Record<string, { glyph: string; color: string; label: string }> = {
  init: { glyph: '⏻', color: '#5b626d', label: 'session init' },
  assistant_text: { glyph: '▸', color: '#e9e7df', label: 'assistant' },
  thinking: { glyph: '✶', color: '#7b6db0', label: 'thinking' },
  tool_use: { glyph: '→', color: '#39d4cf', label: 'tool' },
  tool_result: { glyph: '←', color: '#54e08a', label: 'result' },
  subagent_spawned: { glyph: '⧉', color: '#ffb000', label: 'spawn' },
  subagent_done: { glyph: '✓', color: '#54e08a', label: 'subagent done' },
  permission_request: { glyph: '⚠', color: '#b08cff', label: 'permission' },
  result: { glyph: '■', color: '#ffb000', label: 'run result' },
  error: { glyph: '✕', color: '#ff5d5d', label: 'error' },
  status: { glyph: '·', color: '#5b626d', label: 'status' },
  rate_limit: { glyph: '◷', color: '#5b626d', label: 'rate limit' },
};

function preview(v: unknown, max = 280): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…' : v;
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function EventRow({ ev, raw }: { ev: NormalizedEvent; raw: boolean }) {
  const p: any = ev.payload ?? {};
  let m = META[ev.type] ?? { glyph: '·', color: '#5b626d', label: ev.type };
  if (ev.type === 'subagent_done' && p.isError) m = { glyph: '✕', color: '#ff5d5d', label: 'subagent failed' };
  let body: React.ReactNode = null;

  if (raw) {
    body = <pre className="text-faint text-[10.5px] whitespace-pre-wrap break-all mt-1">{JSON.stringify(p.raw ?? p, null, 1)}</pre>;
  } else {
    switch (ev.type) {
      case 'assistant_text':
      case 'thinking':
        body = <span className="text-ink/90">{preview(p.text, 600)}</span>;
        break;
      case 'tool_use':
        body = (
          <span>
            <span className="text-sig-running" style={{ color: '#39d4cf' }}>{p.name}</span>
            <span className="text-faint"> {preview(p.input, 160)}</span>
          </span>
        );
        break;
      case 'tool_result':
        body = <span className="text-dim">{preview(p.text, 220)}</span>;
        break;
      case 'subagent_spawned':
        body = (
          <span>
            <span className="text-amber">spawned</span> <span className="text-ink">{p.label}</span>{' '}
            <span className="text-faint">({String(p.childId).slice(0, 8)})</span>
          </span>
        );
        break;
      case 'subagent_done':
        body = p.isError ? (
          <span style={{ color: '#ff5d5d' }}>✕ subagent failed · {preview(p.result, 200)}</span>
        ) : (
          <span className="text-dim">↩ {preview(p.result, 200)}</span>
        );
        break;
      case 'result':
        body = (
          <span>
            <span className="text-ink">{preview(p.result, 280)}</span>
            {p.costUsd != null && <span className="text-amber ml-2 font-mono">${Number(p.costUsd).toFixed(4)}</span>}
          </span>
        );
        break;
      case 'permission_request':
        body = <span className="text-sig-awaiting" style={{ color: '#b08cff' }}>{preview(p, 160)}</span>;
        break;
      default:
        body = <span className="text-faint">{m.label}</span>;
    }
  }

  return (
    <div className="flex gap-2.5 py-1.5 border-b border-white/[0.04] text-[12px] leading-relaxed">
      <span className="font-mono text-[10px] text-faint shrink-0 w-[58px] pt-0.5 tnum">{clock(ev.ts)}</span>
      <span className="shrink-0 pt-0.5" style={{ color: m.color }}>{m.glyph}</span>
      <div className="min-w-0 flex-1 break-words">{body}</div>
    </div>
  );
}

export function Timeline({
  events,
  partial,
  raw,
}: {
  events: NormalizedEvent[];
  partial?: string;
  raw: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, partial]);

  return (
    <div>
      {events.length === 0 && !partial && (
        <div className="font-mono text-[12px] text-faint py-6">No events for this node yet.</div>
      )}
      {events.map((ev) => (
        <EventRow key={`${ev.seq}-${ev.nodeId}`} ev={ev} raw={raw} />
      ))}
      {partial && (
        <div className="flex gap-2.5 py-1.5 text-[12px]">
          <span className="font-mono text-[10px] text-faint shrink-0 w-[58px] pt-0.5">live</span>
          <span className="shrink-0 pt-0.5 text-ink">▸</span>
          <div className="min-w-0 flex-1">
            <span className="text-ink/90">{partial}</span>
            <span className="caret" />
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
