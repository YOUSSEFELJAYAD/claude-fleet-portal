/**
 * F-notify — the notifier emits an in-app notification (broadcast on the bus) when a run
 * pauses for a permission decision (PreToolUse gate) or asks a question (ask_human gate).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate DB before any src module is imported (dynamic imports in beforeAll).
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-notify-gates-'));
process.env.FLEET_DATA_DIR = dataDir;

let enqueuePermission: any, __clearPermissionsForTests: any;
let enqueueGate: any, __clearGatesForTests: any;
let subscribeNotifications: any, initNotifier: any;

beforeAll(async () => {
  ({ enqueuePermission, __clearPermissionsForTests } = await import('../src/permissionGate.js'));
  ({ enqueueGate, __clearGatesForTests } = await import('../src/gate.js'));
  ({ subscribeNotifications, initNotifier } = await import('../src/notifier.js'));
  initNotifier(); // registers the permission/gate enqueue subscribers
});

describe('notifier gate alerts', () => {
  it('broadcasts an awaiting-permission notification on permission enqueue', () => {
    const rows: any[] = [];
    const off = subscribeNotifications((r: any) => rows.push(r));
    enqueuePermission({ sessionId: 'r1', tool: 'Bash', input: { command: 'rm x' }, toolUseId: 't', cwd: '/tmp' });
    off();
    // EXACTLY one row per enqueue — a count assertion (not .some()) so a double-fire regression
    // (e.g. a duplicate subscriber from a second initNotifier) would actually fail this test.
    expect(rows.filter((r) => r.kind === 'awaiting-permission' && r.message.includes('Bash'))).toHaveLength(1);
    __clearPermissionsForTests();
  });

  it('broadcasts an awaiting-question notification on gate enqueue', () => {
    const rows: any[] = [];
    const off = subscribeNotifications((r: any) => rows.push(r));
    enqueueGate({ sessionId: 'r2', question: 'Deploy to prod?', options: ['yes', 'no'], multiSelect: false, allowFreeText: false });
    off();
    expect(rows.filter((r) => r.kind === 'awaiting-question' && r.message.includes('Deploy to prod?'))).toHaveLength(1);
    __clearGatesForTests();
  });
});
