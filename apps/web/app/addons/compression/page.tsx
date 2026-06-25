'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { AddonInfo, AddonInstallResult, CompressionConfig, CompressionStats } from '@fleet/shared';
import { Panel, Kicker, Btn, Dot, Stat, Field, Input, Toggle, ErrorBanner } from '@/components/ui';
import { addonStatusColor } from '@/lib/status';

/** §22 — the Compression add-on's dedicated page (unlocked in the nav when enabled):
 *  Headroom proxy status, live savings, config, install helper, how-it-works. */

const SAVINGS_ROWS: Array<[string, string]> = [
  ['log output', '80–95%'],
  ['JSON / API results', '70–90%'],
  ['search results', '60–80%'],
  ['source code', '40–70%'],
  ['plain text', '30–50%'],
];

const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString());

/** The nav rail (Shell) listens for this — toggles must move the rail immediately. */
const notifyShell = () => window.dispatchEvent(new Event('fleet:addons'));

/** Number inputs are STRINGS until save — coercing on keystroke turns a cleared
 *  field into 0 and ships garbage to the server (review: port cannot be emptied). */
interface ConfigForm {
  port: string;
  dailyBudgetUsd: string;
  applyToNewRuns: boolean;
  optimize: boolean;
  cache: boolean;
  rateLimit: boolean;
}

const toForm = (c: CompressionConfig): ConfigForm => ({
  port: String(c.port),
  dailyBudgetUsd: c.dailyBudgetUsd == null ? '' : String(c.dailyBudgetUsd),
  applyToNewRuns: c.applyToNewRuns,
  optimize: c.optimize,
  cache: c.cache,
  rateLimit: c.rateLimit,
});

export default function CompressionPage() {
  const [addon, setAddon] = useState<AddonInfo | null>(null);
  const [stats, setStats] = useState<CompressionStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'toggle' | 'restart' | 'save' | 'install'
  const [installResult, setInstallResult] = useState<AddonInstallResult | null>(null);
  // form state seeds from the server config once, then the user owns it until save
  const [form, setForm] = useState<ConfigForm | null>(null);
  const seeded = useRef(false);
  // the poll is a setTimeout CHAIN — an in-flight fetch resolving after unmount must
  // not re-arm it (alive ref), and a transient error must not kill it (re-arm in catch)
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function rearm(ms: number) {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, ms);
  }

  function load() {
    api
      .addon('compression')
      .then((a) => {
        if (!alive.current) return;
        setAddon(a);
        setErr(null);
        if (!seeded.current) {
          setForm(toForm(a.config as unknown as CompressionConfig));
          seeded.current = true;
        }
        if (a.enabled) {
          api
            .compressionStats()
            .then((s) => alive.current && setStats(s))
            .catch(() => alive.current && setStats(null));
        } else {
          setStats(null);
        }
        rearm(a.status === 'starting' ? 1500 : 5000);
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

  /** Client-side mirror of the server validation — turns a bad form into a readable
   *  message instead of a generic 400. Returns null and sets err when invalid. */
  function formToConfig(): Record<string, unknown> | null {
    if (!form) return null;
    const port = Number(form.port);
    if (form.port.trim() === '' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      setErr('port must be an integer between 1024 and 65535');
      return null;
    }
    let dailyBudgetUsd: number | null = null;
    if (form.dailyBudgetUsd.trim() !== '') {
      dailyBudgetUsd = Number(form.dailyBudgetUsd);
      if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
        setErr('daily budget must be a positive number (or empty for uncapped)');
        return null;
      }
    }
    return {
      port,
      dailyBudgetUsd,
      applyToNewRuns: form.applyToNewRuns,
      optimize: form.optimize,
      cache: form.cache,
      rateLimit: form.rateLimit,
    };
  }

  async function act(kind: 'toggle' | 'restart' | 'save' | 'install') {
    if (!addon) return;
    setErr(null);
    let cfg: Record<string, unknown> | null = null;
    if (kind === 'save') {
      cfg = formToConfig();
      if (!cfg) return;
    }
    setBusy(kind);
    try {
      if (kind === 'toggle') setAddon(addon.enabled ? await api.disableAddon('compression') : await api.enableAddon('compression'));
      if (kind === 'restart') setAddon(await api.restartAddon('compression'));
      if (kind === 'save' && cfg) {
        const next = await api.setAddonConfig('compression', cfg);
        if (alive.current) {
          setAddon(next);
          setForm(toForm(next.config as unknown as CompressionConfig));
        }
      }
      if (kind === 'install') {
        const res = await api.installAddon('compression');
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
        <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-4">Compression</h1>
        <ErrorBanner className="mb-4" onRetry={load}>{err}</ErrorBanner>
      </div>
    );
  }
  if (!addon || !form) return <div className="font-mono text-faint text-[12px]">loading…</div>;

  const a = addon;
  const applied = a.config as unknown as CompressionConfig; // the SAVED config (the form may be mid-edit)
  const live = a.enabled && a.status === 'running';

  return (
    <div>
      {/* ── header ── */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <Kicker>add-on · built-in</Kicker>
          <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Compression</h1>
          <div className="font-mono text-[11px] text-faint mt-1">
            Headroom transparent proxy ·{' '}
            <a href={a.docsUrl ?? '#'} target="_blank" rel="noreferrer" className="underline hover:text-amber">
              headroom docs ↗
            </a>{' '}
            · <Link href="/addons" className="underline hover:text-amber">marketplace</Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {a.enabled && (
            <Btn onClick={() => act('restart')} disabled={busy != null}>
              {busy === 'restart' ? '…' : '↻ Restart'}
            </Btn>
          )}
          {a.installed || a.enabled ? (
            <Btn variant={a.enabled ? 'danger' : 'solid'} onClick={() => act('toggle')} disabled={busy != null}>
              {busy === 'toggle' ? '…' : a.enabled ? 'Disable' : '⏻ Enable'}
            </Btn>
          ) : null}
        </div>
      </div>

      {err && <ErrorBanner className="mb-4">{err}</ErrorBanner>}

      {/* ── status strip ── */}
      <Panel ticked className="p-4 mb-5">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-5">
          <Stat
            label="proxy"
            value={
              <span className="flex items-center gap-2">
                <Dot color={addonStatusColor(a.status)} live={a.status === 'running' || a.status === 'starting'} size={7} />
                {a.status}
              </span>
            }
            accent={addonStatusColor(a.status)}
          />
          <Stat label="endpoint" value={live ? `http://127.0.0.1:${applied.port}` : '—'} />
          <Stat label="requests" value={fmt(stats?.totalRequests ?? null)} />
          <Stat label="tokens saved" value={fmt(stats?.tokensSaved ?? null)} accent={stats?.tokensSaved ? '#54e08a' : undefined} />
          <Stat
            label="savings"
            value={stats?.savingsPercent != null ? `${stats.savingsPercent.toFixed(1)}%` : '—'}
            accent={stats?.savingsPercent ? '#54e08a' : undefined}
          />
          <Stat
            label="saved · usd"
            value={stats?.savedUsd != null ? `$${stats.savedUsd.toFixed(2)}` : '—'}
            accent={stats?.savedUsd ? '#54e08a' : undefined}
          />
        </div>
        {a.statusDetail && (
          <div className={`font-mono text-[10.5px] mt-3 pt-3 border-t hairline ${a.status === 'error' ? 'text-sig-failed' : 'text-dim'}`}>
            {a.statusDetail}
          </div>
        )}
        {live && (
          <div className="font-mono text-[10.5px] text-faint mt-3 pt-3 border-t hairline">
            {applied.applyToNewRuns
              ? 'new claude runs and compatible engine runs route through the proxy automatically — runs already live are untouched'
              : 'routing is OFF — the proxy runs, but new agents talk to provider APIs directly (enable “apply to new runs” below)'}
          </div>
        )}
      </Panel>

      {/* ── install helper (kept visible after an install so its outcome isn't lost) ── */}
      {(!a.installed || installResult) && (
        <Panel className="p-5 mb-5">
          <Kicker>setup · one time</Kicker>
          {!a.installed && (
            <>
              <div className="font-mono text-[12px] text-dim leading-relaxed mt-2">
                Compression is powered by <span className="text-ink">Headroom</span> (open source, Python 3.10+). Install its proxy
                once and the portal manages it from there — start, stop, health, restarts.
              </div>
              <div className="font-mono text-[11px] text-ink mt-3 px-3 py-2 border border-line2 bg-black/40 inline-block">
                <span className="text-amber">$</span> uv tool install --python 3.13 &quot;headroom-ai[proxy]&quot;
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Btn variant="solid" onClick={() => act('install')} disabled={busy != null}>
                  {busy === 'install' ? 'installing… (can take a minute)' : '⇩ Install for me'}
                </Btn>
                <span className="font-mono text-[10px] text-faint">tries uv → pipx → pip with Python 3.10–3.13</span>
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
        {/* ── configuration ── */}
        <Panel className="p-5">
          <Kicker>configuration</Kicker>
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="proxy port" hint="127.0.0.1 only">
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  min={1024}
                  max={65535}
                  placeholder="8787"
                />
              </Field>
              <Field label="daily budget · usd" hint="proxy-enforced · blank = uncapped">
                <Input
                  type="number"
                  step="0.5"
                  value={form.dailyBudgetUsd}
                  placeholder="uncapped"
                  onChange={(e) => setForm({ ...form, dailyBudgetUsd: e.target.value })}
                />
              </Field>
            </div>
            <div className="space-y-3 pt-1">
              <Toggle on={form.applyToNewRuns} onChange={(v) => setForm({ ...form, applyToNewRuns: v })} label="apply to new runs — route claude plus compatible codex/opencode runs through the proxy" />
              <Toggle on={form.optimize} onChange={(v) => setForm({ ...form, optimize: v })} label="token compression — the point of all this" />
              <Toggle on={form.cache} onChange={(v) => setForm({ ...form, cache: v })} label="semantic cache — reuse answers for near-identical requests" />
              <Toggle on={form.rateLimit} onChange={(v) => setForm({ ...form, rateLimit: v })} label="rate-limit smoothing — pace bursts instead of erroring" />
            </div>
            <div className="flex items-center gap-3 pt-2 border-t hairline">
              <Btn variant="solid" onClick={() => act('save')} disabled={busy != null}>
                {busy === 'save' ? 'saving…' : 'Save config'}
              </Btn>
              <span className="font-mono text-[10px] text-faint">{a.enabled ? 'saving restarts the proxy with the new flags' : 'applies when you enable the add-on'}</span>
            </div>
          </div>
        </Panel>

        {/* ── how it works ── */}
        <Panel className="p-5">
          <Kicker>how it works</Kicker>
          <div className="font-mono text-[11px] text-ink mt-3 px-3 py-2.5 border border-line2 bg-black/40 overflow-x-auto whitespace-nowrap">
            agent run <span className="text-faint">──▶</span> <span className="text-amber">headroom proxy :{applied.port}</span>{' '}
            <span className="text-faint">──▶</span> api.anthropic.com
          </div>
          <p className="font-mono text-[11.5px] text-dim leading-relaxed mt-3">
            The proxy compresses what agents send to the model — tool outputs, logs, search results, code —
            before it costs tokens. It keeps errors, anomalies and structure, drops redundancy, and stores every
            original: the model gets a <span className="text-ink">retrieve tool</span> to pull back full content
            on demand, so nothing is lost. Your prompts are never rewritten.
          </p>
          <div className="mt-4 border-t hairline pt-3">
            <Kicker>typical savings</Kicker>
            <div className="mt-2 space-y-1.5">
              {SAVINGS_ROWS.map(([what, pct]) => (
                <div key={what} className="flex items-center justify-between font-mono text-[11px]">
                  <span className="text-dim">{what}</span>
                  <span className="text-sig-completed tnum">{pct}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="font-mono text-[10.5px] text-faint mt-4 border-t hairline pt-3">
            powered by{' '}
            <a href="https://headroom-docs.vercel.app/docs" target="_blank" rel="noreferrer" className="underline hover:text-amber">
              Headroom
            </a>{' '}
            — open source, runs entirely on your machine; the proxy only ever listens on 127.0.0.1
          </div>
        </Panel>
      </div>
    </div>
  );
}
