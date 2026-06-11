'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { AgentTemplate, EffortLevel, PermissionMode } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Textarea, Select, Btn, Empty } from '@/components/ui';

const ROLE_COLOR: Record<string, string> = {
  orchestrator: '#b08cff',
  worker: '#39d4cf',
  synthesizer: '#ffb000',
  reviewer: '#54e08a',
};

function TemplateCard({ t, onDelete }: { t: AgentTemplate; onDelete: () => void }) {
  const color = ROLE_COLOR[t.role] ?? '#9aa1ab';
  return (
    <Panel className="p-4" >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block' }} />
          <Link href={`/templates/${t.id}`} className="font-display text-[13px] text-ink tracking-wide hover:text-amber">
            {t.name}
          </Link>
          <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color, borderColor: color + '40' }}>{t.role}</span>
        </div>
        <div className="flex items-center gap-2">
          {t.isBuiltin && <span className="font-mono text-[9px] text-faint">built-in</span>}
          <Link href={`/templates/${t.id}`} className="font-mono text-[10px] text-dim hover:text-amber underline">
            open →
          </Link>
          {!t.isBuiltin && (
            <button onClick={onDelete} className="font-mono text-[10px] text-faint hover:text-sig-failed">✕ delete</button>
          )}
        </div>
      </div>
      <div className="text-dim text-[11px] mt-2 leading-snug">{t.description}</div>
      <div className="mt-3 flex flex-wrap gap-1.5 font-mono text-[10px]">
        <span className="text-dim border border-line px-1.5 py-0.5">{t.model.replace('claude-', '')}</span>
        <span className="text-amber border border-amber/30 px-1.5 py-0.5">effort {t.effort}</span>
        <span className="text-dim border border-line px-1.5 py-0.5">{t.permissionMode}</span>
        {t.budgetUsd != null && <span className="text-dim border border-line px-1.5 py-0.5">${t.budgetUsd}</span>}
      </div>
      {t.allowedTools.length > 0 && (
        <div className="mt-2 font-mono text-[10px] text-faint truncate">tools: {t.allowedTools.join(', ')}</div>
      )}
      {t.skills.length > 0 && (
        <div className="mt-1 font-mono text-[10px] truncate" style={{ color: '#39d4cf' }}>skills: {t.skills.join(', ')}</div>
      )}
    </Panel>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [open, setOpen] = useState(false);
  // delete failures surface here (the create-form `err` is hidden when the form is closed)
  const [listErr, setListErr] = useState<string | null>(null);
  const reload = () => api.templates().then(setTemplates).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  // new template form state
  const [name, setName] = useState('');
  const [role, setRole] = useState('worker');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [allowedTools, setAllowedTools] = useState('');
  const [budget, setBudget] = useState('3');
  const [err, setErr] = useState<string | null>(null);

  // export/import state
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const importFileRef = React.useRef<HTMLInputElement>(null);

  async function create() {
    if (!name.trim()) {
      setErr('name required');
      return;
    }
    try {
      await api.createTemplate({
        name,
        role,
        description,
        systemPrompt,
        model: 'claude-opus-4-8',
        fastMode: false,
        effort,
        allowedTools: allowedTools.trim() ? allowedTools.split(/[,\s]+/).filter(Boolean) : [],
        skills: [],
        permissionMode,
        budgetUsd: budget.trim() ? Number(budget) : null,
      });
      setOpen(false);
      setName('');
      setDescription('');
      setSystemPrompt('');
      setErr(null);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function handleExport() {
    try {
      const setup = await api.exportSetup();
      const blob = new Blob([JSON.stringify(setup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fleet-setup.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setImportMsg(`Export failed: ${e.message}`);
    }
  }

  async function handleImport(file: File) {
    try {
      const text = await file.text();
      const setup = JSON.parse(text);
      const result = await api.importSetup(setup);
      const counts = `${result.templates.created} templates created, ${result.templates.updated} updated; ${result.packs.created} packs created, ${result.packs.updated} updated`;
      const msg = result.errors.length > 0
        ? `Import completed with errors: ${counts}; ${result.errors.length} item(s) skipped`
        : `Import successful: ${counts}`;
      setImportMsg(msg);
      reload();
    } catch (e: any) {
      setImportMsg(`Import failed: ${e.message}`);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-5">
        <div>
          <Kicker>agent library</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Templates</h1>
          <p className="font-mono text-[11px] text-faint mt-1">Reusable agent profiles — instantiated as orchestrators, workers, and synthesizers in a campaign.</p>
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="ghost" onClick={handleExport} title="Export all templates, packs, and config">⇪ Export setup</Btn>
          <Btn variant="ghost" onClick={() => importFileRef.current?.click()} title="Import setup from JSON">⇩ Import</Btn>
          <input ref={importFileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleImport(f); }} />
          <Btn variant="amber" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : '＋ New Template'}</Btn>
        </div>
      </div>

      {open && (
        <Panel ticked className="p-5 mb-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Worker" /></Field>
            <Field label="role">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {['worker', 'orchestrator', 'synthesizer', 'reviewer'].map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
            <div className="col-span-2"><Field label="description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
            <div className="col-span-2"><Field label="system prompt" hint="appended via --append-system-prompt"><Textarea rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} /></Field></div>
            <Field label="effort"><Select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>{['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
            <Field label="permission mode"><Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}>{['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'].map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
            <Field label="allowed tools" hint="comma-sep"><Input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Read, Grep, Edit" /></Field>
            <Field label="budget USD"><Input type="number" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Btn variant="solid" onClick={create}>Create Template</Btn>
            {err && <span className="font-mono text-[11px] text-sig-failed" style={{ color: '#ff5d5d' }}>{err}</span>}
          </div>
        </Panel>
      )}

      {listErr && (
        <div className="font-mono text-[11px] mb-3 px-3 py-2 border border-sig-failed/30" style={{ color: '#ff5d5d' }}>
          {listErr}
        </div>
      )}

      {importMsg && (
        <div className="font-mono text-[11px] mb-3 px-3 py-2 border border-amber/30" style={{ color: '#ffb000' }}>
          {importMsg}
        </div>
      )}

      {templates.length === 0 ? (
        <Empty>No templates.</Empty>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              t={t}
              onDelete={() =>
                api.deleteTemplate(t.id).then(
                  () => {
                    setListErr(null);
                    reload();
                  },
                  (e: any) => {
                    // 404 = stale list (deleted elsewhere) — reloading IS the recovery
                    if (e?.status === 404) reload();
                    else setListErr(e?.message || 'failed to delete template');
                  },
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
