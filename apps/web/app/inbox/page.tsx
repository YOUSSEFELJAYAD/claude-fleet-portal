'use client';
import React, { useDeferredValue, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Panel, Kicker, Btn, Input, Textarea, Dot, ErrorBanner } from '@/components/ui';
import { usd, ago } from '@/lib/format';

const POLL_MS = 4000;

type FilterKey = 'all' | 'permission' | 'input';

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

function formatPayload(value: unknown, max = 900) {
  if (value == null) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? text.slice(0, max) + '\n…' : text;
}

function queueLabel(kind: InboxItem['kind']) {
  return kind === 'permission'
    ? { label: 'permission', color: '#ffb000', bg: 'rgba(255,176,0,0.1)', border: 'rgba(255,176,0,0.28)' }
    : { label: 'input needed', color: '#39d4cf', bg: 'rgba(57,212,207,0.1)', border: 'rgba(57,212,207,0.28)' };
}

function QueueBadge({ kind }: { kind: InboxItem['kind'] }) {
  const q = queueLabel(kind);
  return (
    <span
      className="font-display text-[10px] uppercase tracking-widest px-2 py-1 inline-flex items-center gap-1.5"
      style={{ color: q.color, background: q.bg, border: `1px solid ${q.border}` }}
    >
      <Dot color={q.color} live size={6} />
      {q.label}
    </span>
  );
}

function RunHeader({ item }: { item: InboxItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <QueueBadge kind={item.kind} />
        <span className="font-mono text-[10px] text-faint border border-line2 px-1.5 py-0.5">
          {item.run.model.replace('claude-', '')}
        </span>
        <span className="font-mono text-[10px] text-faint border border-line2 px-1.5 py-0.5">
          {item.run.status}
        </span>
      </div>
      <Link
        href={`/runs/${item.run.id}`}
        className="block font-display text-[14px] uppercase tracking-wide text-ink hover:text-amber leading-snug"
      >
        {item.run.task}
      </Link>
      <div className="mt-1.5 font-mono text-[10px] text-faint truncate">
        {item.run.cwd}
      </div>
    </div>
  );
}

function CardShell({ item, children }: { item: InboxItem; children: React.ReactNode }) {
  return (
    <div className="border hairline bg-black/20 transition-colors hover:bg-white/[0.025]">
      <div className="p-4 border-b hairline flex items-start justify-between gap-4">
        <RunHeader item={item} />
        <div className="shrink-0 text-right font-mono tnum">
          <div className="text-[10px] text-faint">started {ago(item.run.startedAt)}</div>
          <div className="text-[12px] text-ink mt-1">{usd(item.run.costUsd)}</div>
          <Link href={`/runs/${item.run.id}`} className="inline-block mt-2 text-[10px] text-faint hover:text-amber uppercase tracking-wider">
            view run →
          </Link>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function PermissionCard({ item, onAction }: { item: InboxItem; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasRequest = !!item.request;
  const tool = item.request?.payload.tool ?? 'unknown';
  const requestId = item.request?.id ?? 'pending';
  const inputSummary = formatPayload(item.request?.payload.input);

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

  return (
    <CardShell item={item}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div>
          <Kicker>requested tool</Kicker>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[13px] text-amber border border-amber/25 bg-amber/5 px-2 py-1">
              {tool}
            </span>
            <span className="font-mono text-[10px] text-faint">request {requestId}</span>
          </div>

          {inputSummary ? (
            <details className="mt-4 group" open>
              <summary className="cursor-pointer font-display text-[10px] uppercase tracking-widest text-faint hover:text-amber">
                tool input
              </summary>
              <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-none border border-line2 bg-black/35 p-3 font-mono text-[11px] leading-relaxed text-dim">
                {inputSummary}
              </pre>
            </details>
          ) : (
            <div className="mt-4 font-mono text-[11px] text-faint">No tool input payload captured.</div>
          )}
        </div>

        <div className="border border-line2 bg-black/20 p-3 flex flex-col justify-between gap-3">
          <div>
            <Kicker>decision</Kicker>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-faint">
              Approve only if the tool and target look correct. Deny sends the control response back to the same run.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Btn variant="solid" onClick={() => decide('approve')} disabled={busy || !hasRequest} className="justify-center !py-2">
              Approve
            </Btn>
            <Btn variant="danger" onClick={() => decide('deny')} disabled={busy || !hasRequest} className="justify-center !py-2">
              Deny
            </Btn>
          </div>
        </div>
      </div>

      {!hasRequest && (
        <div className="font-mono text-[10px] text-faint mt-3">
          No pending request captured. Open the run timeline before deciding.
        </div>
      )}
      {err && <ErrorBanner className="mt-3">{err}</ErrorBanner>}
    </CardShell>
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
    <CardShell item={item}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,380px)]">
        <div>
          <Kicker>last message</Kicker>
          {item.lastText ? (
            <div className="mt-2 max-h-[220px] overflow-auto border border-line2 bg-black/35 p-3 font-mono text-[11px] leading-relaxed text-dim whitespace-pre-wrap">
              {item.lastText}
            </div>
          ) : (
            <div className="mt-2 font-mono text-[11px] text-faint">No assistant preview captured.</div>
          )}
        </div>

        <div>
          <Kicker>your reply</Kicker>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
            }}
            placeholder="Type the next instruction for this run…"
            disabled={busy}
            rows={6}
            className="mt-2 !text-[12px]"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] text-faint">⌘/Ctrl Enter sends</span>
            <Btn variant="solid" onClick={send} disabled={busy || !text.trim()} className="!px-4 !py-2">
              Send Reply
            </Btn>
          </div>
        </div>
      </div>
      {err && <ErrorBanner className="mt-3">{err}</ErrorBanner>}
    </CardShell>
  );
}

function matches(item: InboxItem, query: string) {
  if (!query) return true;
  const haystack = [
    item.kind,
    item.run.task,
    item.run.cwd,
    item.run.model,
    item.run.status,
    item.request?.payload.tool,
    item.request?.id,
    item.lastText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [q, setQ] = useState('');
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const deferredQ = useDeferredValue(q.trim().toLowerCase());
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm() {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => loadInbox(false), POLL_MS);
  }

  function loadInbox(manual = false) {
    if (manual) setRefreshing(true);
    api
      .inbox()
      .then((data) => {
        if (!alive.current) return;
        setItems(data.items);
        setErr(null);
        setLoading(false);
        setLastLoadedAt(Date.now());
        rearm();
      })
      .catch((e) => {
        if (!alive.current) return;
        setErr(e.message ?? 'Failed to load inbox');
        setLoading(false);
        rearm();
      })
      .finally(() => {
        if (alive.current) setRefreshing(false);
      });
  }

  useEffect(() => {
    alive.current = true;
    loadInbox(false);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const permItems = items.filter((i) => i.kind === 'permission');
  const inputItems = items.filter((i) => i.kind === 'input');
  const filtered = items.filter((i) => (filter === 'all' || i.kind === filter) && matches(i, deferredQ));

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      <Panel ticked className="p-5 overflow-hidden relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/60 to-transparent" />
        <div className="flex items-start justify-between gap-5 flex-wrap">
          <div className="max-w-3xl">
            <Kicker>Approval Inbox</Kicker>
            <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Human Gate</h1>
            <p className="mt-2 font-mono text-[11px] text-faint leading-relaxed">
              One place for every run blocked on your approval or next instruction. Permission decisions reuse the run control channel;
              input replies continue the interactive session.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Btn onClick={() => loadInbox(true)} disabled={refreshing}>
              {refreshing ? 'refreshing…' : 'Refresh'}
            </Btn>
            <Link href="/" className="font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border border-line2 text-dim hover:text-amber hover:border-amber/60">
              Fleet
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          <div className="border border-line2 bg-black/25 p-3">
            <Kicker>waiting</Kicker>
            <div className="font-mono tnum text-[24px] text-ink mt-1">{items.length}</div>
          </div>
          <div className="border border-line2 bg-black/25 p-3">
            <Kicker>permissions</Kicker>
            <div className="font-mono tnum text-[24px] text-amber mt-1">{permItems.length}</div>
          </div>
          <div className="border border-line2 bg-black/25 p-3">
            <Kicker>inputs</Kicker>
            <div className="font-mono tnum text-[24px] mt-1" style={{ color: '#39d4cf' }}>{inputItems.length}</div>
          </div>
          <div className="border border-line2 bg-black/25 p-3">
            <Kicker>poll</Kicker>
            <div className="font-mono text-[13px] text-dim mt-2">
              {POLL_MS / 1000}s
              {lastLoadedAt && <span className="block text-[10px] text-faint mt-1">last {ago(lastLoadedAt)}</span>}
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <Panel className="p-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-1 flex-wrap">
              {([
                ['all', `All (${items.length})`],
                ['permission', `Permissions (${permItems.length})`],
                ['input', `Input (${inputItems.length})`],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className="font-display text-[11px] uppercase tracking-wider px-3 py-1.5 border transition-colors"
                  style={{
                    borderColor: filter === key ? '#ffb000' : 'rgba(255,255,255,0.075)',
                    color: filter === key ? '#ffb000' : '#9aa1ab',
                    background: filter === key ? 'rgba(255,176,0,0.08)' : 'transparent',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search task, cwd, tool…"
              className="w-full sm:w-[280px] !py-1.5 !text-[12px]"
            />
          </Panel>

          {err && (
            <ErrorBanner onRetry={() => loadInbox(true)}>{err}</ErrorBanner>
          )}

          {loading && !err && (
            <Panel className="p-8 font-mono text-[11px] text-faint">
              Loading approval queue…
            </Panel>
          )}

          {!loading && filtered.length === 0 && (
            <Panel className="p-10 text-center">
              <div className="font-display text-[13px] uppercase tracking-widest text-ink">
                {items.length === 0 ? 'Nothing waiting on you' : 'No matching inbox items'}
              </div>
              <p className="font-mono text-[11px] text-faint mt-2">
                {items.length === 0
                  ? 'Runs that need permission or interactive input will appear here automatically.'
                  : 'Try a different filter or search term.'}
              </p>
            </Panel>
          )}

          {filtered.length > 0 && (
            <div className="flex flex-col gap-4">
              {filtered.map((item) =>
                item.kind === 'permission' ? (
                  <PermissionCard key={`${item.run.id}:permission`} item={item} onAction={() => loadInbox(true)} />
                ) : (
                  <InputCard key={`${item.run.id}:input`} item={item} onAction={() => loadInbox(true)} />
                ),
              )}
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <Panel className="p-4">
            <Kicker>queue rules</Kicker>
            <div className="mt-3 space-y-3 font-mono text-[11px] text-dim leading-relaxed">
              <p><span className="text-amber">Permission</span> items are latest tool-use gates captured from the run event stream.</p>
              <p><span style={{ color: '#39d4cf' }}>Input</span> items are interactive runs waiting for the next user message.</p>
              <p>There is no separate inbox database: clearing a blocker happens by advancing the run.</p>
            </div>
          </Panel>

          <Panel className="p-4">
            <Kicker>before approving</Kicker>
            <div className="mt-3 grid gap-2 font-mono text-[11px] text-faint">
              <div className="border border-line2 p-2">Check the target path and command payload.</div>
              <div className="border border-line2 p-2">Open the run when the request payload is missing or unclear.</div>
              <div className="border border-line2 p-2">Deny if the tool is outside the task scope.</div>
            </div>
          </Panel>

          <Panel className="p-4">
            <Kicker>live link</Kicker>
            <p className="mt-3 font-mono text-[11px] text-faint leading-relaxed">
              The page refreshes every {POLL_MS / 1000}s. Run pages stream in real time, so use them for full context before sending a decision.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
