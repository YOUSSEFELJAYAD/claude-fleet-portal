/**
 * Real tests for validation.ts — the shared "run a pure-check command" primitive.
 * runValidation actually spawns `bash -lc <cmd>` (NO mocks); capOutput is pure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-validation-'));

let V: typeof import('../src/validation.js');
let workdir: string;

beforeAll(async () => {
  V = await import('../src/validation.js');
  workdir = mkdtempSync(join(tmpdir(), 'fleet-validation-work-'));
});

afterAll(() => {
  for (const d of [workdir, process.env.FLEET_DATA_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('capOutput — combine + trim + tail-cap', () => {
  it('returns empty string when both streams are empty', () => {
    expect(V.capOutput('', '')).toBe('');
    expect(V.capOutput('   ', '')).toBe('');
  });

  it('joins stdout and stderr with a newline and trims', () => {
    expect(V.capOutput('out', 'err')).toBe('out\nerr');
    expect(V.capOutput('\nout\n', '')).toBe('out');
    expect(V.capOutput('', 'just-stderr')).toBe('just-stderr');
  });

  it('keeps only the TAIL when the combined output exceeds VALIDATION_OUTPUT_CAP', () => {
    const cap = V.VALIDATION_OUTPUT_CAP; // 16 KB
    const big = 'A'.repeat(cap) + 'TAIL_MARKER';
    const out = V.capOutput(big, '');
    expect(out.length).toBe(cap);
    expect(out.endsWith('TAIL_MARKER')).toBe(true); // errors print last → keep the end
    expect(out.startsWith('A')).toBe(true);
  });
});

describe('runValidation — REAL bash spawn (exit 0 == pass)', () => {
  it('passes on a zero exit and captures stdout', async () => {
    const r = await V.runValidation(workdir, 'echo hello');
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.output).toBe('hello');
  });

  it('fails on a non-zero exit and reports the real exit code', async () => {
    const r = await V.runValidation(workdir, 'exit 3');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
  });

  it('captures stderr too', async () => {
    const r = await V.runValidation(workdir, 'echo boom 1>&2; exit 1');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.output).toContain('boom');
  });

  it('combines stdout + stderr on success', async () => {
    const r = await V.runValidation(workdir, 'echo out; echo err 1>&2');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it('runs in the supplied worktree dir', async () => {
    writeFileSync(join(workdir, 'marker.txt'), 'inside-worktree');
    const r = await V.runValidation(workdir, 'cat marker.txt');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('inside-worktree');
  });

  it('surfaces a command-not-found as a non-zero (127) without throwing', async () => {
    const r = await V.runValidation(workdir, 'this_command_truly_does_not_exist_xyz');
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe(0);
  });
});
