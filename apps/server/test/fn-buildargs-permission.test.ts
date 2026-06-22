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

  it('escapes regex metacharacters in tool names (no matcher injection) and quotes the hook path', () => {
    const args = buildArgs(
      { prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', requirePermission: true, permissionTools: ['.*', 'Bash', '  ', 'Foo|Bar'] } as any,
      'sess-1',
      true,
    );
    const cfg = JSON.parse(args[args.indexOf('--settings') + 1]);
    // '.*' → '\.\*', empty entry dropped, 'Foo|Bar' → 'Foo\|Bar'; joined by literal '|' alternation
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('\\.\\*|Bash|Foo\\|Bar');
    // raw '.*' must NOT appear unescaped (would gate every tool)
    expect(cfg.hooks.PreToolUse[0].matcher).not.toMatch(/(^|\|)\.\*(\||$)/);
    // hook path is quoted so an install path with spaces doesn't shell-split
    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toMatch(/^node ".*fleet-permission-hook\.mjs" \d+$/);
  });

  it('does not crash on malformed permissionTools (non-array or non-string elements) — falls back/filters', () => {
    // permissionTools is typed string[] but reaches buildArgs unvalidated from non-UI callers;
    // a throw here would orphan a 'starting' run (the run is persisted before buildArgs runs).
    const nonArray = buildArgs(
      { prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', requirePermission: true, permissionTools: 'Bash' } as any,
      'sess-1',
      true,
    );
    // a bare string is not a usable tool list → falls back to defaults, no throw
    expect(JSON.parse(nonArray[nonArray.indexOf('--settings') + 1]).hooks.PreToolUse[0].matcher).toBe('Bash|Write|Edit');

    const mixed = buildArgs(
      { prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', requirePermission: true, permissionTools: [123, null, {}, 'Edit'] } as any,
      'sess-1',
      true,
    );
    // non-string elements dropped, only 'Edit' survives
    expect(JSON.parse(mixed[mixed.indexOf('--settings') + 1]).hooks.PreToolUse[0].matcher).toBe('Edit');
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
