'use client';
import { useCallback, useEffect, useState } from 'react';
import type { ChatSession, ChatMessage } from '@fleet/shared';
import { api } from '@/lib/api';
import { useChatStream } from '@/lib/live';
import { ChatSessionList } from '@/components/ChatSessionList';
import { ChatThread } from '@/components/ChatThread';
import { ChatComposer } from '@/components/ChatComposer';
import { RunningAgentsPanel } from '@/components/RunningAgentsPanel';
import { ErrorBanner, Badge } from '@/components/ui';
import { chatStateMeta } from '@/lib/chatState';

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // §3 — chat-scoped SSE for session lifecycle state; null when no session is active.
  const { state: liveState, live } = useChatStream(activeId);
  // derive `chatState` alias for ChatComposer (still expects `chatState === 'running'`)
  const chatState = liveState;
  // previews for the sidebar: last persisted message per session (cheap client derivation).
  const previews = sessions.reduce<Record<string, string>>((acc, s) => {
    if (s.id === activeId) acc[s.id] = messages[messages.length - 1]?.content?.slice(0, 60) ?? '';
    return acc;
  }, {});
  // Prefer the live-streamed state; fall back to the session read's derived field (spec §3).
  const effectiveState = liveState ?? session?.state ?? 'idle';

  const refreshSessions = useCallback(async () => { setSessions(await api.chatSessions()); }, []);
  const loadSession = useCallback(async (id: string) => {
    const { session, messages } = await api.chatSession(id);
    setActiveId(id); setSession(session); setMessages(messages); setLiveRunId(null);
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  async function newSession() {
    setErr(null);
    try {
      const s = await api.createChatSession({ cwd: process.env.NEXT_PUBLIC_DEFAULT_CWD || '.' });
      await refreshSessions(); await loadSession(s.id);
    } catch (e: any) { setErr(e.message); }
  }
  async function renameSession(id: string, title: string) {
    setErr(null);
    try {
      await api.renameChatSession(id, title); await refreshSessions();
    } catch (e: any) { setErr(e.message); }
  }
  async function killSession(id: string) {
    setErr(null);
    try {
      await api.killChatSession(id); await refreshSessions();
    } catch (e: any) { setErr(e.message); }
  }
  async function resumeSession(id: string) {
    setErr(null);
    try {
      await api.resumeChatSession(id); await refreshSessions();
    } catch (e: any) { setErr(e.message); }
  }
  async function deleteSession(id: string) {
    setErr(null);
    try {
      await api.deleteChatSession(id); await refreshSessions();
      if (id === activeId) { setActiveId(null); setSession(null); setMessages([]); }
    } catch (e: any) { setErr(e.message); }
  }

  async function sendTurn(message: string, attachments: import('@fleet/shared').ChatAttachment[] = []) {
    if (!activeId) return;
    setBusy(true);
    setErr(null);
    try {
      const { runId, userMessage } = await api.chatTurn(activeId, message, attachments);
      setMessages((m) => [...m, userMessage]); setLiveRunId(runId);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  function runCommand(line: string) {
    void command(line);
  }
  async function command(line: string) {
    if (!activeId) return;
    setErr(null);
    try {
      await api.chatCommand(activeId, line);
      await loadSession(activeId); // re-pull persisted command + result messages
    } catch (e: any) { setErr(e.message); }
  }
  // Persist the assistant reply when the live run finishes, so it survives a reload (plan note 1).
  const onTurnComplete = useCallback(async (runId: string, finalText: string) => {
    setLiveRunId(null);
    if (!activeId) return;
    try {
      const msg = await api.addChatMessage(activeId, {
        role: 'assistant', kind: 'text', content: finalText.trim() || '(no output)', runId,
      });
      setMessages((m) => [...m, msg]);
    } catch (e: any) { setErr(e.message); }
  }, [activeId]);
  // A dropped/failed live stream clears the live turn so the thread recovers from "⟳ thinking…".
  const onTurnError = useCallback((_runId: string) => {
    setLiveRunId(null);
    setErr('the live run stream was lost — the reply may not have been saved');
  }, []);

  // App-shell layout (scrolling thread + pinned composer). Height fits the shared frame
  // exactly: viewport − 58px sticky header − 48px (main p-6) so it never overflows the body.
  return (
    <div className="flex h-[calc(100vh-106px)] min-h-0">
      <ChatSessionList sessions={sessions} activeId={activeId} previews={previews}
        onSelect={loadSession} onNew={newSession} onRename={renameSession}
        onKill={killSession} onResume={resumeSession} onDelete={deleteSession} />
      <div className="flex-1 flex flex-col min-w-0">
        {session ? (
          <>
            <div className="px-4 py-2 border-b hairline text-[12px] flex items-center gap-2">
              <span>{session.title} · {session.engine} · {session.model} · {session.cwd}</span>
              {session.engine !== 'claude' && <span className="text-faint">(one-shot per turn · limited memory)</span>}
              {effectiveState === 'idle' && (
                <Badge label="RESUMABLE" color={chatStateMeta('idle').color} />
              )}
              {(effectiveState === 'live' || live) && (
                <Badge label="LIVE" color={chatStateMeta('live').color} live />
              )}
            </div>
            {err && (
              <div className="px-4 pt-3">
                <ErrorBanner onRetry={() => setErr(null)}>{err}</ErrorBanner>
              </div>
            )}
            <ChatThread sessionId={activeId} messages={messages} onTurnComplete={onTurnComplete} onTurnError={onTurnError} />
            <ChatComposer
              disabled={busy}
              running={chatState === 'running'}
              cwd={session.cwd}
              onSend={(message, attachments) => sendTurn(message, attachments)}
              onCommand={(line) => runCommand(line)}
              onStop={() => api.chatInterrupt(session.id)}
            />
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-[13px] text-faint">Select or create a session</div>
        )}
      </div>
      <RunningAgentsPanel sessionId={activeId} />
    </div>
  );
}
