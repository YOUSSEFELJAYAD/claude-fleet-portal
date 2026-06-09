'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { ModelInfo, SkillInfo, SubagentInfo, EffortLevel, PermissionMode } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Textarea, Select, Toggle, Btn } from './ui';

export function LaunchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [efforts, setEfforts] = useState<string[]>([]);
  const [permModes, setPermModes] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);

  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('/Users/jd');
  const [model, setModel] = useState('claude-opus-4-8');
  const [fastMode, setFastMode] = useState(false);
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [ultracode, setUltracode] = useState(false);
  const [workflows, setWorkflows] = useState(true);
  const [interactive, setInteractive] = useState(false);
  const [brief, setBrief] = useState(false); // H22 — enable agent→user messages
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [allowedTools, setAllowedTools] = useState('');
  const [disallowedTools, setDisallowedTools] = useState(''); // H10
  const [worktree, setWorktree] = useState(''); // H10
  const [chosenSkills, setChosenSkills] = useState<Set<string>>(new Set());
  const [subagentProfile, setSubagentProfile] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .meta()
      .then((m) => {
        setModels(m.models);
        setEfforts(m.efforts);
        setPermModes(m.permissionModes);
      })
      .catch(() => setErr('Could not load launch options — is the control plane running?')); // H8
  }, []);
  useEffect(() => {
    api.skills(cwd).then(setSkills).catch(() => setSkills([]));
    api.subagents(cwd).then(setSubagents).catch(() => setSubagents([]));
  }, [cwd]);

  const selectedModel = models.find((m) => m.id === model);
  const effectiveEffort = ultracode ? 'xhigh' : effort;

  async function submit() {
    if (!prompt.trim()) {
      setErr('A prompt is required.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const run = await api.launch({
        prompt,
        cwd,
        model,
        fastMode,
        effort: effectiveEffort,
        ultracode,
        workflowsEnabled: workflows,
        interactive,
        brief,
        permissionMode,
        allowedTools: allowedTools.trim() ? allowedTools.split(/[,\s]+/).filter(Boolean) : undefined,
        disallowedTools: disallowedTools.trim() ? disallowedTools.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean) : undefined,
        worktree: worktree.trim() || undefined,
        skills: [...chosenSkills],
        subagentProfile: subagentProfile || null,
        budgetUsd: budget.trim() ? Number(budget) : null,
      });
      onClose();
      router.push(`/runs/${run.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4" style={{ background: 'rgba(4,5,7,0.78)' }} onClick={onClose}>
      <Panel ticked className="w-full max-w-[760px] my-auto" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b hairline">
            <div>
              <Kicker>new run</Kicker>
              <h2 className="font-display text-[18px] tracking-wide text-ink mt-1">Launch Agent</h2>
            </div>
            <button onClick={onClose} className="text-faint hover:text-ink font-mono text-lg leading-none">✕</button>
          </div>

          <div className="p-6 grid grid-cols-2 gap-5">
            <div className="col-span-2">
              <Field label="task prompt">
                <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the task for the agent…" autoFocus />
              </Field>
            </div>

            <Field label="working directory" hint="cwd">
              <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" />
            </Field>
            <Field label="model">
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · ${m.inputPerM}/${m.outputPerM}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex items-center gap-5">
              <div>
                <Kicker>fast mode</Kicker>
                <div className="mt-2">
                  <Toggle on={fastMode} onChange={setFastMode} label={selectedModel?.fastModeCapable ? (fastMode ? '2× rate' : 'standard') : 'n/a'} />
                </div>
              </div>
              <div>
                <Kicker>interactive</Kicker>
                <div className="mt-2">
                  <Toggle on={interactive} onChange={setInteractive} label={interactive ? 'keep alive' : 'one-shot'} />
                </div>
              </div>
              <div>
                <Kicker>brief</Kicker>
                <div className="mt-2">
                  <Toggle on={brief} onChange={setBrief} label={brief ? 'agent can ask' : 'off'} />
                </div>
              </div>
            </div>
            <Field label="effort dial" hint={ultracode ? 'locked → xhigh' : ''}>
              <Select value={effectiveEffort} disabled={ultracode} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
                {efforts.map((e) => (
                  <option key={e} value={e}>
                    {e.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>

            {/* ultracode + workflows row */}
            <div className="col-span-2 border border-amber/25 bg-amber/[0.04] px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2.5">
                  <Toggle on={ultracode} onChange={setUltracode} />
                  <div>
                    <div className="font-display text-[12px] text-amber tracking-wide uppercase">ultracode</div>
                    <div className="text-faint font-mono text-[10px]">xhigh + auto-orchestrate · tighter budget</div>
                  </div>
                </div>
                <div className="w-px h-7 bg-line" />
                <div className="flex items-center gap-2.5">
                  <Toggle on={workflows} onChange={setWorkflows} />
                  <div>
                    <div className="font-display text-[12px] text-dim tracking-wide uppercase">dynamic workflows</div>
                    <div className="text-faint font-mono text-[10px]">≤16 concurrent · 1000 total</div>
                  </div>
                </div>
              </div>
              {ultracode && <span className="font-mono text-[10px] text-sig-failed animate-pulseGlow" style={{ color: '#ff5d5d' }}>⚠ HIGH BURN</span>}
            </div>

            <Field label="permission mode">
              <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}>
                {permModes.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="budget ceiling" hint={ultracode ? 'default $15' : 'default $5'}>
              <Input type="number" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={ultracode ? '15.00' : '5.00'} />
            </Field>

            <div className="col-span-2">
              <Field label="allowed tools" hint="comma-separated · blank = default">
                <Input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Bash(git *), Edit, Read" />
              </Field>
            </div>

            {/* H10 — worktree isolation + tool deny-list */}
            <Field label="git worktree" hint="optional · isolated branch">
              <Input value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="feature-x (blank = none)" />
            </Field>
            <Field label="disallowed tools" hint="deny-list · comma-separated">
              <Input value={disallowedTools} onChange={(e) => setDisallowedTools(e.target.value)} placeholder="Bash(git push *), Write" />
            </Field>

            <div className="col-span-2">
              <Kicker>attach skills{skills.length ? ` · ${skills.length} available` : ' · none found'}</Kicker>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {skills.length === 0 && <span className="text-faint font-mono text-[11px]">No SKILL.md folders in ~/.claude/skills or project</span>}
                {skills.map((s) => {
                  const on = chosenSkills.has(s.name);
                  return (
                    <button
                      key={s.path}
                      onClick={() =>
                        setChosenSkills((prev) => {
                          const next = new Set(prev);
                          on ? next.delete(s.name) : next.add(s.name);
                          return next;
                        })
                      }
                      title={s.description}
                      className="font-mono text-[11px] px-2 py-1 border transition-colors"
                      style={{
                        borderColor: on ? '#ffb000' : 'rgba(255,255,255,0.14)',
                        color: on ? '#ffb000' : '#9aa1ab',
                        background: on ? 'rgba(255,176,0,0.1)' : 'transparent',
                      }}
                    >
                      {on ? '◉ ' : '○ '}
                      {s.name}
                      <span className="text-faint ml-1">·{s.scope}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {subagents.length > 0 && (
              <div className="col-span-2">
                <Field label="subagent profile" hint="optional">
                  <Select value={subagentProfile} onChange={(e) => setSubagentProfile(e.target.value)}>
                    <option value="">— none —</option>
                    {subagents.map((s) => (
                      <option key={s.path} value={s.name}>
                        {s.name} ·{s.scope}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-6 py-4 border-t hairline">
            <div className="font-mono text-[11px]" style={{ color: err ? '#ff5d5d' : '#5b626d' }}>
              {err ?? `spawns: claude -p --effort ${effectiveEffort}${fastMode ? ' (fast)' : ''}`}
            </div>
            <div className="flex gap-2">
              <Btn onClick={onClose}>Cancel</Btn>
              <Btn variant="solid" onClick={submit} disabled={busy}>
                {busy ? 'Launching…' : '▶ Run'}
              </Btn>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
