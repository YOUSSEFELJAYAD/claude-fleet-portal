'use client';
import type { ChatSession } from '@fleet/shared';
import { Btn } from '@/components/ui';

export function ChatSessionList({ sessions, activeId, onSelect, onNew, onRename, onDelete }: {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="w-56 shrink-0 border-r hairline flex flex-col">
      <div className="flex items-center justify-between p-2 border-b hairline">
        <span className="text-[12px] font-semibold">Sessions</span>
        <Btn onClick={onNew}>+ New</Btn>
      </div>
      <div className="flex-1 overflow-auto">
        {sessions.map((s) => (
          <div key={s.id}
            className={`px-2 py-2 text-[12px] cursor-pointer border-b hairline ${s.id === activeId ? 'bg-white/5' : ''}`}
            onClick={() => onSelect(s.id)}>
            <div className="truncate font-medium">{s.title}</div>
            <div className="opacity-50">{s.engine} · {s.model}</div>
            {s.id === activeId && (
              <div className="flex gap-2 mt-1">
                <button className="underline opacity-70" onClick={(e) => { e.stopPropagation(); onRename(s.id); }}>rename</button>
                <button className="underline opacity-70" onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
