'use client';
import { useCallback, useEffect, useState } from 'react';
import type { ChatSession, ChatMessage } from '@fleet/shared';
import { api } from '@/lib/api';
import { ChatSessionList } from '@/components/ChatSessionList';
import { ChatThread } from '@/components/ChatThread';
import { ChatComposer } from '@/components/ChatComposer';
import { RunningAgentsPanel } from '@/components/RunningAgentsPanel';

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshSessions = useCallback(async () => { setSessions(await api.chatSessions()); }, []);
  const loadSession = useCallback(async (id: string) => {
    const { session, messages } = await api.chatSession(id);
    setActiveId(id); setSession(session); setMessages(messages); setLiveRunId(null);
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  async function newSession() {
    const s = await api.createChatSession({ cwd: process.env.NEXT_PUBLIC_DEFAULT_CWD || '.' });
    await refreshSessions(); await loadSession(s.id);
  }
  async function renameSession(id: string) {
    const title = window.prompt('Rename session'); if (!title) return;
    await api.renameChatSession(id, title); await refreshSessions();
  }
  async function deleteSession(id: string) {
    await api.deleteChatSession(id); await refreshSessions();
    if (id === activeId) { setActiveId(null); setSession(null); setMessages([]); }
  }

  async function send(message: string) {
    if (!activeId) return;
    setBusy(true);
    try {
      const { runId, userMessage } = await api.chatTurn(activeId, message);
      setMessages((m) => [...m, userMessage]); setLiveRunId(runId);
    } finally { setBusy(false); }
  }
  async function command(line: string) {
    if (!activeId) return;
    await api.chatCommand(activeId, line);
    await loadSession(activeId); // re-pull persisted command + result messages
  }
  // Persist the assistant reply when the live run finishes, so it survives a reload (plan note 1).
  const onTurnComplete = useCallback(async (runId: string, finalText: string) => {
    setLiveRunId(null);
    if (!activeId) return;
    const msg = await api.addChatMessage(activeId, {
      role: 'assistant', kind: 'text', content: finalText.trim() || '(no output)', runId,
    });
    setMessages((m) => [...m, msg]);
  }, [activeId]);

  // App-shell layout (scrolling thread + pinned composer). Height fits the shared frame
  // exactly: viewport − 58px sticky header − 48px (main p-6) so it never overflows the body.
  return (
    <div className="flex h-[calc(100vh-106px)] min-h-0">
      <ChatSessionList sessions={sessions} activeId={activeId}
        onSelect={loadSession} onNew={newSession} onRename={renameSession} onDelete={deleteSession} />
      <div className="flex-1 flex flex-col min-w-0">
        {session ? (
          <>
            <div className="px-4 py-2 border-b hairline text-[12px]">
              {session.title} · {session.engine} · {session.model} · {session.cwd}
              {session.engine !== 'claude' && <span className="ml-2 text-faint">(one-shot per turn · limited memory)</span>}
            </div>
            <ChatThread messages={messages} liveRunId={liveRunId} onTurnComplete={onTurnComplete} />
            <ChatComposer disabled={busy} onSend={send} onCommand={command} />
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-[13px] text-faint">Select or create a session</div>
        )}
      </div>
      <RunningAgentsPanel />
    </div>
  );
}
