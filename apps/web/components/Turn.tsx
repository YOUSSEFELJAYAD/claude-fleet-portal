'use client';
import React, { useState } from 'react';
import type { ChatTurn, ChatMessage, ChatCommandResult, NormalizedEvent } from '@fleet/shared';
import type { ChatActiveTurn } from '@/lib/live';
import { MarkdownView } from './MarkdownView';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { PermissionCard } from './PermissionCard';
import { SubagentChip } from './SubagentChip';
import { ChatTable } from './ChatTable';
import { ErrorBanner } from './ui';

// ── helpers ───────────────────────────────────────────────────────────────────

function parseCommandResult(content: string): ChatCommandResult | null {
  try {
    const o = JSON.parse(content);
    if (o && typeof o === 'object' && 'kind' in o) return o as ChatCommandResult;
  } catch { /* plain text */ }
  return null;
}

// ponytail: inline SVGs — lucide-react not installed; add dep only if icon set grows project-wide
function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 .49-3.5" />
    </svg>
  );
}

// ── User bubble — right-aligned ───────────────────────────────────────────────

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="rounded-2xl px-4 py-2.5 max-w-[80%] text-white font-sans text-[14px] leading-[1.65] whitespace-pre-wrap break-words"
        style={{ background: '#4f7fff' }}
      >
        {content}
      </div>
    </div>
  );
}

// ── Action row (copy + retry) under settled assistant content ─────────────────

function AssistantActions({ textToCopy, onRetry }: { textToCopy?: string; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  if (!textToCopy && !onRetry) return null;
  return (
    <div className="flex items-center gap-0.5 mt-1">
      {textToCopy && (
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy response'}
          className="p-1.5 rounded-lg text-faint hover:text-dim transition-colors"
        >
          {copied
            ? <span className="text-[11px] font-sans leading-none">✓</span>
            : <CopyIcon />}
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          title="Retry"
          className="p-1.5 rounded-lg text-faint hover:text-dim transition-colors"
        >
          <RetryIcon />
        </button>
      )}
    </div>
  );
}

// ── Failed-turn inline error + retry ──────────────────────────────────────────

function FailedTurnBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-[#ff5d5d]/40 bg-[#ff5d5d]/[0.07] px-4 py-3 font-sans text-[13px] text-[#ff5d5d]">
      <div className="leading-[1.5]">{message}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-dim hover:text-ink border border-[rgba(255,255,255,0.08)] rounded-lg px-2.5 py-1 transition-colors"
        >
          <RetryIcon />
          <span>Retry</span>
        </button>
      )}
    </div>
  );
}

// ── Settled message renderer ──────────────────────────────────────────────────

function SettledMsg({ m }: { m: ChatMessage }) {
  // Special kinds first (can occur on any role)
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
    // Slash command text — show as a dim, right-aligned command pill
    return (
      <div className="flex justify-end">
        <div
          className="font-mono text-[12px] text-dim rounded-xl px-3 py-1.5 max-w-[80%] border"
          style={{ background: '#16181d', borderColor: 'rgba(255,255,255,0.08)' }}
        >
          {m.content}
        </div>
      </div>
    );
  }

  // Regular message — split by role
  if (m.role === 'user') {
    return <UserBubble content={m.content} />;
  }

  // assistant / system → plain prose, no bubble
  return <MarkdownView source={m.content} />;
}

// ── Live events renderer (active turn) ───────────────────────────────────────

function LiveContent({
  sessionId, events, partials,
}: { sessionId: string; events: NormalizedEvent[]; partials: Record<string, string> }) {
  const streaming = Object.values(partials).filter(Boolean).join('');
  const nothingYet = events.length === 0 && !streaming;
  return (
    <div className="space-y-2">
      {events.map((ev, i) => {
        const p: any = ev.payload ?? {};
        switch (ev.type) {
          case 'assistant_text':
            return <MarkdownView key={i} source={String(p.text ?? '')} />;
          case 'thinking':
            return (
              <div key={i} className="rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(255,255,255,0.08)', background: '#16181d' }}>
                <ThinkingBlock text={String(p.text ?? '')} />
              </div>
            );
          case 'tool_use': {
            const result = events.find((e) => e.type === 'tool_result' && (e.payload as any)?.forId === p.id);
            const rp: any = result?.payload ?? null;
            return (
              <div key={i} className="rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(255,255,255,0.08)', background: '#16181d' }}>
                <ToolCallCard
                  name={String(p.name ?? 'tool')}
                  input={p.input}
                  result={rp ? String(rp.text ?? '') : null}
                  isError={!!rp?.isError}
                />
              </div>
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
                toolName={String(p.tool ?? p.toolName ?? p.name ?? 'tool')}
                input={p.input}
              />
            );
          case 'subagent_spawned':
            return <SubagentChip key={i} label={String(p.label ?? 'subagent')} childId={String(p.childId ?? '')} />;
          default:
            return null;
        }
      })}
      {streaming && (
        <div>
          <MarkdownView source={streaming} />
          <span className="caret" />
        </div>
      )}
      {nothingYet && <div className="text-[13px] text-faint font-sans">⟳ thinking…</div>}
    </div>
  );
}

// ── public component ──────────────────────────────────────────────────────────

/** Discriminated union: pass `turn` for a persisted/settled turn, `active` for the in-flight one. */
export type TurnProps =
  | { turn: ChatTurn; active?: never; onRetry?: () => void }
  | { turn?: never; active: ChatActiveTurn; onRetry?: () => void };

/**
 * Renders ONE conversation turn in two modes:
 * - Settled (`turn` prop): user bubble + persisted assistant prose + optional error+retry
 * - Active (`active` prop): user bubble + live events + streaming partial + optional error
 *
 * ponytail: engine-truncated note not rendered — `ChatTurn` carries no truncation marker yet;
 *   add when the server plumbs `truncatedBefore` to the client-side ChatTurn shape.
 */
export function Turn({ turn, active, onRetry }: TurnProps) {
  // ── settled turn ────────────────────────────────────────────────────────────
  if (turn) {
    const hasFailed = turn.status === 'failed';

    // Collect assistant text for the copy action (plain-text messages only)
    const assistantText = turn.messages
      .filter((m) => m.role === 'assistant' && m.kind !== 'error' && m.kind !== 'command-result' && m.kind !== 'command')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    return (
      <div className="space-y-3">
        {turn.messages.map((m) => <SettledMsg key={m.id} m={m} />)}
        {hasFailed
          ? <FailedTurnBanner message={turn.error ?? 'turn failed'} onRetry={onRetry} />
          : <AssistantActions textToCopy={assistantText || undefined} />}
      </div>
    );
  }

  // ── active (in-flight) turn ─────────────────────────────────────────────────
  const { turn: activeTurn, events, partials, status, error } = active;
  return (
    <div className="space-y-3">
      {activeTurn.messages.map((m) => <SettledMsg key={m.id} m={m} />)}
      <LiveContent sessionId={activeTurn.sessionId} events={events} partials={partials} />
      {status === 'failed' && (
        <FailedTurnBanner message={error ?? 'turn failed'} onRetry={onRetry} />
      )}
    </div>
  );
}
