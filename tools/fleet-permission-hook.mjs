#!/usr/bin/env node
/**
 * Fleet PreToolUse permission gate hook.
 *
 * claude spawns this (via the portal-injected `--settings` PreToolUse hook) before a gated
 * tool call. It reads the PreToolUse payload from stdin, blocks on the fleet control plane
 * for an operator decision, and prints the permission decision claude honors.
 *
 * FAIL-CLOSED: any error, non-2xx, or timeout → DENY. A security gate must never allow on
 * failure. argv[2] = control-plane port (default 4319).
 */
import { readFileSync } from 'node:fs';

const PORT = process.argv[2] || '4319';

function decide(permissionDecision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  /* malformed payload → still ask the fleet with an empty body, which will deny on no-session */
}

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/internal/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(880_000), // just under the server-side TTL (900s)
  });
  if (!res.ok) decide('deny', `fleet permission gate error (HTTP ${res.status})`);
  const j = await res.json();
  decide(j.decision === 'allow' ? 'allow' : 'deny', j.reason || 'operator decision');
} catch (e) {
  decide('deny', `fleet permission gate unreachable: ${e?.message || e}`);
}
