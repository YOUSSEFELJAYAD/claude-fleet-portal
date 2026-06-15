'use client';
import React, { useState } from 'react';
import { Btn, Dot, ErrorBanner } from './ui';
import { api } from '@/lib/api';

/** Inline permission approve/deny (spec §7) — works because the chat session is live;
 *  the decision is delivered via the dedicated POST …/permission route (fix 06), which the
 *  server maps to registry.decidePermission ('allow'→'approve', 'deny'→'deny'). */
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

  async function decide(d: 'allow' | 'deny') {
    setBusy(true); setErr(null);
    try {
      await api.chatPermission(sessionId, requestId, d);
      setDecision(d);
    } catch (e: any) {
      setErr(e?.message ?? 'failed to send decision');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-sig-awaiting/40 bg-sig-awaiting/8 my-2 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <Dot color="#b08cff" live={decision == null} size={7} />
        <span className="font-display uppercase tracking-wider text-[10px] text-sig-awaiting">permission request</span>
        <span className="font-mono text-[11px] text-ink">{toolName}</span>
      </div>
      <div className="font-mono text-[11px] text-dim mb-2.5 break-words">{summarize(input)}</div>
      <div className="flex items-center gap-2">
        <Btn variant="amber" disabled={busy || decision != null} onClick={() => decide('allow')}>allow</Btn>
        <Btn variant="danger" disabled={busy || decision != null} onClick={() => decide('deny')}>deny</Btn>
        {decision && (
          <span className={`font-display uppercase tracking-wider text-[10px] ml-1 ${decision === 'allow' ? 'text-sig-completed' : 'text-sig-failed'}`}>
            {decision === 'allow' ? 'allowed' : 'denied'}
          </span>
        )}
      </div>
      {err && <ErrorBanner className="mt-2">{err}</ErrorBanner>}
    </div>
  );
}
