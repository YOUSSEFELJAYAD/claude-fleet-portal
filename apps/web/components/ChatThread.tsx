'use client';
import type { ChatMessage } from '@fleet/shared';
import { useRunStream } from '@/lib/live';

function roleColor(role: string) { return role === 'user' ? '#9ad' : role === 'system' ? '#caa' : '#cfe'; }

/** Renders the streaming text of the active run (the in-flight assistant turn). */
function LiveTurn({ runId }: { runId: string }) {
  const { events } = useRunStream(runId);
  const text = events
    .filter((e) => e.type === 'assistant_text' || e.type === 'result')
    .map((e) => String((e.payload as any)?.text ?? (e.payload as any)?.result ?? ''))
    .join('');
  if (!text) return <div className="text-[13px] opacity-60">⟳ thinking…</div>;
  return <div className="text-[13px] whitespace-pre-wrap"><b style={{ color: '#cfe' }}>assistant: </b>{text}</div>;
}

export function ChatThread({ messages, liveRunId }: { messages: ChatMessage[]; liveRunId: string | null }) {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-2">
      {messages.map((m) => (
        <div key={m.id} className="text-[13px] whitespace-pre-wrap">
          <b style={{ color: roleColor(m.role) }}>{m.role}: </b>
          {m.content}
        </div>
      ))}
      {liveRunId && <LiveTurn runId={liveRunId} />}
    </div>
  );
}
