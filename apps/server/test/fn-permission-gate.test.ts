import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __clearPermissionsForTests,
  enqueuePermission,
  resolvePermission,
  listPermissions,
  rejectPermissionsForSession,
  subscribePermissionEnqueued,
} from '../src/permissionGate.js';

const mk = (over: Partial<Parameters<typeof enqueuePermission>[0]> = {}) =>
  enqueuePermission({ sessionId: 's1', tool: 'Bash', input: { command: 'rm -rf x' }, toolUseId: 'tu1', cwd: '/tmp', ...over });

describe('permission gate store', () => {
  beforeEach(() => __clearPermissionsForTests());

  it('enqueues a pending permission and lists it', () => {
    const { id } = mk();
    const list = listPermissions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, sessionId: 's1', tool: 'Bash', toolUseId: 'tu1', cwd: '/tmp' });
  });

  it('resolvePermission settles the awaited promise and removes the entry', async () => {
    const p = mk();
    resolvePermission(p.id, { decision: 'allow', reason: 'ok' });
    await expect(p.answer).resolves.toEqual({ decision: 'allow', reason: 'ok' });
    expect(listPermissions()).toHaveLength(0);
  });

  it('rejectPermissionsForSession DENIES pending permissions (fail-closed) for a session', async () => {
    const p = mk({ sessionId: 's9' });
    rejectPermissionsForSession('s9', 'run killed');
    await expect(p.answer).resolves.toEqual({ decision: 'deny', reason: 'run killed' });
    expect(listPermissions()).toHaveLength(0);
  });

  it('resolvePermission on an unknown id is a no-op', () => {
    expect(() => resolvePermission('nope', { decision: 'allow' })).not.toThrow();
  });

  it('fires subscribers on enqueue', () => {
    const seen: string[] = [];
    const off = subscribePermissionEnqueued((p) => seen.push(p.tool));
    mk({ tool: 'Write' });
    off();
    mk({ tool: 'Edit' }); // after unsubscribe — not seen
    expect(seen).toEqual(['Write']);
  });

  describe('TTL', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('auto-DENIES an unanswered permission after the TTL and removes it', async () => {
      const p = mk();
      expect(listPermissions()).toHaveLength(1);
      vi.advanceTimersByTime(900_000 + 10);
      await expect(p.answer).resolves.toEqual({ decision: 'deny', reason: 'permission request timed out' });
      expect(listPermissions()).toHaveLength(0);
    });

    it('does not fire the TTL if answered first (timer cleared, no double-resolve)', async () => {
      const p = mk();
      resolvePermission(p.id, { decision: 'allow' });
      await expect(p.answer).resolves.toEqual({ decision: 'allow' });
      vi.advanceTimersByTime(900_000 + 10);
      expect(listPermissions()).toHaveLength(0);
    });
  });
});
