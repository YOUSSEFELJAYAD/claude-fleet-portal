/**
 * Agent-Teams watcher (PRD §7.4, §8.1). Reads the shared task list at
 * ~/.claude/tasks/{id}/ — numbered N.json files (schema verified, DC.md F-3) —
 * plus any mailbox file, and watches the dir for live updates.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TASKS_DIR } from './config.js';
import type { TeamView, TeamTask, TeamMessage } from '@fleet/shared';

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readTasks(dir: string): { tasks: TeamTask[]; updatedAt: number } {
  const files = safeList(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  const tasks: TeamTask[] = [];
  let updatedAt = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const t = JSON.parse(readFileSync(p, 'utf8'));
      tasks.push({
        id: String(t.id ?? f.replace('.json', '')),
        subject: t.subject ?? '(untitled)',
        description: t.description,
        activeForm: t.activeForm,
        status: t.status ?? 'pending',
        blocks: Array.isArray(t.blocks) ? t.blocks.map(String) : [],
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
        owner: t.owner ?? t.assignee ?? null,
      });
      updatedAt = Math.max(updatedAt, statSync(p).mtimeMs);
    } catch {
      /* skip unreadable/partial task file */
    }
  }
  return { tasks, updatedAt };
}

/** Best-effort mailbox read: mailbox/messages/inbox files if a team uses them (F-3 note). */
function readMessages(dir: string): TeamMessage[] {
  const out: TeamMessage[] = [];
  for (const name of ['messages.json', 'mailbox.json', 'inbox.json']) {
    const p = path.join(dir, name);
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      const arr = Array.isArray(data) ? data : Array.isArray(data.messages) ? data.messages : [];
      for (const m of arr) {
        out.push({
          from: m.from ?? m.sender,
          to: m.to ?? m.recipient,
          ts: m.ts ?? m.timestamp,
          text: m.text ?? m.body ?? JSON.stringify(m),
          raw: m,
        });
      }
    } catch {
      /* no mailbox of this name */
    }
  }
  return out;
}

export function readTeam(id: string): TeamView | null {
  const dir = path.join(TASKS_DIR, id);
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const { tasks, updatedAt } = readTasks(dir);
  return {
    id,
    name: id.length > 12 ? id.slice(0, 8) : id,
    taskDir: dir,
    tasks,
    messages: readMessages(dir),
    updatedAt,
  };
}

export function listTeams(): Array<{ id: string; name: string; taskDir: string; taskCount: number; updatedAt: number }> {
  return safeList(TASKS_DIR)
    .map((id) => {
      const dir = path.join(TASKS_DIR, id);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        return null;
      }
      if (!isDir) return null;
      const { tasks, updatedAt } = readTasks(dir);
      if (tasks.length === 0) return null; // only surface dirs that hold a task list
      return { id, name: id.slice(0, 8), taskDir: dir, taskCount: tasks.length, updatedAt };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Watch a team's task dir; invoke cb (debounced) with a fresh TeamView on change. */
export function watchTeam(id: string, cb: (view: TeamView) => void): () => void {
  const dir = path.join(TASKS_DIR, id);
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const view = readTeam(id);
      if (view) cb(view);
    }, 150);
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 1 });
    watcher.on('all', fire);
  } catch {
    /* dir may not exist */
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
