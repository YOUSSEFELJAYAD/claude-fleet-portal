import { describe, it, expect } from 'vitest';
import { buildArgs } from '../src/processManager.js';

describe('buildArgs gate injection', () => {
  it('injects fleet-gate mcp-config, the ask_human tool, and a nudge', () => {
    const args = buildArgs({ prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', allowedTools: ['Read'] } as any, 'sess-1', false);
    const cfgIdx = args.indexOf('--mcp-config');
    expect(cfgIdx).toBeGreaterThan(-1);
    const cfg = JSON.parse(args[cfgIdx + 1]);
    expect(cfg.mcpServers['fleet-gate']).toBeTruthy();
    expect(JSON.stringify(cfg)).toContain('sess-1'); // session attribution baked into the URL
    const tools = args[args.indexOf('--allowedTools') + 1];
    expect(tools).toContain('mcp__fleet-gate__ask_human');
    const sys = args[args.indexOf('--append-system-prompt') + 1];
    expect(sys).toMatch(/ask_human/);
  });

  it('does NOT pass --strict-mcp-config (gate must merge with the user\'s MCP servers)', () => {
    const args = buildArgs({ prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', allowedTools: ['Read'] } as any, 'sess-1', false);
    expect(args).not.toContain('--strict-mcp-config');
  });
});
