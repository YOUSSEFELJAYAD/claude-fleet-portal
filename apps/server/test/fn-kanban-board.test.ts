/**
 * Real tests for kanban.ts board pub/sub — subscribeBoard / broadcastBoard / broadcastTask.
 * Exercises the actual in-module subscriber registry (no mocks): a subscriber gets an
 * immediate board-hello, then live frames, and stops receiving after unsubscribe.
 * Importing kanban pulls db → isolated tmp DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-kanban-board-'));

let kanban: typeof import('../src/kanban.js');
beforeAll(async () => { kanban = await import('../src/kanban.js'); });

describe('subscribeBoard', () => {
  it('immediately emits a board-hello snapshot (empty board is valid)', () => {
    const seen: any[] = [];
    const off = kanban.subscribeBoard('proj-1', (m) => seen.push(m));
    expect(seen[0]).toEqual({ kind: 'board-hello', tasks: [] });
    off();
  });

  it('delivers broadcastBoard frames to live subscribers and stops after unsubscribe', () => {
    const seen: any[] = [];
    const off = kanban.subscribeBoard('proj-2', (m) => seen.push(m));
    const frame = { kind: 'task-removed', taskId: 't9' } as any;
    kanban.broadcastBoard('proj-2', frame);
    expect(seen).toContainEqual(frame);

    off();
    kanban.broadcastBoard('proj-2', { kind: 'task-removed', taskId: 't10' } as any);
    expect(seen.find((m) => m.taskId === 't10')).toBeUndefined();
  });

  it('broadcastTask wraps a card as a task frame for its project', () => {
    const seen: any[] = [];
    const off = kanban.subscribeBoard('proj-3', (m) => seen.push(m));
    const task = { id: 't1', projectId: 'proj-3', title: 'do x' } as any;
    kanban.broadcastTask(task);
    expect(seen).toContainEqual({ kind: 'task', task });
    off();
  });

  it('broadcasting to a project with no subscribers is a harmless no-op', () => {
    expect(() => kanban.broadcastBoard('nobody-home', { kind: 'task-removed', taskId: 'x' } as any)).not.toThrow();
  });

  it('broadcastBoard guards against a subscriber that throws on a live frame', () => {
    const good: any[] = [];
    // throws only on live frames (the initial board-hello is emitted synchronously by
    // subscribeBoard and is intentionally NOT guarded — only the broadcast loop is).
    const offBad = kanban.subscribeBoard('proj-4', (m) => { if (m.kind !== 'board-hello') throw new Error('dead subscriber'); });
    const offGood = kanban.subscribeBoard('proj-4', (m) => good.push(m));
    expect(() => kanban.broadcastBoard('proj-4', { kind: 'task-removed', taskId: 'z' } as any)).not.toThrow();
    expect(good.find((m) => m.taskId === 'z')).toBeDefined();
    offBad(); offGood();
  });
});
