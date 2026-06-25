'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { AddonInfo, AddonInstallResult } from '@fleet/shared';
import { Panel, Kicker, Btn, Dot, Stat, ErrorBanner } from '@/components/ui';
import { addonStatusColor } from '@/lib/status';

/** §24 — Shared engine add-on shell (codex / opencode). Header: enable/disable, status strip
 *  (status dot, version, binary), install helper when missing, auth panel, config, how-it-works.
 *  The engine-specific config form is supplied via toForm/buildCfg + the renderConfig render-prop. */

const notifyShell = () => window.dispatchEvent(new Event('fleet:addons'));

interface AddonEnginePageProps<F> {
  engineId: string;
  title: string;
  /** subtitle copy shown before the docs link, e.g. 'OpenAI Codex CLI' */
  subtitle: React.ReactNode;
  /** docs link label, e.g. 'codex docs ↗' */
  docsLabel: string;
  /** binary name shown in the status strip when installed, e.g. 'codex' */
  binaryName: string;
  /** copy shown under the status strip when the engine is live */
  liveMessage: React.ReactNode;
  /** install helper "Requires …" copy */
  installRequires: React.ReactNode;
  /** install shell command, e.g. 'npm install -g @openai/codex' */
  installCmd: string;
  /** auth panel intro copy */
  authCopy: React.ReactNode;
  /** auth shell command, e.g. 'codex login' */
  authCmd: string;
  /** auth env-var hint shown under the command box */
  authEnvHint: React.ReactNode;
  /** the varying command in the how-it-works pipeline, e.g. 'codex exec --json' */
  pipelineCmd: string;
  /** how-it-works descriptive paragraph */
  howItWorksCopy: React.ReactNode;
  /** experimental limitations list lines */
  limitations: string[];
  toForm: (cfg: Record<string, unknown>) => F;
  buildCfg: (form: F) => Record<string, unknown>;
  renderConfig: (form: F, setForm: (next: F) => void) => React.ReactNode;
}

export function AddonEnginePage<F>({
  engineId,
  title,
  subtitle,
  docsLabel,
  binaryName,
  liveMessage,
  installRequires,
  installCmd,
  authCopy,
  authCmd,
  authEnvHint,
  pipelineCmd,
  howItWorksCopy,
  limitations,
  toForm,
  buildCfg,
  renderConfig,
}: AddonEnginePageProps<F>) {
  const [addon, setAddon] = useState<AddonInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<AddonInstallResult | null>(null);
  const [form, setForm] = useState<F | null>(null);
  const seeded = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm(ms: number) {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, ms);
  }

  function load() {
    api.addon(engineId)
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
        setAddon(addon.enabled ? await api.disableAddon(engineId) : await api.enableAddon(engineId));
      }
      if (kind === 'save' && form) {
        const next = await api.setAddonConfig(engineId, buildCfg(form));
        if (alive.current) {
          setAddon(next);
          setForm(toForm(next.config));
        }
      }
      if (kind === 'install') {
        const res = await api.installAddon(engineId);
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
        <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-4">{title}</h1>
        <ErrorBanner className="mb-4" onRetry={load}>{err}</ErrorBanner>
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
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">{title}</h1>
          <div className="font-mono text-[11px] text-faint mt-1">
            {subtitle} ·{' '}
            <a href={a.docsUrl ?? '#'} target="_blank" rel="noreferrer" className="underline hover:text-amber">
              {docsLabel}
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
                <Dot color={addonStatusColor(a.status)} live={a.status === 'running'} size={7} />
                {a.status}
              </span>
            }
            accent={addonStatusColor(a.status)}
          />
          <Stat label="binary" value={a.installed ? binaryName : 'not found'} accent={a.installed ? '#54e08a' : '#e8704a'} />
          <Stat label="version" value={a.version ?? '—'} />
        </div>
        {a.statusDetail && (
          <div className="font-mono text-[10.5px] mt-3 pt-3 border-t hairline text-dim">
            {a.statusDetail}
          </div>
        )}
        {live && (
          <div className="font-mono text-[10.5px] text-faint mt-3 pt-3 border-t hairline">
            {liveMessage}
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
                {installRequires}
              </div>
              <div className="font-mono text-[11px] text-ink mt-3 px-3 py-2 border border-line2 bg-black/40 inline-block">
                <span className="text-amber">$</span> {installCmd}
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
            {authCopy}
          </div>
          <div className="font-mono text-[11px] text-ink mt-2 px-3 py-2 border border-line2 bg-black/40 inline-block">
            <span className="text-amber">$</span> {authCmd}
          </div>
          <div className="font-mono text-[10.5px] text-faint mt-1">
            {authEnvHint}
          </div>

          <div className="mt-5 space-y-4">
            {renderConfig(form, setForm)}
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
            launch → <span className="text-amber">{pipelineCmd}</span> → stdout JSONL → fleet timeline
          </div>
          <p className="font-mono text-[11.5px] text-dim leading-relaxed mt-3">
            {howItWorksCopy}
          </p>
          <div className="mt-4 border-t hairline pt-3">
            <Kicker>experimental limitations</Kicker>
            <div className="mt-2 space-y-1.5 font-mono text-[11px] text-dim">
              {limitations.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
