import { describe, it, expect } from 'vitest';
import { buildArgs } from '../src/processManager.js';

describe('buildArgs permission-gate injection', () => {
  it('injects a PreToolUse hook over --settings when requirePermission is set', () => {
    const args = buildArgs(
      { prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', requirePermission: true, permissionTools: ['Bash'] } as any,
      'sess-1',
      true,
    );
    const i = args.indexOf('--settings');
    expect(i).toBeGreaterThan(-1);
    const cfg = JSON.parse(args[i + 1]);
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('Bash');
    const hook = cfg.hooks.PreToolUse[0].hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toMatch(/fleet-permission-hook\.mjs/);
    expect(hook.timeout).toBe(900);
    // --settings must precede the prompt separator (it never appears for interactive, but guard anyway)
    const dd = args.indexOf('--');
    if (dd > -1) expect(i).toBeLessThan(dd);
  });

  it('defaults the matcher to Bash|Write|Edit when permissionTools is omitted', () => {
    const args = buildArgs(
      { prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', requirePermission: true } as any,
      'sess-1',
      true,
    );
    const cfg = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('Bash|Write|Edit');
  });

  it('injects NOTHING when requirePermission is not set', () => {
    const args = buildArgs(
      { prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high' } as any,
      'sess-1',
      false,
    );
    expect(args).not.toContain('--settings');
  });
});
