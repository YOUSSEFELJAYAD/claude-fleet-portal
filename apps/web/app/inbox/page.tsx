'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Panel, Kicker, Btn, Input } from '@/components/ui';
import { usd, ago } from '@/lib/format';

const POLL_MS = 4000;

interface SlimRun {
  id: string;
  task: string;
  cwd: string;
  model: string;
  status: string;
  startedAt: number;
  costUsd: number;
}

interface InboxItem {
  run: SlimRun;
  kind: 'permission' | 'input';
  request?: { id: string; payload: { tool: string; input: unknown } };
  lastText?: string;
}

function PermissionCard({ item, onAction }: { item: InboxItem; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    if (!item.request) return;
    setBusy(true);
    setErr(null);
    try {
      await api.permission(item.run.id, item.request.id, decision);
      onAction();
    } catch (e: any) {
      setErr(e.message ?? 'Error');
    } finally {
      setBusy(false);
    }
  }

  const hasRequest = !!item.request;
  const tool = item.request?.payload.tool ?? 'unknown';
  const rawInput = item.request?.payload.input;
  const inputSummary =
    rawInput == null
      ? ''
      : typeof rawInput === 'string'
        ? rawInput.slice(0, 200)
        : JSON.stringify(rawInput).slice(0, 200);

  return (
    <div className="border hairline p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="font-display text-[10px] uppercase tracking-widest px-1.5 py-0.5"
              style={{ color: '#ffb000', background: 'rgba(255,176,0,0.1)', border: '1px solid rgba(255,176,0,0.25)' }}
            >
              permission
            </span>
            <span className="font-mono text-[11px]" style={{ color: '#54a0e0' }}>
              {tool}
            </span>
          </div>
          <Link
            href={`/runs/${item.run.id}`}
            className="block font-display text-[12px] uppercase tracking-wide text-ink hover:text-amber truncate"
          >
            {item.run.task}
          </Link>
          {inputSummary && (
            <div className="mt-1.5 font-mono text-[11px] text-faint break-all whitespace-pre-wrap" style={{ maxHeight: 72, overflow: 'hidden' }}>
              {inputSummary}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[10px] text-faint">{ago(item.run.startedAt)}</div>
          <div className="font-mono text-[10px] text-faint mt-0.5">{usd(item.run.costUsd)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Btn variant="solid" onClick={() => decide('approve')} disabled={busy || !hasRequest} className="!px-3 !py-1.5 !text-[11px]">
          ✓ Approve
        </Btn>
        <Btn variant="ghost" onClick={() => decide('deny')} disabled={busy || !hasRequest} className="!px-3 !py-1.5 !text-[11px]">
          ✕ Deny
        </Btn>
        <Link href={`/runs/${item.run.id}`} className="font-display text-[10px] uppercase tracking-wider text-faint hover:text-amber ml-auto">
          view run →
        </Link>
      </div>
      {!hasRequest && (
        <div className="font-mono text-[10px] text-faint">
          no pending request captured — open the run to review
        </div>
      )}
      {err && <div className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{err}</div>}
    </div>
  );
}

function InputCard({ item, onAction }: { item: InboxItem; onAction: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.input(item.run.id, text.trim());
      setText('');
      onAction();
    } catch (e: any) {
      setErr(e.message ?? 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border hairline p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="font-display text-[10px] uppercase tracking-widest px-1.5 py-0.5"
              style={{ color: '#39d4cf', background: 'rgba(57,212,207,0.1)', border: '1px solid rgba(57,212,207,0.25)' }}
            >
              input needed
            </span>
          </div>
          <Link
            href={`/runs/${item.run.id}`}
            className="block font-display text-[12px] uppercase tracking-wide text-ink hover:text-amber truncate"
          >
            {item.run.task}
          </Link>
          {item.lastText && (
            <div className="mt-1.5 font-mono text-[11px] text-faint whitespace-pre-wrap" style={{ maxHeight: 80, overflow: 'hidden' }}>
              {item.lastText}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[10px] text-faint">{ago(item.run.startedAt)}</div>
          <div className="font-mono text-[10px] text-faint mt-0.5">{usd(item.run.costUsd)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Type your reply…"
          disabled={busy}
          className="flex-1 !text-[12px]"
        />
        <Btn variant="solid" onClick={send} disabled={busy || !text.trim()} className="!px-3 !py-1.5 !text-[11px] shrink-0">
          Send
        </Btn>
        <Link href={`/runs/${item.run.id}`} className="font-display text-[10px] uppercase tracking-wider text-faint hover:text-amber shrink-0">
          view →
        </Link>
      </div>
      {err && <div className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{err}</div>}
    </div>
  );
}

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm() {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(loadInbox, POLL_MS);
  }

  function loadInbox() {
    api
      .inbox()
      .then((data) => {
        if (!alive.current) return;
        setItems(data.items);
        setErr(null);
        setLoading(false);
        rearm();
      })
      .catch((e) => {
        if (!alive.current) return;
        setErr(e.message ?? 'Failed to load inbox');
        setLoading(false);
        rearm();
      });
  }

  useEffect(() => {
    alive.current = true;
    loadInbox();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const permItems = items.filter((i) => i.kind === 'permission');
  const inputItems = items.filter((i) => i.kind === 'input');

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      {/* header */}
      <div className="flex items-center justify-between">
        <div>
          <Kicker>Approval Inbox</Kicker>
          <h1 className="font-display text-[20px] tracking-wide text-ink mt-1">Inbox</h1>
        </div>
        {items.length > 0 && (
          <div className="font-mono text-[11px] text-faint">
            {items.length} waiting
          </div>
        )}
      </div>

      {err && (
        <div className="border hairline p-3 font-mono text-[11px]" style={{ color: '#ff5d5d', borderColor: 'rgba(255,93,93,0.3)' }}>
          {err}
        </div>
      )}

      {loading && !err && (
        <div className="font-mono text-[11px] text-faint">Loading…</div>
      )}

      {!loading && items.length === 0 && (
        <Panel>
          <div className="p-8 text-center font-mono text-[12px] text-faint">
            — nothing waiting on you —
          </div>
        </Panel>
      )}

      {permItems.length > 0 && (
        <Panel>
          <div className="px-4 py-3 border-b hairline flex items-center gap-3">
            <span className="font-display text-[12px] uppercase tracking-wide text-ink">Permission Requests</span>
            <span className="font-mono text-[10px]" style={{ color: '#ffb000' }}>{permItems.length}</span>
          </div>
          <div className="p-4 flex flex-col gap-4">
            {permItems.map((item) => (
              <PermissionCard key={item.run.id} item={item} onAction={loadInbox} />
            ))}
          </div>
        </Panel>
      )}

      {inputItems.length > 0 && (
        <Panel>
          <div className="px-4 py-3 border-b hairline flex items-center gap-3">
            <span className="font-display text-[12px] uppercase tracking-wide text-ink">Input Needed</span>
            <span className="font-mono text-[10px]" style={{ color: '#39d4cf' }}>{inputItems.length}</span>
          </div>
          <div className="p-4 flex flex-col gap-4">
            {inputItems.map((item) => (
              <InputCard key={item.run.id} item={item} onAction={loadInbox} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
