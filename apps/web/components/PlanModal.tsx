'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { PlanDraft, PlanTask, StreamMessage } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Textarea, Btn } from './ui';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

/**
 * PM Plan-board (v2 #3). Objective input → launches the orchestrator planner → streams its
 * live progress over the EXISTING /api/agents/:id/stream (using draft.orchestratorRunId, zero
 * new SSE) → editable task preview → Apply (one Ready card per task, deps mapped from the DAG).
 * Rendering is intentionally plain (rich markdown is item #6).
 */
export function PlanModal({ projectId, onClose, onApplied }: { projectId: string; onClose: () => void; onApplied?: () => void }) {
  const router = useRouter();
  const [objective, setObjective] = useState('');
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [tasks, setTasks] = useState<PlanTask[]>([]); // editable preview
  const [progress, setProgress] = useState<string>(''); // live planner text
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  function teardown() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    esRef.current?.close();
    esRef.current = null;
  }
  useEffect(() => () => teardown(), []);

  async function startPlanning() {
    if (!objective.trim()) {
      setErr('An objective is required.');
      return;
    }
    setBusy(true);
    setErr(null);
    setProgress('');
    try {
      const d = await api.createPlan(projectId, objective.trim());
      setDraft(d);
      // stream the planner run's live progress over the existing per-run SSE.
      if (d.orchestratorRunId) openStream(d.orchestratorRunId);
      // poll the draft until the terminal hook flips it to ready/error.
      pollRef.current = setInterval(async () => {
        try {
          const fresh = await api.getPlan(d.id);
          setDraft(fresh);
          if (fresh.status === 'ready') {
            setTasks(fresh.plan ?? []);
            teardown();
          } else if (fresh.status === 'error') {
            setErr(fresh.error || 'planning failed');
            teardown();
          }
        } catch {
          /* transient — keep polling */
        }
      }, 700);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function openStream(runId: string) {
    esRef.current?.close();
    const es = new EventSource(`${API}/api/agents/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      let m: StreamMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if ((m as any).error) {
        es.close();
        return;
      }
      if (m.kind === 'event' && m.event.type === 'assistant_text') {
        const text = String((m.event as any).payload?.text ?? '');
        if (text) setProgress((p) => (p ? p + '\n' : '') + text);
      }
    };
    es.onerror = () => {/* the poll is the source of truth for terminal state */};
  }

  function patchTask(i: number, patch: Partial<PlanTask>) {
    setTasks((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function removeTask(i: number) {
    setTasks((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function apply() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await api.applyPlan(draft.id, tasks);
      teardown();
      onApplied?.();
      onClose();
      router.push(`/projects/${projectId}/board`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  const status = draft?.status;
  const taskIds = new Set(tasks.map((t) => t.id));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4" style={{ background: 'rgba(4,5,7,0.78)' }} onClick={onClose}>
      <Panel ticked className="w-full max-w-[760px] my-auto">
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b hairline">
            <div>
              <Kicker>plan board</Kicker>
              <h2 className="font-display text-[18px] tracking-wide text-ink mt-1">Plan from objective</h2>
            </div>
            <button onClick={onClose} className="text-faint hover:text-ink font-mono text-lg leading-none">✕</button>
          </div>

          <div className="p-6 space-y-5">
            {/* objective */}
            <Field label="objective" hint="the planner decomposes this into a task DAG">
              <Textarea
                rows={3}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Add OAuth login, harden the session store, and document the flow."
                disabled={!!draft}
                autoFocus
              />
            </Field>

            {/* live planner progress */}
            {draft && status === 'planning' && (
              <div>
                <Kicker>planning · live</Kicker>
                <div className="mt-2 font-mono text-[11px] text-dim whitespace-pre-wrap border border-line2 bg-black/20 px-3 py-2 max-h-[160px] overflow-y-auto">
                  {progress || 'decomposing the objective…'}
                  <span className="animate-pulse text-amber"> ▋</span>
                </div>
              </div>
            )}

            {/* editable task preview */}
            {status === 'ready' && (
              <div>
                <div className="flex items-baseline justify-between">
                  <Kicker>review plan · {tasks.length} task{tasks.length === 1 ? '' : 's'}</Kicker>
                  <span className="font-mono text-[10px] text-faint">edit/remove before apply → one card each</span>
                </div>
                <div className="mt-2 space-y-3">
                  {tasks.map((t, i) => (
                    <div key={t.id} className="border border-line2 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-amber">{t.id}</span>
                        <button onClick={() => removeTask(i)} className="font-mono text-[10px] text-faint hover:text-sig-failed" style={{ color: '#9aa1ab' }}>
                          remove
                        </button>
                      </div>
                      <Input className="mt-1.5" value={t.title} onChange={(e) => patchTask(i, { title: e.target.value })} placeholder="title" />
                      <Textarea
                        className="mt-1.5"
                        rows={2}
                        value={t.prompt}
                        onChange={(e) => patchTask(i, { prompt: e.target.value })}
                        placeholder="card description / instruction"
                      />
                      {(t.dependsOn ?? []).filter((d) => taskIds.has(d)).length > 0 && (
                        <div className="mt-1.5 font-mono text-[10px] text-faint">
                          depends on: {(t.dependsOn ?? []).filter((d) => taskIds.has(d)).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                  {tasks.length === 0 && <div className="font-mono text-[11px] text-faint">all tasks removed — nothing to apply</div>}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-6 py-4 border-t hairline">
            <div className="font-mono text-[11px]" style={{ color: err ? '#ff5d5d' : '#5b626d' }}>
              {err ?? (status === 'ready' ? `apply → ${tasks.length} card(s) into Ready` : status === 'planning' ? 'orchestrator planning…' : 'objective → plan → review → apply')}
            </div>
            <div className="flex gap-2">
              <Btn onClick={onClose}>Cancel</Btn>
              {status === 'ready' ? (
                <Btn variant="solid" onClick={apply} disabled={busy || tasks.length === 0}>
                  {busy ? 'Applying…' : `✓ Apply ${tasks.length} card${tasks.length === 1 ? '' : 's'}`}
                </Btn>
              ) : (
                <Btn variant="solid" onClick={startPlanning} disabled={busy || !!draft}>
                  {busy ? 'Planning…' : '▶ Plan'}
                </Btn>
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
