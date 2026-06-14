'use client';
import React, { useEffect, useState } from 'react';
import type { ChatSession } from '@fleet/shared';
import { Btn, Dot, Input, Kicker } from '@/components/ui';
import { chatStateMeta } from '@/lib/chatState';
import { ago } from '@/lib/format';

export function ChatSessionList({
  sessions, activeId, previews, onSelect, onNew, onRename, onKill, onResume, onDelete,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  /** sessionId → last-message preview text (supplied by the page). */
  previews: Record<string, string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onKill: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // inline-rename edit buffer: the id being renamed + its draft title (replaces window.prompt).
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => { setEditId(null); }, [activeId]);

  function startRename(s: ChatSession) { setEditId(s.id); setDraft(s.title); }
  function commitRename(id: string) {
    const t = draft.trim();
    setEditId(null);
    if (t) onRename(id, t);
  }

  return (
    <div className="w-56 shrink-0 border-r hairline flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b hairline">
        <Kicker>sessions</Kicker>
        <Btn variant="ghost" onClick={onNew}>+ New</Btn>
      </div>
      <div className="flex-1 overflow-auto">
        {sessions.map((s) => {
          const meta = chatStateMeta(s.state ?? 'idle');
          const active = s.id === activeId;
          const canKill = s.state === 'live' || s.state === 'running';
          return (
            <div key={s.id}
              className={`px-3 py-2.5 text-[12px] cursor-pointer border-b hairline last:border-0 transition-colors ${active ? 'bg-amber/[0.06]' : 'hover:bg-white/[0.02]'}`}
              onClick={() => onSelect(s.id)}>
              <div className="flex items-center gap-1.5">
                <Dot color={meta.color} live={meta.live} size={6} />
                {editId === s.id ? (
                  <Input autoFocus value={draft} className="!py-0.5 !text-[12px]"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id); }
                      if (e.key === 'Escape') { e.preventDefault(); setEditId(null); }
                    }}
                    onBlur={() => commitRename(s.id)} />
                ) : (
                  <span className="truncate text-ink flex-1">{s.title}</span>
                )}
              </div>
              {previews[s.id] && (
                <div className="truncate text-[10px] text-dim mt-0.5">{previews[s.id]}</div>
              )}
              <div className="flex items-center justify-between font-mono text-[10px] text-faint mt-0.5">
                <span>{s.engine} · {s.model}</span>
                <span>{ago(s.updatedAt)}</span>
              </div>
              {active && editId !== s.id && (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <div className="flex gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                  <Btn variant="ghost" className="text-[10px] px-2 py-1" onClick={() => startRename(s)}>rename</Btn>
                  {canKill && (
                    <Btn variant="danger" className="text-[10px] px-2 py-1" onClick={() => onKill(s.id)}>kill</Btn>
                  )}
                  {(s.state === 'idle' || s.state === 'killed') && (
                    <Btn variant="amber" className="text-[10px] px-2 py-1" onClick={() => onResume(s.id)}>resume</Btn>
                  )}
                  <Btn variant="danger" className="text-[10px] px-2 py-1" onClick={() => onDelete(s.id)}>delete</Btn>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
