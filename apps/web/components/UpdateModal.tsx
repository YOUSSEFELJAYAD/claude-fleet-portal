'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { ReleaseStatus, SelfUpdateResult } from '@fleet/shared';
import { Panel, Kicker, Btn } from './ui';

/**
 * Update popup — shown by Shell when GitHub has a newer release AND the portal can
 * self-update (origin remote present). "Later" snoozes that specific version via
 * localStorage; the popup returns for the next one. After a successful update the
 * dialog asks the user to restart the app (start.sh rebuilds stale bundles itself).
 */
export const updateDismissKey = (tag: string) => `fleet-update-dismissed-${tag}`;

export function UpdateModal({ status, onClose }: { status: ReleaseStatus; onClose: () => void }) {
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<SelfUpdateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = status.latest!;

  function later() {
    try {
      localStorage.setItem(updateDismissKey(latest.tag), '1');
    } catch {
      /* private mode etc. — popup just reappears next load */
    }
    onClose();
  }

  async function update() {
    setUpdating(true);
    setErr(null);
    try {
      setResult(await api.selfUpdate());
    } catch (e: any) {
      setErr(e?.message || 'update failed');
    } finally {
      setUpdating(false);
    }
  }

  const done = result?.ok === true;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-16 px-4" style={{ background: 'rgba(4,5,7,0.78)' }}>
      <Panel ticked className="w-full max-w-[560px]">
        <div className="flex items-center justify-between px-5 py-4 border-b hairline">
          <div>
            <Kicker>{done ? 'update applied' : 'update available'}</Kicker>
            <div className="font-display text-[16px] text-ink tracking-wide mt-1">
              {done ? 'Restart to finish' : latest.name || latest.tag}
            </div>
          </div>
          <span className="font-mono text-[11px] text-faint">
            v{status.currentVersion} <span className="text-amber">→ {latest.tag}</span>
          </span>
        </div>

        <div className="p-5">
          {/* pre-update: what's new */}
          {!result && !err && (
            <>
              {latest.body && (
                <pre className="font-mono text-[11px] text-dim whitespace-pre-wrap border border-line2 px-3 py-2 overflow-auto" style={{ maxHeight: 180 }}>
                  {latest.body.slice(0, 600)}
                  {latest.body.length > 600 ? '\n…' : ''}
                </pre>
              )}
              <div className="font-mono text-[10.5px] text-faint mt-3">
                runs <span className="text-ink">git pull --ff-only</span> + <span className="text-ink">pnpm install</span> in the repo · refuses over uncommitted changes ·{' '}
                <Link href="/releases" onClick={onClose} className="underline hover:text-amber">full changelog →</Link>
              </div>
            </>
          )}

          {/* failure */}
          {err && <div className="font-mono text-[11.5px]" style={{ color: '#ff5d5d' }}>{err}</div>}
          {result && !result.ok && (
            <div className="space-y-2">
              {result.steps.map((st, i) => (
                <div key={i} className="font-mono text-[11px]" style={{ color: st.ok ? '#54e08a' : '#ff5d5d' }}>
                  {st.ok ? '✓' : '✕'} {st.step}
                </div>
              ))}
              <div className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>{result.note}</div>
            </div>
          )}

          {/* success → restart instruction */}
          {done && (
            <div className="space-y-3">
              {result!.steps.map((st, i) => (
                <div key={i} className="font-mono text-[11px]" style={{ color: '#54e08a' }}>✓ {st.step}</div>
              ))}
              <div className="font-mono text-[12px] text-ink border border-amber/40 bg-amber/5 px-3 py-2.5 leading-relaxed">
                <span className="text-amber">⟳ Restart the app to finish.</span>
                <br />
                Stop the portal (Ctrl-C) and run <span className="text-amber">./start.sh</span> — it rebuilds the
                web bundle automatically when needed. Dev mode (<span className="text-amber">pnpm dev</span>) reloads itself.
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t hairline flex items-center justify-end gap-2">
          {!done ? (
            <>
              <Btn onClick={later} disabled={updating}>Later</Btn>
              <Btn variant="solid" onClick={update} disabled={updating}>
                {updating ? 'updating…' : `⇪ Update to ${latest.tag}`}
              </Btn>
            </>
          ) : (
            <Btn variant="solid" onClick={later}>Got it — will restart</Btn>
          )}
        </div>
      </Panel>
    </div>
  );
}
