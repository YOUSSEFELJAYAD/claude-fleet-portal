/**
 * Unit tests for engines.ts — buildEngineArgs, parseEngineLine.
 * All tests are pure (no I/O, no spawning) except the end-to-end fake-bin test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate DB before any src module is imported
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-engines-'));

import { buildEngineArgs, parseEngineLine } from '../src/engines.js';
import type { CodexEngineConfig, OpencodeEngineConfig } from '../src/engines.js';

// ── buildEngineArgs ──────────────────────────────────────────────────────────

describe('buildEngineArgs — codex', () => {
  const baseCfg: CodexEngineConfig = { defaultModel: null, sandbox: 'workspace-write' };

  it('minimal: no model override', () => {
    const args = buildEngineArgs('codex', { prompt: 'fix bugs', cwd: '/proj', engineModel: undefined }, baseCfg);
    expect(args).toEqual([
      '--ask-for-approval', 'never',
      '--sandbox', 'workspace-write',
      '--cd', '/proj',
      'exec', '--json', '--skip-git-repo-check', '--',
      'fix bugs',
    ]);
  });

  it('with engineModel from request (overrides cfg.defaultModel)', () => {
    const cfg: CodexEngineConfig = { defaultModel: 'gpt-4o', sandbox: 'workspace-write' };
    const args = buildEngineArgs('codex', { prompt: 'task', cwd: '/x', engineModel: 'gpt-5' }, cfg);
    // engineModel in req wins
    expect(args.indexOf('--model')).toBeGreaterThanOrEqual(0);
    const mIdx = args.indexOf('--model');
    expect(args[mIdx + 1]).toBe('gpt-5');
  });

  it('uses cfg.defaultModel when no engineModel in req', () => {
    const cfg: CodexEngineConfig = { defaultModel: 'gpt-4o-mini', sandbox: 'read-only' };
    const args = buildEngineArgs('codex', { prompt: 'go', cwd: '/y', engineModel: undefined }, cfg);
    const mIdx = args.indexOf('--model');
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe('gpt-4o-mini');
    expect(args).toContain('read-only'); // sandbox
  });

  it('danger-full-access sandbox', () => {
    const cfg: CodexEngineConfig = { defaultModel: null, sandbox: 'danger-full-access' };
    const args = buildEngineArgs('codex', { prompt: 'go', cwd: '/z', engineModel: undefined }, cfg);
    expect(args).toContain('danger-full-access');
  });

  it("prompt is the last argument, behind a '--' separator (F-11 — hyphen prompts must not parse as flags)", () => {
    const args = buildEngineArgs('codex', { prompt: 'hello world', cwd: '/p', engineModel: undefined }, baseCfg);
    expect(args[args.length - 1]).toBe('hello world');
    expect(args[args.length - 2]).toBe('--');
    const dash = buildEngineArgs('codex', { prompt: '- fix the login bug', cwd: '/p', engineModel: undefined }, baseCfg);
    expect(dash[dash.length - 1]).toBe('- fix the login bug');
    expect(dash[dash.length - 2]).toBe('--');
  });
});

describe('buildEngineArgs — opencode', () => {
  const baseCfg: OpencodeEngineConfig = { defaultModel: null, skipPermissions: false };

  it('minimal: no model, no skip-permissions', () => {
    const args = buildEngineArgs('opencode', { prompt: 'refactor', cwd: '/p', engineModel: undefined }, baseCfg);
    expect(args).toEqual(['run', '--format', 'json', '--', 'refactor']);
  });

  it('with model from req', () => {
    const args = buildEngineArgs('opencode', { prompt: 'work', cwd: '/p', engineModel: 'anthropic/claude-sonnet-4-5' }, baseCfg);
    expect(args).toContain('--model');
    const mIdx = args.indexOf('--model');
    expect(args[mIdx + 1]).toBe('anthropic/claude-sonnet-4-5');
  });

  it('with cfg.defaultModel', () => {
    const cfg: OpencodeEngineConfig = { defaultModel: 'openai/gpt-4o', skipPermissions: false };
    const args = buildEngineArgs('opencode', { prompt: 'go', cwd: '/p', engineModel: undefined }, cfg);
    const mIdx = args.indexOf('--model');
    expect(args[mIdx + 1]).toBe('openai/gpt-4o');
  });

  it('skipPermissions=true adds --dangerously-skip-permissions', () => {
    const cfg: OpencodeEngineConfig = { defaultModel: null, skipPermissions: true };
    const args = buildEngineArgs('opencode', { prompt: 'go', cwd: '/p', engineModel: undefined }, cfg);
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('prompt is the last argument', () => {
    const args = buildEngineArgs('opencode', { prompt: 'my task', cwd: '/p', engineModel: undefined }, baseCfg);
    expect(args[args.length - 1]).toBe('my task');
  });
});

// ── buildEngineArgs — thinking level (§26) ───────────────────────────────────

describe('buildEngineArgs — thinkingLevel codex', () => {
  const cfg: CodexEngineConfig = { defaultModel: null, sandbox: 'workspace-write' };

  it('thinkingLevel high → -c model_reasoning_effort=high appears BEFORE exec', () => {
    const args = buildEngineArgs('codex', { prompt: 'go', cwd: '/p', engineModel: undefined, thinkingLevel: 'high' }, cfg);
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('model_reasoning_effort=high');
    // must come before 'exec' subcommand
    const execIdx = args.indexOf('exec');
    expect(cIdx).toBeLessThan(execIdx);
  });

  it('absent thinkingLevel → no -c flag', () => {
    const args = buildEngineArgs('codex', { prompt: 'go', cwd: '/p', engineModel: undefined }, cfg);
    expect(args).not.toContain('-c');
  });

  it('null thinkingLevel → no -c flag', () => {
    const args = buildEngineArgs('codex', { prompt: 'go', cwd: '/p', engineModel: undefined, thinkingLevel: null }, cfg);
    expect(args).not.toContain('-c');
  });
});

describe('buildEngineArgs — thinkingLevel opencode', () => {
  const cfg: OpencodeEngineConfig = { defaultModel: null, skipPermissions: false };

  it('thinkingLevel max → --variant max before -- separator', () => {
    const args = buildEngineArgs('opencode', { prompt: 'go', cwd: '/p', engineModel: undefined, thinkingLevel: 'max' }, cfg);
    const vIdx = args.indexOf('--variant');
    expect(vIdx).toBeGreaterThanOrEqual(0);
    expect(args[vIdx + 1]).toBe('max');
    // must come before the -- separator
    const ddIdx = args.indexOf('--');
    expect(vIdx).toBeLessThan(ddIdx);
  });

  it('absent thinkingLevel → no --variant flag', () => {
    const args = buildEngineArgs('opencode', { prompt: 'go', cwd: '/p', engineModel: undefined }, cfg);
    expect(args).not.toContain('--variant');
  });

  it('null thinkingLevel → no --variant flag', () => {
    const args = buildEngineArgs('opencode', { prompt: 'go', cwd: '/p', engineModel: undefined, thinkingLevel: null }, cfg);
    expect(args).not.toContain('--variant');
  });
});

// ── parseEngineLine — codex ──────────────────────────────────────────────────

describe('parseEngineLine — codex', () => {
  it('thread.started → no event', () => {
    expect(parseEngineLine('codex', { type: 'thread.started' }).type).toBeNull();
  });

  it('turn.started → no event', () => {
    expect(parseEngineLine('codex', { type: 'turn.started' }).type).toBeNull();
  });

  it('item.started → no event', () => {
    expect(parseEngineLine('codex', { type: 'item.started', item: { type: 'agent_message' } }).type).toBeNull();
  });

  it('item.completed agent_message → assistant_text with resultText', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Hello there!' },
    });
    expect(line.type).toBe('assistant_text');
    expect(line.payload?.text).toBe('Hello there!');
    expect(line.resultText).toBe('Hello there!');
    expect(line.isError).toBeFalsy();
  });

  it('item.completed reasoning → thinking', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'reasoning', content: 'I should check the file.' },
    });
    expect(line.type).toBe('thinking');
    expect(line.payload?.text).toBe('I should check the file.');
  });

  it('item.completed command_execution → tool_use', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la /tmp' },
    });
    expect(line.type).toBe('tool_use');
    expect((line.payload?.name as string)).toBe('command_execution');
    expect((line.payload?.input as string)).toContain('ls -la /tmp');
  });

  it('item.completed mcp_tool_call → tool_use', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'mcp_tool_call', id: 'mcp-1', tool_name: 'read_file' },
    });
    expect(line.type).toBe('tool_use');
    expect(line.payload?.name).toBe('mcp_tool_call');
    expect(line.payload?.input).toBe('read_file');
  });

  it('item.completed web_search → tool_use with query', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'web_search', id: 'ws-1', query: 'TypeScript generics' },
    });
    expect(line.type).toBe('tool_use');
    expect((line.payload?.input as string)).toContain('TypeScript generics');
  });

  it('item.completed file_changes → tool_use', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'file_changes', id: 'fc-1' },
    });
    expect(line.type).toBe('tool_use');
    expect(line.payload?.input).toBe('file changes');
  });

  it('item.completed unknown type → no event', () => {
    const line = parseEngineLine('codex', {
      type: 'item.completed',
      item: { type: 'plan_update', text: 'plan changed' },
    });
    expect(line.type).toBeNull();
  });

  it('turn.completed with usage → usage only, no event', () => {
    const line = parseEngineLine('codex', {
      type: 'turn.completed',
      usage: { input_tokens: 150, cached_input_tokens: 20, output_tokens: 80, reasoning_output_tokens: 5 },
    });
    expect(line.type).toBeNull();
    expect(line.usage?.tokensIn).toBe(150);
    expect(line.usage?.tokensOut).toBe(80);
  });

  it('turn.completed without usage → no event, no usage', () => {
    const line = parseEngineLine('codex', { type: 'turn.completed' });
    expect(line.type).toBeNull();
    expect(line.usage).toBeUndefined();
  });

  it('turn.failed → isError result event', () => {
    const line = parseEngineLine('codex', { type: 'turn.failed', message: 'auth failed' });
    expect(line.type).toBe('result');
    expect(line.isError).toBe(true);
    expect(line.payload?.isError).toBe(true);
    expect((line.payload?.result as string)).toContain('auth failed');
  });

  it('error type → isError result event', () => {
    const line = parseEngineLine('codex', { type: 'error', error: 'something went wrong' });
    expect(line.type).toBe('result');
    expect(line.isError).toBe(true);
  });

  it('turn.failed with the REAL nested shape {error:{message}} unwraps to a string (review)', () => {
    const line = parseEngineLine('codex', { type: 'turn.failed', error: { message: 'rate limited' } });
    expect(line.type).toBe('result');
    expect(line.isError).toBe(true);
    expect(line.payload?.result).toBe('rate limited'); // an object here would render raw JSON in the Timeline
  });

  it('null/garbage input → no event', () => {
    expect(parseEngineLine('codex', null).type).toBeNull();
    expect(parseEngineLine('codex', 'bad').type).toBeNull();
    expect(parseEngineLine('codex', 42).type).toBeNull();
  });
});

// ── parseEngineLine — opencode ───────────────────────────────────────────────

describe('parseEngineLine — opencode', () => {
  it('step_start → no event', () => {
    expect(parseEngineLine('opencode', { type: 'step_start', part: {} }).type).toBeNull();
  });

  it('text → assistant_text with resultText', () => {
    const line = parseEngineLine('opencode', {
      type: 'text',
      timestamp: 1234567890,
      sessionID: 'abc',
      part: { text: 'The fix is in place.' },
    });
    expect(line.type).toBe('assistant_text');
    expect(line.payload?.text).toBe('The fix is in place.');
    expect(line.resultText).toBe('The fix is in place.');
  });

  it('reasoning → thinking', () => {
    const line = parseEngineLine('opencode', {
      type: 'reasoning',
      part: { text: 'Let me think step by step.' },
    });
    expect(line.type).toBe('thinking');
    expect(line.payload?.text).toBe('Let me think step by step.');
  });

  it('tool_use → tool_use event', () => {
    const line = parseEngineLine('opencode', {
      type: 'tool_use',
      part: { tool: 'read_file', id: 'tu-1', input: { path: '/src/index.ts' } },
    });
    expect(line.type).toBe('tool_use');
    expect(line.payload?.name).toBe('read_file');
    expect(line.payload?.id).toBe('tu-1');
    expect((line.payload?.input as any)?.path).toBe('/src/index.ts');
  });

  it('tool_use with part.name fallback', () => {
    const line = parseEngineLine('opencode', {
      type: 'tool_use',
      part: { name: 'bash', id: 'tu-2', input: 'ls' },
    });
    expect(line.payload?.name).toBe('bash');
  });

  it('step_finish with tokens → usage only', () => {
    const line = parseEngineLine('opencode', {
      type: 'step_finish',
      part: { tokens: { input: 100, output: 50 } },
    });
    expect(line.type).toBeNull();
    expect(line.usage?.tokensIn).toBe(100);
    expect(line.usage?.tokensOut).toBe(50);
  });

  it('step_finish with usage fallback field', () => {
    const line = parseEngineLine('opencode', {
      type: 'step_finish',
      part: { usage: { input: 200, output: 75 } },
    });
    expect(line.usage?.tokensIn).toBe(200);
    expect(line.usage?.tokensOut).toBe(75);
  });

  it('step_finish without token info → no event, no usage', () => {
    const line = parseEngineLine('opencode', { type: 'step_finish', part: {} });
    expect(line.type).toBeNull();
    expect(line.usage).toBeUndefined();
  });

  it('step_finish with zero tokens → no event (both zero → skipped)', () => {
    const line = parseEngineLine('opencode', {
      type: 'step_finish',
      part: { tokens: { input: 0, output: 0 } },
    });
    expect(line.type).toBeNull();
    expect(line.usage).toBeUndefined();
  });

  it('error → isError result event', () => {
    const line = parseEngineLine('opencode', {
      type: 'error',
      part: { message: 'api key missing' },
    });
    expect(line.type).toBe('result');
    expect(line.isError).toBe(true);
    expect((line.payload?.result as string)).toContain('api key missing');
  });

  it('error with o.error fallback', () => {
    const line = parseEngineLine('opencode', {
      type: 'error',
      error: 'network timeout',
      part: {},
    });
    expect(line.type).toBe('result');
    expect(line.isError).toBe(true);
    // Uses part.message fallback, then o.error
    expect((line.payload?.result as string)).toMatch(/network timeout|error/);
  });

  it('null input → no event', () => {
    expect(parseEngineLine('opencode', null).type).toBeNull();
  });
});

// ── end-to-end: fake engine bin emitting JSONL ───────────────────────────────

describe('end-to-end fake engine spawn (opencode shape)', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'fleet-fake-engine-'));
  const FAKE_BIN = join(binDir, 'fake-engine');

  beforeAll(() => {
    // Fake engine: writes 3 JSONL lines then exits 0
    writeFileSync(
      FAKE_BIN,
      `#!/usr/bin/env node
const lines = [
  JSON.stringify({ type: 'step_start', part: {} }),
  JSON.stringify({ type: 'text', part: { text: 'all done' } }),
  JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 5 } } }),
];
for (const l of lines) process.stdout.write(l + '\\n');
process.exit(0);
`,
    );
    chmodSync(FAKE_BIN, 0o755);
  });

  it('spawnEngine + parseEngineLine: collects message text + tokens, exits 0', async () => {
    const { spawnEngine } = await import('../src/engines.js');
    const collected: { text?: string; tokIn?: number; tokOut?: number } = {};

    await new Promise<void>((resolve, reject) => {
      const proc = spawnEngine('opencode', FAKE_BIN, ['run', '--format', 'json', 'task'], '/tmp', {
        onLine: (obj) => {
          const line = parseEngineLine('opencode', obj);
          if (line.resultText) collected.text = line.resultText;
          if (line.usage) {
            collected.tokIn = (collected.tokIn ?? 0) + line.usage.tokensIn;
            collected.tokOut = (collected.tokOut ?? 0) + line.usage.tokensOut;
          }
        },
        onStderr: () => {},
        onExit: (code) => {
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        },
      });
      // safety: if it hangs, reject after 5s
      setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 5000).unref();
    });

    expect(collected.text).toBe('all done');
    expect(collected.tokIn).toBe(10);
    expect(collected.tokOut).toBe(5);
  });
});
