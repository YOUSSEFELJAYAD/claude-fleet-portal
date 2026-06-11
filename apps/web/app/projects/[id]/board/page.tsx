'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { KanbanTask, KanbanColumn, KanbanBoardMessage, Project, ModelInfo, RunEngine } from '@fleet/shared';
import { API } from '@/lib/api';
import { Kicker, Panel, Btn, Field, Input, Textarea, Select, Empty } from '@/components/ui';
import { KanbanBoard } from '@/components/KanbanBoard';
import { DiffView } from '@/components/DiffView';
import { ModelSelect, modelEngine } from '@/components/ModelSelect';

// ── inlined per-project board SSE hook ──────────────────────────────────────────
// lib/live.ts is off-limits to edit, so this lives here. Mirrors `useCampaign`:
//   board-hello → replace, task → upsert, task-removed → delete.
// H8: on a {error} frame the server ends the stream; close the EventSource so it
// does not auto-reconnect every ~3s forever.
function useBoard(projectId: string): { tasks: KanbanTask[]; connected: boolean; error: string | null } {
  const [taskMap, setTaskMap] = useState<Map<string, KanbanTask>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTaskMap(new Map());
    setError(null);
    const es = new EventSource(`${API}/api/projects/${projectId}/board/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let m: KanbanBoardMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if ((m as any).error) {
        setError(String((m as any).error));
        es.close();
        return;
      }
      if (m.kind === 'board-hello') {
        setTaskMap(new Map(m.tasks.map((t) => [t.id, t])));
      } else if (m.kind === 'task') {
        setTaskMap((prev) => {
          const next = new Map(prev);
          next.set(m.task.id, m.task);
          return next;
        });
      } else if (m.kind === 'task-removed') {
        setTaskMap((prev) => {
          const next = new Map(prev);
          next.delete(m.taskId);
          return next;
        });
      }
    };
    return () => es.close();
  }, [projectId]);

  return { tasks: [...taskMap.values()], connected, error };
}

interface BranchDiff {
  diff: string;
  truncated: boolean;
  binary: boolean;
  error?: string;
}

const PRIORITIES: { v: number; label: string }[] = [
  { v: 0, label: 'none' },
  { v: 1, label: 'low' },
  { v: 2, label: 'medium' },
  { v: 3, label: 'high' },
  { v: 4, label: 'urgent' },
];

export default function BoardPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const { tasks, connected, error } = useBoard(projectId);

  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', inputPerM: 0, outputPerM: 0, contextWindow: 0, maxOutput: 0, fastModeCapable: false },
  ]);
  const [enabledEngines, setEnabledEngines] = useState<RunEngine[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // create-card form
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [validationCommand, setValidationCommand] = useState('');
  const [priority, setPriority] = useState(0);
  const [budgetUsd, setBudgetUsd] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('3');
  const [column, setColumn] = useState<KanbanColumn>('Backlog');
  const [model, setModel] = useState('');
  // v2 #4 — single (one build run) vs campaign (orchestrator+worker sub-DAG). Immutable once the card
  // leaves Backlog (the server rejects a mode edit outside Backlog), so it's only offered at create.
  const [mode, setMode] = useState<'single' | 'campaign'>('single');

  // load project header (spend gauge / wip context). Best-effort; board still works without it.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/api/projects/${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => alive && setProject(p))
      .catch(() => {});
    fetch(`${API}/api/meta`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => alive && m?.models && setModels(m.models))
      .catch(() => {});
    fetch(`${API}/api/addons`)
      .then((r) => (r.ok ? r.json() : []))
      .then((addons: Array<{ id: string; enabled: boolean }>) => {
        if (alive) setEnabledEngines(addons.filter((a) => (a.id === 'codex' || a.id === 'opencode') && a.enabled).map((a) => a.id as RunEngine));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId]);

  // ── mutations (rely on SSE for state — no optimistic updates) ──────────────────
  async function mutate(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      // json content-type only when a body is sent — Fastify 400s an empty JSON-typed
      // body, which broke the body-less DELETE behind the card's ✕.
      const r = await fetch(`${API}${path}`, {
        ...(init.body != null ? { headers: { 'content-type': 'application/json' } } : {}),
        ...init,
      });
      if (!r.ok) {
        let msg = r.statusText;
        try {
          msg = (await r.json()).error ?? msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      return true;
    } catch (e: any) {
      setActionError(e.message || 'request failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const ok = await mutate(`/api/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: title.trim(),
        description: description || undefined,
        acceptanceCriteria: acceptanceCriteria || undefined,
        validationCommand: validationCommand.trim() ? validationCommand.trim() : undefined,
        priority,
        maxAttempts: maxAttempts.trim() ? Number(maxAttempts) : undefined,
        budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : undefined,
        column,
        mode,
        model: model || null,
      }),
    });
    if (!ok) return;
    // reset (SSE delivers the new card)
    setTitle('');
    setDescription('');
    setAcceptanceCriteria('');
    setValidationCommand('');
    setPriority(0);
    setBudgetUsd('');
    setMaxAttempts('3');
    setColumn('Backlog');
    setModel('');
    setMode('single');
    setShowCreate(false);
  }

  const moveTask = (task: KanbanTask, col: KanbanColumn) =>
    mutate(`/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ column: col }) });

  const approveTask = (task: KanbanTask) =>
    mutate(`/api/tasks/${task.id}/approve`, { method: 'POST', body: JSON.stringify({}) });

  const requestChanges = (task: KanbanTask) => {
    const comment = prompt('What changes are needed? (consumes an attempt)');
    if (comment == null) return; // cancelled
    return mutate(`/api/tasks/${task.id}/request-changes`, { method: 'POST', body: JSON.stringify({ comment }) });
  };

  const deleteTask = (task: KanbanTask) => {
    if (!confirm(`Delete card "${task.title}"? This cannot be undone.`)) return;
    return mutate(`/api/tasks/${task.id}`, { method: 'DELETE' });
  };

  const refreshPr = (task: KanbanTask) =>
    mutate(`/api/tasks/${task.id}/refresh-pr`, { method: 'POST', body: JSON.stringify({}) });

  // ── per-card proposed-merge diff (GET .../git/diff?branch=<worktree>) ───────────
  const [diffTask, setDiffTask] = useState<KanbanTask | null>(null);
  const [diffData, setDiffData] = useState<BranchDiff | null>(null);
  const diffSeq = useRef(0);

  const viewDiff = (task: KanbanTask) => {
    if (!task.worktreeName) return;
    const seq = ++diffSeq.current;
    setDiffTask(task);
    setDiffData(null);
    fetch(`${API}/api/projects/${projectId}/git/diff?branch=${encodeURIComponent(task.worktreeName)}`)
      .then((r) => r.json())
      .then((d: BranchDiff) => {
        if (diffSeq.current === seq) setDiffData(d);
      })
      .catch((e) => {
        if (diffSeq.current === seq) setDiffData({ diff: '', truncated: false, binary: false, error: e?.message || 'failed to load diff' });
      });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <Kicker>kanban</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 flex items-center gap-3">
            {project?.name ?? 'Board'}
            <span
              className="font-mono text-[10px] uppercase tracking-wider"
              style={{ color: connected ? '#54e08a' : '#7b828c' }}
              title={connected ? 'live' : 'reconnecting'}
            >
              {connected ? '● live' : '○ offline'}
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/projects/${projectId}`} className="font-mono text-[11px] text-dim hover:text-amber underline">
            ← project
          </Link>
          <Link href={`/projects/${projectId}/files`} className="font-mono text-[11px] text-dim hover:text-amber underline">
            files
          </Link>
          <Link href={`/projects/${projectId}/history`} className="font-mono text-[11px] text-dim hover:text-amber underline">
            history
          </Link>
          <Btn variant="amber" onClick={() => setShowCreate((s) => !s)}>
            + Card
          </Btn>
        </div>
      </div>

      {project?.paused && (
        <div className="font-mono text-[11px] border border-amber/30 bg-amber/5 px-3 py-2 mb-3" style={{ color: '#ffb000' }}>
          Project is paused — the PM will not pick up Ready cards until resumed.
        </div>
      )}

      {actionError && (
        <div className="font-mono text-sig-failed text-[11px] border border-sig-failed/30 bg-sig-failed/5 px-3 py-2 mb-3 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-faint hover:text-ink">
            ✕
          </button>
        </div>
      )}

      {/* create-card form */}
      {showCreate && (
        <Panel className="p-4 mb-4">
          <form onSubmit={createTask} className="grid gap-3">
            <Field label="title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what needs building" autoFocus />
            </Field>
            <Field label="description" hint="optional context">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="background / pointers" />
            </Field>
            <Field label="acceptance criteria" hint="definition-of-done · part of the build prompt">
              <Textarea
                value={acceptanceCriteria}
                onChange={(e) => setAcceptanceCriteria(e.target.value)}
                rows={2}
                placeholder="what makes this done"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="validation command" hint="blank → project default">
                <Input value={validationCommand} onChange={(e) => setValidationCommand(e.target.value)} placeholder="npm test" />
              </Field>
              <Field label="priority">
                <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                  {PRIORITIES.map((p) => (
                    <option key={p.v} value={p.v}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="budget usd" hint="per-run cap (each build/fix attempt)">
                <Input value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} placeholder="unbounded" inputMode="decimal" />
              </Field>
              <Field label="max attempts">
                <Input value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="column">
                <Select value={column} onChange={(e) => setColumn(e.target.value as KanbanColumn)}>
                  <option value="Backlog">Backlog</option>
                  <option value="Ready">Ready</option>
                </Select>
              </Field>
            </div>
            <Field label="mode" hint="single build run · or a campaign sub-DAG · immutable once it leaves Backlog">
              <Select value={mode} onChange={(e) => setMode(e.target.value as 'single' | 'campaign')}>
                <option value="single">single</option>
                <option value="campaign">campaign</option>
              </Select>
            </Field>
            <Field label="model" hint="blank = PM default; engine models delegate the card to that add-on">
              <ModelSelect
                models={models}
                value={model}
                onChange={setModel}
                enabledEngines={enabledEngines}
                allowCustom={false}
                defaultOption={{ value: '', label: 'PM default · Claude Opus 4.8' }}
              />
              {model && modelEngine(models, model) !== 'claude' && (
                <div className="text-faint font-mono text-[10px] mt-1.5">
                  engine card · disallowed-tools and per-run budget caps are not enforced by engine CLIs
                </div>
              )}
            </Field>
            <div className="flex items-center gap-2">
              <Btn type="submit" variant="solid" disabled={busy || !title.trim()}>
                Create card
              </Btn>
              <Btn onClick={() => setShowCreate(false)} disabled={busy}>
                Cancel
              </Btn>
            </div>
          </form>
        </Panel>
      )}

      {error ? (
        <div className="font-mono text-sig-failed text-[12px] border border-sig-failed/30 bg-sig-failed/5 px-3 py-2">
          Board stream error: {error}
        </div>
      ) : tasks.length === 0 ? (
        <Empty>No cards yet. Create one to get started.</Empty>
      ) : (
        <div className="overflow-x-auto pb-2">
          <KanbanBoard
            tasks={tasks}
            wipLimit={project?.wipLimit ?? null}
            projectId={projectId}
            busy={busy}
            onMove={moveTask}
            onApprove={approveTask}
            onRequestChanges={requestChanges}
            onDelete={deleteTask}
            onRefreshPr={refreshPr}
            onViewDiff={viewDiff}
          />
        </div>
      )}

      {diffTask && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4"
          style={{ background: 'rgba(4,5,7,0.78)' }}
          onClick={() => setDiffTask(null)}
        >
          <Panel className="w-full max-w-[900px] my-auto">
            <div onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b hairline">
                <div className="min-w-0">
                  <Kicker>proposed-merge diff</Kicker>
                  <div className="font-mono text-[11px] text-dim mt-1 truncate">
                    {diffTask.title} · {diffTask.worktreeName}
                  </div>
                </div>
                <button onClick={() => setDiffTask(null)} className="text-faint hover:text-ink font-mono text-lg leading-none">
                  ✕
                </button>
              </div>
              <div className="p-4">
                {diffData == null ? (
                  <div className="font-mono text-[11px] text-faint py-2">loading diff…</div>
                ) : (
                  <DiffView diff={diffData.diff} truncated={diffData.truncated} binary={diffData.binary} error={diffData.error} />
                )}
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
