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
        <span className="kicker">sessions</span>
        <Btn onClick={onNew}>+ New</Btn>
      </div>
      <div className="flex-1 overflow-auto">
        {sessions.map((s) => (
          <div key={s.id}
            className={`px-2 py-2 text-[12px] cursor-pointer border-b hairline transition-colors ${s.id === activeId ? 'bg-amber/[0.06]' : 'hover:bg-white/5'}`}
            onClick={() => onSelect(s.id)}>
            <div className="truncate text-ink">{s.title}</div>
            <div className="font-mono text-[10px] text-faint mt-0.5">{s.engine} · {s.model}</div>
            {s.id === activeId && (
              <div className="flex gap-2 mt-1.5 font-mono text-[10px]">
                <button className="text-faint hover:text-ink transition-colors" onClick={(e) => { e.stopPropagation(); onRename(s.id); }}>rename</button>
                <button className="text-faint hover:text-sig-failed transition-colors" onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
