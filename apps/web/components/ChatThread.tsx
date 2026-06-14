'use client';
import React, { useEffect, useRef } from 'react';
import type { ChatMessage, NormalizedEvent, ChatCommandResult } from '@fleet/shared';
import { useChatStream } from '@/lib/live';
import { api } from '@/lib/api';
import { MarkdownView } from './MarkdownView';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { PermissionCard } from './PermissionCard';
import { SubagentChip } from './SubagentChip';
import { ChatTable } from './ChatTable';
import { ErrorBanner, Btn } from './ui';

const TERMINAL = new Set(['completed', 'failed', 'killed']);
const roleLabelColor = (role: string) => (role === 'user' ? '#39d4cf' : role === 'system' ? '#9aa1ab' : '#ffb000');

/** Try to parse a persisted command-result message body as a serialized ChatCommandResult. */
function parseCommandResult(content: string): ChatCommandResult | null {
  try {
    const o = JSON.parse(content);
    if (o && typeof o === 'object' && 'kind' in o) return o as ChatCommandResult;
  } catch { /* not JSON → plain text */ }
  return null;
}

/** One persisted message → markdown / table / error, per its kind. */
function PersistedMessage({ m }: { m: ChatMessage }) {
  if (m.kind === 'error') {
    return <div className="my-1"><ErrorBanner>{m.content}</ErrorBanner></div>;
  }
  if (m.kind === 'command-result') {
    const res = parseCommandResult(m.content);
    if (res?.kind === 'table') return <ChatTable columns={res.columns ?? []} rows={res.rows ?? []} />;
    if (res?.kind === 'error') return <div className="my-1"><ErrorBanner>{res.text ?? m.content}</ErrorBanner></div>;
    return <MarkdownView source={res?.text ?? m.content} />;
  }
  if (m.kind === 'command') {
    // the user's slash command echo — keep it terse + monospace
    return <div className="font-mono text-[12px] text-dim my-1">{m.content}</div>;
  }
  return (
    <div className="my-1">
      <div className="font-display uppercase tracking-wider text-[9px] mb-0.5" style={{ color: roleLabelColor(m.role) }}>{m.role}</div>
      <MarkdownView source={m.content} />
    </div>
  );
}

/** The live turn — consumes the chat-scoped stream and renders the full event vocabulary
 *  as ordered, chat-native cards. Fires onComplete once when the backing run goes terminal. */
function LiveTurn({
  sessionId, onComplete, onError,
}: { sessionId: string; onComplete: (runId: string, finalText: string) => void; onError: (runId: string) => void }) {
  const { run, events, partials, state, error } = useChatStream(sessionId);
  const done = useRef<string | null>(null);

  // Final assistant text = concatenation of assistant_text + result payloads (matches the old contract).
  const finalText = events
    .filter((e) => e.type === 'assistant_text' || e.type === 'result')
    .map((e) => String((e.payload as any)?.text ?? (e.payload as any)?.result ?? ''))
    .join('');

  useEffect(() => {
    if (!run || done.current === run.id || !TERMINAL.has(run.status)) return;
    done.current = run.id;
    onComplete(run.id, (run as any).resultText ?? finalText);
  }, [run, finalText, onComplete]);

  if (error) {
    return (
      <ErrorBanner>
        live stream lost — {error}
        <button type="button" onClick={() => onError(run?.id ?? '')} className="ml-2 underline hover:text-ink transition-colors">dismiss</button>
      </ErrorBanner>
    );
  }

  // Live streaming token text (any node currently mid-message).
  const streaming = Object.values(partials).filter(Boolean).join('');
  const nothingYet = events.length === 0 && !streaming;

  return (
    <div className="space-y-1">
      {events.map((ev: NormalizedEvent, i: number) => {
        const p: any = ev.payload ?? {};
        switch (ev.type) {
          case 'assistant_text':
            return <div key={i} className="my-1"><MarkdownView source={String(p.text ?? '')} /></div>;
          case 'thinking':
            return <ThinkingBlock key={i} text={String(p.text ?? '')} />;
          case 'tool_use': {
            // pair with its tool_result (matched on the tool_use id) if present later in the stream
            const result = events.find((e) => e.type === 'tool_result' && (e.payload as any)?.forId === p.id);
            const rp: any = result?.payload ?? null;
            return (
              <ToolCallCard
                key={i}
                name={String(p.name ?? 'tool')}
                input={p.input}
                result={rp ? String(rp.text ?? '') : null}
                isError={!!rp?.isError}
              />
            );
          }
          case 'tool_result':
            return null; // rendered inside its paired ToolCallCard
          case 'permission_request':
            return (
              <PermissionCard
                key={i}
                sessionId={sessionId}
                requestId={String(p.requestId ?? p.id ?? '')}
                toolName={String(p.toolName ?? p.name ?? 'tool')}
                input={p.input}
              />
            );
          case 'subagent_spawned':
            return <SubagentChip key={i} label={String(p.label ?? 'subagent')} childId={String(p.childId ?? '')} />;
          case 'result':
            return null; // folded into finalText / onComplete
          default:
            return null;
        }
      })}
      {streaming && (
        <div className="my-1">
          <MarkdownView source={streaming} />
          <span className="caret" />
        </div>
      )}
      {nothingYet && state === 'running' && <div className="text-[13px] text-faint">⟳ thinking…</div>}
    </div>
  );
}

export function ChatThread({
  sessionId, messages, onTurnComplete, onTurnError,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  onTurnComplete: (runId: string, finalText: string) => void;
  onTurnError: (runId: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const { state } = useChatStream(sessionId);

  useEffect(() => {
    const end = endRef.current;
    if (!end) return;
    let sc: HTMLElement | null = end.parentElement;
    while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
    if (!sc) return;
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120) sc.scrollTop = sc.scrollHeight;
  }, [messages.length, state]);

  return (
    <div className="flex-1 overflow-auto p-4">
      {messages.map((m) => <PersistedMessage key={m.id} m={m} />)}
      {sessionId && <LiveTurn sessionId={sessionId} onComplete={onTurnComplete} onError={onTurnError} />}
      {state === 'running' && (
        <div className="sticky bottom-0 flex justify-center py-2">
          <Btn variant="danger" onClick={() => { if (sessionId) api.chatInterrupt(sessionId).catch(() => {}); }}>stop</Btn>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
