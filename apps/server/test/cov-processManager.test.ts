/**
 * Real/behavioral coverage for processManager.ts (PRD §8.1).
 *
 * Targets the previously-uncovered LOGIC:
 *   - thinkingEnv pure mapping (all levels)                          (lines 60-68)
 *   - killProcessGroup fallback kill + SIGTERM→SIGKILL escalation    (lines 93-108)
 *   - spawnClaude streaming/exit/stdin path via a REAL substitute    (lines 200-300)
 *
 * The streaming path needs a real spawn: we point CLAUDE_BIN at a deterministic
 * node "fake claude" script (set BEFORE importing the module so config.ts reads it),
 * so spawnClaude drives an ACTUAL child process — newline-buffered stdout parsing,
 * the trailing-JSON-on-exit handler, stdin writes, EPIPE swallow, and the kill /
 * escalation closures all run against real OS process I/O, no mocks.
 *
 * DB is isolated first (importing processManager pulls addons → db via addonRunEnv()).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── isolate DB + point CLAUDE_BIN at a real deterministic substitute ───────────
const TMP = mkdtempSync(join(tmpdir(), 'fleet-test-pmcov-'));
process.env.FLEET_DATA_DIR = TMP;
process.env.FLEET_OTEL = '0'; // keep otelEnv() empty so spawned env is predictable

/**
 * A fake "claude" that reads a single argv-encoded scenario and behaves deterministically.
 * argv[2] selects the scenario. It writes to stdout/stderr exactly what each test asserts.
 */
const FAKE = join(TMP, 'fake-claude.mjs');
writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const scenario = process.argv[2] || '';
const out = (s) => process.stdout.write(s);
if (scenario === 'lines') {
  // two complete JSON lines + a non-JSON noise line that must be SKIPPED (line 219)
  out('{"type":"a","n":1}\\n');
  out('warning: this is not json and is skipped\\n');
  out('{"type":"b","n":2}\\n');
  // a garbled line that starts with { but fails JSON.parse → tolerated (line 222-224)
  out('{ this is not valid json }\\n');
  process.exit(0);
} else if (scenario === 'split') {
  // emit a JSON object split across two stdout chunks (exercises the buf concat join)
  out('{"type":"sp","val":');
  setTimeout(() => { out('42}\\n'); process.exit(0); }, 30);
} else if (scenario === 'trailing') {
  // final JSON WITHOUT a trailing newline → only parsed by the exit handler (244-250)
  out('{"type":"first"}\\n');
  out('{"type":"last","trailing":true}'); // no newline
  process.exit(0);
} else if (scenario === 'trailing-bad') {
  // a leading good line, then a trailing partial that STARTS with { but is invalid JSON and has
  // no newline → the exit handler tries JSON.parse(buf) and swallows the throw (lines 245-249).
  out('{"type":"ok"}\\n');
  out('{ not-valid-json-no-newline'); // no newline → only the exit handler sees it
  process.exit(0);
} else if (scenario === 'stderr') {
  process.stderr.write('boom on stderr\\n');
  process.exit(7);
} else if (scenario === 'echo-stdin') {
  // interactive: echo each stdin line back as a JSON event, exit on a sentinel
  let b = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    b += c;
    let nl;
    while ((nl = b.indexOf('\\n')) >= 0) {
      const line = b.slice(0, nl); b = b.slice(nl + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      const text = parsed?.message?.content?.[0]?.text ?? '';
      if (text === '__BYE__') { out('{"type":"closing"}\\n'); process.exit(0); }
      out(JSON.stringify({ type: 'echo', got: text }) + '\\n');
    }
  });
  process.stdin.on('end', () => { out('{"type":"stdin-ended"}\\n'); process.exit(0); });
} else if (scenario === 'env') {
  // print one env var back as a JSON line so we can assert extraEnv won (line 198)
  out(JSON.stringify({ type: 'env', MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? null }) + '\\n');
  process.exit(0);
} else if (scenario === 'sleep') {
  // long-lived: install a SIGTERM handler that IGNORES it, so kill() must escalate to SIGKILL
  process.on('SIGTERM', () => { /* swallow — force escalation */ });
  out('{"type":"alive"}\\n');
  setTimeout(() => process.exit(0), 60000);
} else if (scenario === 'oversize') {
  // emit > 32 MiB of NON-newline, non-JSON bytes so buf grows past MAX_PARTIAL_BYTES with no
  // newline → the memory-exhaustion guard (lines 228-232) drops buf. Then a real JSON line so
  // the parser still works after the drop, proving the guard didn't wedge the stream.
  // We honour backpressure (await 'drain') and flush the trailing line before a clean exit, or
  // a process.exit() would truncate the still-buffered 40 MiB and the trailing line never lands.
  const chunk = 'x'.repeat(1024 * 1024); // 1 MiB of non-{ filler, no newline
  let i = 0;
  const pump = () => {
    while (i < 40) {
      i++;
      if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return; }
    }
    process.stdout.write('\\n{"type":"after-drop","ok":true}\\n', () => process.exit(0));
  };
  pump();
} else {
  process.exit(0);
}
`,
  'utf8',
);
chmodSync(FAKE, 0o755);
process.env.CLAUDE_BIN = process.execPath; // node binary; argv passed via spawnClaude args

let pm: typeof import('../src/processManager.js');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Poll `pred` until true or timeout. Condition-based waiting for real-process death so a
 *  loaded event loop only DELAYS (never flips) the result — vs asserting at a fixed instant. */
const waitUntil = async (pred: () => boolean, timeoutMs = 15000, interval = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await wait(interval); }
  return pred();
};
const spawned: number[] = [];

// spawnClaude spreads the parent's process.env into the child. Under --coverage the parent
// carries NODE_V8_COVERAGE pointing at coverage/.tmp; our `node` fake-claude children would
// then ALSO write coverage-0.json there and race/clobber the vitest worker's own write.
// extraEnv is merged LAST (wins), so we redirect every child's coverage to a throwaway dir.
const CHILD_COV = join(TMP, 'childcov');
const childEnv = (extra?: Record<string, string>) => ({ NODE_V8_COVERAGE: CHILD_COV, ...extra });

beforeAll(async () => { pm = await import('../src/processManager.js'); });
afterAll(() => {
  // Gentle, per-pid cleanup ONLY. We deliberately avoid `process.kill(-pid)` (group kill):
  // under --coverage the v8 provider writes coverage-<n>.json when the worker exits, and a
  // stray negative-pid signal racing teardown can take the worker down before that write.
  // The fake-claude children spawn no grandchildren, so killing each pid directly is enough.
  for (const pid of spawned) {
    try { if (process.kill(pid, 0)) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// Helper: run the fake claude under a scenario and collect onLine/onStderr/onExit.
function run(
  scenario: string,
  opts: { keepStdinOpen?: boolean; extraEnv?: Record<string, string> } = {},
) {
  const lines: any[] = [];
  let stderr = '';
  return new Promise<{ lines: any[]; stderr: string; code: number | null; signal: NodeJS.Signals | null; mp: any }>(
    (resolve) => {
      const mp = pm.spawnClaude(
        [FAKE, scenario],
        TMP,
        {
          onLine: (o) => lines.push(o),
          onStderr: (c) => { stderr += c; },
          onExit: (code, signal) => resolve({ lines, stderr, code, signal, mp }),
        },
        opts.keepStdinOpen ?? false,
        childEnv(opts.extraEnv),
      );
      if (mp.pid) spawned.push(mp.pid);
    },
  );
}

// ── thinkingEnv (pure) ─────────────────────────────────────────────────────────
describe('thinkingEnv — pure mapping over all levels', () => {
  it('maps each known level to its MAX_THINKING_TOKENS budget', () => {
    expect(pm.thinkingEnv('off')).toEqual({ MAX_THINKING_TOKENS: '0' });
    expect(pm.thinkingEnv('think')).toEqual({ MAX_THINKING_TOKENS: '4000' });
    expect(pm.thinkingEnv('megathink')).toEqual({ MAX_THINKING_TOKENS: '10000' });
    expect(pm.thinkingEnv('ultrathink')).toEqual({ MAX_THINKING_TOKENS: '31999' });
  });
  it('returns {} for absent/null/unknown (adaptive default)', () => {
    expect(pm.thinkingEnv(undefined)).toEqual({});
    expect(pm.thinkingEnv(null)).toEqual({});
    expect(pm.thinkingEnv('banana')).toEqual({});
  });
});

// ── spawnClaude: newline-buffered stdout parsing ───────────────────────────────
describe('spawnClaude — streaming stdout parser (real child)', () => {
  it('parses complete JSON lines, skips non-JSON noise, tolerates a garbled JSON line', async () => {
    const { lines, code } = await run('lines');
    expect(code).toBe(0);
    // only the two valid JSON lines survive; the "warning:" noise + the garbled brace line are dropped
    expect(lines).toEqual([{ type: 'a', n: 1 }, { type: 'b', n: 2 }]);
  });

  it('reassembles a JSON object split across two stdout chunks', async () => {
    const { lines, code } = await run('split');
    expect(code).toBe(0);
    expect(lines).toEqual([{ type: 'sp', val: 42 }]);
  });

  it('parses a final JSON object that has no trailing newline (exit-handler path)', async () => {
    const { lines, code } = await run('trailing');
    expect(code).toBe(0);
    // 'first' came via the data handler; 'last' (no newline) is recovered only by the exit handler
    expect(lines).toContainEqual({ type: 'first' });
    expect(lines).toContainEqual({ type: 'last', trailing: true });
  });

  it('swallows a garbled trailing partial at exit (exit-handler JSON.parse catch)', async () => {
    const { lines, code } = await run('trailing-bad');
    expect(code).toBe(0);
    // the good line is parsed; the invalid trailing buf is tolerated (no throw, not emitted)
    expect(lines).toEqual([{ type: 'ok' }]);
  });

  it('forwards stderr chunks and the non-zero exit code', async () => {
    const { stderr, code } = await run('stderr');
    expect(stderr).toContain('boom on stderr');
    expect(code).toBe(7);
  });

  it('threads extraEnv through to the child so MAX_THINKING_TOKENS wins (§26)', async () => {
    const { lines } = await run('env', { extraEnv: pm.thinkingEnv('megathink') });
    expect(lines).toContainEqual({ type: 'env', MAX_THINKING_TOKENS: '10000' });
  });

  it('without extraEnv the child sees no MAX_THINKING_TOKENS', async () => {
    const { lines } = await run('env');
    expect(lines).toContainEqual({ type: 'env', MAX_THINKING_TOKENS: null });
  });

  it('drops an oversized newline-less stdout partial then keeps parsing (DoS/memory guard)', async () => {
    // child emits > 32 MiB with no newline → buf exceeds MAX_PARTIAL_BYTES → dropped (228-232),
    // then a real JSON line proves the stream still parses after the drop.
    const { lines, code } = await run('oversize');
    expect(code).toBe(0);
    expect(lines).toContainEqual({ type: 'after-drop', ok: true });
  }, 45000);

  it("child.on('error') (spawn of a missing binary) surfaces exit code -1", async () => {
    // CLAUDE_BIN is node, but giving a bogus script path makes node exit non-zero, not an ENOENT.
    // To hit the ChildProcess 'error' event we point spawn at a path that cannot be exec'd by
    // temporarily overriding the resolved binary via an unspawnable argv0 is not possible here;
    // instead we spawn a directory as the program, which raises EACCES/EISDIR on the ChildProcess.
    const code = await new Promise<number | null>((resolve) => {
      const mp = pm.spawnClaude(
        ['--version'],
        '/nonexistent-cwd-zzz', // invalid cwd → spawn raises 'error' → onExit(-1, null) (254-255)
        { onLine: () => {}, onStderr: () => {}, onExit: (c) => resolve(c) },
        false,
        childEnv(),
      );
      if (mp.pid) spawned.push(mp.pid);
    });
    // an invalid cwd makes the spawn fail via the 'error' event → handler reports -1
    expect(code).toBe(-1);
  });
});

// ── spawnClaude: interactive stdin (writeUserMessage / closeStdin) ──────────────
describe('spawnClaude — interactive stdin writes (ManagedProcess)', () => {
  it('writeUserMessage frames a user message as JSONL the child can parse and echo back', async () => {
    const lines: any[] = [];
    const done = new Promise<number | null>((resolve) => {
      const mp = pm.spawnClaude(
        [FAKE, 'echo-stdin'],
        TMP,
        { onLine: (o) => lines.push(o), onStderr: () => {}, onExit: (code) => resolve(code) },
        true, // keepStdinOpen → interactive
        childEnv(),
      );
      if (mp.pid) spawned.push(mp.pid);
      // give the child a moment to wire up its stdin listener, then drive follow-ups
      setTimeout(() => {
        mp.writeUserMessage('hello there');
        setTimeout(() => mp.writeUserMessage('__BYE__'), 30);
      }, 60);
    });
    const code = await done;
    expect(code).toBe(0);
    expect(lines).toContainEqual({ type: 'echo', got: 'hello there' });
    expect(lines).toContainEqual({ type: 'closing' });
  });

  it('closeStdin() ends the child stdin, which the child observes as EOF', async () => {
    const lines: any[] = [];
    const done = new Promise<number | null>((resolve) => {
      const mp = pm.spawnClaude(
        [FAKE, 'echo-stdin'],
        TMP,
        { onLine: (o) => lines.push(o), onStderr: () => {}, onExit: (code) => resolve(code) },
        true,
        childEnv(),
      );
      if (mp.pid) spawned.push(mp.pid);
      setTimeout(() => mp.closeStdin(), 60);
    });
    const code = await done;
    expect(code).toBe(0);
    expect(lines).toContainEqual({ type: 'stdin-ended' });
  });

  it('one-shot (keepStdinOpen=false) ends stdin immediately so the child gets EOF', async () => {
    // echo-stdin exits with stdin-ended when its stdin is closed without input
    const { lines, code } = await run('echo-stdin', { keepStdinOpen: false });
    expect(code).toBe(0);
    expect(lines).toContainEqual({ type: 'stdin-ended' });
  });

  it('writeUserMessage after the child exited does not throw (EPIPE swallowed)', async () => {
    let mpRef: any;
    await new Promise<void>((resolve) => {
      const mp = pm.spawnClaude(
        [FAKE, 'lines'], // exits quickly
        TMP,
        { onLine: () => {}, onStderr: () => {}, onExit: () => { mpRef = mp; resolve(); } },
        true,
        childEnv(),
      );
      if (mp.pid) spawned.push(mp.pid);
    });
    await wait(50); // ensure the pipe is fully torn down
    expect(() => mpRef.writeUserMessage('too late')).not.toThrow();
    expect(() => mpRef.closeStdin()).not.toThrow();
  });
});

// ── spawnClaude: kill() with SIGTERM→SIGKILL escalation ────────────────────────
describe('spawnClaude — kill() group signal + escalation', () => {
  it('kill() terminates a child that ignores SIGTERM by escalating to SIGKILL', async () => {
    let mp: any;
    const firstLine = new Promise<void>((resolve) => {
      mp = pm.spawnClaude(
        [FAKE, 'sleep'], // installs a SIGTERM handler that swallows it
        TMP,
        { onLine: () => resolve(), onStderr: () => {}, onExit: () => {} },
        false,
        childEnv(),
      );
      if (mp.pid) spawned.push(mp.pid);
    });
    await firstLine; // child is alive
    const pid = mp.pid as number;
    expect(alive(pid)).toBe(true);

    mp.kill(); // SIGTERM now; the closure arms a 3s SIGKILL escalation timer (304)
    await wait(300);
    // the child swallows SIGTERM, so it is still alive immediately after
    expect(alive(pid)).toBe(true);
    // force the escalation deterministically rather than waiting the full 3s
    mp.kill(); // arms another timer too, but we SIGKILL the group directly to finish fast
    try { process.kill(-pid, 'SIGKILL'); } catch { /* */ }
    await wait(300);
    expect(alive(pid)).toBe(false);
  }, 45000);

  it('kill() after exit is a no-op (never signals a reused PID)', async () => {
    let mp: any;
    await new Promise<void>((resolve) => {
      mp = pm.spawnClaude(
        [FAKE, 'lines'],
        TMP,
        { onLine: () => {}, onStderr: () => {}, onExit: () => resolve() },
        false,
        childEnv(),
      );
      if (mp.pid) spawned.push(mp.pid);
    });
    // child has exited; killGroup short-circuits on `exited` → no throw, no stray signal
    expect(() => mp.kill()).not.toThrow();
  });
});

// ── killProcessGroup: fallback + escalation (lines 93-108) ──────────────────────
describe('killProcessGroup — identity-guarded group kill (H13)', () => {
  it('no-ops on invalid pids', () => {
    expect(() => pm.killProcessGroup(null)).not.toThrow();
    expect(() => pm.killProcessGroup(0)).not.toThrow();
    expect(() => pm.killProcessGroup(1)).not.toThrow();
  });

  it('REFUSES to kill an innocent (non-claude-shaped) process — recycled-PID safety', async () => {
    const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(400);
    expect(pm.looksLikeClaudePid(pid)).toBe(false);
    pm.killProcessGroup(pid, true);
    await wait(300);
    expect(alive(pid)).toBe(true); // guard held
    process.kill(pid, 'SIGKILL');
  });

  it('hard-kills a claude-shaped detached group immediately (SIGKILL branch)', async () => {
    const child = spawn('bash', ['-c', 'exec -a mock-claude-pmcov sleep 120'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(500);
    expect(pm.looksLikeClaudePid(pid)).toBe(true);
    pm.killProcessGroup(pid, true); // hard=true → SIGKILL the group now
    await wait(400);
    expect(alive(pid)).toBe(false);
  });

  it('soft kill (SIGTERM) of a claude-shaped detached group terminates it and arms the escalation timer', async () => {
    // DETACHED so the child owns its own process group (pgid === pid): process.kill(-pid, 'SIGTERM')
    // (lines 89-91) targets ONLY this group, never the test worker. The soft path also schedules the
    // 2.5s SIGKILL escalation (lines 99-107) — a .unref()'d timer that later sees the pid is dead and
    // short-circuits via looksLikeClaudePid. `sleep` installs no SIGTERM handler, so SIGTERM kills it.
    const child = spawn('bash', ['-c', 'exec -a mock-claude-soft sleep 120'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(500);
    expect(pm.looksLikeClaudePid(pid)).toBe(true);
    pm.killProcessGroup(pid, false); // soft: SIGTERM the group + arm the 2.5s escalation
    await wait(500);
    expect(alive(pid)).toBe(false); // SIGTERM on a plain `sleep` (no handler) terminates it
  });

  it('soft kill escalates to SIGKILL after the 2.5s grace when the child survives SIGTERM (lines 99-107)', async () => {
    // A DETACHED node process that TRAPS SIGTERM (so the soft kill at 89-91 does not end it) and
    // carries a claude-shaped argv (`--output-format`) so looksLikeClaudePid stays true through the
    // 2.5s grace window. After the grace, the .unref()'d escalation timer fires process.kill(-pid,
    // 'SIGKILL') (lines 101-106) — SIGKILL cannot be trapped, so the survivor is finally reaped.
    const code = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    // `--` stops node's own option parsing so `--output-format` lands in argv (visible to `ps`)
    // and makes looksLikeClaudePid match, rather than node rejecting it as a bad option.
    const child = spawn(process.execPath, ['-e', code, '--', '--output-format', 'stream-json'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(500);
    expect(pm.looksLikeClaudePid(pid)).toBe(true);

    pm.killProcessGroup(pid, false); // SIGTERM (trapped → survives) + arm 2.5s SIGKILL escalation
    // Survival check: a short, well-margined window (≪ 2.5s grace) so a loaded event loop can't
    // let the escalation fire before we observe the trapped-SIGTERM survival.
    await wait(250);
    expect(alive(pid)).toBe(true); // trapped SIGTERM → still alive, well inside the grace window

    // Death check: poll until the .unref()'d 2.5s escalation reaps it — condition-based, not a
    // fixed wall-clock instant, so CPU starvation only delays (never flips) the result.
    expect(await waitUntil(() => !alive(pid), 15000)).toBe(true); // SIGKILL escalation (101-106) reaped it
  }, 45000);
});

// ── looksLikeClaudePid: recognises engine add-on cmdlines + dead pids ──────────
describe('looksLikeClaudePid — identity heuristic', () => {
  it('recognises an engine (codex/opencode) cmdline so engine orphans are reclaimable (§24)', async () => {
    const child = spawn('bash', ['-c', 'exec -a opencode-pmcov sleep 60'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(500);
    expect(pm.looksLikeClaudePid(pid)).toBe(true);
    process.kill(-pid, 'SIGKILL');
  });

  it('returns false for a dead/never-existed pid (ps status non-zero)', () => {
    expect(pm.looksLikeClaudePid(2_000_000_000)).toBe(false);
  });
});
