/**
 * Real test for processManager.ts killProcessGroup — the not-in-memory / boot-orphan kill
 * path (PRD §10, H13). Spawns ACTUAL detached processes (no mocks):
 *  - one disguised so its `ps` cmdline looks like claude → it IS killed,
 *  - one plain `sleep` → the H13 identity guard REFUSES to kill it (recycled-PID safety),
 *  - invalid pids → no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-kill-'));

let pm: typeof import('../src/processManager.js');
const spawned: number[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(async () => { pm = await import('../src/processManager.js'); });
afterAll(() => {
  for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

describe('killProcessGroup', () => {
  it('is a no-op for invalid pids', () => {
    expect(() => pm.killProcessGroup(null)).not.toThrow();
    expect(() => pm.killProcessGroup(0)).not.toThrow();
    expect(() => pm.killProcessGroup(1)).not.toThrow();
  });

  it('kills a detached process group whose cmdline looks like claude', async () => {
    // exec -a rewrites argv[0] so `ps -o args=` reports a claude-shaped command line.
    const child = spawn('bash', ['-c', 'exec -a mock-claude-killtest sleep 120'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(500); // let the exec settle so ps sees the new argv0
    expect(pm.looksLikeClaudePid(pid)).toBe(true);

    pm.killProcessGroup(pid, true); // hard = SIGKILL the group now
    await wait(500);
    expect(alive(pid)).toBe(false);
  });

  it('REFUSES to kill an innocent process whose cmdline is not claude-shaped (H13)', async () => {
    const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    spawned.push(pid);
    await wait(400);
    expect(pm.looksLikeClaudePid(pid)).toBe(false); // a recycled/innocent pid

    pm.killProcessGroup(pid, true); // guard short-circuits → no signal sent
    await wait(400);
    expect(alive(pid)).toBe(true); // survived — the safety guard held

    process.kill(pid, 'SIGKILL'); // explicit cleanup
  });
});
