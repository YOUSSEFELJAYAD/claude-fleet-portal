'use client';
import React from 'react';
import { Field, Input, Select } from '@/components/ui';
import { AddonEnginePage } from '@/components/AddonEnginePage';

/** §24 — Codex Engine add-on page. Header: enable/disable, status strip (status dot, version, binary),
 *  install helper when missing, auth panel, config (default model + sandbox), how-it-works. */

interface ConfigForm {
  defaultModel: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

const toForm = (cfg: Record<string, unknown>): ConfigForm => ({
  defaultModel: typeof cfg.defaultModel === 'string' ? cfg.defaultModel : '',
  sandbox: (['read-only', 'workspace-write', 'danger-full-access'] as const).includes(cfg.sandbox as any)
    ? (cfg.sandbox as ConfigForm['sandbox'])
    : 'workspace-write',
});

const buildCfg = (form: ConfigForm): Record<string, unknown> => ({
  defaultModel: form.defaultModel.trim() || null,
  sandbox: form.sandbox,
});

export default function CodexPage() {
  return (
    <AddonEnginePage<ConfigForm>
      engineId="codex"
      title="Codex Engine"
      subtitle="OpenAI Codex CLI"
      docsLabel="codex docs ↗"
      binaryName="codex"
      liveMessage={<>engine is enabled — the Launch Modal shows a &ldquo;Codex&rdquo; engine option for new runs</>}
      installRequires={
        <>
          Requires the <span className="text-ink">Codex CLI</span> (OpenAI) on PATH. Install once and then enable the add-on.
        </>
      }
      installCmd="npm install -g @openai/codex"
      authCopy={
        <>
          Codex authenticates via <span className="text-ink">ChatGPT OAuth</span> or an API key:
        </>
      }
      authCmd="codex login"
      authEnvHint={
        <>
          or set <span className="text-ink">CODEX_API_KEY</span> in your environment
        </>
      }
      pipelineCmd="codex exec --json"
      howItWorksCopy={
        <>
          Once enabled, the <span className="text-ink">Launch Modal</span> shows a segmented engine control at the top.
          Select <span className="text-ink">Codex</span> to run the task on the Codex CLI instead of claude.
          The run timeline renders the same event types (messages, tool calls, reasoning).
        </>
      }
      limitations={[
        '· one-shot only — no interactive / resume / subagent tree',
        '· flat timeline — events streamed as assistant text + tool calls',
        '· stop works — kills the codex process group',
        '· budget not enforced — codex manages its own cost',
        '· input / permission decisions not supported',
      ]}
      toForm={toForm}
      buildCfg={buildCfg}
      renderConfig={(form, setForm) => (
        <>
          <Field label="default model" hint="blank = codex CLI default · e.g. gpt-5-codex">
            <Input
              value={form.defaultModel}
              onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
              placeholder="gpt-5-codex · blank = engine default"
            />
          </Field>
          <Field label="sandbox mode" hint="controls codex --sandbox flag">
            <Select value={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.value as ConfigForm['sandbox'] })}>
              <option value="workspace-write">workspace-write (default — read + write project files)</option>
              <option value="read-only">read-only (safest)</option>
              <option value="danger-full-access">danger-full-access (no restrictions)</option>
            </Select>
          </Field>
        </>
      )}
    />
  );
}
