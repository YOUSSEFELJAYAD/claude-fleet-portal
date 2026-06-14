/**
 * fn-inbox-resolve — draining the command-approval queue. resolveApproval(id,'approve')
 * executes the parked command (via the stored line+cwd) and removes the entry from the
 * inbox; resolveApproval(id,'deny') removes it WITHOUT executing. The queue is also
 * bounded: enqueueing past the cap drops the oldest entries so it can never grow without
 * limit. Isolated tmp DB (importing inbox pulls registry + db).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-inbox-resolve-'));

let inbox: typeof import('../src/inbox.js');
beforeAll(async () => { inbox = await import('../src/inbox.js'); });
beforeEach(() => inbox.__clearApprovalsForTests());

describe('resolveApproval', () => {
  it('approve runs the parked command (via its stored line) and removes the entry', async () => {
    // /reset-data is a danger verb whose run() returns a deterministic ok text — a clean,
    // registry-independent way to assert the parked command actually executed on approve.
    const id = inbox.enqueueApproval({
      command: 'reset-data',
      summary: 'Wipe all portal runs/history and reset config (destructive)',
      cwd: '/repo',
      line: '/reset-data',
    });
    expect(inbox.getInboxItems().some((i) => i.kind === 'command' && i.approval?.id === id)).toBe(true);

    const out = await inbox.resolveApproval(id, 'approve');
    expect(out.ran).toBeTruthy();
    expect(out.ran!.ok).toBe(true);
    // the entry is gone from the inbox after resolution
    expect(inbox.getInboxItems().some((i) => i.kind === 'command' && i.approval?.id === id)).toBe(false);
  });

  it('deny removes the entry WITHOUT executing the parked command', async () => {
    const id = inbox.enqueueApproval({
      command: 'reset-data',
      summary: 'Wipe all portal runs/history and reset config (destructive)',
      cwd: '/repo',
      line: '/reset-data',
    });
    const out = await inbox.resolveApproval(id, 'deny');
    expect(out.ran).toBeUndefined();
    expect(inbox.getInboxItems().some((i) => i.kind === 'command' && i.approval?.id === id)).toBe(false);
  });

  it('resolving an unknown id is a no-op (no throw, nothing ran)', async () => {
    const out = await inbox.resolveApproval('does-not-exist', 'approve');
    expect(out.ran).toBeUndefined();
  });
});

describe('pendingApprovals cap', () => {
  it('is bounded — enqueueing past the max drops the oldest entries', () => {
    const N = 50; // safely past any sane cap
    for (let i = 0; i < N; i++) {
      inbox.enqueueApproval({ command: 'reset-data', summary: `s${i}`, cwd: '/repo', line: '/reset-data' });
    }
    const commandItems = inbox.getInboxItems().filter((i) => i.kind === 'command');
    expect(commandItems.length).toBeLessThan(N);
    // the most-recent enqueue survives; the oldest were dropped
    expect(commandItems.some((i) => i.approval?.summary === `s${N - 1}`)).toBe(true);
    expect(commandItems.some((i) => i.approval?.summary === 's0')).toBe(false);
  });
});
