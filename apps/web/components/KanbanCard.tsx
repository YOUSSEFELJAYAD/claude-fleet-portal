'use client';
import React from 'react';
import Link from 'next/link';
import type { KanbanTask, KanbanColumn, ExecutionPhase } from '@fleet/shared';
import { KANBAN_COLUMNS } from '@fleet/shared';
import { Dot, Btn } from '@/components/ui';
import { usd, ago } from '@/lib/format';

// ── local ExecutionPhase → color map (status.ts is off-limits to edit) ──────────
const PHASE_META: Record<ExecutionPhase, { label: string; color: string; live: boolean }> = {
  idle: { label: 'IDLE', color: '#7b828c', live: false },
  building: { label: 'BUILDING', color: '#39d4cf', live: true },
  validating: { label: 'VALIDATING', color: '#ffb000', live: true },
  merging: { label: 'MERGING', color: '#b08cff', live: true },
  resolving: { label: 'RESOLVING', color: '#b08cff', live: true },
  conflicts: { label: 'CONFLICTS', color: '#ff7a45', live: false },
  'paused-budget': { label: 'PAUSED $', color: '#ff7a45', live: false },
  failed: { label: 'FAILED', color: '#ff5d5d', live: false },
};

export function phaseMeta(p: ExecutionPhase) {
  return PHASE_META[p] ?? { label: String(p).toUpperCase(), color: '#7b828c', live: false };
}

const PRIORITY_LABEL = ['—', 'low', 'med', 'high', 'urgent'];
const PRIORITY_COLOR = ['#5b626d', '#7b828c', '#39d4cf', '#ffb000', '#ff5d5d'];

export function PhaseBadge({ phase, size = 'sm' }: { phase: ExecutionPhase; size?: 'sm' | 'md' }) {
  const m = phaseMeta(phase);
  const big = size === 'md';
  return (
    <span
      className="font-display inline-flex items-center gap-1 uppercase tracking-wider"
      style={{
        color: m.color,
        fontSize: big ? 10 : 8.5,
        border: `1px solid ${m.color}40`,
        background: `${m.color}12`,
        padding: big ? '2px 6px' : '1.5px 5px',
        letterSpacing: '0.1em',
      }}
    >
      <Dot color={m.color} live={m.live} size={big ? 6 : 5} />
      {m.label}
    </span>
  );
}

export interface KanbanCardProps {
  task: KanbanTask;
  projectId: string;
  busy?: boolean;
  /** move the card to another column (PUT /api/tasks/:id { column }). */
  onMove: (task: KanbanTask, column: KanbanColumn) => void;
  /** Review actions. */
  onApprove?: (task: KanbanTask) => void;
  onRequestChanges?: (task: KanbanTask) => void;
  onDelete?: (task: KanbanTask) => void;
  /** Re-read the card's PR state from GitHub (v2 #2 PR mode). */
  onRefreshPr?: (task: KanbanTask) => void;
  /** Open the card's proposed-merge branch diff (GET .../git/diff?branch=). */
  onViewDiff?: (task: KanbanTask) => void;
}

// ── PR state badge color map (v2 #2) ──
const PR_STATE_COLOR: Record<NonNullable<KanbanTask['prState']>, string> = {
  open: '#39d4cf',
  merged: '#b08cff',
  closed: '#ff5d5d',
};

/** Presentational card — title, phase badge, attempt/budget evidence, move + Review actions. */
export function KanbanCard({ task, projectId, busy = false, onMove, onApprove, onRequestChanges, onDelete, onRefreshPr, onViewDiff }: KanbanCardProps) {
  const m = phaseMeta(task.executionPhase);
  const attemptHot = task.attemptCount >= task.maxAttempts;
  const isReview = task.column === 'Review';
  // once Approved the server flips phase→merging (still in Review until the PM merges to
  // Done); hide the gate buttons so they don't linger as no-ops during the merge. Also hide
  // them while a PR is LIVE (v2 #2 PR mode parks Review+idle with prState set) — a second Approve
  // would re-run push + `gh pr create` and FAIL because the PR already exists. A CLOSED
  // (rejected) PR keeps the gate: re-approving pushes a fresh PR. prState is null in local
  // mode, so local behavior is unchanged.
  const awaitingGate =
    isReview &&
    task.executionPhase !== 'merging' &&
    task.executionPhase !== 'resolving' &&
    task.prState !== 'open' &&
    task.prState !== 'merged';
  const pr = Math.max(0, Math.min(4, task.priority ?? 0));

  return (
    <div
      className="panel p-2.5 group"
      style={{ borderColor: m.live ? `${m.color}55` : undefined, boxShadow: m.live ? `0 0 12px -6px ${m.color}` : undefined }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-ink text-[12.5px] leading-snug font-medium break-words flex-1">{task.title}</div>
        {onDelete && (
          <button
            title="delete card"
            onClick={() => onDelete(task)}
            className="opacity-0 group-hover:opacity-100 text-faint hover:text-sig-failed font-mono text-[12px] transition-opacity shrink-0"
            style={{ lineHeight: 1 }}
            disabled={busy}
          >
            ✕
          </button>
        )}
      </div>

      {task.description && (
        <div className="text-dim text-[10.5px] font-mono mt-1.5 line-clamp-2 leading-snug">{task.description}</div>
      )}

      {/* evidence row: phase · attempts · budget · priority */}
      <div className="flex items-center gap-1.5 flex-wrap mt-2">
        <PhaseBadge phase={task.executionPhase} />
        {pr > 0 && (
          <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: PRIORITY_COLOR[pr], borderColor: `${PRIORITY_COLOR[pr]}40` }}>
            {PRIORITY_LABEL[pr]}
          </span>
        )}
        <span className="font-mono tnum text-[9.5px]" style={{ color: attemptHot ? '#ff5d5d' : '#7b828c' }} title="attempts / max attempts">
          {task.attemptCount}/{task.maxAttempts} att
        </span>
        {task.budgetUsd != null && (
          <span className="font-mono tnum text-[9.5px] text-faint" title="per-run budget (each build / fix / resolve attempt gets this cap)">{usd(task.budgetUsd)}</span>
        )}
        {task.prState && (
          <span
            className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border"
            style={{ color: PR_STATE_COLOR[task.prState], borderColor: `${PR_STATE_COLOR[task.prState]}40` }}
            title="GitHub PR state"
          >
            PR {task.prState}
          </span>
        )}
        {/* v2 #4 — campaign-mode marker (a sub-DAG of orchestrator+worker runs, not one build run). */}
        {task.mode === 'campaign' && (
          <span
            className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border"
            style={{ color: '#b08cff', borderColor: '#b08cff40' }}
            title="runs as a campaign (orchestrator + worker sub-DAG)"
          >
            campaign
          </span>
        )}
        {task.labels?.map((l) => (
          <span key={l} className="font-mono text-[9px] px-1.5 py-0.5 border border-line2 text-faint">{l}</span>
        ))}
      </div>

      {task.lastError && (
        <div className="text-sig-failed/90 text-[9.5px] font-mono mt-1.5 line-clamp-2 leading-snug" title={task.lastError}>
          {task.lastError}
        </div>
      )}

      {/* footer: links + meta */}
      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t hairline">
        <div className="flex items-center gap-2">
          {task.runId && (
            <Link href={`/runs/${task.runId}`} className="font-mono text-[9.5px] text-dim hover:text-amber underline">
              run
            </Link>
          )}
          {/* v2 #4 — drill into the campaign sub-DAG (reuses the existing campaign view + SSE stream). */}
          {task.mode === 'campaign' && task.campaignId && (
            <Link href={`/orchestrate/${task.campaignId}`} className="font-mono text-[9.5px] text-dim hover:text-amber underline">
              campaign ↗
            </Link>
          )}
          {(isReview || task.worktreeName) &&
            (task.worktreeName && onViewDiff ? (
              <button onClick={() => onViewDiff(task)} className="font-mono text-[9.5px] text-dim hover:text-amber underline">
                view diff
              </button>
            ) : (
              <Link href={`/projects/${projectId}/files`} className="font-mono text-[9.5px] text-dim hover:text-amber underline">
                view diff
              </Link>
            ))}
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[9.5px] text-dim hover:text-amber underline"
            >
              PR ↗
            </a>
          )}
          {onRefreshPr && (task.prState || task.prUrl) && (
            <button
              onClick={() => onRefreshPr(task)}
              disabled={busy}
              className="font-mono text-[9.5px] text-dim hover:text-amber underline disabled:opacity-40"
              title="re-read PR state from GitHub"
            >
              refresh
            </button>
          )}
        </div>
        <span className="font-mono text-[9px] text-faint">{ago(task.updatedAt)}</span>
      </div>

      {/* Review-only gate actions (hidden once Approved → phase 'merging') */}
      {awaitingGate && (onApprove || onRequestChanges) && (
        <div className="flex items-center gap-1.5 mt-2">
          {onApprove && (
            <Btn variant="solid" className="!px-2 !py-1 !text-[9.5px] flex-1 justify-center" onClick={() => onApprove(task)} disabled={busy}>
              Approve
            </Btn>
          )}
          {onRequestChanges && (
            <Btn variant="amber" className="!px-2 !py-1 !text-[9.5px] flex-1 justify-center" onClick={() => onRequestChanges(task)} disabled={busy}>
              Request changes
            </Btn>
          )}
        </div>
      )}

      {/* column-select move (drag is optional per spec) */}
      <div className="mt-2">
        <select
          value={task.column}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as KanbanColumn;
            if (next !== task.column) onMove(task, next);
          }}
          className="w-full bg-black/40 border border-line2 text-dim font-mono text-[9.5px] px-1.5 py-1 focus:border-amber/60 outline-none cursor-pointer appearance-none hover:text-ink disabled:opacity-40"
          title="move card to column"
        >
          {KANBAN_COLUMNS.map((c) => (
            <option key={c} value={c}>
              → {c}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
