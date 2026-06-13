'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { AddonInfo, AddonInstallResult } from '@fleet/shared';
import { Panel, Kicker, Btn, Dot, Stat, Field, Input, Toggle, ErrorBanner } from '@/components/ui';

/** §24 — OpenCode Engine add-on page. Header: enable/disable, status strip (status dot, version, binary),
 *  install helper when missing, auth panel, config (default model + skipPermissions), how-it-works. */

const STATUS_COLOR: Record<AddonInfo['status'], string> = {
  running: '#54e08a',
  starting: '#ffb000',
  stopped: '#ffb000',
  error: '#ff5d5d',
  disabled: '#5b626d',
  'not-installed': '#e8704a',
};

const notifyShell = () => window.dispatchEvent(new Event('fleet:addons'));

interface ConfigForm {
  defaultModel: string;
  skipPermissions: boolean;
}

const toForm = (cfg: Record<string, unknown>): ConfigForm => ({
  defaultModel: typeof cfg.defaultModel === 'string' ? cfg.defaultModel : '',
  skipPermissions: !!cfg.skipPermissions,
});

export default function OpencodePage() {
  const [addon, setAddon] = useState<AddonInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<AddonInstallResult | null>(null);
  const [form, setForm] = useState<ConfigForm | null>(null);
  const seeded = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm(ms: number) {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, ms);
  }

  function load() {
    api.addon('opencode')
      .then((a) => {
        if (!alive.current) return;
        setAddon(a);
        setErr(null);
        if (!seeded.current) {
          setForm(toForm(a.config));
          seeded.current = true;
        }
        rearm(5000);
      })
      .catch((e: any) => {
        if (!alive.current) return;
        setErr(e?.message || 'failed to load the add-on');
        rearm(5000);
      });
  }

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(kind: 'toggle' | 'save' | 'install') {
    if (!addon) return;
    setErr(null);
    setBusy(kind);
    try {
      if (kind === 'toggle') {
        setAddon(addon.enabled ? await api.disableAddon('opencode') : await api.enableAddon('opencode'));
      }
      if (kind === 'save' && form) {
        const cfg: Record<string, unknown> = {
          defaultModel: form.defaultModel.trim() || null,
          skipPermissions: form.skipPermissions,
        };
        const next = await api.setAddonConfig('opencode', cfg);
        if (alive.current) {
          setAddon(next);
          setForm(toForm(next.config));
        }
      }
      if (kind === 'install') {
        const res = await api.installAddon('opencode');
        if (alive.current) setInstallResult(res);
      }
      notifyShell();
      load();
    } catch (e: any) {
      if (alive.current) setErr(e?.message || `${kind} failed`);
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  if (err && !addon) {
    return (
      <div>
        <Kicker>add-on</Kicker>
        <h1 className="font-display text-[22px] text-ink tracking-wide mt-1 mb-4">OpenCode Engine</h1>
        <div className="font-mono text-[12px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2">{err}</div>
      </div>
    );
  }
  if (!addon || !form) return <div className="font-mono text-faint text-[12px]">loading…</div>;

  const a = addon;
  const live = a.enabled && a.status === 'running';

  return (
    <div>
      {/* ── header ── */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <Kicker>add-on · built-in · engine</Kicker>
          <h1 className="font-display text-[22px] text-ink tracking-wide mt-1">OpenCode Engine</h1>
          <div className="font-mono text-[11px] text-faint mt-1">
            Open-source multi-provider CLI ·{' '}
            <a href={a.docsUrl ?? '#'} target="_blank" rel="noreferrer" className="underline hover:text-amber">
              opencode docs ↗
            </a>{' '}
            · <Link href="/addons" className="underline hover:text-amber">marketplace</Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(a.installed || a.enabled) && (
            <Btn variant={a.enabled ? 'danger' : 'solid'} onClick={() => act('toggle')} disabled={busy != null}>
              {busy === 'toggle' ? '…' : a.enabled ? 'Disable' : '⏻ Enable'}
            </Btn>
          )}
        </div>
      </div>

      {err && <ErrorBanner className="mb-4">{err}</ErrorBanner>}

      {/* ── status strip ── */}
      <Panel ticked className="p-4 mb-5">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
          <Stat
            label="engine"
            value={
              <span className="flex items-center gap-2">
                <Dot color={STATUS_COLOR[a.status]} live={a.status === 'running'} size={7} />
                {a.status}
              </span>
            }
            accent={STATUS_COLOR[a.status]}
          />
          <Stat label="binary" value={a.installed ? 'opencode' : 'not found'} accent={a.installed ? '#54e08a' : '#e8704a'} />
          <Stat label="version" value={a.version ?? '—'} />
        </div>
        {a.statusDetail && (
          <div className="font-mono text-[10.5px] mt-3 pt-3 border-t hairline text-dim">
            {a.statusDetail}
          </div>
        )}
        {live && (
          <div className="font-mono text-[10.5px] text-faint mt-3 pt-3 border-t hairline">
            engine is enabled — the Launch Modal shows an &ldquo;OpenCode&rdquo; engine option for new runs
          </div>
        )}
      </Panel>

      {/* ── install helper ── */}
      {(!a.installed || installResult) && (
        <Panel className="p-5 mb-5">
          <Kicker>setup · one time</Kicker>
          {!a.installed && (
            <>
              <div className="font-mono text-[12px] text-dim leading-relaxed mt-2">
                Requires the <span className="text-ink">opencode CLI</span> on PATH. Install once and then enable the add-on.
              </div>
              <div className="font-mono text-[11px] text-ink mt-3 px-3 py-2 border border-line2 bg-black/40 inline-block">
                <span className="text-amber">$</span> npm install -g opencode-ai@latest
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Btn variant="solid" onClick={() => act('install')} disabled={busy != null}>
                  {busy === 'install' ? 'installing… (can take a minute)' : '⇩ Install for me'}
                </Btn>
                <span className="font-mono text-[10px] text-faint">uses npm (Node 18+ required)</span>
              </div>
            </>
          )}
          {installResult && (
            <div className="mt-4 space-y-2">
              {installResult.steps.map((st, i) => (
                <div key={i}>
                  <div className={`font-mono text-[11px] ${st.ok ? 'text-sig-completed' : 'text-sig-failed'}`}>
                    {st.ok ? '✓' : '✕'} {st.step}
                  </div>
                  {st.output && (
                    <pre className="font-mono text-[10px] text-dim whitespace-pre-wrap mt-1 px-3 py-2 border border-line2 overflow-auto" style={{ maxHeight: 140 }}>
                      {st.output}
                    </pre>
                  )}
                </div>
              ))}
              <div className="font-mono text-[11px] text-dim">{installResult.note}</div>
            </div>
          )}
        </Panel>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        {/* ── auth + config ── */}
        <Panel className="p-5">
          <Kicker>auth &amp; configuration</Kicker>
          <div className="font-mono text-[11.5px] text-dim leading-relaxed mt-3">
            OpenCode uses your existing <span className="text-ink">provider credentials</span>. Run{' '}
            <span className="text-ink">opencode auth</span> to configure providers, or set environment variables:
          </div>
          <div className="font-mono text-[11px] text-ink mt-2 px-3 py-2 border border-line2 bg-black/40 inline-block">
            <span className="text-amber">$</span> opencode auth
          </div>
          <div className="font-mono text-[10.5px] text-faint mt-1">
            or set <span className="text-ink">ANTHROPIC_API_KEY</span> / <span className="text-ink">OPENAI_API_KEY</span> etc.
          </div>

          <div className="mt-5 space-y-4">
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
            <div className="flex items-center gap-3 pt-2 border-t hairline">
              <Btn variant="solid" onClick={() => act('save')} disabled={busy != null}>
                {busy === 'save' ? 'saving…' : 'Save config'}
              </Btn>
            </div>
          </div>
        </Panel>

        {/* ── how it works ── */}
        <Panel className="p-5">
          <Kicker>how it works</Kicker>
          <div className="font-mono text-[11px] text-ink mt-3 px-3 py-2.5 border border-line2 bg-black/40 overflow-x-auto whitespace-nowrap">
            launch → <span className="text-amber">opencode run --format json</span> → stdout JSONL → fleet timeline
          </div>
          <p className="font-mono text-[11.5px] text-dim leading-relaxed mt-3">
            Once enabled, the <span className="text-ink">Launch Modal</span> shows a segmented engine control at the top.
            Select <span className="text-ink">OpenCode</span> to run the task on the opencode CLI instead of claude.
            The run timeline renders the same event types. OpenCode supports multiple providers — Anthropic, OpenAI, and others.
          </p>
          <div className="mt-4 border-t hairline pt-3">
            <Kicker>experimental limitations</Kicker>
            <div className="mt-2 space-y-1.5 font-mono text-[11px] text-dim">
              <div>· one-shot only — no interactive / resume / subagent tree</div>
              <div>· flat timeline — events streamed as assistant text + tool calls</div>
              <div>· stop works — kills the opencode process group</div>
              <div>· budget not enforced — opencode manages its own cost</div>
              <div>· input / permission decisions not supported</div>
              <div>· model string uses provider/model format (e.g. anthropic/claude-sonnet-4-5)</div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
