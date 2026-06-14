'use client';
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@fleet/shared';
import { useRunStream } from '@/lib/live';

const TERMINAL = new Set(['completed', 'failed', 'killed']);
// palette-aligned role colors: user=teal (sig-running), system=dim, assistant=amber
function roleColor(role: string) { return role === 'user' ? '#39d4cf' : role === 'system' ? '#9aa1ab' : '#ffb000'; }

/** Streams the active run's assistant text and, once the run reaches a terminal state, fires
 *  onComplete exactly once with the final text so the parent can persist the assistant turn.
 *  If the stream reports a permanent error (unknown/deleted run), it clears the live turn via
 *  onError so the thread recovers instead of pinning "⟳ thinking…". */
function LiveTurn({ runId, onComplete, onError }: { runId: string; onComplete: (runId: string, finalText: string) => void; onError: (runId: string) => void }) {
  const { run, events, error } = useRunStream(runId);
  const text = events
    .filter((e) => e.type === 'assistant_text' || e.type === 'result')
    .map((e) => String((e.payload as any)?.text ?? (e.payload as any)?.result ?? ''))
    .join('');
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !run || !TERMINAL.has(run.status)) return;
    done.current = true;
    onComplete(runId, run.resultText ?? text);
  }, [run, runId, text, onComplete]);
  if (error) {
    return (
      <div className="text-[13px] text-sig-failed">
        run stream lost — {error}
        <button type="button" onClick={() => onError(runId)} className="ml-2 underline hover:text-ink transition-colors">dismiss</button>
      </div>
    );
  }
  if (!text) return <div className="text-[13px] text-faint">⟳ thinking…</div>;
  return <div className="text-[13px] whitespace-pre-wrap"><b style={{ color: roleColor('assistant') }}>assistant: </b>{text}</div>;
}

export function ChatThread({ messages, liveRunId, onTurnComplete, onTurnError }: {
  messages: ChatMessage[];
  liveRunId: string | null;
  onTurnComplete: (runId: string, finalText: string) => void;
  onTurnError: (runId: string) => void;
}) {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-2">
      {messages.map((m) => (
        <div key={m.id} className="text-[13px] whitespace-pre-wrap">
          <b style={{ color: roleColor(m.role) }}>{m.role}: </b>
          {m.content}
        </div>
      ))}
      {/* key={liveRunId} remounts per turn so the once-per-turn guard resets */}
      {liveRunId && <LiveTurn key={liveRunId} runId={liveRunId} onComplete={onTurnComplete} onError={onTurnError} />}
    </div>
  );
}
