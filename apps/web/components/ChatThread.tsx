'use client';
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@fleet/shared';
import { useRunStream } from '@/lib/live';

const TERMINAL = new Set(['completed', 'failed', 'killed']);
function roleColor(role: string) { return role === 'user' ? '#9ad' : role === 'system' ? '#caa' : '#cfe'; }

/** Streams the active run's assistant text and, once the run reaches a terminal state, fires
 *  onComplete exactly once with the final text so the parent can persist the assistant turn. */
function LiveTurn({ runId, onComplete }: { runId: string; onComplete: (runId: string, finalText: string) => void }) {
  const { run, events } = useRunStream(runId);
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
  if (!text) return <div className="text-[13px] opacity-60">⟳ thinking…</div>;
  return <div className="text-[13px] whitespace-pre-wrap"><b style={{ color: '#cfe' }}>assistant: </b>{text}</div>;
}

export function ChatThread({ messages, liveRunId, onTurnComplete }: {
  messages: ChatMessage[];
  liveRunId: string | null;
  onTurnComplete: (runId: string, finalText: string) => void;
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
      {liveRunId && <LiveTurn key={liveRunId} runId={liveRunId} onComplete={onTurnComplete} />}
    </div>
  );
}
