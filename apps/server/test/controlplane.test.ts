import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

// Isolate the DB BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load) is imported.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-controlplane-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let cp: any; // src/controlplane.js module namespace
let pm: any;
let projectsRepo: any;
let kanbanRepo: any;
let app: any;
let PORT: number;
const H = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  PORT = (await import('../src/config.js')).PORT;
  // stub pm.tick so the PM engine doesn't fight the tests
  ({ pm } = await import('../src/pm.js'));
  pm.tick = async () => {};
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  cp = await import('../src/controlplane.js');
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────────
function makeProject(): string {
  return projectsRepo.createProject({ name: 'cp-' + uuid().slice(0, 8), rootDir: '/tmp' }).id;
}

function boardLoop(projectId: string): any {
  return { id: 'loop-' + uuid().slice(0, 6), projectId, kind: 'manager', controlPlane: 'board', mode: 'apply' };
}

function dryLoop(projectId: string): any {
  return { id: 'loop-' + uuid().slice(0, 6), projectId, kind: 'manager', controlPlane: 'board', mode: 'dry-run' };
}

// ── 03.1 — kanban_comments repo ────────────────────────────────────────────────
describe('03.1 — kanban_comments repo', () => {
  it('inserts a comment and reads it back newest-last for the task', () => {
    const taskId = 'task-' + Math.random().toString(36).slice(2);
    const c1 = cp.commentsRepo.add(taskId, 'manager', 'first assessment');
    const c2 = cp.commentsRepo.add(taskId, 'reviewer', 'second note');
    expect(c1.id).toBeTruthy();
    expect(c1.taskId).toBe(taskId);
    expect(c1.author).toBe('manager');
    expect(c1.body).toBe('first assessment');
    expect(typeof c1.createdAt).toBe('number');

    const list = cp.commentsRepo.list(taskId);
    expect(list.map((c: any) => c.id)).toEqual([c1.id, c2.id]); // created_at ASC
    expect(cp.commentsRepo.list('no-such-task')).toEqual([]);
  });
});

// ── 03.2 — control-plane types are structurally usable ─────────────────────────
import type { WorkItem, IntendedAction, ControlPlane } from '../src/controlplane.js';

describe('03.2 — control-plane types are structurally usable', () => {
  it('a WorkItem and an IntendedAction satisfy their shapes', () => {
    const item: WorkItem = { id: 't1', title: 'fix bug', body: 'desc', labels: [] };
    const action: IntendedAction = { kind: 'classify', itemId: item.id, detail: { risk: 'low' } };
    expect(item.id).toBe('t1');
    expect(action.kind).toBe('classify');
    expect(action.itemId).toBe('t1');
    // a minimal ControlPlane is assignable from a plain object literal
    const stub: ControlPlane = {
      listBacklog: async () => [],
      listReady: async () => [],
      classify: async () => {},
      postAssessment: async () => {},
      attachQuestions: async () => {},
    };
    expect(typeof stub.listBacklog).toBe('function');
  });
});

// ── 03.3 — board adapter listBacklog / listReady ───────────────────────────────
describe('03.3 — board adapter listBacklog / listReady', () => {
  it('listBacklog returns only Backlog cards lacking a risk:* label', async () => {
    const pid = makeProject();
    const untriaged = kanbanRepo.createTask({ projectId: pid, title: 'untriaged' });
    const triaged = kanbanRepo.createTask({ projectId: pid, title: 'triaged' });
    kanbanRepo.updateTask(triaged.id, { labels: ['risk:low', 'type:bug'] });
    const readyCard = kanbanRepo.createTask({ projectId: pid, title: 'ready', column: 'Ready' });

    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    const backlog = await board.listBacklog();
    const ids = backlog.map((w: any) => w.id);
    expect(ids).toContain(untriaged.id);
    expect(ids).not.toContain(triaged.id); // already carries risk:low
    expect(ids).not.toContain(readyCard.id); // not in Backlog
    // WorkItem shape: body comes from the card description.
    const w = backlog.find((x: any) => x.id === untriaged.id);
    expect(w.title).toBe('untriaged');
    expect(w.labels).toEqual([]);
  });

  it('listReady returns Ready cards as WorkItems (priority DESC, rank ASC)', async () => {
    const pid = makeProject();
    const lo = kanbanRepo.createTask({ projectId: pid, title: 'lo', column: 'Ready', priority: 1 });
    const hi = kanbanRepo.createTask({ projectId: pid, title: 'hi', column: 'Ready', priority: 4 });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    const ready = await board.listReady();
    const ids = ready.map((w: any) => w.id);
    expect(ids).toEqual([hi.id, lo.id]); // priority DESC ordering preserved
  });
});

// ── 03.4 — board adapter classify ─────────────────────────────────────────────
describe('03.4 — board adapter classify writes labels/assignee and promotes', () => {
  it('agentReady → risk/type + agent:ready, assignee pm, Backlog moved to Ready', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'route me', description: 'd' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'low', type: 'bug', agentReady: true, reason: 'safe' });

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toContain('risk:low');
    expect(after.labels).toContain('type:bug');
    expect(after.labels).toContain('agent:ready');
    expect(after.labels).not.toContain('needs:human');
    expect(after.assignee).toBe('pm');
    expect(after.column).toBe('Ready'); // promoted
  });

  it('not agentReady → needs:human, assignee human, stays in Backlog', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'ambiguous' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'high', type: 'feature', agentReady: false, reason: 'risky' });

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toContain('risk:high');
    expect(after.labels).toContain('type:feature');
    expect(after.labels).toContain('needs:human');
    expect(after.labels).not.toContain('agent:ready');
    expect(after.assignee).toBe('human');
    expect(after.column).toBe('Backlog'); // NOT promoted
  });

  it('re-classifying replaces stale risk/type/routing labels (no dupes)', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'reclassify' });
    kanbanRepo.updateTask(card.id, { labels: ['risk:high', 'type:bug', 'needs:human', 'keepme'] });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'low', type: 'docs', agentReady: true, reason: 'ok' });

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toContain('keepme'); // unrelated label preserved
    expect(after.labels.filter((l: string) => l.startsWith('risk:'))).toEqual(['risk:low']);
    expect(after.labels.filter((l: string) => l.startsWith('type:'))).toEqual(['type:docs']);
    expect(after.labels).toContain('agent:ready');
    expect(after.labels).not.toContain('needs:human');
  });
});

// ── 03.5 — board adapter postAssessment ───────────────────────────────────────
import { subscribeBoard } from '../src/kanban.js';

describe('03.5 — board adapter postAssessment', () => {
  it('inserts a manager comment and broadcasts a task frame', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'assess me' });
    const msgs: any[] = [];
    const unsub = subscribeBoard(pid, (m: any) => msgs.push(m)); // board-hello arrives synchronously
    msgs.length = 0; // drop the hello

    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.postAssessment(card.id, 'Risk: low\nType: bug\nReason: trivial');

    const comments = cp.commentsRepo.list(card.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('manager');
    expect(comments[0].body).toContain('Risk: low');
    // a task frame for the card was broadcast.
    expect(msgs.some((m: any) => m.kind === 'task' && m.task.id === card.id)).toBe(true);
    unsub();
  });
});

// ── 03.6 — board adapter attachQuestions ─────────────────────────────────────
describe('03.6 — board adapter attachQuestions', () => {
  it('adds needs:human (once) and posts a manager question comment', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'has questions' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.attachQuestions(card.id, ['Which API?', 'Backwards compatible?']);
    await board.attachQuestions(card.id, ['And tests?']); // second call must not duplicate needs:human

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels.filter((l: string) => l === 'needs:human')).toEqual(['needs:human']); // exactly one
    const comments = cp.commentsRepo.list(card.id);
    expect(comments).toHaveLength(2);
    expect(comments[0].author).toBe('manager');
    expect(comments[0].body).toContain('Which API?');
    expect(comments[0].body).toContain('Backwards compatible?');
  });

  it('no questions → no label change and no comment', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'no qs' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.attachQuestions(card.id, []);
    expect(kanbanRepo.getTask(card.id).labels).toEqual([]);
    expect(cp.commentsRepo.list(card.id)).toEqual([]);
  });
});

// ── 03.7 — dry-run wrapper suppresses all writes into intended[] ───────────────
describe('03.7 — dry-run wrapper suppresses all writes into intended[]', () => {
  it('classify/postAssessment/attachQuestions are intercepted, no DB write', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'dry card', description: 'd' });
    const { cp: board, intended } = cp.controlPlaneFor(dryLoop(pid), { id: pid } as any);

    // reads still work in dry-run.
    const backlog = await board.listBacklog();
    expect(backlog.map((w: any) => w.id)).toContain(card.id);

    await board.classify(card.id, { risk: 'low', type: 'bug', agentReady: true, reason: 'x' });
    await board.postAssessment(card.id, 'Risk: low');
    await board.attachQuestions(card.id, ['why?']);

    // nothing was written.
    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toEqual([]);
    expect(after.assignee).toBe('human');
    expect(after.column).toBe('Backlog');
    expect(cp.commentsRepo.list(card.id)).toEqual([]);

    // every intended write is recorded, in order.
    expect(intended.map((a: any) => a.kind)).toEqual(['classify', 'assessment', 'questions']);
    expect(intended[0].itemId).toBe(card.id);
    expect(intended[0].detail).toMatchObject({ risk: 'low', agentReady: true });
    expect(intended[1].detail).toBe('Risk: low');
    expect(intended[2].detail).toEqual(['why?']);
  });

  it('apply mode performs real writes and leaves intended empty', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'apply card' });
    const { cp: board, intended } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'low', type: 'bug', agentReady: true, reason: 'x' });
    expect(kanbanRepo.getTask(card.id).labels).toContain('agent:ready'); // real write happened
    expect(intended).toEqual([]);
  });
});

// ── 03.8 — GET /api/tasks/:id/comments ────────────────────────────────────────
describe('03.8 — GET /api/tasks/:id/comments', () => {
  it('returns the card assessment thread, created_at ascending', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'commented' });
    cp.commentsRepo.add(card.id, 'manager', 'first');
    cp.commentsRepo.add(card.id, 'reviewer', 'second');

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${card.id}/comments`, headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((c: any) => c.body)).toEqual(['first', 'second']);
    expect(body[0].author).toBe('manager');
  });

  it('returns an empty array for a card with no comments', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'empty thread' });
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${card.id}/comments`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
