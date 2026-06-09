import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn the real mock-claude child through the registry, then prove shutdown() kills it.
// Env must be set BEFORE config.js is imported (CLAUDE_BIN is read at import time).
const here = dirname(fileURLToPath(import.meta.url));
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-sd-'));
process.env.CLAUDE_BIN = resolve(here, '..', '..', '..', 'tools', 'mock-claude.mjs');
process.env.MOCK_DELAY_MS = '6000'; // keep the child alive long enough to kill it mid-run

let registry: any;
let repo: any;
beforeAll(async () => {
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('registry.shutdown() kills live children (H4 integration, mock-claude)', () => {
  it('terminates the spawned child process group on shutdown', async () => {
    const run = registry.launch({
      prompt: 'hi',
      cwd: process.env.FLEET_DATA_DIR,
      model: 'claude-haiku-4-5',
      effort: 'medium',
      permissionMode: 'default',
      interactive: true,
    });

    let pid: number | null = null;
    for (let i = 0; i < 60 && !pid; i++) {
      await sleep(50);
      pid = registry.getRun(run.id)?.pid ?? null;
    }
    expect(pid).toBeTruthy();
    expect(alive(pid!)).toBe(true); // child running before shutdown

    // H13 — the identity guard must recognize our spawned child (so shutdown can kill it),
    // and must NOT match a dead/unrelated pid.
    const { looksLikeClaudePid } = await import('../src/processManager.js');
    expect(looksLikeClaudePid(pid!)).toBe(true);
    expect(looksLikeClaudePid(2_000_000_000)).toBe(false);

    // H13 — the boot orphan-sweep finds non-terminal runs by persisted pid; confirm the live
    // child's pid IS in that set (so a real post-restart orphan WOULD be discovered + reaped).
    expect(repo.nonTerminalPids()).toContain(pid);

    registry.shutdown();

    let dead = false;
    for (let i = 0; i < 60 && !dead; i++) {
      await sleep(50);
      dead = !alive(pid!);
    }
    expect(dead).toBe(true); // child reaped by shutdown()
  });
});
