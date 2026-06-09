'use client';
import React from 'react';
import type { KanbanTask, KanbanColumn } from '@fleet/shared';
import { KANBAN_COLUMNS } from '@fleet/shared';
import { KanbanCard, type KanbanCardProps } from '@/components/KanbanCard';

// per-column accent (orthogonal to ExecutionPhase) — purely visual.
const COLUMN_COLOR: Record<KanbanColumn, string> = {
  Backlog: '#7b828c',
  Ready: '#39d4cf',
  InProgress: '#ffb000',
  Review: '#b08cff',
  Done: '#54e08a',
  Blocked: '#ff7a45',
  Canceled: '#5b626d',
};

export interface KanbanBoardProps extends Omit<KanbanCardProps, 'task'> {
  tasks: KanbanTask[];
  wipLimit?: number | null;
}

/** Presentational board — lays out KANBAN_COLUMNS, sorts cards by priority then rank. */
export function KanbanBoard({ tasks, wipLimit, projectId, busy, onMove, onApprove, onRequestChanges, onDelete, onRefreshPr }: KanbanBoardProps) {
  const byColumn = new Map<KanbanColumn, KanbanTask[]>();
  for (const c of KANBAN_COLUMNS) byColumn.set(c, []);
  for (const t of tasks) {
    const list = byColumn.get(t.column);
    if (list) list.push(t);
    else byColumn.set(t.column, [t]); // tolerate unknown columns defensively
  }
  // top of board = highest priority, then lexorank ascending (matches PM select order).
  for (const list of byColumn.values()) {
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  }

  return (
    <div className="grid gap-3 items-start" style={{ gridTemplateColumns: `repeat(${KANBAN_COLUMNS.length}, minmax(190px, 1fr))` }}>
      {KANBAN_COLUMNS.map((col) => {
        const list = byColumn.get(col) ?? [];
        const color = COLUMN_COLOR[col] ?? '#7b828c';
        const overWip = col === 'InProgress' && wipLimit != null && list.length > wipLimit;
        return (
          <div key={col} className="flex flex-col min-w-0">
            <div className="flex items-baseline justify-between mb-2 px-0.5 sticky top-0 z-[1] py-1" style={{ background: '#0a0b0e' }}>
              <span className="font-display uppercase tracking-wider text-[10px]" style={{ color }}>
                {col}
              </span>
              <span
                className="font-mono tnum text-[10px]"
                style={{ color: overWip ? '#ff5d5d' : '#7b828c' }}
                title={col === 'InProgress' && wipLimit != null ? `${list.length} in progress / WIP limit ${wipLimit}` : undefined}
              >
                {list.length}
                {col === 'InProgress' && wipLimit != null ? `/${wipLimit}` : ''}
              </span>
            </div>
            <div className="flex flex-col gap-2 min-h-[40px]">
              {list.length === 0 ? (
                <div className="border border-dashed border-line2 py-4 text-center text-faint font-mono text-[10px] opacity-60">empty</div>
              ) : (
                list.map((t) => (
                  <KanbanCard
                    key={t.id}
                    task={t}
                    projectId={projectId}
                    busy={busy}
                    onMove={onMove}
                    onApprove={onApprove}
                    onRequestChanges={onRequestChanges}
                    onDelete={onDelete}
                    onRefreshPr={onRefreshPr}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
