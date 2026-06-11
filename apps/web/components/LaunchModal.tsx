'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type McpServerInfo } from '@/lib/api';
import type { AgentTemplate, ModelInfo, SkillInfo, SubagentInfo, EffortLevel, PermissionMode, ToolPack, RunEngine } from '@fleet/shared';
import { CLAUDE_TOOLS, MODELS } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Textarea, Select, Toggle, Btn } from './ui';
import { MultiPicker } from './MultiPicker';
import { PackBar } from './PackBar';

/** Engine options available in the segmented control (claude is always shown). */
const ENGINE_LABELS: Record<string, string> = {
  claude: 'Claude (default)',
  codex: 'Codex (ChatGPT)',
  opencode: 'OpenCode',
};

const union = (base: string[], add: string[]) => [...base, ...add.filter((x) => !base.includes(x))];

/** built-in tools + one `mcp__<server>` entry per configured MCP server (= every tool
 *  that server exposes — claude's own allowed-tools semantics); specific
 *  `mcp__server__tool` patterns are still typeable as custom entries. */
function buildToolOptions(mcpServers: McpServerInfo[]) {
  return [
    ...CLAUDE_TOOLS.map((t) => ({ value: t.name, hint: t.hint, group: 'claude tools' })),
    ...mcpServers.map((s) => ({
      value: `mcp__${s.name}`,
      hint: `every ${s.name} tool · ${s.status}${s.detail ? ` · ${s.detail}` : ''}`,
      group: 'mcp servers · all tools of the server',
    })),
  ];
}

export function LaunchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [efforts, setEfforts] = useState<string[]>([]);
  const [permModes, setPermModes] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  /** Engine add-ons that are currently enabled (id only). claude is always available. */
  const [enabledEngines, setEnabledEngines] = useState<string[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<RunEngine>('claude');
  const [engineModel, setEngineModel] = useState('');

  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [appendSys, setAppendSys] = useState('');
  const [sysOpen, setSysOpen] = useState(false);

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
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [disallowedTools, setDisallowedTools] = useState<string[]>([]); // H10
  const [worktree, setWorktree] = useState(''); // H10
  const [chosenSkills, setChosenSkills] = useState<string[]>([]);
  const [command, setCommand] = useState(''); // optional /command the run starts on
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
    api
      .mcp()
      .then((r) => setMcpServers(r.servers))
      .catch(() => {}); // no MCP servers ≠ broken launch form
    // fetch enabled engine add-ons for the engine selector
    api
      .addons()
      .then((addons) => {
        const engines = addons
          .filter((a) => (a.id === 'codex' || a.id === 'opencode') && a.enabled)
          .map((a) => a.id);
        setEnabledEngines(engines);
      })
      .catch(() => {}); // no enabled engines ≠ broken form
    api.templates().then(setTemplates).catch(() => {});
  }, []);
  const toolOptions = useMemo(() => buildToolOptions(mcpServers), [mcpServers]);
  useEffect(() => {
    let alive = true;
    api.skills(cwd).then((s) => alive && setSkills(s)).catch(() => alive && setSkills([]));
    api.subagents(cwd).then((s) => alive && setSubagents(s)).catch(() => alive && setSubagents([]));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const selectedModel = models.find((m) => m.id === model);
  const effectiveEffort = ultracode ? 'xhigh' : effort;

  const isEngineRun = selectedEngine !== 'claude';

  // Group templates by role for optgroup rendering
  const TEMPLATE_ROLES = ['orchestrator', 'worker', 'reviewer', 'synthesizer'] as const;
  const templatesByRole = useMemo(() => {
    const map: Record<string, AgentTemplate[]> = {};
    for (const t of templates) {
      const r = t.role || 'other';
      (map[r] ??= []).push(t);
    }
    return map;
  }, [templates]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    if (!id) {
      setAppendSys('');
      return;
    }
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setAppendSys(t.systemPrompt);
    setSysOpen(true); // auto-expand when a template is applied
    if (MODELS.find((m) => m.id === t.model)) setModel(t.model);
    setFastMode(t.fastMode);
    setEffort(t.effort as EffortLevel);
    setPermissionMode(t.permissionMode as PermissionMode);
    setAllowedTools(t.allowedTools ?? []);
    setChosenSkills(t.skills ?? []);
    setBudget(t.budgetUsd != null ? String(t.budgetUsd) : '');
  }

  // A picked /command becomes the head of the prompt — CLAUDE ONLY: codex/opencode
  // have no claude slash-commands, and a stale selection from before an engine switch
  // must never silently prefix the engine prompt (review).
  const effectivePrompt =
    !isEngineRun && command ? `/${command}${prompt.trim() ? ' ' + prompt.trim() : ''}` : prompt;

  async function submit() {
    if (!effectivePrompt.trim()) {
      setErr('A prompt or a /command is required.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const run = isEngineRun
        ? await api.launch({
            prompt: effectivePrompt,
            cwd,
            engine: selectedEngine,
            engineModel: engineModel.trim() || undefined,
            // send sane defaults the server validation accepts; the engine branch ignores them
            model: 'claude-opus-4-8',
            effort: 'high',
            permissionMode: 'default',
            budgetUsd: budget.trim() ? Number(budget) : null,
          })
        : await api.launch({
            prompt: effectivePrompt,
            cwd,
            model,
            fastMode,
            effort: effectiveEffort,
            ultracode,
            workflowsEnabled: workflows,
            interactive,
            brief,
            permissionMode,
            allowedTools: allowedTools.length ? allowedTools : undefined,
            disallowedTools: disallowedTools.length ? disallowedTools : undefined,
            worktree: worktree.trim() || undefined,
            // the picked /command's instructions auto-load with the command — never double-inject
            skills: chosenSkills.filter((s) => s !== command),
            subagentProfile: subagentProfile || null,
            budgetUsd: budget.trim() ? Number(budget) : null,
            appendSystemPrompt: appendSys.trim() || undefined,
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
            {/* ── engine selector (only shown when at least one engine add-on is enabled) ── */}
            {enabledEngines.length > 0 && (
              <div className="col-span-2">
                <Kicker>engine</Kicker>
                <div className="mt-2 flex items-center gap-1 flex-wrap">
                  {(['claude', ...enabledEngines] as RunEngine[]).map((eng) => (
                    <button
                      key={eng}
                      onClick={() => {
                        // engine-model formats differ (codex: bare id; opencode: provider/model)
                        // — a stale value from the previous engine would submit garbage
                        if (eng !== selectedEngine) setEngineModel('');
                        setSelectedEngine(eng);
                      }}
                      className="font-mono text-[11px] px-3 py-1.5 border transition-colors"
                      style={{
                        background: selectedEngine === eng ? 'rgba(255,176,0,0.12)' : 'transparent',
                        borderColor: selectedEngine === eng ? 'rgba(255,176,0,0.5)' : 'var(--color-line)',
                        color: selectedEngine === eng ? '#ffb000' : 'var(--color-dim)',
                      }}
                    >
                      {ENGINE_LABELS[eng] ?? eng}
                    </button>
                  ))}
                </div>
                {isEngineRun && (
                  <div className="font-mono text-[10.5px] text-faint mt-1.5">
                    one-shot · flat timeline · stop works; resume/input/permission do not
                  </div>
                )}
              </div>
            )}

            {/* ── engine model input (shown only for engine runs) ── */}
            {isEngineRun && (
              <div className="col-span-2">
                <Field
                  label="engine model"
                  hint={selectedEngine === 'codex' ? 'blank = codex CLI default · e.g. gpt-5-codex' : 'blank = opencode default · e.g. anthropic/claude-sonnet-4-5'}
                >
                  <Input
                    value={engineModel}
                    onChange={(e) => setEngineModel(e.target.value)}
                    placeholder={selectedEngine === 'codex' ? 'gpt-5-codex · blank = engine default' : 'anthropic/claude-sonnet-4-5 · blank = engine default'}
                  />
                </Field>
              </div>
            )}

            {/* ── agent profile (template) picker — claude only ── */}
            {!isEngineRun && (
              <div className="col-span-2">
                <Field label="agent profile · template" hint="applies its system prompt, model, tools, skills & budget — everything stays editable">
                  <Select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                    <option value="">— blank agent (no profile) —</option>
                    {TEMPLATE_ROLES.map((role) =>
                      templatesByRole[role]?.length ? (
                        <optgroup key={role} label={role}>
                          {templatesByRole[role].map((t) => (
                            <option key={t.id} value={t.id} title={t.description}>
                              {t.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null
                    )}
                    {/* any roles not in the fixed list */}
                    {Object.entries(templatesByRole)
                      .filter(([role]) => !(TEMPLATE_ROLES as readonly string[]).includes(role))
                      .map(([role, ts]) => (
                        <optgroup key={role} label={role}>
                          {ts.map((t) => (
                            <option key={t.id} value={t.id} title={t.description}>
                              {t.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                  </Select>
                </Field>
              </div>
            )}

            {/* /command selector — claude only */}
            {!isEngineRun && (
              <div className="col-span-2">
                <Field label="run a /command" hint="optional · the agent starts on this slash-command; the prompt becomes its arguments">
                  <Select value={command} onChange={(e) => setCommand(e.target.value)}>
                    <option value="">— none (free-form prompt) —</option>
                    <optgroup label="built-in (claude)">
                      {skills
                        .filter((s) => s.scope === 'builtin')
                        .map((s) => (
                          <option key={s.path} value={s.name} title={s.description}>
                            /{s.name}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="commands (plugins · user · project)">
                      {skills
                        .filter((s) => s.kind === 'command' && s.scope !== 'builtin')
                        .map((s) => (
                          <option key={s.path} value={s.name} title={s.description}>
                            /{s.name}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="skills (also run as /name)">
                      {skills
                        .filter((s) => s.kind !== 'command')
                        .map((s) => (
                          <option key={s.path} value={s.name} title={s.description}>
                            /{s.name}
                          </option>
                        ))}
                    </optgroup>
                  </Select>
                </Field>
              </div>
            )}

            <div className="col-span-2">
              <Field label={command && !isEngineRun ? `arguments for /${command}` : 'task prompt'}>
                <Textarea
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={command && !isEngineRun ? 'optional arguments / extra context for the command…' : 'Describe the task for the agent…'}
                  autoFocus
                />
              </Field>
              {command && !isEngineRun && (
                <div className="font-mono text-[10px] text-faint mt-1 truncate">
                  will run: <span className="text-amber">{effectivePrompt}</span>
                </div>
              )}
            </div>

            {/* ── agent instructions (system prompt) — claude only ── */}
            {!isEngineRun && (
              <div className="col-span-2">
                <button
                  type="button"
                  onClick={() => setSysOpen((v) => !v)}
                  className="font-mono text-[10.5px] text-faint hover:text-ink transition-colors flex items-center gap-1.5"
                >
                  <span>{sysOpen ? '▾' : '▸'}</span>
                  {!sysOpen && appendSys.trim() ? (
                    <span style={{ color: '#ffb000' }}>agent instructions · ACTIVE ({appendSys.length} chars)</span>
                  ) : (
                    <span>agent instructions · system prompt</span>
                  )}
                </button>
                {sysOpen && (
                  <div className="mt-2">
                    <Textarea
                      rows={6}
                      value={appendSys}
                      onChange={(e) => setAppendSys(e.target.value)}
                      placeholder="how this agent should work — appended via --append-system-prompt"
                      className="w-full"
                    />
                    <div className="font-mono text-[9.5px] text-faint mt-1">
                      how this agent should work — appended via --append-system-prompt
                    </div>
                  </div>
                )}
              </div>
            )}

            <Field label="working directory" hint="cwd">
              <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" />
            </Field>

            {/* model select — claude only */}
            {!isEngineRun && (
              <Field label="model">
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · ${m.inputPerM}/${m.outputPerM}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {/* fast mode / interactive / brief — claude only */}
            {!isEngineRun && (
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
            )}

            {/* effort dial — claude only */}
            {!isEngineRun && (
              <Field label="effort dial" hint={ultracode ? 'locked → xhigh' : ''}>
                <Select value={effectiveEffort} disabled={ultracode} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
                  {efforts.map((e) => (
                    <option key={e} value={e}>
                      {e.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {/* ultracode + workflows row — claude only */}
            {!isEngineRun && (
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
            )}

            {/* permission mode — claude only */}
            {!isEngineRun && (
              <Field label="permission mode">
                <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}>
                  {permModes.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="budget ceiling" hint={isEngineRun ? 'not enforced on this engine' : (ultracode ? 'default $15' : 'default $5')}>
              <Input
                type="number"
                step="0.5"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder={isEngineRun ? 'not enforced' : (ultracode ? '15.00' : '5.00')}
              />
            </Field>

            {/* packs / tools / skills / worktree / subagent — claude only */}
            {!isEngineRun && (
              <>
                {/* §23 — packs: one-click presets unioned into the pickers below */}
                <div className="col-span-2 border-t hairline pt-4">
                  <PackBar
                    tools={allowedTools}
                    skills={chosenSkills}
                    onApply={(p: ToolPack) => {
                      setAllowedTools((prev) => union(prev, p.tools));
                      setChosenSkills((prev) => union(prev, p.skills));
                    }}
                  />
                </div>

                <div className="col-span-2">
                  <Field label="allowed tools" hint="searchable · blank = default toolset · custom patterns allowed">
                    <MultiPicker
                      value={allowedTools}
                      onChange={setAllowedTools}
                      options={toolOptions}
                      placeholder="search tools & mcp servers — or type a pattern like Bash(git *)…"
                      customHint="patterns like Bash(git *) / mcp__server__tool work"
                    />
                  </Field>
                </div>

                {/* H10 — worktree isolation + tool deny-list */}
                <Field label="git worktree" hint="optional · isolated branch">
                  <Input value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="feature-x (blank = none)" />
                </Field>
                <Field label="disallowed tools" hint="deny-list · searchable">
                  <MultiPicker
                    value={disallowedTools}
                    onChange={setDisallowedTools}
                    options={toolOptions}
                    placeholder="search… e.g. Bash(git push *)"
                    customHint="deny patterns work too"
                  />
                </Field>

                <div className="col-span-2">
                  <Field
                    label={`attach skills${skills.length ? ` · ${skills.length} available` : ''}`}
                    hint="injected with an instruction to invoke them before work starts"
                  >
                    <MultiPicker
                      value={chosenSkills}
                      onChange={setChosenSkills}
                      options={skills.map((s) => ({
                        value: s.name,
                        hint: s.description,
                        group: `${s.kind === 'command' ? 'commands' : 'skills'} · ${s.scope}`,
                      }))}
                      placeholder={skills.length ? 'search skills & commands…' : 'no skills found — type a name to add one'}
                      customHint="attach by name even if not in the catalog"
                    />
                  </Field>
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
              </>
            )}
          </div>

          <div className="flex items-center justify-between px-6 py-4 border-t hairline">
            <div className="font-mono text-[11px]" style={{ color: err ? '#ff5d5d' : '#5b626d' }}>
              {err ?? (isEngineRun
                ? selectedEngine === 'codex'
                  ? `spawns: codex${engineModel.trim() ? ` --model ${engineModel.trim()}` : ''} exec --json`
                  : `spawns: opencode run --format json${engineModel.trim() ? ` --model ${engineModel.trim()}` : ''}`
                : `spawns: claude -p --effort ${effectiveEffort}${fastMode ? ' (fast)' : ''}`)}
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
