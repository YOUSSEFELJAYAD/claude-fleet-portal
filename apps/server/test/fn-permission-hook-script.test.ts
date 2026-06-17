/**
 * F-perm — fail-closed coverage for the OUTER enforcement layer: the spawned PreToolUse hook
 * `tools/fleet-permission-hook.mjs`. The store TTL (fn-permission-gate) is the inner layer; this
 * runs the real hook as a child process and asserts it prints DENY on every failure mode and only
 * ALLOWs on an explicit {decision:'allow'}. The spec names both layers as the fail-closed guarantee.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'fleet-permission-hook.mjs');
const PAYLOAD = JSON.stringify({ session_id: 'run-1', tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, tool_use_id: 'tu', cwd: '/tmp' });

/** Run the hook against a port, feed it a stdin payload, return the parsed permissionDecision. */
function runHook(port: number, payload = PAYLOAD): Promise<{ decision: string; reason: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      try {
        const j = JSON.parse(out.trim());
        resolve({ decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason });
      } catch (e) {
        reject(new Error(`hook stdout not parseable: ${JSON.stringify(out)} (${e})`));
      }
    });
    child.stdin.end(payload);
  });
}

let server: Server | null = null;
/** Start a stub /internal/permission server returning a fixed status+body; resolve with its port. */
async function stub(status: number, body: string): Promise<number> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as any).port;
}

afterEach(async () => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('fleet-permission-hook.mjs (fail-closed)', () => {
  it('ALLOWs only on an explicit {decision:"allow"}', async () => {
    const port = await stub(200, JSON.stringify({ decision: 'allow', reason: 'operator approve' }));
    expect(await runHook(port)).toMatchObject({ decision: 'allow' });
  });

  it('DENIES on {decision:"deny"}', async () => {
    const port = await stub(200, JSON.stringify({ decision: 'deny', reason: 'operator deny' }));
    expect(await runHook(port)).toMatchObject({ decision: 'deny' });
  });

  it('DENIES on any non-"allow" decision value (default-deny coercion)', async () => {
    const port = await stub(200, JSON.stringify({ decision: 'maybe' }));
    expect((await runHook(port)).decision).toBe('deny');
  });

  it('DENIES on a non-2xx response', async () => {
    const port = await stub(500, 'kaboom');
    expect((await runHook(port)).decision).toBe('deny');
  });

  it('DENIES when the response body is not valid JSON', async () => {
    const port = await stub(200, 'not json');
    expect((await runHook(port)).decision).toBe('deny');
  });

  it('DENIES when the control plane is unreachable (connection refused)', async () => {
    // Bind then immediately close to obtain a port that is (almost certainly) not listening.
    const port = await stub(200, '{}');
    server!.close();
    server = null;
    await new Promise((r) => setTimeout(r, 30));
    expect((await runHook(port)).decision).toBe('deny');
  });
});
