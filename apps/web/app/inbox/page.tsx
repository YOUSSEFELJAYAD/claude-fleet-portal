'use client';
import React, { useDeferredValue, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Panel, Kicker, Btn, Input, Textarea, Dot, Badge, Tab, Empty, ErrorBanner } from '@/components/ui';
import { usd, ago } from '@/lib/format';
import { QuestionCard } from '@/components/QuestionCard';

const POLL_MS = 4000;

type FilterKey = 'all' | 'permission' | 'input' | 'question';

interface SlimRun {
  id: string;
  task: string;
  cwd: string;
  model: string;
  status: string;
  startedAt: number;
  costUsd: number;
}

interface QuestionData {
  id: string;
  sessionId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  createdAt: number;
}

interface InboxItem {
  run?: SlimRun;
  kind: 'permission' | 'input' | 'question';
  request?: { id: string; payload: { tool: string; input: unknown } };
  lastText?: string;
  /** F-perm — true when the permission item is from the PreToolUse hook store. */
  viaHook?: boolean;
  question?: QuestionData;
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

const queueMeta = (kind: InboxItem['kind']) =>
  kind === 'permission'
    ? { label: 'permission', color: '#ffb000' }
    : kind === 'question'
      ? { label: 'question', color: '#39d4cf' }
      : { label: 'input needed', color: '#39d4cf' };

function QueueBadge({ kind }: { kind: InboxItem['kind'] }) {
  const q = queueMeta(kind);
  return <Badge label={q.label} color={q.color} live />;
}

function RunHeader({ item }: { item: InboxItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <QueueBadge kind={item.kind} />
        {item.run && (
          <>
            <span className="font-mono text-[10px] text-faint border border-line2 px-1.5 py-0.5">
              {item.run.model.replace('claude-', '')}
            </span>
            <span className="font-mono text-[10px] text-faint border border-line2 px-1.5 py-0.5">
              {item.run.status}
            </span>
          </>
        )}
      </div>
      {item.run && (
        <>
          <Link
            href={`/runs/${item.run.id}`}
            className="block font-display text-[14px] uppercase tracking-wide text-ink hover:text-amber leading-snug"
          >
            {item.run.task}
          </Link>
          <div className="mt-1.5 font-mono text-[10px] text-faint truncate">
            {item.run.cwd}
          </div>
        </>
      )}
    </div>
  );
}

function CardShell({ item, children }: { item: InboxItem; children: React.ReactNode }) {
  return (
    <div className="border hairline bg-black/20 transition-colors hover:bg-white/[0.025]">
      <div className="p-4 border-b hairline flex items-start justify-between gap-4">
        <RunHeader item={item} />
        {item.run && (
          <div className="shrink-0 text-right font-mono tnum">
            <div className="text-[10px] text-faint">started {ago(item.run.startedAt)}</div>
            <div className="text-[12px] text-ink mt-1">{usd(item.run.costUsd)}</div>
            <Link href={`/runs/${item.run.id}`} className="inline-block mt-2 text-[10px] text-faint hover:text-amber uppercase tracking-wider">
              view run →
            </Link>
          </div>
        )}
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
    if (!item.request || !item.run) return;
    setBusy(true);
    setErr(null);
    try {
      // F-perm — hook-based gates resolve via the inbox decide route; the legacy stdin path
      // (dormant under headless -p) still uses /api/agents/:id/permission.
      if (item.viaHook) await api.decidePermissionGate(item.request.id, decision);
      else await api.permission(item.run.id, item.request.id, decision);
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
    if (!text.trim() || !item.run) return;
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
    item.run?.task,
    item.run?.cwd,
    item.run?.model,
    item.run?.status,
    item.request?.payload.tool,
    item.request?.id,
    item.lastText,
    item.question?.question,
    ...(item.question?.options ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'permission', label: 'Permissions' },
  { key: 'input', label: 'Input' },
  { key: 'question', label: 'Questions' },
];

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
  const questionItems = items.filter((i) => i.kind === 'question');
  const filtered = items.filter((i) => (filter === 'all' || i.kind === filter) && matches(i, deferredQ));

  const counts: Record<FilterKey, number> = {
    all: items.length,
    permission: permItems.length,
    input: inputItems.length,
    question: questionItems.length,
  };

  return (
    <div>
      <Kicker>approval inbox</Kicker>
      <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-1">Human Gate</h1>
      <p className="font-mono text-[11px] text-faint mb-5">
        One place for every run blocked on your approval or next instruction — permission decisions reuse the run control channel; input replies continue the interactive session.
      </p>

      {err && <ErrorBanner className="mb-5" onRetry={() => loadInbox(true)}>{err}</ErrorBanner>}

      <div className="space-y-5">
        {/* ── block 1 · queue ────────────────────────────────────────────────── */}
        <Panel ticked>
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b hairline flex-wrap">
            <span className="flex items-center gap-2">
              <Dot color="#ffb000" live={items.length > 0} size={6} />
              <Kicker>waiting</Kicker>
              <span className="font-mono tnum text-[12px] text-amber ml-1">{String(items.length).padStart(2, '0')}</span>
              <span className="font-mono text-[10px] text-faint ml-1">
                {permItems.length} perm · {inputItems.length} input · {questionItems.length} question · {POLL_MS / 1000}s poll{lastLoadedAt && ` · last ${ago(lastLoadedAt)}`}
              </span>
            </span>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-1">
                {FILTERS.map((f) => (
                  <Tab key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                    {f.label} {counts[f.key]}
                  </Tab>
                ))}
              </div>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search task, cwd, tool…" className="w-[220px] !py-1" />
              <Btn onClick={() => loadInbox(true)} disabled={refreshing}>{refreshing ? 'refreshing…' : 'Refresh'}</Btn>
            </div>
          </div>
          <div className="p-4">
            {loading && !err ? (
              <div className="font-mono text-[11px] text-faint">Loading approval queue…</div>
            ) : filtered.length === 0 ? (
              <Empty>
                {items.length === 0
                  ? 'Nothing waiting on you — runs that need permission or interactive input appear here automatically.'
                  : 'No matching inbox items — try a different filter or search term.'}
              </Empty>
            ) : (
              <div className="flex flex-col gap-4">
                {filtered.map((item) =>
                  item.kind === 'permission' ? (
                    // Key by the unique permission request id first: a run can have several
                    // concurrent hook gates (parallel Bash/Edit/Write in one turn), all sharing the
                    // same run id — keying on run id would collide and mis-associate card state.
                    <PermissionCard key={`${item.request?.id ?? item.run?.id}:permission`} item={item} onAction={() => loadInbox(true)} />
                  ) : item.kind === 'question' ? (
                    <QuestionCard key={`${item.question?.id}:question`} item={item} onAction={() => loadInbox(true)} />
                  ) : (
                    <InputCard key={`${item.run?.id}:input`} item={item} onAction={() => loadInbox(true)} />
                  ),
                )}
              </div>
            )}
          </div>
        </Panel>

        {/* ── block 2 · queue rules ──────────────────────────────────────────── */}
        <Panel>
          <div className="px-4 py-3 border-b hairline">
            <Kicker>queue rules</Kicker>
          </div>
          <div className="p-4 grid gap-4 md:grid-cols-2">
            <div className="space-y-2 font-mono text-[11px] text-dim leading-relaxed">
              <p><span className="text-amber">Permission</span> items are latest tool-use gates captured from the run event stream.</p>
              <p><span style={{ color: '#39d4cf' }}>Input</span> items are interactive runs waiting for the next user message.</p>
              <p><span style={{ color: '#39d4cf' }}>Question</span> items are mid-run gates where the agent needs a structured answer to continue.</p>
              <p>There is no separate inbox database: clearing a blocker happens by advancing the run. The page refreshes every {POLL_MS / 1000}s; run pages stream in real time, so use them for full context before deciding.</p>
            </div>
            <div className="grid gap-2 font-mono text-[11px] text-faint">
              <div className="border border-line2 p-2">Check the target path and command payload.</div>
              <div className="border border-line2 p-2">Open the run when the request payload is missing or unclear.</div>
              <div className="border border-line2 p-2">Deny if the tool is outside the task scope.</div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
