/**
 * fn-inbox-enqueue — the command-approval queue. enqueueApproval() parks a pending
 * destructive action; getInboxItems() must surface it as a 'command' inbox item.
 * Isolated tmp DB (importing inbox pulls registry + db).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-inbox-enq-'));

let inbox: typeof import('../src/inbox.js');
beforeAll(async () => { inbox = await import('../src/inbox.js'); });
beforeEach(() => inbox.__clearApprovalsForTests());

describe('enqueueApproval', () => {
  it('returns an id and surfaces a command inbox item with the verb + summary', () => {
    const id = inbox.enqueueApproval({ command: 'stop-all', summary: 'Stop all running agents', cwd: '/repo' });
    expect(typeof id).toBe('string');
    const items = inbox.getInboxItems();
    const mine = items.find((i) => i.kind === 'command' && i.approval?.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.approval!.command).toBe('stop-all');
    expect(mine!.approval!.summary).toBe('Stop all running agents');
    expect(mine!.approval!.cwd).toBe('/repo');
  });

  it('keeps derived run items and command items in the same list', () => {
    inbox.enqueueApproval({ command: 'self-update', summary: 'Self-update the portal', cwd: '/repo' });
    const items = inbox.getInboxItems();
    expect(items.every((i) => ['permission', 'input', 'command'].includes(i.kind))).toBe(true);
    expect(items.some((i) => i.kind === 'command')).toBe(true);
  });
});
