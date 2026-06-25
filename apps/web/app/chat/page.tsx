'use client';
import { useCallback, useEffect, useState } from 'react';
import type { ChatSession, ChatTurn, ChatAttachment } from '@fleet/shared';
import { api } from '@/lib/api';
import { useChatStream, usePendingQuestions } from '@/lib/live';
import { ChatSessionList } from '@/components/ChatSessionList';
import { ChatSearch } from '@/components/ChatSearch';
import { ChatThread } from '@/components/ChatThread';
import { ChatComposer } from '@/components/ChatComposer';
import { ErrorBanner, Badge } from '@/components/ui';
import { QuestionCard } from '@/components/QuestionCard';
import { chatStateMeta } from '@/lib/chatState';

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // §3 — chat-scoped SSE: ONE subscription per session, derived values flow down as props.
  const { state: liveState, activeTurn, error: streamError, clearError: clearStreamError } = useChatStream(activeId);
  // ponytail: live stubbed false; the LIVE badge still reads it.
  const live = false;
  const { questions: pendingQuestions, refresh: refreshQuestions } = usePendingQuestions(activeId);
  const chatState = liveState;

  // Sidebar previews: last settled turn's last message (assistant reply) per session.
  const previews = sessions.reduce<Record<string, string>>((acc, s) => {
    if (s.id === activeId) {
      const last = turns[turns.length - 1];
      acc[s.id] = last?.messages[last.messages.length - 1]?.content?.slice(0, 60) ?? '';
    }
    return acc;
  }, {});

  const effectiveState = liveState ?? session?.state ?? 'idle';

  const refreshSessions = useCallback(async () => { setSessions(await api.chatSessions()); }, []);
  const loadSession = useCallback(async (id: string) => {
    const { session: s, turns: t } = await api.chatSession(id);
    setActiveId(id); setSession(s); setTurns(t);
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  // C1: on turn:settled, trigger history refetch but KEEP activeTurn rendered until the refetch
  // lands — ChatThread deduplicates by turnId. No gap where the turn is in neither slot.
  useEffect(() => {
    if (activeTurn?.status === 'settled' && activeId) {
      api.chatTurns(activeId).then((fresh) => {
        setTurns((existing) => {
          const knownIds = new Set(existing.map((t) => t.id));
          const newOnes = fresh.filter((t) => !knownIds.has(t.id));
          return newOnes.length ? [...existing, ...newOnes] : existing;
        });
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurn?.status, activeTurn?.turnId, activeId]);

  // CV1: on turn:failed, build a synthetic ChatTurn and move it into history so it persists
  // across new turns. ChatThread dedup suppresses the active card once the id is in history.
  useEffect(() => {
    if (activeTurn?.status === 'failed' && activeId) {
      const { turnId, turn, error } = activeTurn;
      const failedTurn: ChatTurn = {
        id: turnId, sessionId: activeId, status: 'failed',
        messages: turn.messages, createdAt: turn.createdAt, settledAt: null,
        error,
      };
      setTurns((existing) => existing.some((t) => t.id === turnId) ? existing : [...existing, failedTurn]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurn?.status, activeTurn?.turnId, activeId]);

  async function newSession() {
    setErr(null);
    try {
      const s = await api.createChatSession({ cwd: process.env.NEXT_PUBLIC_DEFAULT_CWD || '.' });
      await refreshSessions(); await loadSession(s.id);
    } catch (e: any) { setErr(e.message); }
  }
  async function renameSession(id: string, title: string) {
    setErr(null);
    try { await api.renameChatSession(id, title); await refreshSessions(); }
    catch (e: any) { setErr(e.message); }
  }
  async function killSession(id: string) {
    setErr(null);
    try { await api.killChatSession(id); await refreshSessions(); if (id === activeId) await loadSession(id); }
    catch (e: any) { setErr(e.message); }
  }
  async function resumeSession(id: string) {
    setErr(null);
    try { await api.resumeChatSession(id); await refreshSessions(); if (id === activeId) await loadSession(id); }
    catch (e: any) { setErr(e.message); }
  }
  async function deleteSession(id: string) {
    setErr(null);
    try {
      await api.deleteChatSession(id); await refreshSessions();
      if (id === activeId) { setActiveId(null); setSession(null); setTurns([]); }
    } catch (e: any) { setErr(e.message); }
  }

  async function sendTurn(message: string, attachments: ChatAttachment[] = []) {
    if (!activeId) return;
    setBusy(true); setErr(null);
    try {
      // Server emits turn:start on the SSE → useChatStream sets activeTurn → renders live.
      await api.chatTurn(activeId, message, attachments);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  function handleRetry(turn: ChatTurn) {
    if (activeTurn) return; // I3: guard — a turn is already in flight
    const userMsg = turn.messages.find((m) => m.role === 'user');
    if (userMsg && activeId) void sendTurn(userMsg.content);
  }

  function runCommand(line: string) { void command(line); }
  async function command(line: string) {
    if (!activeId) return;
    setErr(null);
    try {
      await api.chatCommand(activeId, line);
      await loadSession(activeId); // re-pull persisted command + result turns
    } catch (e: any) { setErr(e.message); }
  }

  /**
   * Jump to a specific turn, loading the session first if it differs from the active one.
   * ponytail: 100ms delay after loadSession lets React commit the new turns before we
   * getElementById; if the turn is not in the currently-loaded page (deep history), the
   * scroll is a no-op — user can click "load older" to page in older turns.
   */
  function openSessionAtTurn(sessionId: string, turnId: string) {
    const jump = () => setTimeout(() => {
      const el = document.getElementById(`turn-${turnId}`);
      if (!el) return; // limitation: turn not in loaded history page
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid #ffb000';
      setTimeout(() => { el.style.outline = ''; }, 1500);
    }, 100);
    if (sessionId !== activeId) { void loadSession(sessionId).then(jump); } else { jump(); }
  }

  // App-shell layout: viewport − 58px sticky header − 48px (main p-6).
  return (
    <div className="flex flex-col h-[calc(100vh-106px)] min-h-0 font-sans">
      {/* TOP BAR — session switcher (left) · search + model/engine + new chat (right).
          Sessions live on the same level here, not in a left column. */}
      <header className="flex-none flex items-center gap-3 px-3 py-2 mb-3 rounded-xl border border-white/[0.08] bg-[#16181d]">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[14px] font-medium text-ink shrink-0">Chat</span>
          <ChatSessionList sessions={sessions} activeId={activeId} previews={previews}
            onSelect={loadSession} onNew={newSession} onRename={renameSession}
            onKill={killSession} onResume={resumeSession} onDelete={deleteSession} />
        </div>
        <div className="flex items-center gap-3 ml-auto min-w-0">
          <ChatSearch activeId={activeId} onOpenAtTurn={openSessionAtTurn} />
          {session && (
            <div className="flex items-center gap-2 min-w-0">
              {effectiveState === 'idle' && (
                <Badge label="RESUMABLE" color={chatStateMeta('idle').color} />
              )}
              {(effectiveState === 'live' || live) && (
                <Badge label="LIVE" color={chatStateMeta('live').color} live />
              )}
              <span
                className="text-[12px] text-dim whitespace-nowrap truncate max-w-[200px]"
                title={`${session.title} · ${session.cwd}`}
              >
                {session.engine} · {session.model}
                {session.engine !== 'claude' && <span className="text-faint"> · one-shot</span>}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={newSession}
            className="shrink-0 rounded-lg border border-white/[0.08] bg-[#1b1e26] text-[12px] text-ink px-3 py-1.5 hover:border-[#4f7fff]/60 hover:text-[#4f7fff] transition-colors"
          >
            + New chat
          </button>
        </div>
      </header>

      {session ? (
        <>
          {(err || streamError) && (
            <div className="flex-none w-full max-w-[800px] mx-auto px-4 mb-2">
              <ErrorBanner onRetry={err ? () => setErr(null) : clearStreamError}>{err ?? streamError}</ErrorBanner>
            </div>
          )}

          {/* CONVERSATION — centered scroll column (max-w-800), fills remaining height. */}
          <ChatThread
            sessionId={activeId}
            turns={turns}
            activeTurn={activeTurn}
            onRetry={handleRetry}
          />

          {pendingQuestions.length > 0 && (
            <div className="flex-none w-full max-w-[800px] mx-auto px-4 pb-2 space-y-2">
              {pendingQuestions.map((q) => (
                <QuestionCard key={q.id} item={{ kind: 'question', question: q }} onAction={refreshQuestions} />
              ))}
            </div>
          )}

          {/* COMPOSER — docked at the bottom, same centered max-w-800 column. */}
          <div className="flex-none w-full max-w-[800px] mx-auto px-4 pb-3">
            <ChatComposer
              disabled={busy}
              running={chatState === 'running'}
              engine={session.engine}
              cwd={session.cwd}
              sessionId={session.id}
              onSend={(message, attachments) => sendTurn(message, attachments)}
              onCommand={(line) => runCommand(line)}
              onStop={() => api.chatInterrupt(session.id)}
            />
          </div>
        </>
      ) : (
        <div className="flex-1 grid place-items-center text-[13px] text-faint">Select or create a session</div>
      )}
    </div>
  );
}
