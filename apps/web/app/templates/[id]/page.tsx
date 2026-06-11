'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type McpServerInfo } from '@/lib/api';
import type { AgentTemplate, EffortLevel, PermissionMode, SkillInfo, ToolPack } from '@fleet/shared';
import { CLAUDE_TOOLS } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Textarea, Select, Btn } from '@/components/ui';
import { MultiPicker } from '@/components/MultiPicker';
import { PackBar } from '@/components/PackBar';

const union = (base: string[], add: string[]) => [...base, ...add.filter((x) => !base.includes(x))];

const ROLE_COLOR: Record<string, string> = {
  orchestrator: '#b08cff',
  worker: '#39d4cf',
  synthesizer: '#ffb000',
  reviewer: '#54e08a',
};
const ROLES = ['orchestrator', 'worker', 'reviewer', 'synthesizer'] as const;

export default function TemplateDetail({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const [t, setT] = useState<AgentTemplate | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ models: { id: string; label: string }[]; efforts: string[]; permissionModes: string[] } | null>(null);
  const [catalog, setCatalog] = useState<SkillInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);

  // ── edit state (initialized from the loaded template) ────────────────────────
  const [role, setRole] = useState<string>('worker');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function hydrate(tpl: AgentTemplate) {
    setT(tpl);
    setRole(tpl.role);
    setDescription(tpl.description);
    setSystemPrompt(tpl.systemPrompt);
    setModel(tpl.model);
    setEffort(tpl.effort as EffortLevel);
    setPermissionMode(tpl.permissionMode as PermissionMode);
    setAllowedTools(tpl.allowedTools);
    setSkills(tpl.skills);
    setBudget(tpl.budgetUsd != null ? String(tpl.budgetUsd) : '');
  }

  useEffect(() => {
    api.template(id).then(hydrate).catch((e: any) => setLoadErr(e?.message || 'failed to load template'));
    api.meta().then((m) => setMeta(m as any)).catch(() => {});
    api.skills().then(setCatalog).catch(() => setCatalog([]));
    api.mcp().then((r) => setMcpServers(r.servers)).catch(() => {});
  }, [id]);

  // built-in tools + one mcp__<server> entry per configured MCP server (= all its tools)
  const toolOptions = useMemo(
    () => [
      ...CLAUDE_TOOLS.map((t) => ({ value: t.name, hint: t.hint, group: 'claude tools' })),
      ...mcpServers.map((s) => ({
        value: `mcp__${s.name}`,
        hint: `every ${s.name} tool · ${s.status}${s.detail ? ` · ${s.detail}` : ''}`,
        group: 'mcp servers · all tools of the server',
      })),
    ],
    [mcpServers],
  );

  const skillOptions = useMemo(
    () =>
      catalog.map((s) => ({
        value: s.name,
        hint: s.description,
        group: `${s.kind === 'command' ? 'commands' : 'skills'} · ${s.scope}`,
      })),
    [catalog],
  );

  async function save() {
    if (!t) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const next = await api.updateTemplate(t.id, {
        role: role as AgentTemplate['role'],
        description,
        systemPrompt,
        model,
        effort,
        permissionMode,
        allowedTools,
        skills,
        budgetUsd: budget.trim() ? Number(budget) : null,
      });
      hydrate(next);
      setSaved(true);
    } catch (e: any) {
      setErr(e?.message || 'failed to save');
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!t || t.isBuiltin) return;
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteTemplate(t.id);
      router.push('/templates');
    } catch (e: any) {
      setErr(e?.message || 'failed to delete');
    }
  }

  if (loadErr) {
    return (
      <div className="font-mono text-[12px] text-sig-failed">
        <Link href="/templates" className="text-amber">← templates</Link>
        <div className="mt-6">{loadErr}</div>
      </div>
    );
  }
  if (!t) return <div className="font-mono text-faint text-[12px]">loading template…</div>;

  const color = ROLE_COLOR[role] ?? '#9aa1ab';

  return (
    <div>
      <div className="mb-5">
        <Link href="/templates" className="font-mono text-[11px] text-amber hover:underline">← templates</Link>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <Kicker>agent profile</Kicker>
          {t.isBuiltin && (
            <span className="font-mono text-[9px] uppercase tracking-wider text-faint border border-line px-1.5 py-0.5">built-in · name fixed · editable</span>
          )}
        </div>
        <h1 className="font-display text-[22px] text-ink tracking-wide mt-1 flex items-center gap-3">
          <span style={{ width: 9, height: 9, borderRadius: 999, background: color, display: 'inline-block' }} />
          {t.name}
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5 items-start">
        {/* ── left: prompt + skills ─────────────────────────────────────────── */}
        <div className="space-y-5">
          <Panel className="p-4">
            <Kicker>system prompt — how this agent works</Kicker>
            <div className="font-mono text-[10px] text-faint mt-1 mb-2">
              appended to the agent via --append-system-prompt on every launch that uses this template
            </div>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={16}
              className="w-full font-mono text-[11.5px] leading-relaxed"
            />
          </Panel>

          <Panel className="p-4 space-y-4">
            {/* §23 — packs union into BOTH pickers (skills here, allowed tools on the right) */}
            <PackBar
              tools={allowedTools}
              skills={skills}
              onApply={(p: ToolPack) => {
                setAllowedTools((prev) => union(prev, p.tools));
                setSkills((prev) => union(prev, p.skills));
              }}
            />
            <div>
              <Kicker>skills</Kicker>
              <div className="font-mono text-[10px] text-faint mt-1 mb-2">
                selected skills are injected into the agent&apos;s system prompt with an instruction to invoke them
                via its Skill tool before starting work
              </div>
              <MultiPicker
                value={skills}
                onChange={setSkills}
                options={skillOptions}
                placeholder={skillOptions.length ? 'search skills & commands…' : 'no skills found — type a name to add one'}
                customHint="attach by name even if not in the catalog"
              />
            </div>
          </Panel>
        </div>

        {/* ── right: profile knobs ───────────────────────────────────────────── */}
        <div className="space-y-5">
          <Panel className="p-4 space-y-3">
            <Kicker>profile</Kicker>
            <Field label="description">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full" />
            </Field>
            <Field label="role" hint="orchestrator/synthesizer are picked by campaigns">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </Select>
            </Field>
            <Field label="model">
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                {(meta?.models ?? [{ id: model, label: model }]).map((m) => (
                  <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
                ))}
              </Select>
            </Field>
            <Field label="effort">
              <Select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
                {(meta?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']).map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="permission mode">
              <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}>
                {(meta?.permissionModes ?? ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions']).map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="allowed tools" hint="searchable · empty = all tools">
              <MultiPicker
                value={allowedTools}
                onChange={setAllowedTools}
                options={toolOptions}
                placeholder="search tools & mcp servers…"
                customHint="patterns like Bash(git *) work"
              />
            </Field>
            <Field label="budget USD / run" hint="empty = config default">
              <Input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="unbounded" />
            </Field>
          </Panel>

          <div className="flex items-center gap-3 flex-wrap">
            <Btn variant="solid" onClick={save} disabled={busy}>
              {busy ? 'saving…' : 'Save Profile'}
            </Btn>
            {!t.isBuiltin && (
              <Btn variant="danger" onClick={del} disabled={busy}>
                ✕ Delete
              </Btn>
            )}
            {saved && <span className="font-mono text-[11px]" style={{ color: '#54e08a' }}>✓ saved</span>}
            {err && <span className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{err}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
