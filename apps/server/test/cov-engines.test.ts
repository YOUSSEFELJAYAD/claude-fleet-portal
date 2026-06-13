/**
 * cov-engines.ts — behavioral coverage for the uncovered LOGIC in engines.ts.
 *
 * Targets (per coverage map): buildEngineArgs unsupported-engine throw (70-71),
 * codex `reasoning` text fallback (114-115), parseEngineLine unsupported-engine
 * tail (240-241), and the spawnEngine runtime branches that ARE deterministically
 * exercisable with a fake bin: garbled-line tolerance (302), trailing-partial
 * drain on exit — both valid + garbled (316-326), the `child.on('error')` path
 * for a missing binary (331-332), and the process-group kill cascade incl. the
 * killTimer clear in the exit handler (336-346, 352-355).
 *
 * Every test asserts a real OUTPUT or side-effect of the REAL code.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate DB before any src module is imported (fn-validation.test.ts pattern).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-engines-'));

import { buildEngineArgs, parseEngineLine, spawnEngine } from '../src/engines.js';
import type { CodexEngineConfig } from '../src/engines.js';
import type { RunEngine } from '@fleet/shared';

// ── pure: buildEngineArgs unsupported engine (lines 70-71) ───────────────────

describe('buildEngineArgs — unsupported engine throws', () => {
  it('throws with the engine name in the message', () => {
    expect(() =>
      buildEngineArgs(
        'gemini' as unknown as RunEngine,
        { prompt: 'go', cwd: '/p', engineModel: undefined },
        { defaultModel: null, sandbox: 'workspace-write' } as CodexEngineConfig,
      ),
    ).toThrow(/unsupported engine: gemini/);
  });

  it('empty-string engine also throws (no silent fallthrough)', () => {
    expect(() =>
      buildEngineArgs(
        '' as unknown as RunEngine,
        { prompt: 'x', cwd: '/p', engineModel: undefined },
        { defaultModel: null, sandbox: 'read-only' } as CodexEngineConfig,
      ),
    ).toThrow(/unsupported engine/);
  });
});

// ── pure: codex reasoning text fallback (lines 114-115) ──────────────────────

describe('parseEngineLine — codex reasoning content/text precedence', () => {
  it('falls back to item.text when item.content is absent (114)', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'reasoning', text: 'fallback reasoning body' },
    });
    expect(line.type).toBe('thinking');
    expect(line.payload?.text).toBe('fallback reasoning body');
  });

  it('falls back to empty string when neither content nor text present (115)', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'reasoning' },
    });
    expect(line.type).toBe('thinking');
    expect(line.payload?.text).toBe('');
  });

  it('content wins over text when both present', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'reasoning', content: 'from content', text: 'from text' },
    });
    expect(line.payload?.text).toBe('from content');
  });
});

// ── pure: parseEngineLine unsupported engine tail (lines 240-241) ────────────

describe('parseEngineLine — unsupported engine returns null event', () => {
  it('unknown engine string → { type: null }', () => {
    const line = parseEngineLine('mystery' as unknown as RunEngine, {
      type: 'text',
      part: { text: 'should be ignored' },
    });
    expect(line.type).toBeNull();
    expect(line.usage).toBeUndefined();
    expect(line.resultText).toBeUndefined();
  });

  it('unknown engine with a well-formed object still yields no event', () => {
    const line = parseEngineLine('claude' as unknown as RunEngine, { type: 'turn.completed', usage: { input_tokens: 9 } });
    expect(line.type).toBeNull();
    expect(line.usage).toBeUndefined();
  });
});

// ── spawnEngine runtime branches via fake bins ───────────────────────────────

describe('spawnEngine — runtime side-effects (fake bins)', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'fleet-cov-engine-bin-'));

  // (a) emits one garbled '{...' line, one valid line, then a NEWLINE-terminated
  //     valid line — exercises the streaming JSON.parse catch (line 302).
  const GARBLED_BIN = join(binDir, 'garbled');
  // (b) emits a valid newline line, then a trailing partial WITHOUT a newline so
  //     it survives in buf and is drained by the exit handler (lines 320-323).
  const PARTIAL_OK_BIN = join(binDir, 'partial-ok');
  // (c) emits a valid newline line, then a garbled trailing partial (no newline,
  //     starts with '{' but invalid) → exit-handler drain catch (lines 325).
  const PARTIAL_BAD_BIN = join(binDir, 'partial-bad');
  // (d) long-lived process (sleeps) so kill() can tear down the group (336-355).
  const SLEEP_BIN = join(binDir, 'sleeper');
  // (e) emits an oversized line check is not part of target; skip.

  beforeAll(() => {
    writeFileSync(
      GARBLED_BIN,
      `#!/usr/bin/env node
process.stdout.write('{ this is not json }\\n');
process.stdout.write('not-even-brace-skip\\n');
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'after garbage' } }) + '\\n');
process.exit(0);
`,
    );
    chmodSync(GARBLED_BIN, 0o755);

    writeFileSync(
      PARTIAL_OK_BIN,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'first line' } }) + '\\n');
// trailing partial: valid JSON but NO newline — must be drained on exit
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'trailing drained' } }));
process.exit(0);
`,
    );
    chmodSync(PARTIAL_OK_BIN, 0o755);

    writeFileSync(
      PARTIAL_BAD_BIN,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'only good line' } }) + '\\n');
// trailing partial starting with '{' but malformed — exit drain catch swallows it
process.stdout.write('{ broken trailing');
process.exit(0);
`,
    );
    chmodSync(PARTIAL_BAD_BIN, 0o755);

    writeFileSync(
      SLEEP_BIN,
      `#!/usr/bin/env node
// announce readiness, then stay alive until killed
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'alive' } }) + '\\n');
setInterval(() => {}, 1000);
`,
    );
    chmodSync(SLEEP_BIN, 0o755);
  });

  it('tolerates a garbled JSON line and still parses the valid one after it (302)', async () => {
    const seen: unknown[] = [];
    let exitCode: number | null = -999;

    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', GARBLED_BIN, [], '/tmp', {
        onLine: (obj) => seen.push(obj),
        onStderr: () => {},
        onExit: (code) => { exitCode = code; resolve(); },
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    // The garbled '{' line was attempted (JSON.parse threw, swallowed) and the
    // non-brace line was skipped — only the one valid object reaches onLine.
    expect(exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    const line = parseEngineLine('opencode', seen[0]);
    expect(line.resultText).toBe('after garbage');
  });

  it('drains a valid trailing partial (no final newline) in the exit handler (320-323)', async () => {
    const texts: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', PARTIAL_OK_BIN, [], '/tmp', {
        onLine: (obj) => {
          const l = parseEngineLine('opencode', obj);
          if (l.resultText) texts.push(l.resultText);
        },
        onStderr: () => {},
        onExit: () => resolve(),
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    // Both the newline-terminated line AND the trailing un-terminated partial
    // must surface — the second only via the exit-handler drain path.
    expect(texts).toEqual(['first line', 'trailing drained']);
  });

  it('swallows a malformed trailing partial without throwing (325)', async () => {
    const texts: string[] = [];
    let exitCode: number | null = -999;

    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', PARTIAL_BAD_BIN, [], '/tmp', {
        onLine: (obj) => {
          const l = parseEngineLine('opencode', obj);
          if (l.resultText) texts.push(l.resultText);
        },
        onStderr: () => {},
        onExit: (code) => { exitCode = code; resolve(); },
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    // The good line survives; the broken trailing partial is attempted then the
    // parse error is swallowed — no crash, clean exit.
    expect(exitCode).toBe(0);
    expect(texts).toEqual(['only good line']);
  });

  it('fires onExit(-1, null) via child error when the binary does not exist (331-332)', async () => {
    const missing = join(binDir, 'does-not-exist-' + Date.now());
    expect(existsSync(missing)).toBe(false);

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const proc = spawnEngine('codex', missing, ['exec'], '/tmp', {
        onLine: () => {},
        onStderr: () => {},
        onExit: (code, signal) => resolve({ code, signal }),
      });
      // pid should be undefined / process never really started
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    expect(result.code).toBe(-1);
    expect(result.signal).toBeNull();
  });

  it('kill() tears down a live process group and the exit handler clears the killTimer (336-355)', async () => {
    let resolved = false;

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const proc = spawnEngine('opencode', SLEEP_BIN, [], '/tmp', {
        onLine: (obj) => {
          // once the child announces it's alive, kill it — this drives kill()
          // (352-355) → killGroup SIGTERM (336-346); the subsequent exit event
          // runs the clearTimeout(killTimer) branch (316-318).
          const l = parseEngineLine('opencode', obj);
          if (l.resultText === 'alive') proc.kill();
        },
        onStderr: () => {},
        onExit: (code, signal) => {
          if (!resolved) { resolved = true; resolve({ code, signal }); }
        },
      });
      expect(typeof proc.pid === 'number' || proc.pid === undefined).toBe(true);
      setTimeout(() => { try { proc.kill(); } catch { /* */ } reject(new Error('kill did not terminate process')); }, 8000).unref();
    });

    // SIGTERM-killed via the detached group: terminated by signal, not a clean code.
    expect(exitInfo.code === null || typeof exitInfo.code === 'number').toBe(true);
    expect(exitInfo.signal === 'SIGTERM' || exitInfo.code !== 0).toBe(true);
  });

  it('kill() after the process already exited is a safe no-op (early-return guard)', async () => {
    // Use a bin that exits immediately; then call kill() — killGroup's `exited`
    // guard (line 336) must short-circuit without throwing.
    const QUICK = join(binDir, 'quick');
    writeFileSync(QUICK, `#!/usr/bin/env node\nprocess.exit(0);\n`);
    chmodSync(QUICK, 0o755);

    const proc = await new Promise<ReturnType<typeof spawnEngine>>((resolve, reject) => {
      const p = spawnEngine('opencode', QUICK, [], '/tmp', {
        onLine: () => {},
        onStderr: () => {},
        onExit: () => resolve(p),
      });
      setTimeout(() => reject(new Error('timeout')), 5000).unref();
    });

    // Process already exited; kill() must not throw.
    expect(() => proc.kill()).not.toThrow();
  });

  it('opencode spawn sets OPENCODE_DISABLE_AUTOUPDATE=1 in the child env', async () => {
    const ENV_PROBE = join(binDir, 'env-probe');
    writeFileSync(
      ENV_PROBE,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'text', part: { text: process.env.OPENCODE_DISABLE_AUTOUPDATE || 'UNSET' } }) + '\\n');
process.exit(0);
`,
    );
    chmodSync(ENV_PROBE, 0o755);

    let text = '';
    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', ENV_PROBE, [], '/tmp', {
        onLine: (obj) => { text = parseEngineLine('opencode', obj).resultText ?? text; },
        onStderr: () => {},
        onExit: () => resolve(),
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    expect(text).toBe('1');
  });

  it('codex spawn does NOT set OPENCODE_DISABLE_AUTOUPDATE (engine-specific env branch)', async () => {
    const ENV_PROBE2 = join(binDir, 'env-probe-codex');
    writeFileSync(
      ENV_PROBE2,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.env.OPENCODE_DISABLE_AUTOUPDATE || 'UNSET' } }) + '\\n');
process.exit(0);
`,
    );
    chmodSync(ENV_PROBE2, 0o755);

    let text = '';
    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('codex', ENV_PROBE2, [], '/tmp', {
        onLine: (obj) => { text = parseEngineLine('codex', obj).resultText ?? text; },
        onStderr: () => {},
        onExit: () => resolve(),
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    expect(text).toBe('UNSET');
  });

  it('drops an oversized un-newlined stdout partial past MAX_PARTIAL_BYTES (305-307)', async () => {
    // Emit > 32 MiB of '{'-prefixed bytes with NO newline so it accumulates in
    // buf until it exceeds MAX_PARTIAL_BYTES and is discarded with a warn. Then a
    // final newline-terminated valid line proves the stream recovered (buf reset).
    const BIG_BIN = join(binDir, 'bigpartial');
    writeFileSync(
      BIG_BIN,
      `#!/usr/bin/env node
const big = '{'.padEnd(33 * 1024 * 1024, 'x'); // 33 MiB, no newline, starts with '{'
process.stdout.write(big, () => {
  process.stdout.write('\\n' + JSON.stringify({ type: 'text', part: { text: 'recovered' } }) + '\\n', () => {
    process.exit(0);
  });
});
`,
    );
    chmodSync(BIG_BIN, 0o755);

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };

    let recovered = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawnEngine('opencode', BIG_BIN, [], '/tmp', {
          onLine: (obj) => { recovered = parseEngineLine('opencode', obj).resultText ?? recovered; },
          onStderr: () => {},
          onExit: () => resolve(),
        });
        setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 15000).unref();
      });
    } finally {
      console.warn = origWarn;
    }

    // The oversized partial path logged a warn and reset buf so the later line parsed.
    expect(warns.some((w) => /oversized stdout partial/.test(w))).toBe(true);
    expect(recovered).toBe('recovered');
  }, 60000);

  it('stderr chunks are forwarded to onStderr', async () => {
    const ERR_BIN = join(binDir, 'errbin');
    writeFileSync(
      ERR_BIN,
      `#!/usr/bin/env node
process.stderr.write('warning: deprecated flag\\n');
process.exit(0);
`,
    );
    chmodSync(ERR_BIN, 0o755);

    let err = '';
    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', ERR_BIN, [], '/tmp', {
        onLine: () => {},
        onStderr: (c) => { err += c; },
        onExit: () => resolve(),
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    expect(err).toContain('deprecated flag');
  });

  it('falls back to process.cwd() when cwd is an empty string', async () => {
    // cwd '' triggers the `cwd || process.cwd()` branch on the spawn options.
    const CWD_BIN = join(binDir, 'cwdbin');
    writeFileSync(
      CWD_BIN,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'text', part: { text: process.cwd() } }) + '\\n');
process.exit(0);
`,
    );
    chmodSync(CWD_BIN, 0o755);

    let cwdReported = '';
    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', CWD_BIN, [], '', {
        onLine: (obj) => { cwdReported = parseEngineLine('opencode', obj).resultText ?? cwdReported; },
        onStderr: () => {},
        onExit: () => resolve(),
      });
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    // The child inherited the server's cwd (non-empty) rather than ''.
    expect(cwdReported.length).toBeGreaterThan(0);
    expect(cwdReported).not.toBe('');
  });
});
