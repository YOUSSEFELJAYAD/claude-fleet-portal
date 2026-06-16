/**
 * Real tests for processManager.ts argv builders (DC.md F-4 / F-11):
 *   buildArgs       — the verified `claude -p` argv
 *   buildResumeArgs — same, but drops --session-id and adds --resume <id>
 * Pure functions over a LaunchRequest; importing processManager pulls addons → db,
 * so the DB is isolated first. No process is spawned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pm-args-'));

let pm: typeof import('../src/processManager.js');
beforeAll(async () => { pm = await import('../src/processManager.js'); });

const baseReq = () => ({
  prompt: 'do the thing',
  permissionMode: 'default' as const,
  effort: 'medium' as const,
});

describe('buildArgs — the one-shot baseline', () => {
  it('assigns --session-id and emits the prompt last after the -- separator', () => {
    const args = pm.buildArgs(baseReq() as any, 'sess-1', false);
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sess-1');
    // prompt is the final positional, guarded by the -- separator (F-11)
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('do the thing');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('--effort');
  });

  it('adds --input-format stream-json only for interactive runs (no positional prompt)', () => {
    const interactive = pm.buildArgs(baseReq() as any, 'sess-1', true);
    expect(interactive).toContain('--input-format');
    expect(interactive).not.toContain('--'); // interactive delivers the prompt via stdin
    expect(interactive).not.toContain('do the thing');
  });
});

describe('buildResumeArgs — resume a finished session (PRD §7.6)', () => {
  it('drops --session-id and its value, inserting --resume <id> before the -- separator', () => {
    const args = pm.buildResumeArgs(baseReq() as any, 'sess-9', false);
    expect(args).not.toContain('--session-id');
    const r = args.indexOf('--resume');
    expect(r).toBeGreaterThanOrEqual(0);
    expect(args[r + 1]).toBe('sess-9');
    // --resume must sit immediately before the -- prompt separator
    expect(args[args.indexOf('--') - 2]).toBe('--resume');
    // prompt is still last
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('appends --resume at the end for interactive resumes (no -- separator)', () => {
    const args = pm.buildResumeArgs(baseReq() as any, 'sess-9', true);
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--');
    expect(args.slice(-2)).toEqual(['--resume', 'sess-9']);
  });

  it('threads optional flags (model, budget, allowedTools, cwd) through from buildArgs', () => {
    const args = pm.buildResumeArgs(
      { ...baseReq(), model: 'claude-opus-4-8', budgetUsd: 5, allowedTools: ['Read', 'Write'], cwd: '/tmp/x' } as any,
      'sess-2',
      false,
    );
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('Read');
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('Write');
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('mcp__fleet-gate__ask_human');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/tmp/x');
  });
});
