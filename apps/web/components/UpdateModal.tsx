'use client';
import React from 'react';
import type { ReleaseStatus } from '@fleet/shared';
import { Panel, Kicker, Btn, Dot } from './ui';
import { MarkdownView } from './MarkdownView';

/**
 * Update popup — same design language as every other portal modal (Panel/Kicker/Btn,
 * amber-on-charcoal), and deliberately free of tech detail: the update itself runs in
 * the BACKGROUND (Shell owns the phase state, so closing the popup doesn't stop it).
 * When it finishes, the popup (or the sidebar chip) asks the user to restart the app.
 * Anything technical (step logs, git output) lives on /releases for the curious.
 */
export const updateDismissKey = (tag: string) => `fleet-update-dismissed-${tag}`;

export type UpdatePhase = 'idle' | 'running' | 'ready' | 'failed';

export function UpdateModal({
  status,
  phase,
  onStart,
  onClose,
}: {
  status: ReleaseStatus;
  phase: UpdatePhase;
  onStart: () => void;
  onClose: (snooze: boolean) => void;
}) {
  const latest = status.latest!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-16 px-4"
      style={{ background: 'rgba(4,5,7,0.78)' }}
      onClick={() => onClose(false)}
    >
      <Panel ticked className="w-full max-w-[520px]" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-4 border-b hairline">
            <div>
              <Kicker>
                {phase === 'ready' ? 'update ready' : phase === 'running' ? 'updating' : phase === 'failed' ? 'update' : 'update available'}
              </Kicker>
              <div className="font-display text-[16px] text-ink tracking-wide mt-1">
                {phase === 'ready' ? 'Restart to apply' : latest.name || latest.tag}
              </div>
            </div>
            <span className="font-mono text-[11px] text-faint">
              v{status.currentVersion} <span className="text-amber">→ {latest.tag.replace(/^v/i, 'v')}</span>
            </span>
          </div>

          <div className="p-5">
            {phase === 'idle' && (
              <>
                {latest.body && (
                  <div className="overflow-auto pr-1" style={{ maxHeight: 220 }}>
                    <MarkdownView source={latest.body} />
                  </div>
                )}
                <div className="font-mono text-[10.5px] text-faint mt-4">
                  {status.canSelfUpdate
                    ? 'the update happens in the background — you can keep working'
                    : 'opens the download page — your data stays where it is'}
                </div>
                {!status.canSelfUpdate && (
                  <div className="font-mono text-[10.5px] text-faint mt-1.5">
                    macOS: Gatekeeper warns once on the new download — System Settings → Privacy &amp; Security →
                    &quot;Open Anyway&quot;, or <span className="text-dim">xattr -cr</span> the app
                  </div>
                )}
              </>
            )}

            {phase === 'running' && (
              <div className="flex items-center gap-3 py-2">
                <Dot color="#ffb000" live size={8} />
                <div>
                  <div className="text-ink text-[13px]">Updating in the background…</div>
                  <div className="font-mono text-[10.5px] text-faint mt-1">you can close this and keep working — we&apos;ll let you know</div>
                </div>
              </div>
            )}

            {phase === 'ready' && (
              <div className="border border-amber/40 bg-amber/5 px-4 py-3 leading-relaxed">
                <div className="text-ink text-[13px]">
                  <span className="text-amber">⟳</span> {latest.tag} is ready — <span className="text-amber">restart the app</span> to start using it.
                </div>
                <div className="font-mono text-[10.5px] text-faint mt-1.5">quit the portal and open it again — that&apos;s it</div>
              </div>
            )}

            {phase === 'failed' && (
              <div className="leading-relaxed">
                <div className="text-ink text-[13px]">The update couldn&apos;t be applied automatically.</div>
                <div className="font-mono text-[10.5px] text-faint mt-1.5">
                  nothing was changed — see the{' '}
                  <a href="/releases" className="text-amber underline">Releases page</a> to update from there
                </div>
              </div>
            )}
          </div>

          <div className="px-5 py-4 border-t hairline flex items-center justify-end gap-2">
            {phase === 'idle' && (
              <>
                <Btn onClick={() => onClose(true)}>Later</Btn>
                {status.canSelfUpdate ? (
                  <Btn variant="solid" onClick={onStart}>⇪ Update now</Btn>
                ) : (
                  <Btn
                    variant="solid"
                    onClick={() => {
                      window.open(latest.url, '_blank', 'noopener');
                      onClose(true);
                    }}
                  >
                    ⇪ Get {latest.tag}
                  </Btn>
                )}
              </>
            )}
            {phase === 'running' && <Btn onClick={() => onClose(false)}>Continue working</Btn>}
            {(phase === 'ready' || phase === 'failed') && (
              <Btn variant="solid" onClick={() => onClose(true)}>Got it</Btn>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
