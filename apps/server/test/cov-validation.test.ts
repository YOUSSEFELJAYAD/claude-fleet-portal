/**
 * Coverage test for validation.ts — exercises the runValidation kill/error/signal paths that the
 * happy-path fn-validation.test.ts never reaches. Everything drives a REAL `bash -lc` subprocess
 * (NO mocks) and asserts the real exit code + real captured output / side-effects.
 *
 * Targeted uncovered ranges (src/validation.ts):
 *   - 44-56   killGroup(): process.kill(-pid, sig) on the detached process group
 *   - 66      buffer-overflow trip: `bytes > VALIDATION_MAX_BUFFER && !killed` → killGroup('SIGTERM')
 *   - 87-89   child.on('error'): ENOENT → code 127, message fallback
 *   - 91-99   close handler: killed/signal → code 124, "killed by <sig>" + "exit N" output fallbacks
 *
 * NOT covered here (genuinely untestable in a unit harness — see "untestable" in the run report):
 *   - 57-61   the 10-min VALIDATION_TIMEOUT_MS timer firing SIGTERM then escalating to SIGKILL
 *   - 95      close handler `else code = -1` (exitCode null AND no signal — Node never emits both null)
 *   - 103-104 outer try/catch (spawn() throwing synchronously — never happens with valid bash args)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-validation-'));

let V: typeof import('../src/validation.js');
let workdir: string;

beforeAll(async () => {
  V = await import('../src/validation.js');
  workdir = mkdtempSync(join(tmpdir(), 'fleet-cov-validation-work-'));
});

afterAll(() => {
  for (const d of [workdir, process.env.FLEET_DATA_DIR!]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('runValidation — buffer-overflow kill via VALIDATION_MAX_BUFFER (lines 66, 44-56, 93)', () => {
  it('kills the process group with SIGTERM and reports code 124 when stdout floods past the 8MB cap', async () => {
    // `yes <line>` floods stdout indefinitely; it crosses the 8MB VALIDATION_MAX_BUFFER almost
    // immediately, tripping `bytes > VALIDATION_MAX_BUFFER && !killed` (line 66) → killGroup('SIGTERM')
    // (lines 44-56: process.kill(-pid, sig) on the detached group) → the child closes via a signal →
    // the close handler maps killed → code 124 (line 93). NEVER throws.
    const filler = 'A'.repeat(64);
    const r = await V.runValidation(workdir, `yes ${filler}`);
    expect(r.code).toBe(124);
    expect(r.ok).toBe(false);
    // it streamed + captured SOME of the flood before the cap kill (real bytes really arrived)
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.output).toContain('A');
    // the captured output is tail-capped to the 16KB fix-prompt budget
    expect(r.output.length).toBeLessThanOrEqual(V.VALIDATION_OUTPUT_CAP);
  }, 20_000);

  it('also trips the cap when the flood is on stderr (onChunk byte accounting is shared)', async () => {
    // Same overflow path, but `yes` output is redirected to stderr (1>&2). Proves onChunk's byte
    // counter is shared across stdout+stderr and still kills the detached group.
    const filler = 'B'.repeat(64);
    const r = await V.runValidation(workdir, `yes ${filler} 1>&2`);
    expect(r.code).toBe(124);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('B');
  }, 20_000);

  it('does NOT kill when total output stays under the cap (negative side of the byte branch)', async () => {
    // A bounded flood (~1MB, well under the 8MB cap) runs to a clean exit 0 — the
    // `bytes > VALIDATION_MAX_BUFFER` condition is never true, so killGroup is never called and
    // the close handler takes the numeric-exitCode branch (line 94) with code 0.
    const r = await V.runValidation(workdir, `head -c 1048576 /dev/zero | tr '\\0' 'C'`);
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.output).toContain('C');
  }, 20_000);
});

describe('runValidation — child "error" event / ENOENT (lines 87-89)', () => {
  it('returns code 127 with the spawn error message when the worktree dir does not exist', async () => {
    // Spawning with a non-existent cwd makes Node emit a `child.on('error')` with e.code === 'ENOENT'
    // BEFORE/instead of a normal close → line 88 maps ENOENT → 127, and since no stdout/stderr was
    // captured, capOutput('','') === '' so the output falls back to e.message (line 89). NEVER throws.
    const missingDir = join(tmpdir(), 'fleet-cov-validation-does-not-exist-xyz-123');
    const r = await V.runValidation(missingDir, 'echo should-never-run');
    expect(r.code).toBe(127);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('ENOENT');
    expect(r.output).not.toContain('should-never-run');
  });
});

describe('runValidation — close handler signal & exit mapping (lines 91-99)', () => {
  it('maps an external signal-kill to code 124 with a "killed by <signal>" message when no output', async () => {
    // bash terminates itself with SIGTERM and prints nothing. `killed` stays false, but `signal` is
    // set → code 124 (line 93). With empty stdout/stderr, capOutput('','') === '' so the output
    // falls through to the `signal ? \`killed by ${signal}\`` branch (line 98).
    const r = await V.runValidation(workdir, 'kill -TERM $$');
    expect(r.code).toBe(124);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('killed by SIGTERM');
  });

  it('prefers captured output over the "killed by" fallback when the child printed before dying', async () => {
    // Same signal close, but real output was produced first → capOutput wins over the signal fallback.
    const r = await V.runValidation(workdir, 'echo alive-then-dead; kill -TERM $$');
    expect(r.code).toBe(124);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('alive-then-dead');
  });

  it('uses the "command failed (exit N)" fallback on a non-zero exit with no output (lines 94, 98)', async () => {
    // Real exit-code path: no signal, exitCode is a number → code = exitCode (line 94). With no
    // stdout/stderr, capOutput is '' so output falls to the `command failed (exit ${code})` branch.
    const r = await V.runValidation(workdir, 'exit 7');
    expect(r.code).toBe(7);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('command failed (exit 7)');
  });

  it('returns empty output (not a fallback message) on a clean exit 0 with no output', async () => {
    // code === 0 branch of the output ternary → '' (no "command failed", no "killed by").
    const r = await V.runValidation(workdir, 'true');
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('');
  });
});
