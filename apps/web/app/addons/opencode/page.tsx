'use client';
import React from 'react';
import { Field, Input, Toggle } from '@/components/ui';
import { AddonEnginePage } from '@/components/AddonEnginePage';

/** §24 — OpenCode Engine add-on page. Header: enable/disable, status strip (status dot, version, binary),
 *  install helper when missing, auth panel, config (default model + skipPermissions), how-it-works. */

interface ConfigForm {
  defaultModel: string;
  skipPermissions: boolean;
}

const toForm = (cfg: Record<string, unknown>): ConfigForm => ({
  defaultModel: typeof cfg.defaultModel === 'string' ? cfg.defaultModel : '',
  skipPermissions: !!cfg.skipPermissions,
});

const buildCfg = (form: ConfigForm): Record<string, unknown> => ({
  defaultModel: form.defaultModel.trim() || null,
  skipPermissions: form.skipPermissions,
});

export default function OpencodePage() {
  return (
    <AddonEnginePage<ConfigForm>
      engineId="opencode"
      title="OpenCode Engine"
      subtitle="Open-source multi-provider CLI"
      docsLabel="opencode docs ↗"
      binaryName="opencode"
      liveMessage={<>engine is enabled — the Launch Modal shows an &ldquo;OpenCode&rdquo; engine option for new runs</>}
      installRequires={
        <>
          Requires the <span className="text-ink">opencode CLI</span> on PATH. Install once and then enable the add-on.
        </>
      }
      installCmd="npm install -g opencode-ai@latest"
      authCopy={
        <>
          OpenCode uses your existing <span className="text-ink">provider credentials</span>. Run{' '}
          <span className="text-ink">opencode auth</span> to configure providers, or set environment variables:
        </>
      }
      authCmd="opencode auth"
      authEnvHint={
        <>
          or set <span className="text-ink">ANTHROPIC_API_KEY</span> / <span className="text-ink">OPENAI_API_KEY</span> etc.
        </>
      }
      pipelineCmd="opencode run --format json"
      howItWorksCopy={
        <>
          Once enabled, the <span className="text-ink">Launch Modal</span> shows a segmented engine control at the top.
          Select <span className="text-ink">OpenCode</span> to run the task on the opencode CLI instead of claude.
          The run timeline renders the same event types. OpenCode supports multiple providers — Anthropic, OpenAI, and others.
        </>
      }
      limitations={[
        '· one-shot only — no interactive / resume / subagent tree',
        '· flat timeline — events streamed as assistant text + tool calls',
        '· stop works — kills the opencode process group',
        '· budget not enforced — opencode manages its own cost',
        '· input / permission decisions not supported',
        '· model string uses provider/model format (e.g. anthropic/claude-sonnet-4-5)',
      ]}
      toForm={toForm}
      buildCfg={buildCfg}
      renderConfig={(form, setForm) => (
        <>
          <Field label="default model" hint="blank = opencode default · e.g. anthropic/claude-sonnet-4-5">
            <Input
              value={form.defaultModel}
              onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
              placeholder="anthropic/claude-sonnet-4-5 · blank = engine default"
            />
          </Field>
          <div className="pt-1">
            <Toggle
              on={form.skipPermissions}
              onChange={(v) => setForm({ ...form, skipPermissions: v })}
              label="dangerously skip permissions — auto-approve all tool calls (--dangerously-skip-permissions)"
            />
            {form.skipPermissions ? (
              <div className="font-mono text-[10.5px] mt-1 text-sig-failed">
                warning: this disables opencode permission checks entirely
              </div>
            ) : (
              <div className="font-mono text-[10.5px] mt-1 text-faint">
                off = headless opencode AUTO-REJECTS permission asks — runs needing protected
                tools will degrade silently unless your opencode permission config allows them
              </div>
            )}
          </div>
        </>
      )}
    />
  );
}
