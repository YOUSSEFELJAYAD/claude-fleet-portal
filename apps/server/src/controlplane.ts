/**
 * Control plane (Loops feature, spec docs/superpowers/specs/2026-06-13-loop-engineering-design.md §5).
 *
 * One ControlPlane interface, two adapters selected per-loop by `loop.controlPlane`:
 *   • board  — reads/writes the local kanban via kanbanRepo (this slice, fully offline)
 *   • github — issues + labels (Slice 07; a marked throw-stub here)
 *
 * Self-contained module (mirrors scheduler.ts): owns the `kanban_comments` table (§4.4) +
 * its prepared statements + the GET /api/tasks/:id/comments route registrar.
 *
 * Dry-run wrapper: controlPlaneFor(loop) wraps the adapter so that in mode='dry-run' the three
 * write verbs (classify/postAssessment/attachQuestions) are intercepted into `intended[]` and
 * NOT performed; mode='apply' performs real writes and leaves intended empty.
 *
 * NOTE: exports are plain named exports (not a mutable object) so test suites can
 * property-reassign them on the module namespace (e.g. `(controlplane as any).controlPlaneFor = ...`).
 * Vitest with { deps: { interopDefault: true } } or vite-node SSR allows this via the
 * makeExportsWritable helper in setup-loop-stubs.ts.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Loop, TriageVerdict, KanbanTask, Project } from '@fleet/shared';
import { RISK_LABELS, TYPE_LABELS, ROUTING } from '@fleet/shared';
import db from './db.js';
import { kanbanRepo, broadcastTask } from './kanban.js';
import { ghExec, resolveRemote, ghLabelAdd, ghLabelRemove, ghIssueComment } from './gh.js';
import { parseRepoSlug } from './release.js';

// ── schema (idempotent, §4.4) ───────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS kanban_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_comments_task ON kanban_comments(task_id, created_at);
`);

// ── comment types + repo ────────────────────────────────────────────────────────
export type CommentAuthor = 'manager' | 'reviewer' | 'worker' | 'human';

export interface KanbanComment {
  id: string;
  taskId: string;
  author: CommentAuthor;
  body: string;
  createdAt: number;
}

const insertCommentStmt = db.prepare(
  `INSERT INTO kanban_comments (id, task_id, author, body, created_at) VALUES (@id, @task_id, @author, @body, @created_at)`,
);
const listCommentsStmt = db.prepare(
  `SELECT id, task_id, author, body, created_at FROM kanban_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
);

function rowToComment(r: any): KanbanComment {
  return {
    id: r.id,
    taskId: r.task_id,
    author: r.author as CommentAuthor,
    body: r.body,
    createdAt: r.created_at,
  };
}

// Monotonically-increasing sequence for created_at: Date.now() can return duplicate
// milliseconds for rapid insertions, so we track the last-issued timestamp and bump
// by one when the wall clock hasn't advanced. This keeps ordering stable in tests and prod.
let _lastCommentTs = 0;
function nextCommentTs(): number {
  const now = Date.now();
  if (now > _lastCommentTs) {
    _lastCommentTs = now;
  } else {
    _lastCommentTs += 1;
  }
  return _lastCommentTs;
}

export const commentsRepo = {
  add(taskId: string, author: CommentAuthor, body: string): KanbanComment {
    const c: KanbanComment = { id: randomUUID(), taskId, author, body, createdAt: nextCommentTs() };
    insertCommentStmt.run({ id: c.id, task_id: c.taskId, author: c.author, body: c.body, created_at: c.createdAt });
    return c;
  },
  list(taskId: string): KanbanComment[] {
    return (listCommentsStmt.all(taskId) as any[]).map(rowToComment);
  },
};

// ── control-plane contract (§5) ──────────────────────────────────────────────────
export interface WorkItem {
  id: string;
  title: string;
  body: string;
  labels: string[];
}

export type IntendedAction = {
  kind: 'classify' | 'assessment' | 'questions';
  itemId: string;
  detail: unknown;
};

export interface ControlPlane {
  listBacklog(): Promise<WorkItem[]>;
  listReady(): Promise<WorkItem[]>;
  classify(itemId: string, v: TriageVerdict): Promise<void>;
  postAssessment(itemId: string, markdown: string): Promise<void>;
  attachQuestions(itemId: string, questions: string[]): Promise<void>;
}

// ── board adapter helpers ────────────────────────────────────────────────────────
const RISK_LABEL_SET = new Set<string>(Object.values(RISK_LABELS)); // risk:low|risk:medium|risk:high
const ROUTING_LABELS = new Set<string>([ROUTING.ready, ROUTING.needsHuman]); // agent:ready | needs:human

function taskToWorkItem(t: KanbanTask): WorkItem {
  return { id: t.id, title: t.title, body: t.description, labels: t.labels };
}

function hasRiskLabel(labels: string[]): boolean {
  return labels.some((l) => RISK_LABEL_SET.has(l));
}

/** Strip any prior risk:* / type:* / routing labels so classify is idempotent on re-run. */
function stripVerdictLabels(labels: string[]): string[] {
  return labels.filter(
    (l) => !l.startsWith('risk:') && !l.startsWith('type:') && !ROUTING_LABELS.has(l),
  );
}

// ── board adapter (§5: kanban_tasks via kanbanRepo) ──────────────────────────────
function makeBoardAdapter(projectId: string): ControlPlane {
  return {
    // untriaged = Backlog cards with no risk:* label yet.
    async listBacklog(): Promise<WorkItem[]> {
      return kanbanRepo
        .listTasks(projectId)
        .filter((t) => t.column === 'Backlog' && !hasRiskLabel(t.labels))
        .map(taskToWorkItem);
    },
    // Ready = the existing PM selection query (priority DESC, rank ASC).
    async listReady(): Promise<WorkItem[]> {
      return kanbanRepo.readyTasks(projectId).map(taskToWorkItem);
    },
    async classify(itemId: string, v: TriageVerdict): Promise<void> {
      const card = kanbanRepo.getTask(itemId);
      if (!card) return; // adapters never throw out of a fire (§18)
      const labels = stripVerdictLabels(card.labels);
      labels.push(RISK_LABELS[v.risk]); // risk:low|risk:medium|risk:high
      labels.push(TYPE_LABELS[v.type]); // type:<work-type>
      const patch: Partial<KanbanTask> = { labels };
      if (v.agentReady) {
        labels.push(ROUTING.ready); // agent:ready
        patch.assignee = 'pm';
        if (card.column === 'Backlog') patch.column = 'Ready'; // promote
      } else {
        labels.push(ROUTING.needsHuman); // needs:human
        patch.assignee = 'human';
      }
      kanbanRepo.updateTask(itemId, patch); // broadcasts a task frame
    },
    async postAssessment(itemId: string, markdown: string): Promise<void> {
      commentsRepo.add(itemId, 'manager', markdown);
      const card = kanbanRepo.getTask(itemId);
      if (card) broadcastTask(card); // no comment frame in KanbanBoardMessage → refresh via task frame
    },
    async attachQuestions(itemId: string, questions: string[]): Promise<void> {
      if (questions.length === 0) return;
      const card = kanbanRepo.getTask(itemId);
      if (!card) return;
      if (!card.labels.includes(ROUTING.needsHuman)) {
        kanbanRepo.updateTask(itemId, { labels: [...card.labels, ROUTING.needsHuman] });
      }
      const body = ['**Open questions (needs:human):**', ...questions.map((q) => `- ${q}`)].join('\n');
      commentsRepo.add(itemId, 'manager', body);
    },
  };
}

// ── github control-plane: issue intake (mirrors triggers.ts fetchIssuesWithLabel) ──

/** Raw GitHub REST issue shape (the fields we read; labels may be objects or bare strings). */
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name?: string } | string>;
}

/** PURE: map a GitHub REST issue to a control-plane WorkItem; flatten labels[].name, null body → ''. */
export function issueToWorkItem(issue: GhIssue): WorkItem {
  const labels = (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : typeof l?.name === 'string' ? l.name : ''))
    .filter(Boolean);
  return { id: String(issue.number), title: issue.title, body: issue.body ?? '', labels };
}

/**
 * Resolve `owner/repo` for a project from its configured remote (scrubbed URL via resolveRemote +
 * parseRepoSlug). Returns null when no GitHub remote is configured — the github adapter then treats
 * the backlog/ready as empty (no work), exactly like triggers.ts treats a failed gh call.
 */
async function ghRepoSlug(project: Project): Promise<string | null> {
  const remote = await resolveRemote(project.rootDir, project.remoteName);
  if (!remote.resolves || !remote.url) return null;
  return parseRepoSlug(remote.url);
}

/** Fetch open issues for a repo (mirrors triggers.ts fetchIssuesWithLabel; null on any gh failure). */
async function fetchOpenIssues(root: string, ghRepo: string): Promise<GhIssue[] | null> {
  const r = await ghExec(root, [
    'api', `repos/${ghRepo}/issues`,
    '--method', 'GET',
    '-f', 'state=open',
    '-f', 'per_page=20',
  ]);
  if (!r.ok) return null;
  try {
    const items = JSON.parse(r.stdout);
    if (!Array.isArray(items)) return null;
    return items as GhIssue[];
  } catch {
    return null;
  }
}

/** PURE: an item is untriaged backlog when it carries NO risk:* label. */
export function selectBacklog(items: WorkItem[]): WorkItem[] {
  return items.filter((i) => !i.labels.some((l) => l.startsWith('risk:')));
}

/** PURE: an item is ready when it carries the agent:ready routing label. */
export function selectReady(items: WorkItem[]): WorkItem[] {
  return items.filter((i) => i.labels.includes(ROUTING.ready));
}

/**
 * The github control plane: reads open issues via `gh api` and writes via the gh issue verbs.
 * Reads return [] (treated as "no work") when no GitHub remote is configured or gh fails — the
 * fire is then skipped by the scheduler, exactly like triggers.ts on a failed gh call.
 */
export function githubControlPlane(loop: Loop, project: Project): ControlPlane {
  const root = project.rootDir;
  async function fetchAll(): Promise<WorkItem[]> {
    const slug = await ghRepoSlug(project);
    if (!slug) return [];
    const issues = await fetchOpenIssues(root, slug);
    if (!issues) return [];
    return issues.map(issueToWorkItem);
  }
  return {
    async listBacklog() {
      return selectBacklog(await fetchAll());
    },
    async listReady() {
      return selectReady(await fetchAll());
    },
    async classify(itemId: string, v: TriageVerdict) {
      const n = Number(itemId);
      await ghLabelAdd(root, n, RISK_LABELS[v.risk]);
      await ghLabelAdd(root, n, TYPE_LABELS[v.type]);
      if (v.agentReady) {
        await ghLabelAdd(root, n, ROUTING.ready);
        await ghLabelRemove(root, n, ROUTING.needsHuman);
      } else {
        await ghLabelAdd(root, n, ROUTING.needsHuman);
        await ghLabelRemove(root, n, ROUTING.ready);
      }
    },
    async postAssessment(itemId: string, markdown: string) {
      await ghIssueComment(root, Number(itemId), markdown);
    },
    async attachQuestions(itemId: string, questions: string[]) {
      const n = Number(itemId);
      const body = ['**Questions for a human before this is agent-ready:**', '', ...questions.map((q) => `- ${q}`)].join('\n');
      await ghIssueComment(root, n, body);
      await ghLabelAdd(root, n, ROUTING.needsHuman);
    },
  };
}

// ── dry-run wrapper ───────────────────────────────────────────────────────────────
function dryRunWrap(real: ControlPlane, intended: IntendedAction[]): ControlPlane {
  return {
    listBacklog: () => real.listBacklog(), // reads pass through unchanged
    listReady: () => real.listReady(),
    async classify(itemId, v) {
      intended.push({ kind: 'classify', itemId, detail: v });
    },
    async postAssessment(itemId, markdown) {
      intended.push({ kind: 'assessment', itemId, detail: markdown });
    },
    async attachQuestions(itemId, questions) {
      intended.push({ kind: 'questions', itemId, detail: questions });
    },
  };
}

// ── adapter selection + dry-run wrapper (§5) ─────────────────────────────────────
export function controlPlaneFor(
  loop: Loop,
  project: Project,
): { cp: ControlPlane; intended: IntendedAction[] } {
  const real =
    loop.controlPlane === 'github'
      ? githubControlPlane(loop, project) // Slice 07: gh issues + labels (ghLabelAdd/ghIssueComment)
      : makeBoardAdapter(loop.projectId); // Slice 03: local kanban via kanbanRepo
  const intended: IntendedAction[] = [];
  if (loop.mode === 'dry-run') return { cp: dryRunWrap(real, intended), intended };
  return { cp: real, intended };
}

// ── routes (§16: GET /api/tasks/:id/comments — the board assessment thread) ───────
export function registerControlPlaneRoutes(app: FastifyInstance): void {
  app.get('/api/tasks/:id/comments', async (req) => {
    const id = (req.params as any).id as string;
    return commentsRepo.list(id);
  });
}
