import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';

// Isolate the DB to a throwaway dir BEFORE any src module (→ config.js reads FLEET_DATA_DIR at
// module-load) is imported. Static imports above are env-agnostic; src is pulled in lazily.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-portbroker-'));

let workDir: string; // a throwaway dir that doubles as the "worktree" the broker runs in
let brokerValidate: typeof import('../src/portbroker.js').brokerValidate;

// ── server fixtures (written into workDir, run via `bash -lc node <file>`) ──────────
//
// HEALTHY: reads process.env.PORT, serves 200 "ok" on every path. Default health probe
// (GET http://127.0.0.1:$PORT/ < 500) and an explicit URL both pass against it.
const HEALTHY_SERVER = `
import http from 'node:http';
const port = Number(process.env.PORT);
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
srv.listen(port, '127.0.0.1', () => {
  // marker the regex-readiness path can match
  process.stdout.write('LISTENING on ' + port + '\\n');
});
`;

// NEVER-HEALTHY: a process that stays alive (so it must be KILLED) but never opens an HTTP server
// and never prints the readiness marker. Default health probe gets ECONNREFUSED forever → timeout.
// It does NOT trap SIGTERM, so the broker's group-SIGTERM kills it instantly.
const NEVER_HEALTHY_SERVER = `
// no http server, no marker — just keep the event loop alive forever.
setInterval(() => {}, 1000);
process.stdout.write('started but not serving\\n');
`;

/** Probe whether a TCP port is free by binding/closing a net.Server (mirrors the broker's check). */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'fleet-portbroker-work-'));
  writeFileSync(join(workDir, 'healthy.mjs'), HEALTHY_SERVER);
  writeFileSync(join(workDir, 'never.mjs'), NEVER_HEALTHY_SERVER);
  ({ brokerValidate } = await import('../src/portbroker.js'));
});

afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// A small dedicated range so we know exactly which port was used (and can re-bind it after).
const RANGE_START = 53_211;
const RANGE_END = 53_240;

describe('portbroker.brokerValidate', () => {
  it('waits for health, runs validation against the live port, then tears the server down (port freed)', async () => {
    // The validation command HITS the live server on $PORT and asserts a 200 — proving (a) the
    // broker waited until the server was actually serving, and (b) the validation ran against the
    // live, brokered port.
    const validationCommand = [
      'code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/")',
      '[ "$code" = "200" ]',
    ].join('\n');

    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      validationCommand,
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);

    // Teardown must have killed the server: EVERY port in the range is free again (the broker
    // awaits the child's exit before resolving, so this is not racy).
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('reports validation failure (server live but the check fails) and still tears down', async () => {
    // Server is healthy; the validation command exits nonzero → ok:false but the run completed,
    // distinguishing this from the readiness-timeout path below.
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      validationCommand: 'echo "boom" >&2; exit 7',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(7);
    expect(result.output).toContain('boom');

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('readiness TIMEOUT path: never-healthy server is killed and a failure is returned', async () => {
    // Tiny timeout → fast. The server never serves HTTP, so the default probe never succeeds and we
    // hit the readiness deadline; the broker must kill the (still-alive) server and return failure.
    const start = Date.now();
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node never.mjs',
      // If readiness were (wrongly) considered met, this would run and pass — it must NOT run.
      validationCommand: 'exit 0',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 800,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.output).toContain('never became healthy');
    // We bailed at the readiness deadline, not after the (skipped) validation.
    expect(elapsed).toBeLessThan(10_000);

    // The never-healthy server was alive; teardown must have killed it → range free again.
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('regex readiness path: matches stdout marker, sets the custom port env var', async () => {
    // No healthCheckUrl → with a regex set, readiness is driven by the stdout marker. The
    // validation command reads BOTH PORT and the custom var to prove both are injected.
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      healthCheckRegex: 'LISTENING on \\d+',
      portEnvVar: 'APP_PORT',
      validationCommand: '[ -n "$PORT" ] && [ "$PORT" = "$APP_PORT" ]',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('copies a .env into the worktree before spawn (server-readable config)', async () => {
    // Write a .env in a SOURCE dir; the broker copies it to <workDir>/.env. The validation command
    // reads it to confirm the copy happened before the server/validation ran.
    const envSrcDir = mkdtempSync(join(tmpdir(), 'fleet-portbroker-env-'));
    const envSrc = join(envSrcDir, 'fixture.env');
    writeFileSync(envSrc, 'BROKER_ENV_MARKER=copied-ok\n');

    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      copyEnvFrom: envSrc,
      validationCommand: 'grep -q "BROKER_ENV_MARKER=copied-ok" .env',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    rmSync(envSrcDir, { recursive: true, force: true });
    rmSync(join(workDir, '.env'), { force: true });
  }, 30_000);
});
