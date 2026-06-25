'use client';
import React from 'react';
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

const roleLabelColor = (role: string) =>
  role === 'user' ? '#39d4cf' : role === 'system' ? '#9aa1ab' : '#ffb000';

function parseCommandResult(content: string): ChatCommandResult | null {
  try {
    const o = JSON.parse(content);
    if (o && typeof o === 'object' && 'kind' in o) return o as ChatCommandResult;
  } catch { /* plain text */ }
  return null;
}

// ── settled message renderer — ported from ChatThread's PersistedMessage ─────

function SettledMsg({ m }: { m: ChatMessage }) {
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
    return <div className="font-mono text-[12px] text-dim my-1">{m.content}</div>;
  }
  return (
    <div className="my-1">
      <div className="font-display uppercase tracking-wider text-[9px] mb-0.5" style={{ color: roleLabelColor(m.role) }}>{m.role}</div>
      <MarkdownView source={m.content} />
    </div>
  );
}

// ── live events renderer — ported from ChatThread's LiveTurn ──────────────────

function LiveContent({
  sessionId, events, partials,
}: { sessionId: string; events: NormalizedEvent[]; partials: Record<string, string> }) {
  const streaming = Object.values(partials).filter(Boolean).join('');
  const nothingYet = events.length === 0 && !streaming;
  return (
    <div className="space-y-1">
      {events.map((ev, i) => {
        const p: any = ev.payload ?? {};
        switch (ev.type) {
          case 'assistant_text':
            return <div key={i} className="my-1"><MarkdownView source={String(p.text ?? '')} /></div>;
          case 'thinking':
            return <ThinkingBlock key={i} text={String(p.text ?? '')} />;
          case 'tool_use': {
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
        <div className="my-1">
          <MarkdownView source={streaming} />
          <span className="caret" />
        </div>
      )}
      {nothingYet && <div className="text-[13px] text-faint">⟳ thinking…</div>}
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
 * - Settled (`turn` prop): user message + persisted assistant messages + optional error+retry
 * - Active (`active` prop): user message + live events + streaming partial + optional error
 *
 * ponytail: engine-truncated note not rendered — `ChatTurn` carries no truncation marker yet;
 *   add when the server plumbs `truncatedBefore` to the client-side ChatTurn shape.
 */
export function Turn({ turn, active, onRetry }: TurnProps) {
  // ── settled turn ────────────────────────────────────────────────────────────
  if (turn) {
    return (
      <div className="space-y-1">
        {turn.messages.map((m) => <SettledMsg key={m.id} m={m} />)}
        {turn.status === 'failed' && (
          <div className="my-1">
            <ErrorBanner onRetry={onRetry}>turn failed</ErrorBanner>
          </div>
        )}
      </div>
    );
  }

  // ── active (in-flight) turn ─────────────────────────────────────────────────
  const { turn: activeTurn, events, partials, status } = active;
  return (
    <div className="space-y-1">
      {activeTurn.messages.map((m) => <SettledMsg key={m.id} m={m} />)}
      <LiveContent sessionId={activeTurn.sessionId} events={events} partials={partials} />
      {status === 'failed' && (
        <div className="my-1">
          <ErrorBanner onRetry={onRetry}>turn failed</ErrorBanner>
        </div>
      )}
    </div>
  );
}
