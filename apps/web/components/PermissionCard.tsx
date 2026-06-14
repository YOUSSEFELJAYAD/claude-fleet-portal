'use client';
import React, { useState } from 'react';
import { Btn, Dot, ErrorBanner } from './ui';
import { api } from '@/lib/api';

/** Inline permission approve/deny (spec §7) — works because the chat session is live;
 *  the decision is written to the live process stdin via POST …/input. */
function summarize(input: unknown, max = 120): string {
  if (input == null) return '';
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function PermissionCard({
  sessionId, requestId, toolName, input,
}: { sessionId: string; requestId: string; toolName: string; input: unknown }) {
  const [decision, setDecision] = useState<'allow' | 'deny' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const purple = '#b08cff';

  async function decide(d: 'allow' | 'deny') {
    setBusy(true); setErr(null);
    try {
      await api.chatInput(sessionId, { type: 'permission', requestId, decision: d });
      setDecision(d);
    } catch (e: any) {
      setErr(e?.message ?? 'failed to send decision');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border my-2 px-3 py-2.5" style={{ borderColor: `${purple}55`, background: `${purple}10` }}>
      <div className="flex items-center gap-2 mb-2">
        <Dot color={purple} live={decision == null} size={7} />
        <span className="font-display uppercase tracking-wider text-[10px]" style={{ color: purple }}>permission request</span>
        <span className="font-mono text-[11px] text-ink">{toolName}</span>
      </div>
      <div className="font-mono text-[11px] text-dim mb-2.5 break-words">{summarize(input)}</div>
      <div className="flex items-center gap-2">
        <Btn variant="amber" disabled={busy || decision != null} onClick={() => decide('allow')}>allow</Btn>
        <Btn variant="danger" disabled={busy || decision != null} onClick={() => decide('deny')}>deny</Btn>
        {decision && (
          <span className="font-display uppercase tracking-wider text-[10px] ml-1" style={{ color: decision === 'allow' ? '#54e08a' : '#ff5d5d' }}>
            {decision === 'allow' ? 'allowed' : 'denied'}
          </span>
        )}
      </div>
      {err && <ErrorBanner className="mt-2">{err}</ErrorBanner>}
    </div>
  );
}
