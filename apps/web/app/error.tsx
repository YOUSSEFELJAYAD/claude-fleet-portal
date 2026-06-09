'use client';
import { useEffect } from 'react';
import { Panel, Kicker, Btn } from '@/components/ui';

/**
 * A10 — route-level error boundary. Every page maps over arrays straight from SSE/REST
 * payloads, so one malformed payload that throws during render would white-screen the whole
 * console. This degrades a render throw to a recoverable in-shell panel with a working reset().
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[fleet] route render error:', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl py-20">
      <Panel className="p-6">
        <Kicker className="text-sig-failed">render fault</Kicker>
        <h1 className="font-display mt-2 text-lg text-ink">This panel hit an error</h1>
        <p className="text-dim mt-2 font-mono text-[12px] leading-relaxed">
          A view failed to render — usually a malformed payload from the control plane. The rest of the
          console is unaffected.
        </p>
        {error?.message && (
          <pre className="mt-3 max-h-40 overflow-auto border border-line2 bg-black/40 p-3 font-mono text-[11px] text-faint">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ''}
          </pre>
        )}
        <div className="mt-4 flex gap-2">
          <Btn variant="amber" onClick={() => reset()}>
            ⟳ Retry
          </Btn>
          <Btn onClick={() => (window.location.href = '/')}>← Back to Fleet</Btn>
        </div>
      </Panel>
    </div>
  );
}
