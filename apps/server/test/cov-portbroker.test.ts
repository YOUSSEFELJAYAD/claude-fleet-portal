import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';

// Isolate the DB to a throwaway dir BEFORE any src module (config.js reads FLEET_DATA_DIR at
// module-load) is imported. The static imports above are env-agnostic; src is pulled in lazily.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-portbroker-'));

let workDir: string;
let brokerValidate: typeof import('../src/portbroker.js').brokerValidate;

// ── server fixtures (written into workDir, run via `bash -lc node <file>`) ──────────

// Healthy: serves 200 on every path AND prints a readiness marker to stdout.
const HEALTHY_SERVER = `
import http from 'node:http';
const port = Number(process.env.PORT);
const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
srv.listen(port, '127.0.0.1', () => { process.stdout.write('LISTENING on ' + port + '\\n'); });
`;

// Writes a readiness marker to STDERR (not stdout), then keeps the loop alive without serving HTTP.
// Drives the stderr 'data' accumulation branch and the regex-on-stderr readiness path.
const STDERR_MARKER_SERVER = `
process.stderr.write('STDERR_READY token\\n');
setInterval(() => {}, 1000);
`;

// Becomes ready (prints marker) then EXITS 0 almost immediately. By the time the broker tears down,
// the direct child is already dead → exercises the "child.exitCode != null" teardown branch.
const READY_THEN_EXIT_SERVER = `
process.stdout.write('LISTENING on ' + process.env.PORT + '\\n');
// give the broker's regex poll (150ms cadence) a beat to observe readiness, then exit.
setTimeout(() => process.exit(0), 60);
`;

// Traps SIGTERM (ignores it) and never serves HTTP. The broker's group-SIGTERM is swallowed, so
// teardown must escalate to SIGKILL after the 2.5s grace → exercises the escalation timer.
const SIGTERM_IGNORING_SERVER = `
process.on('SIGTERM', () => { /* swallow — refuse to die on SIGTERM */ });
process.stdout.write('STUBBORN up\\n');
setInterval(() => {}, 1000);
`;

/** Probe whether a TCP port is free by binding/closing a net.Server. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'fleet-cov-portbroker-work-'));
  writeFileSync(join(workDir, 'healthy.mjs'), HEALTHY_SERVER);
  writeFileSync(join(workDir, 'stderr.mjs'), STDERR_MARKER_SERVER);
  writeFileSync(join(workDir, 'readyexit.mjs'), READY_THEN_EXIT_SERVER);
  writeFileSync(join(workDir, 'stubborn.mjs'), SIGTERM_IGNORING_SERVER);
  ({ brokerValidate } = await import('../src/portbroker.js'));
});

afterAll(() => {
  for (const d of [workDir, process.env.FLEET_DATA_DIR!]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// A dedicated range distinct from portbroker.test.ts's range to avoid cross-file port contention.
const RANGE_START = 53_311;
const RANGE_END = 53_340;

describe('portbroker.brokerValidate — uncovered logic', () => {
  it('returns a no-free-port failure when every port in the range is occupied', async () => {
    // Occupy the SINGLE port in a 1-wide range by holding a wildcard bind. allocatePort's tryBind
    // requires BOTH wildcard AND 127.0.0.1 to be free, so the held wildcard bind triggers the
    // bindProbe error handler and allocatePort exhausts the loop → returns null → the no-free-port
    // branch. (No server is ever spawned because allocation fails first.)
    const occupiedPort = 53_399;
    const holder: NetServer = createNetServer();
    await new Promise<void>((res, rej) => {
      holder.once('error', rej);
      holder.listen(occupiedPort, res); // wildcard bind
    });

    try {
      const result = await brokerValidate(workDir, {
        serverStartCommand: 'node healthy.mjs',
        // This must NOT run — allocation fails before any spawn.
        validationCommand: 'exit 0',
        portRangeStart: occupiedPort,
        portRangeEnd: occupiedPort,
        readinessTimeoutMs: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe(1);
      expect(result.output).toContain('no free port in range');
      expect(result.output).toContain(`${occupiedPort}-${occupiedPort}`);
    } finally {
      await new Promise<void>((res) => holder.close(() => res()));
    }
  }, 20_000);

  it('returns a copy-env failure when copyEnvFrom points at a missing file', async () => {
    // copyFile rejects (ENOENT) → the broker catches it and returns a structured failure WITHOUT
    // ever spawning the server. We assert the message names the bad source path.
    const missing = join(workDir, 'does-not-exist.env');
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      copyEnvFrom: missing,
      // Must NOT run — the env copy fails first.
      validationCommand: 'exit 0',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output).toContain('failed to copy env from');
    expect(result.output).toContain(missing);

    // Nothing was spawned/reserved → the whole range is free.
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 20_000);

  it('regex readiness matches a STDERR marker (stderr accumulation path)', async () => {
    // The server prints its readiness token to stderr and never opens HTTP. With ONLY a regex
    // configured (no healthCheckUrl), the broker must NOT http-probe — readiness comes purely from
    // the accumulated stderr matching the regex. This drives the stderr 'data' handler.
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node stderr.mjs',
      healthCheckRegex: 'STDERR_READY token',
      validationCommand: '[ -n "$PORT" ]',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 8_000,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('treats a malformed healthCheckUrl as never-healthy (httpHealthOk throws → false) and times out', async () => {
    // A health URL that http.request() rejects synchronously (unsupported protocol) makes every
    // probe throw → caught → false, so readiness never flips and we hit the timeout/teardown path.
    // Healthy server is irrelevant here: the broker only ever consults the (broken) URL.
    const start = Date.now();
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      healthCheckUrl: 'gopher://127.0.0.1:$PORT/',
      validationCommand: 'exit 0', // must NOT run
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 600,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.output).toContain('never became healthy');
    expect(elapsed).toBeLessThan(10_000);

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('bails when the server exits BEFORE readiness (child-exit-during-poll path), freeing the port', async () => {
    // The server prints a marker we do NOT match on, then exits 0 promptly. With a regex that never
    // matches and no HTTP service, waitForReady observes the child's 'exit' during polling and bails
    // with the "server process exited before readiness" reason → ok:false, no validation run.
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node readyexit.mjs',
      healthCheckRegex: 'NEVER_MATCHES_THIS_TOKEN',
      validationCommand: 'exit 0', // must NOT run
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 8_000,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output).toContain('never became healthy');
    // The reason names the early exit (vs a timeout) — distinguishes this branch.
    expect(result.output).toContain('exited');

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('default HTTP probe success with a valid custom portEnvVar (inlined export) drives validation', async () => {
    // No regex and no healthCheckUrl → the broker uses the DEFAULT probe GET http://127.0.0.1:$PORT/.
    // The healthy server answers 200 (< 500) so httpHealthOk resolves true via its real response
    // callback. portEnvVar is a valid shell identifier, so the broker also inlines `export APP_PORT`
    // into the validation command; we assert PORT and APP_PORT are both set and equal.
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node healthy.mjs',
      portEnvVar: 'APP_PORT',
      validationCommand: '[ -n "$PORT" ] && [ "$PORT" = "$APP_PORT" ]',
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 8_000,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);

  it('escalates to SIGKILL when the server ignores SIGTERM (teardown escalation), still freeing the port', async () => {
    // Server traps SIGTERM and never serves HTTP → readiness times out → teardown sends group
    // SIGTERM (swallowed) and must escalate to SIGKILL after the 2.5s grace. The broker awaits the
    // child's exit before resolving, so when it returns the port is provably free again.
    const start = Date.now();
    const result = await brokerValidate(workDir, {
      serverStartCommand: 'node stubborn.mjs',
      validationCommand: 'exit 0', // must NOT run
      portRangeStart: RANGE_START,
      portRangeEnd: RANGE_END,
      readinessTimeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.output).toContain('never became healthy');
    // It survived SIGTERM for the full grace window, so teardown took > the 2.5s escalation grace.
    expect(elapsed).toBeGreaterThan(2_000);

    for (let p = RANGE_START; p <= RANGE_END; p++) {
      expect(await portIsFree(p)).toBe(true);
    }
  }, 30_000);
});
