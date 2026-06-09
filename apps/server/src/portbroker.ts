/**
 * Port-broker server validation (v2 §4 #5).
 *
 * Validate a worktree against a *live server*: allocate an ephemeral FREE port, inject it (PORT +
 * an optional custom var) into the child env, optionally copy a `.env`, start the project's server
 * detached as a process GROUP, poll readiness (HTTP health probe < 500 OR a stdout regex match),
 * then run the card's pure validation command against the live port — and, in a `finally`,
 * UNCONDITIONALLY tear the server down (SIGTERM the group → SIGKILL after 2.5s) and release the
 * reserved port. NEVER leaves a process or a port leaked.
 *
 * IMPORTANT (deviation from spec §4 #5, which named `killProcessGroup(pid,false)`): we do NOT call
 * `processManager.killProcessGroup` for teardown. That helper guards on `looksLikeClaudePid(pid)`
 * (processManager.ts:33) and no-ops unless the process command line looks like a claude run
 * (`claude` / `mock-claude` / `--output-format` / `--session-id`). An arbitrary project server
 * (`npm start`, a node http server, …) never matches, so `killProcessGroup` would silently leave it
 * alive → leak. So the broker OWNS its teardown: it holds the live ChildProcess handle and signals
 * the live process-group pid directly (the same primitive as `spawnClaude`'s `killGroup` closure +
 * the SIGTERM→SIGKILL-after-2.5s escalation, processManager.ts:64-82 / 218-229), and AWAITS the
 * child's `exit` before resolving so the freed port is provably re-bindable on return.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { copyFile } from 'node:fs/promises';
import { runValidation, type ValidationResult } from './validation.js';

// ── tunables ─────────────────────────────────────────────────────────────────
/** Default readiness budget if cfg.readinessTimeoutMs is unset. */
export const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
/** Default ephemeral port range to scan when cfg.portRange{Start,End} is unset. */
export const DEFAULT_PORT_RANGE_START = 49_152;
export const DEFAULT_PORT_RANGE_END = 65_535;
/** How often to poll the health check while waiting for readiness. */
const READINESS_POLL_MS = 150;
/** Grace after SIGTERM before escalating to SIGKILL on the server's process group. */
const KILL_GRACE_MS = 2_500;
/** Per-probe HTTP timeout for the health check. */
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/**
 * Reserved ports held across IN-FLIGHT brokered validations (process-local). Two concurrent
 * brokers (up to the project WIP limit — risk register #6) must never pick the same port between
 * "found free" and "child binds it". An entry is added at allocation and released in `finally`.
 */
const reservedPorts = new Set<number>();

export interface BrokerConfig {
  /** Command to start the server, run via `bash -lc <cmd>` (shell, like runValidation). REQUIRED. */
  serverStartCommand: string;
  /** Validation command to run against the live server (`bash -lc`), in the worktree dir. REQUIRED. */
  validationCommand: string;
  /** If set, readiness = HTTP GET this URL returns status < 500. May use the literal `$PORT`. */
  healthCheckUrl?: string;
  /** If set, readiness = server stdout/stderr matches this JS regex source. */
  healthCheckRegex?: string;
  /** Max time to wait for readiness before giving up and tearing down. */
  readinessTimeoutMs?: number;
  /** Inclusive port scan range. Defaults to the ephemeral range. */
  portRangeStart?: number;
  portRangeEnd?: number;
  /** Absolute path to a `.env` file to copy into `<worktreeDir>/.env` before spawn. */
  copyEnvFrom?: string;
  /** Optional extra env var to ALSO receive the allocated port (in addition to PORT). */
  portEnvVar?: string;
}

/**
 * Run a brokered, live-server validation against `worktreeDir`. Returns a ValidationResult-shaped
 * object: `ok` true only if the server became ready AND the validation command exited 0.
 * NEVER throws; ALWAYS tears the server down and releases the port before resolving.
 */
export async function brokerValidate(worktreeDir: string, cfg: BrokerConfig): Promise<ValidationResult> {
  const rangeStart = cfg.portRangeStart ?? DEFAULT_PORT_RANGE_START;
  const rangeEnd = cfg.portRangeEnd ?? DEFAULT_PORT_RANGE_END;
  const readinessTimeoutMs = cfg.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  let port: number | null = null;
  let child: ChildProcess | null = null;
  let captured = ''; // accumulated server stdout+stderr (for the regex health path + evidence)

  try {
    // 1) Allocate a FREE port (probe by binding a net.Server; skip ports another broker reserved).
    port = await allocatePort(rangeStart, rangeEnd);
    if (port == null) {
      return { ok: false, code: 1, output: `port-broker: no free port in range ${rangeStart}-${rangeEnd}` };
    }
    reservedPorts.add(port);

    // 2) Optionally copy a .env into the worktree before the server reads its config.
    if (cfg.copyEnvFrom) {
      try {
        await copyFile(cfg.copyEnvFrom, `${worktreeDir}/.env`);
      } catch (e: any) {
        return { ok: false, code: 1, output: `port-broker: failed to copy env from ${cfg.copyEnvFrom}: ${e?.message ?? e}` };
      }
    }

    // 3) Spawn the server DETACHED (own process group → group-kill on teardown). `bash -lc` matches
    //    runValidation's shell convention so a project can use `npm start`, a script, etc.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
    if (cfg.portEnvVar) childEnv[cfg.portEnvVar] = String(port);
    child = spawn('bash', ['-lc', cfg.serverStartCommand], {
      cwd: worktreeDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    const spawned = child;
    spawned.stdout?.setEncoding('utf8');
    spawned.stderr?.setEncoding('utf8');
    spawned.stdout?.on('data', (c: string) => {
      captured += c;
    });
    spawned.stderr?.on('data', (c: string) => {
      captured += c;
    });
    // NEVER-throws: an unhandled 'error' event (e.g. bash itself missing → ENOENT) would crash the
    // control plane. Capture it instead; the child then never becomes ready → waitForReady bails →
    // finally tears it down.
    spawned.on('error', (e: any) => {
      captured += `\n[spawn error] ${e?.message ?? e}`;
    });

    // 4) Poll readiness until ready or timeout. If the child dies before becoming ready, bail.
    const ready = await waitForReady(spawned, port, cfg, readinessTimeoutMs, () => captured);
    if (!ready.ok) {
      // Never became healthy (timeout) or the server exited early → fail (finally tears it down).
      return {
        ok: false,
        code: 1,
        output: tail(`port-broker: server never became healthy (${ready.reason})\n${captured}`),
      };
    }

    // 5) Server is live → run the pure validation command against it via the shared primitive.
    //    runValidation(worktreeDir, cmd) runs `bash -lc <cmd>` with NO env override, so it would
    //    NOT see the allocated PORT (we only injected PORT into the SERVER child's env). Inline an
    //    `export PORT=<n>` (+ the custom var) prefix into the command string so the validation shell
    //    can reach the live server on the brokered port. Inlining keeps it concurrency-safe — no
    //    mutation of the shared `process.env` that two parallel brokers would race on.
    const portStr = String(port);
    const exports = [`export PORT=${portStr}`];
    // Only inline a custom var if it's a valid shell identifier (defense-in-depth against an
    // unexpected config value injecting into the validation shell).
    if (cfg.portEnvVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.portEnvVar)) {
      exports.push(`export ${cfg.portEnvVar}=${portStr}`);
    }
    const effectiveCmd = `${exports.join('; ')}; ${cfg.validationCommand}`;
    const result = await runValidation(worktreeDir, effectiveCmd);
    return result;
  } catch (e: any) {
    return { ok: false, code: 1, output: `port-broker: ${e?.message ?? String(e)}` };
  } finally {
    // 6) UNCONDITIONAL teardown — runs on pass, fail, timeout, and any throw above. Kill the
    //    server's process group and AWAIT its exit so the freed port is re-bindable on return.
    if (child) await teardownServer(child);
    if (port != null) reservedPorts.delete(port);
  }
}

// ── port allocation ────────────────────────────────────────────────────────────

/**
 * Find a free TCP port in [start,end] by attempting to bind a net.Server on 127.0.0.1. Skips ports
 * another in-flight broker has reserved. Returns the port (the probe server is CLOSED before
 * returning, so the child can bind it) or null if none is free. Tries port 0 (OS-assigned) first as
 * a fast path when the range is the default ephemeral range.
 */
async function allocatePort(start: number, end: number): Promise<number | null> {
  const lo = Math.max(1, Math.min(start, end));
  const hi = Math.min(65_535, Math.max(start, end));
  for (let p = lo; p <= hi; p++) {
    if (reservedPorts.has(p)) continue;
    if (await tryBind(p)) return p;
  }
  return null;
}

/** Bind-probe a single port: resolves true if 127.0.0.1:p was free (server is closed before resolve). */
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => {
      // EADDRINUSE / EACCES / etc. → not usable.
      resolve(false);
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

// ── readiness polling ────────────────────────────────────────────────────────────

interface ReadyOutcome {
  ok: boolean;
  reason: string;
}

/**
 * Poll until the server is ready or the deadline passes. Readiness is:
 *   - if healthCheckRegex set: accumulated stdout/stderr matches it; OR
 *   - if healthCheckUrl set: GET it (with `$PORT` substituted) returns status < 500; ELSE
 *   - default: GET http://127.0.0.1:$PORT/ returns status < 500.
 * (regex and url may both be set — either satisfying wins.) Bails early if the child exits.
 */
async function waitForReady(
  child: ChildProcess,
  port: number,
  cfg: BrokerConfig,
  timeoutMs: number,
  getCaptured: () => string,
): Promise<ReadyOutcome> {
  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });

  const regex = cfg.healthCheckRegex ? new RegExp(cfg.healthCheckRegex) : null;
  const url = (cfg.healthCheckUrl ?? `http://127.0.0.1:$PORT/`).replace(/\$PORT/g, String(port));
  // When a regex is the ONLY configured signal, don't also HTTP-probe (a regex-readiness server may
  // not even speak HTTP). With no regex, the URL (explicit or default) is the signal.
  const useHttp = !cfg.healthCheckRegex || !!cfg.healthCheckUrl;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) return { ok: false, reason: 'server process exited before readiness' };
    if (regex && regex.test(getCaptured())) return { ok: true, reason: 'stdout regex matched' };
    if (useHttp && (await httpHealthOk(url))) return { ok: true, reason: 'health url < 500' };
    await delay(READINESS_POLL_MS);
  }
  // One last check at the deadline edge.
  if (!childExited && regex && regex.test(getCaptured())) return { ok: true, reason: 'stdout regex matched' };
  if (!childExited && useHttp && (await httpHealthOk(url))) return { ok: true, reason: 'health url < 500' };
  return { ok: false, reason: childExited ? 'server process exited' : `timeout after ${timeoutMs}ms` };
}

/** Resolve true iff an HTTP GET to `url` returns a status code < 500 within the probe timeout. */
function httpHealthOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let req: ReturnType<typeof httpRequest>;
    try {
      req = httpRequest(url, { method: 'GET', timeout: HEALTH_PROBE_TIMEOUT_MS }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain so the socket can close
        done(status > 0 && status < 500);
      });
    } catch {
      done(false);
      return;
    }
    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

// ── teardown ───────────────────────────────────────────────────────────────────

/**
 * Kill the server's whole process GROUP and AWAIT its exit. SIGTERM the group first; if it ignores
 * SIGTERM, escalate to SIGKILL after KILL_GRACE_MS. Resolves once the child has actually exited (or
 * was already dead) so the reserved port is provably free and re-bindable on return. NEVER throws.
 */
function teardownServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // Already dead (exitCode/signalCode set, no live pid)? nothing to do.
    if (child.exitCode != null || child.signalCode != null || child.pid == null) {
      resolve();
      return;
    }
    const pid = child.pid;
    let escalation: NodeJS.Timeout | null = null;

    const finish = () => {
      if (escalation) {
        clearTimeout(escalation);
        escalation = null;
      }
      resolve();
    };
    child.once('exit', finish);
    child.once('error', finish); // a spawn 'error' means it never ran → treat as gone

    // SIGTERM the GROUP (negative pid). Fall back to the single pid if the group send fails.
    signalGroup(pid, 'SIGTERM');
    // Escalate to SIGKILL on the group if it hasn't exited within the grace window.
    escalation = setTimeout(() => {
      signalGroup(pid, 'SIGKILL');
    }, KILL_GRACE_MS);
    escalation.unref();
  });
}

/** Send `sig` to the process GROUP of `pid` (negative pid); fall back to the lone pid. NEVER throws. */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  if (!pid || pid <= 1) return;
  try {
    process.kill(-pid, sig); // negative → whole group (child was spawned detached)
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already dead */
    }
  }
}

// ── misc ─────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

/** Tail-cap evidence the same way validation.ts does, so brokered output threads into fix prompts. */
function tail(s: string): string {
  const CAP = 16 * 1024;
  const t = s.trim();
  return t.length > CAP ? t.slice(-CAP) : t;
}
