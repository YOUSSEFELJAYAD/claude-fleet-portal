'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiError } from '@/lib/api';
import type { AddonInfo } from '@fleet/shared';
import { Panel, Kicker, Btn, Dot, ErrorBanner } from '@/components/ui';

/** §22 — Add-on Marketplace: optional capabilities toggled at runtime. Enabling an
 *  add-on unlocks its dedicated page (it appears in the nav rail under Add-ons). */

const STATUS_COLOR: Record<AddonInfo['status'], string> = {
  running: '#54e08a',
  starting: '#ffb000',
  stopped: '#ffb000',
  error: '#ff5d5d',
  disabled: '#5b626d',
  'not-installed': '#e8704a',
};

const STATUS_LABEL: Record<AddonInfo['status'], string> = {
  running: 'running',
  starting: 'starting…',
  stopped: 'stopped',
  error: 'error',
  disabled: 'off',
  'not-installed': 'not installed',
};

/** The nav rail (Shell) listens for this — toggles must move the rail immediately. */
const notifyShell = () => window.dispatchEvent(new Event('fleet:addons'));

export default function AddonsPage() {
  const router = useRouter();
  const [addons, setAddons] = useState<AddonInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // addon id with an in-flight toggle
  const [err, setErr] = useState<string | null>(null);
  // the poll is a setTimeout CHAIN — an in-flight fetch resolving after unmount must
  // not re-arm it (alive ref), and an error must not kill the watch (re-arm in catch)
  const alive = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function load() {
    api
      .addons()
      .then((list) => {
        if (!alive.current) return;
        setAddons(list);
        setErr(null);
        if (pollRef.current) clearTimeout(pollRef.current);
        if (list.some((a) => a.status === 'starting')) pollRef.current = setTimeout(load, 1500);
      })
      .catch((e: any) => {
        if (!alive.current) return;
        setErr(e?.message || 'failed to load add-ons');
        if (pollRef.current) clearTimeout(pollRef.current);
        pollRef.current = setTimeout(load, 5000);
      });
  }

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle(a: AddonInfo) {
    setBusy(a.id);
    setErr(null);
    try {
      const next = a.enabled ? await api.disableAddon(a.id) : await api.enableAddon(a.id);
      if (!alive.current) return;
      setAddons((list) => (list ?? []).map((x) => (x.id === next.id ? next : x)));
      notifyShell();
      load();
    } catch (e: any) {
      if (!alive.current) return;
      const ae = e as ApiError;
      setErr(
        ae.code === 'not-installed'
          ? `${a.name} needs its dependency installed first — open the add-on page to install it.`
          : ae.message || 'toggle failed',
      );
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <Kicker>settings</Kicker>
        <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Add-on Marketplace</h1>
        <div className="font-mono text-[11.5px] text-faint mt-1.5">
          optional capabilities for the whole fleet — enable one and its page appears in the rail
        </div>
      </div>

      {err && <ErrorBanner className="mb-4">{err}</ErrorBanner>}

      {!addons ? (
        <div className="font-mono text-faint text-[12px]">loading add-ons…</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {addons.map((a) => (
            <Panel key={a.id} ticked className="p-5 flex flex-col">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <span className="text-amber text-[15px]">◍</span>
                  <span className="font-display text-[15px] text-ink tracking-wide">{a.name}</span>
                  {a.kind === 'builtin' && (
                    <span className="font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 border text-dim border-line">built-in</span>
                  )}
                </div>
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider" style={{ color: STATUS_COLOR[a.status] }}>
                  <Dot color={STATUS_COLOR[a.status]} live={a.status === 'running' || a.status === 'starting'} size={6} />
                  {STATUS_LABEL[a.status]}
                </span>
              </div>

              <div className="font-mono text-[11.5px] text-amber mt-3">{a.tagline}</div>
              <p className="font-mono text-[11.5px] text-dim leading-relaxed mt-2 flex-1">{a.description}</p>

              <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t hairline flex-wrap">
                <div className="font-mono text-[10px] text-faint">
                  {a.version ? `v${a.version}` : a.installed ? 'installed' : 'dependency not installed'}
                  {a.docsUrl && (
                    <>
                      {' · '}
                      <a href={a.docsUrl} target="_blank" rel="noreferrer" className="underline hover:text-amber">
                        docs ↗
                      </a>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {a.page && (
                    <Btn onClick={() => router.push(a.page!)}>{a.enabled ? '⚙ Configure' : 'Details'}</Btn>
                  )}
                  {a.installed || a.enabled ? (
                    <Btn variant={a.enabled ? 'ghost' : 'solid'} onClick={() => toggle(a)} disabled={busy === a.id}>
                      {busy === a.id ? '…' : a.enabled ? 'Disable' : '⏻ Enable'}
                    </Btn>
                  ) : (
                    a.page && (
                      <Btn variant="solid" onClick={() => router.push(a.page!)}>
                        ⇩ Install
                      </Btn>
                    )
                  )}
                </div>
              </div>
            </Panel>
          ))}

          {/* the marketplace is open — more add-ons ship with portal releases */}
          <Panel className="p-5 flex flex-col items-start justify-center border-dashed">
            <div className="flex items-center gap-2.5">
              <span className="text-faint text-[15px]">＋</span>
              <span className="font-display text-[15px] text-dim tracking-wide">More add-ons</span>
            </div>
            <p className="font-mono text-[11.5px] text-faint leading-relaxed mt-2">
              The marketplace is open — new add-ons land here with portal updates, and the add-on API is
              part of the open-source codebase. Have an idea (observability, notifications, routing)?
            </p>
            <a
              href="https://github.com/YOUSSEFELJAYAD/claude-fleet-portal"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-amber underline mt-3"
            >
              contribute on GitHub ↗
            </a>
          </Panel>
        </div>
      )}
    </div>
  );
}
