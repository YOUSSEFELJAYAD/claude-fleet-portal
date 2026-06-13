# Chat Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-session `/chat` dashboard that is both a live agent chat (Claude + engine add-ons) and a fleet control-plane (slash-commands + a running-agents panel), reusing the existing launch/resume/SSE machinery.

**Architecture:** A chat session maps to one run id, advanced resume-per-turn (turn 1 = `registry.launch`, turn N = `registry.resume`); engine sessions are one-shot per turn with a reconstructed transcript. Server: `chat.ts` (persistence + turn orchestration + routes) and `commands.ts` (slash-command dispatch). Web: a 3-pane `/chat` page reusing `useRunStream`/`useFleet`, `ModelSelect`, and the existing pickers. Assistant turns are persisted by the client on stream-terminal (a generic add-message route).

**Tech Stack:** TypeScript, Fastify, better-sqlite3 (`db` default export), Next.js/React, vitest. Reuses `registry.launch/resume/stop/listRuns`, `GET /api/agents/:id/stream`, `/api/fleet/stream`.

**Spec:** `docs/superpowers/specs/2026-06-13-chat-dashboard-design.md` · **Decisions:** DC.md §30 (D-029…D-032)

**Plan refinements vs spec (flagged):**
1. **Assistant-message persistence** is client-driven: on stream-terminal the client POSTs the final text to a generic `POST /api/chat/sessions/:id/messages`. Server-side terminal-subscription persistence is a noted future hardening (if the client disconnects mid-turn, that one reply isn't persisted; the run still completes). Uses only confirmed primitives.
2. **`/schedule` command** renders a pointer to the Schedules page in v1 (the schedule-create path isn't cleanly exported); the other commands (`/help`, `/agents`, `/kill`, `/launch`, `/campaign`, `/addons`, `/addon enable|disable`) are fully implemented. `/schedule` full dispatch is a fast-follow.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/index.ts` | modify | Chat types: `ChatSession`, `ChatMessage`, role/kind unions, request/response, `ChatCommandResult`. |
| `apps/server/src/chat.ts` | create | `chatRepo` (sqlite CRUD), `buildEnginePrompt`, `startTurn`, `registerChatRoutes`. |
| `apps/server/src/commands.ts` | create | `dispatchCommand` + the `COMMANDS` registry. |
| `apps/server/src/addons.ts` | modify | Export `listAddonInfos()` and `setAddonEnabledById()` for the `/addons` commands. |
| `apps/server/src/server.ts` | modify | `registerChatRoutes(app)`. |
| `apps/web/lib/api.ts` | modify | Chat client helpers. |
| `apps/web/app/chat/page.tsx` | create | 3-pane dashboard. |
| `apps/web/components/ChatSessionList.tsx` | create | Session switcher. |
| `apps/web/components/ChatThread.tsx` | create | Message list + streaming turn. |
| `apps/web/components/ChatComposer.tsx` | create | Input + options popover + slash menu. |
| `apps/web/components/RunningAgentsPanel.tsx` | create | Live running-runs panel. |
| `apps/web/components/Shell.tsx` | modify | `/chat` nav entry. |
| `apps/server/test/chat.test.ts` | create | Repo CRUD + turn orchestration + engine prompt. |
| `apps/server/test/commands.test.ts` | create | Command dispatch. |

---

## Task 1: Shared types

**Files:** Modify `packages/shared/src/index.ts` (append after the web-research §28 block)

- [ ] **Step 1: Add the types**

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Chat Dashboard (§30) — multi-session agent control-plane
// ─────────────────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatMessageKind = 'text' | 'command' | 'command-result' | 'error';

export interface ChatSession {
  id: string;
  title: string;
  engine: RunEngine;          // 'claude' | 'codex' | 'opencode'
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  cwd: string;
  allowedTools: string[] | null;
  skills: string[] | null;
  runId: string | null;       // current backing run (null until first turn)
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  runId: string | null;       // links an assistant turn to the run that produced it
  createdAt: number;
}

export interface CreateChatSessionRequest {
  title?: string;
  engine?: RunEngine;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  cwd: string;
  allowedTools?: string[] | null;
  skills?: string[] | null;
}

export interface ChatTurnRequest { message: string }
export interface ChatTurnResponse { runId: string; userMessage: ChatMessage }

export interface AddChatMessageRequest {
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  runId?: string | null;
}

export interface ChatCommandResult {
  ok: boolean;
  kind: 'text' | 'table' | 'error';
  text?: string;
  columns?: string[];
  rows?: string[][];
  runId?: string | null;      // when a command started a run
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fleet/shared typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): chat dashboard types"
```

---

## Task 2: Chat persistence (`chatRepo`)

**Files:** Create `apps/server/src/chat.ts` · Test `apps/server/test/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/chat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chatRepo } from '../src/chat.js';

describe('chatRepo', () => {
  it('creates, lists, gets, renames, and deletes a session', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/x', title: 'first' });
    expect(s.id).toBeTruthy();
    expect(s.title).toBe('first');
    expect(s.engine).toBe('claude');
    expect(s.runId).toBeNull();

    expect(chatRepo.getSession(s.id)?.id).toBe(s.id);
    expect(chatRepo.listSessions().some((x) => x.id === s.id)).toBe(true);

    chatRepo.renameSession(s.id, 'renamed');
    expect(chatRepo.getSession(s.id)?.title).toBe('renamed');

    chatRepo.setSessionRun(s.id, 'run-1');
    expect(chatRepo.getSession(s.id)?.runId).toBe('run-1');

    chatRepo.deleteSession(s.id);
    expect(chatRepo.getSession(s.id)).toBeNull();
  });

  it('appends and lists messages in order', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/y' });
    chatRepo.addMessage({ sessionId: s.id, role: 'user', kind: 'text', content: 'hi', runId: null });
    chatRepo.addMessage({ sessionId: s.id, role: 'assistant', kind: 'text', content: 'hello', runId: 'r1' });
    const msgs = chatRepo.listMessages(s.id);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(msgs[1].runId).toBe('r1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/chat.test.ts`
Expected: FAIL — `Cannot find module '../src/chat.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/chat.ts`:

```typescript
/**
 * Chat Dashboard (§30) — multi-session agent control-plane.
 * A chat session maps to one run id, advanced resume-per-turn (DC §D-029). This module owns
 * session/message persistence, turn orchestration, and the HTTP routes.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import db from './db.js';
import type {
  ChatSession, ChatMessage, ChatRole, ChatMessageKind,
  CreateChatSessionRequest, RunEngine, EffortLevel, PermissionMode,
} from '@fleet/shared';

db.exec(`
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'claude',
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  cwd TEXT NOT NULL,
  allowed_tools TEXT,
  skills TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
`);

const insSession = db.prepare(`INSERT INTO chat_sessions
  (id,title,engine,model,effort,permission_mode,cwd,allowed_tools,skills,run_id,created_at,updated_at)
  VALUES (@id,@title,@engine,@model,@effort,@permission_mode,@cwd,@allowed_tools,@skills,@run_id,@created_at,@updated_at)`);
const getSessionStmt = db.prepare('SELECT * FROM chat_sessions WHERE id = ?');
const listSessionsStmt = db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC');
const renameStmt = db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?');
const setRunStmt = db.prepare('UPDATE chat_sessions SET run_id = ?, updated_at = ? WHERE id = ?');
const delSessionStmt = db.prepare('DELETE FROM chat_sessions WHERE id = ?');
const delMessagesStmt = db.prepare('DELETE FROM chat_messages WHERE session_id = ?');
const insMessage = db.prepare(`INSERT INTO chat_messages
  (id,session_id,role,kind,content,run_id,created_at) VALUES (@id,@session_id,@role,@kind,@content,@run_id,@created_at)`);
const listMessagesStmt = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC');

function rowToSession(r: any): ChatSession {
  return {
    id: r.id, title: r.title, engine: r.engine as RunEngine, model: r.model,
    effort: r.effort as EffortLevel, permissionMode: r.permission_mode as PermissionMode, cwd: r.cwd,
    allowedTools: r.allowed_tools ? JSON.parse(r.allowed_tools) : null,
    skills: r.skills ? JSON.parse(r.skills) : null,
    runId: r.run_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToMessage(r: any): ChatMessage {
  return { id: r.id, sessionId: r.session_id, role: r.role as ChatRole, kind: r.kind as ChatMessageKind,
    content: r.content, runId: r.run_id ?? null, createdAt: r.created_at };
}

export const chatRepo = {
  createSession(req: CreateChatSessionRequest): ChatSession {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      title: req.title?.trim() || 'New chat',
      engine: req.engine ?? 'claude',
      model: req.model ?? 'claude-opus-4-8',
      effort: req.effort ?? 'high',
      permission_mode: req.permissionMode ?? 'default',
      cwd: req.cwd,
      allowed_tools: req.allowedTools ? JSON.stringify(req.allowedTools) : null,
      skills: req.skills ? JSON.stringify(req.skills) : null,
      run_id: null as string | null,
      created_at: now, updated_at: now,
    };
    insSession.run(row);
    return rowToSession({ ...row });
  },
  listSessions(): ChatSession[] { return (listSessionsStmt.all() as any[]).map(rowToSession); },
  getSession(id: string): ChatSession | null { const r = getSessionStmt.get(id); return r ? rowToSession(r) : null; },
  renameSession(id: string, title: string) { renameStmt.run(title, Date.now(), id); },
  setSessionRun(id: string, runId: string | null) { setRunStmt.run(runId, Date.now(), id); },
  deleteSession(id: string) { delMessagesStmt.run(id); delSessionStmt.run(id); },
  addMessage(m: { sessionId: string; role: ChatRole; kind: ChatMessageKind; content: string; runId: string | null }): ChatMessage {
    const row = { id: randomUUID(), session_id: m.sessionId, role: m.role, kind: m.kind, content: m.content, run_id: m.runId, created_at: Date.now() };
    insMessage.run(row);
    return rowToMessage(row);
  },
  listMessages(sessionId: string): ChatMessage[] { return (listMessagesStmt.all(sessionId) as any[]).map(rowToMessage); },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/chat.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat.ts apps/server/test/chat.test.ts
git commit -m "feat(chat): session + message persistence (chatRepo)"
```

---

## Task 3: Engine-prompt reconstruction

**Files:** Modify `apps/server/src/chat.ts` · Test `apps/server/test/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/chat.test.ts` (add `buildEnginePrompt` to the import):

```typescript
import { chatRepo, buildEnginePrompt } from '../src/chat.js';

describe('buildEnginePrompt', () => {
  it('reconstructs prior turns + the new message', () => {
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as any[];
    const p = buildEnginePrompt(history, 'next question');
    expect(p).toContain('hi');
    expect(p).toContain('hello');
    expect(p).toContain('next question');
    expect(p.indexOf('next question')).toBeGreaterThan(p.indexOf('hello'));
  });

  it('caps total length, keeping the most recent turns', () => {
    const history = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `OLD${i}` })) as any[];
    const p = buildEnginePrompt(history, 'fresh');
    expect(p.length).toBeLessThanOrEqual(12_200);
    expect(p).toContain('fresh');
    expect(p).not.toContain('OLD0'); // oldest dropped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/chat.test.ts -t buildEnginePrompt`
Expected: FAIL — `buildEnginePrompt is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/server/src/chat.ts`:

```typescript
const ENGINE_PROMPT_CAP = 12_000;

/** Engines (codex/opencode) cannot resume, so reconstruct a capped transcript prefix into each
 *  turn's prompt (DC §D-030). Keeps the most recent turns when over the cap. */
export function buildEnginePrompt(history: Array<{ role: string; content: string }>, message: string): string {
  const tail = `\nUser: ${message}\nAssistant:`;
  const turns = history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  let body = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    const next = turns[i] + '\n' + body;
    if (next.length + tail.length > ENGINE_PROMPT_CAP) break;
    body = next;
  }
  return (body + tail).trimStart();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/chat.test.ts -t buildEnginePrompt`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat.ts apps/server/test/chat.test.ts
git commit -m "feat(chat): capped engine transcript reconstruction"
```

---

## Task 4: Turn orchestration (`startTurn`) + routes

**Files:** Modify `apps/server/src/chat.ts`, `apps/server/src/server.ts` · Test `apps/server/test/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/chat.test.ts`:

```typescript
import { vi } from 'vitest';
vi.mock('../src/registry.js', () => ({
  registry: {
    launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
    resume: vi.fn(async (id: string) => ({ id: 'run-resume', sessionId: 's', status: 'running' })),
    launchEngine: vi.fn(async (req: any) => ({ id: 'run-engine', sessionId: 's', status: 'running', ...req })),
  },
}));

describe('startTurn', () => {
  it('turn 1 launches; turn 2 resumes the stored run id', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: '/tmp/t' });

    const t1 = await startTurn(s.id, 'first');
    expect((registry.launch as any)).toHaveBeenCalledTimes(1);
    expect(t1.runId).toBe('run-launch');
    expect(chatRepo.getSession(s.id)?.runId).toBe('run-launch');
    expect(t1.userMessage.content).toBe('first');

    const t2 = await startTurn(s.id, 'second');
    expect((registry.resume as any)).toHaveBeenCalledWith('run-launch', 'second', undefined);
    expect(t2.runId).toBe('run-resume');
    expect(chatRepo.getSession(s.id)?.runId).toBe('run-resume');
  });

  it('engine session launches an engine run with a reconstructed prompt each turn', async () => {
    const { registry } = await import('../src/registry.js');
    const { chatRepo, startTurn } = await import('../src/chat.js');
    const s = chatRepo.createSession({ cwd: '/tmp/e', engine: 'codex', model: 'gpt-5-codex' });
    await startTurn(s.id, 'hello engine');
    expect((registry.launchEngine as any)).toHaveBeenCalled();
    const arg = (registry.launchEngine as any).mock.calls.at(-1)[0];
    expect(arg.engine).toBe('codex');
    expect(arg.prompt).toContain('hello engine');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/chat.test.ts -t startTurn`
Expected: FAIL — `startTurn is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/server/src/chat.ts` (imports + function + routes):

```typescript
import { registry } from './registry.js';
import type { ChatTurnResponse, AddChatMessageRequest } from '@fleet/shared';

/** Run one chat turn. Persists the user message, then launches (turn 1) or resumes (turn N) for
 *  Claude, or launches a fresh engine one-shot with a reconstructed prompt for engines. */
export async function startTurn(sessionId: string, message: string): Promise<ChatTurnResponse> {
  const session = chatRepo.getSession(sessionId);
  if (!session) throw Object.assign(new Error('session not found'), { statusCode: 404 });
  if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('message is required'), { statusCode: 400 });

  const userMessage = chatRepo.addMessage({ sessionId, role: 'user', kind: 'text', content: message, runId: null });
  const opts = {
    cwd: session.cwd, model: session.model, effort: session.effort, permissionMode: session.permissionMode,
    allowedTools: session.allowedTools ?? undefined, skills: session.skills ?? undefined,
  };

  let run: { id: string };
  if (session.engine && session.engine !== 'claude') {
    const history = chatRepo.listMessages(sessionId).slice(0, -1); // exclude the just-added user msg
    const prompt = buildEnginePrompt(history.map((m) => ({ role: m.role, content: m.content })), message);
    run = await registry.launchEngine({ ...opts, engine: session.engine, prompt });
  } else if (!session.runId) {
    run = await registry.launch({ ...opts, prompt: message });
  } else {
    run = await registry.resume(session.runId, message, undefined);
  }
  chatRepo.setSessionRun(sessionId, run.id);
  return { runId: run.id, userMessage };
}

export function registerChatRoutes(app: FastifyInstance) {
  app.get('/api/chat/sessions', async () => chatRepo.listSessions());

  app.post('/api/chat/sessions', async (req, reply) => {
    const b = (req.body ?? {}) as CreateChatSessionRequest;
    if (!b.cwd || typeof b.cwd !== 'string') return reply.code(400).send({ error: 'cwd is required' });
    return chatRepo.createSession(b);
  });

  app.get('/api/chat/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return { session, messages: chatRepo.listMessages(id) };
  });

  app.patch('/api/chat/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!chatRepo.getSession(id)) return reply.code(404).send({ error: 'not found' });
    const title = (req.body as any)?.title;
    if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: 'title is required' });
    chatRepo.renameSession(id, title.trim());
    return chatRepo.getSession(id);
  });

  app.delete('/api/chat/sessions/:id', async (req) => {
    chatRepo.deleteSession((req.params as any).id);
    return { ok: true };
  });

  app.post('/api/chat/sessions/:id/turn', async (req, reply) => {
    try {
      return await startTurn((req.params as any).id, (req.body as any)?.message);
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'turn failed' });
    }
  });

  // Generic add-message — the client persists the assistant reply on stream-terminal (plan note 1).
  app.post('/api/chat/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id;
    if (!chatRepo.getSession(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as AddChatMessageRequest;
    if (typeof b.content !== 'string') return reply.code(400).send({ error: 'content is required' });
    return chatRepo.addMessage({ sessionId: id, role: b.role, kind: b.kind, content: b.content, runId: b.runId ?? null });
  });
}
```

- [ ] **Step 4: Wire into `server.ts`**

Add the import near the other route imports:
```typescript
import { registerChatRoutes } from './chat.js';
```
Add the registration next to `registerAddonRoutes(app);`:
```typescript
  registerChatRoutes(app); // §30 — chat dashboard
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/chat.test.ts`
Expected: PASS (all chat tests). Then `pnpm --filter @fleet/server typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chat.ts apps/server/src/server.ts apps/server/test/chat.test.ts
git commit -m "feat(chat): turn orchestration (launch/resume/engine) + routes"
```

---

## Task 5: Add-on command exports

**Files:** Modify `apps/server/src/addons.ts`

- [ ] **Step 1: Add the exports**

`/api/addons` already does `ADDON_DEFS.map((d) => addonInfo(d.id))`, and enable/disable already exist as route logic. Export thin wrappers for the command layer (place after `registerAddonRoutes` or near `addonInfo`):

```typescript
/** §30 chat commands — list all add-on infos (same shape as GET /api/addons). */
export async function listAddonInfos(): Promise<AddonInfo[]> {
  const infos = await Promise.all(ADDON_DEFS.map((d) => addonInfo(d.id)));
  return infos.filter((x): x is AddonInfo => !!x);
}

/** §30 chat commands — enable/disable an add-on by id; returns the updated info or throws 404. */
export async function setAddonEnabledById(id: string, enabled: boolean): Promise<AddonInfo> {
  const def = ADDON_DEFS.find((d) => d.id === id);
  if (!def) throw Object.assign(new Error(`unknown add-on: ${id}`), { statusCode: 404 });
  const row = loadRow(id);
  saveRow(id, enabled, row.config);
  if (def.runtime === 'proxy') { if (enabled) void startProxy(); else stopProxy(); }
  const info = await addonInfo(id);
  if (!info) throw Object.assign(new Error('add-on not found'), { statusCode: 404 });
  return info;
}
```

> `AddonInfo` is already imported in `addons.ts`. This is a thin extraction of logic the routes already perform — no behavior change to existing routes.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fleet/server typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/addons.ts
git commit -m "feat(addons): export listAddonInfos + setAddonEnabledById for chat commands"
```

---

## Task 6: Slash-command dispatch (`commands.ts`)

**Files:** Create `apps/server/src/commands.ts` · Test `apps/server/test/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/commands.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/registry.js', () => ({
  registry: {
    listRuns: vi.fn(() => [
      { id: 'a1', status: 'running', model: 'opus', task: 'do x', cwd: '/r' },
      { id: 'z9', status: 'completed', model: 'opus', task: 'done', cwd: '/r' },
    ]),
    stop: vi.fn(),
    launch: vi.fn(async () => ({ id: 'new-run' })),
  },
}));
vi.mock('../src/addons.js', () => ({
  listAddonInfos: vi.fn(async () => [{ id: 'compression', enabled: true, status: 'running' }]),
  setAddonEnabledById: vi.fn(async (id: string, en: boolean) => ({ id, enabled: en, status: en ? 'running' : 'disabled' })),
}));
vi.mock('../src/campaigns.js', () => ({ campaigns: { create: vi.fn(async () => ({ id: 'camp-1' })) } }));

import { dispatchCommand } from '../src/commands.js';

describe('dispatchCommand', () => {
  it('/agents lists only non-terminal runs as a table', async () => {
    const r = await dispatchCommand('/agents', '/repo');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('table');
    expect(r.rows?.some((row) => row.includes('a1'))).toBe(true);
    expect(r.rows?.some((row) => row.includes('z9'))).toBe(false); // completed excluded
  });

  it('/kill <id> stops the run', async () => {
    const { registry } = await import('../src/registry.js');
    const r = await dispatchCommand('/kill a1', '/repo');
    expect((registry.stop as any)).toHaveBeenCalledWith('a1');
    expect(r.ok).toBe(true);
  });

  it('/launch <prompt> starts a run and returns its id', async () => {
    const r = await dispatchCommand('/launch fix the bug', '/repo');
    expect(r.runId).toBe('new-run');
  });

  it('/addon enable compression toggles it', async () => {
    const { setAddonEnabledById } = await import('../src/addons.js');
    const r = await dispatchCommand('/addon enable compression', '/repo');
    expect((setAddonEnabledById as any)).toHaveBeenCalledWith('compression', true);
    expect(r.ok).toBe(true);
  });

  it('unknown command returns an error result', async () => {
    const r = await dispatchCommand('/nope', '/repo');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fleet/server exec vitest run test/commands.test.ts`
Expected: FAIL — `Cannot find module '../src/commands.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/commands.ts`:

```typescript
/**
 * §30 — slash-command control-plane for the chat dashboard. Each command dispatches to an
 * existing registry/module call; results render as command-result messages. Commands inherit the
 * permission posture of the calls they make (DC §D-031).
 */
import { registry } from './registry.js';
import { listAddonInfos, setAddonEnabledById } from './addons.js';
import { campaigns } from './campaigns.js';
import type { ChatCommandResult } from '@fleet/shared';

const TERMINAL = new Set(['completed', 'failed', 'killed']);
const ok = (text: string, extra: Partial<ChatCommandResult> = {}): ChatCommandResult => ({ ok: true, kind: 'text', text, ...extra });
const err = (text: string): ChatCommandResult => ({ ok: false, kind: 'error', text });

const HELP = [
  '/agents — list running agents',
  '/kill <id> — stop a run',
  '/launch <prompt> — start an agent in the chat cwd',
  '/campaign <objective> — start a campaign',
  '/addons — list add-ons',
  '/addon enable|disable <id> — toggle an add-on',
  '/schedule — open the Schedules page',
  '/help — this list',
].join('\n');

/** Parse and run one slash-command line. `cwd` is the chat session's working dir. */
export async function dispatchCommand(line: string, cwd: string): Promise<ChatCommandResult> {
  const trimmed = line.trim().replace(/^\//, '');
  const [name, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(' ');
  switch (name) {
    case 'help': return ok(HELP);
    case 'agents': {
      const runs = (registry.listRuns() as any[]).filter((r) => !TERMINAL.has(r.status));
      return { ok: true, kind: 'table', columns: ['id', 'status', 'model', 'task'],
        rows: runs.map((r) => [r.id, r.status, r.model, String(r.task ?? '').slice(0, 60)]) };
    }
    case 'kill': {
      if (!arg) return err('usage: /kill <run-id>');
      try { registry.stop(arg); return ok(`stopped ${arg}`); }
      catch (e: any) { return err(e?.message ?? 'kill failed'); }
    }
    case 'launch': {
      if (!arg) return err('usage: /launch <prompt>');
      try {
        const run = await registry.launch({ prompt: arg, cwd, model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default' });
        return ok(`launched run ${run.id}`, { runId: run.id });
      } catch (e: any) { return err(e?.message ?? 'launch failed'); }
    }
    case 'campaign': {
      if (!arg) return err('usage: /campaign <objective>');
      try { const c = await campaigns.create({ objective: arg, cwd }); return ok(`started campaign ${c.id}`); }
      catch (e: any) { return err(e?.message ?? 'campaign failed'); }
    }
    case 'addons': {
      const infos = await listAddonInfos();
      return { ok: true, kind: 'table', columns: ['id', 'enabled', 'status'],
        rows: infos.map((a) => [a.id, String(a.enabled), a.status]) };
    }
    case 'addon': {
      const [action, id] = rest;
      if ((action !== 'enable' && action !== 'disable') || !id) return err('usage: /addon enable|disable <id>');
      try { const info = await setAddonEnabledById(id, action === 'enable'); return ok(`${id} → ${info.status}`); }
      catch (e: any) { return err(e?.message ?? 'addon toggle failed'); }
    }
    case 'schedule': return ok('Open the Schedules page to create or manage schedules: /schedules');
    default: return err(`unknown command: /${name} — try /help`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fleet/server exec vitest run test/commands.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/commands.ts apps/server/test/commands.test.ts
git commit -m "feat(commands): slash-command dispatch (/agents /kill /launch /campaign /addons /addon /help)"
```

---

## Task 7: Command route

**Files:** Modify `apps/server/src/chat.ts` (add a route) · Test `apps/server/test/commands.test.ts` (route test optional — covered by dispatch tests)

- [ ] **Step 1: Add the route**

In `registerChatRoutes` (chat.ts), add — and import `dispatchCommand`:

```typescript
import { dispatchCommand } from './commands.js';
```
```typescript
  app.post('/api/chat/sessions/:id/command', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const line = (req.body as any)?.line;
    if (typeof line !== 'string' || !line.trim()) return reply.code(400).send({ error: 'line is required' });
    chatRepo.addMessage({ sessionId: id, role: 'user', kind: 'command', content: line, runId: null });
    const result = await dispatchCommand(line, session.cwd);
    chatRepo.addMessage({ sessionId: id, role: 'system', kind: result.ok ? 'command-result' : 'error', content: result.text ?? JSON.stringify(result), runId: result.runId ?? null });
    return result;
  });
```

- [ ] **Step 2: Typecheck + run server suite**

Run: `pnpm --filter @fleet/server typecheck` → PASS
Run: `pnpm --filter @fleet/server test` → PASS (all suites incl. chat + commands)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/chat.ts
git commit -m "feat(chat): /command route persists the command + result messages"
```

---

## Task 8: Web API client helpers

**Files:** Modify `apps/web/lib/api.ts`

- [ ] **Step 1: Add the client methods + type imports**

Add to the `api` object:

```typescript
  // ── §30 chat dashboard ──
  chatSessions: () => j<ChatSession[]>('/api/chat/sessions'),
  chatSession: (id: string) => j<{ session: ChatSession; messages: ChatMessage[] }>(`/api/chat/sessions/${id}`),
  createChatSession: (body: CreateChatSessionRequest) => j<ChatSession>('/api/chat/sessions', { method: 'POST', body: JSON.stringify(body) }),
  renameChatSession: (id: string, title: string) => j<ChatSession>(`/api/chat/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChatSession: (id: string) => j(`/api/chat/sessions/${id}`, { method: 'DELETE' }),
  chatTurn: (id: string, message: string) => j<ChatTurnResponse>(`/api/chat/sessions/${id}/turn`, { method: 'POST', body: JSON.stringify({ message }) }),
  addChatMessage: (id: string, body: AddChatMessageRequest) => j<ChatMessage>(`/api/chat/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify(body) }),
  chatCommand: (id: string, line: string) => j<ChatCommandResult>(`/api/chat/sessions/${id}/command`, { method: 'POST', body: JSON.stringify({ line }) }),
```

Add to the `@fleet/shared` type import:
```typescript
import type { /* …existing… */ ChatSession, ChatMessage, CreateChatSessionRequest, ChatTurnResponse, AddChatMessageRequest, ChatCommandResult } from '@fleet/shared';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fleet/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): chat API client helpers"
```

---

## Task 9: `ChatSessionList` + `RunningAgentsPanel` components

**Files:** Create `apps/web/components/ChatSessionList.tsx`, `apps/web/components/RunningAgentsPanel.tsx`

- [ ] **Step 1: Create `ChatSessionList.tsx`**

```tsx
'use client';
import type { ChatSession } from '@fleet/shared';
import { Btn } from '@/components/ui';

export function ChatSessionList({ sessions, activeId, onSelect, onNew, onRename, onDelete }: {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="w-56 shrink-0 border-r hairline flex flex-col">
      <div className="flex items-center justify-between p-2 border-b hairline">
        <span className="text-[12px] font-semibold">Sessions</span>
        <Btn onClick={onNew}>+ New</Btn>
      </div>
      <div className="flex-1 overflow-auto">
        {sessions.map((s) => (
          <div key={s.id}
            className={`px-2 py-2 text-[12px] cursor-pointer border-b hairline ${s.id === activeId ? 'bg-white/5' : ''}`}
            onClick={() => onSelect(s.id)}>
            <div className="truncate font-medium">{s.title}</div>
            <div className="opacity-50">{s.engine} · {s.model}</div>
            {s.id === activeId && (
              <div className="flex gap-2 mt-1">
                <button className="underline opacity-70" onClick={(e) => { e.stopPropagation(); onRename(s.id); }}>rename</button>
                <button className="underline opacity-70" onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `RunningAgentsPanel.tsx`**

```tsx
'use client';
import Link from 'next/link';
import { useFleet } from '@/lib/live';

const TERMINAL = new Set(['completed', 'failed', 'killed']);

export function RunningAgentsPanel() {
  const { runs } = useFleet();
  const live = [...runs.values()].filter((r) => !TERMINAL.has(r.status));
  return (
    <div className="w-64 shrink-0 border-l hairline flex flex-col">
      <div className="p-2 border-b hairline text-[12px] font-semibold">Running agents ({live.length})</div>
      <div className="flex-1 overflow-auto">
        {live.length === 0 && <div className="p-3 text-[12px] opacity-50">none running</div>}
        {live.map((r) => (
          <Link key={r.id} href={`/runs/${r.id}`}
            className="block px-2 py-2 text-[12px] border-b hairline hover:bg-white/5">
            <div className="font-mono">{r.id.slice(0, 8)} · {r.status}</div>
            <div className="opacity-60 truncate">{r.model} · {r.cwd}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

> Verify `useFleet`'s return shape against `apps/web/lib/live.ts` (it returns `{ runs: Map<string, Run>, spend, connected }`). Adjust class names to match existing pages.

- [ ] **Step 3: Build**

Run: `pnpm --filter @fleet/web build`
Expected: PASS (these aren't imported by a route yet, but must typecheck).

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/ChatSessionList.tsx apps/web/components/RunningAgentsPanel.tsx
git commit -m "feat(web): chat session list + running-agents panel"
```

---

## Task 10: `ChatThread` + `ChatComposer`

**Files:** Create `apps/web/components/ChatThread.tsx`, `apps/web/components/ChatComposer.tsx`

- [ ] **Step 1: Create `ChatThread.tsx`** (renders persisted messages + the live streaming turn)

```tsx
'use client';
import type { ChatMessage } from '@fleet/shared';
import { useRunStream } from '@/lib/live';

function roleColor(role: string) { return role === 'user' ? '#9ad' : role === 'system' ? '#caa' : '#cfe'; }

/** Renders the streaming text of the active run (the in-flight assistant turn). */
function LiveTurn({ runId }: { runId: string }) {
  const { events } = useRunStream(runId);
  const text = events
    .filter((e) => e.type === 'assistant' || e.type === 'result')
    .map((e) => (e.payload as any)?.text ?? (e.payload as any)?.resultText ?? '')
    .join('');
  if (!text) return <div className="text-[13px] opacity-60">⟳ thinking…</div>;
  return <div className="text-[13px] whitespace-pre-wrap"><b style={{ color: '#cfe' }}>assistant: </b>{text}</div>;
}

export function ChatThread({ messages, liveRunId }: { messages: ChatMessage[]; liveRunId: string | null }) {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-2">
      {messages.map((m) => (
        <div key={m.id} className="text-[13px] whitespace-pre-wrap">
          <b style={{ color: roleColor(m.role) }}>{m.role}: </b>
          {m.content}
        </div>
      ))}
      {liveRunId && <LiveTurn runId={liveRunId} />}
    </div>
  );
}
```

> Verify `useRunStream`'s return shape in `apps/web/lib/live.ts` and the event `type`/`payload` field names against `NormalizedEvent` (the run-detail page already renders these — mirror how `/runs/[id]` extracts assistant/result text).

- [ ] **Step 2: Create `ChatComposer.tsx`** (input + slash detection; options popover reuses `ModelSelect`)

```tsx
'use client';
import { useState } from 'react';
import { Btn, Input } from '@/components/ui';

export function ChatComposer({ disabled, onSend, onCommand }: {
  disabled: boolean;
  onSend: (message: string) => void;
  onCommand: (line: string) => void;
}) {
  const [text, setText] = useState('');
  function submit() {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) onCommand(t); else onSend(t);
    setText('');
  }
  return (
    <div className="border-t hairline p-3 flex gap-2">
      <Input value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Message…  (/ for commands)"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
      <Btn variant="solid" onClick={submit} disabled={disabled || !text.trim()}>▶</Btn>
    </div>
  );
}
```

> Options popover (model/engine/effort/tools/skills/permission-mode/cwd) is set at session-create time in Task 11's page via `ModelSelect` + the existing pickers; the composer stays minimal for v1. A per-turn options popover is a fast-follow.

- [ ] **Step 3: Build**

Run: `pnpm --filter @fleet/web build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/ChatThread.tsx apps/web/components/ChatComposer.tsx
git commit -m "feat(web): chat thread (live streaming turn) + composer"
```

---

## Task 11: `/chat` page (wires everything) + nav

**Files:** Create `apps/web/app/chat/page.tsx` · Modify `apps/web/components/Shell.tsx`

- [ ] **Step 1: Create the page**

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import type { ChatSession, ChatMessage } from '@fleet/shared';
import { api } from '@/lib/api';
import { ChatSessionList } from '@/components/ChatSessionList';
import { ChatThread } from '@/components/ChatThread';
import { ChatComposer } from '@/components/ChatComposer';
import { RunningAgentsPanel } from '@/components/RunningAgentsPanel';

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshSessions = useCallback(async () => { setSessions(await api.chatSessions()); }, []);
  const loadSession = useCallback(async (id: string) => {
    const { session, messages } = await api.chatSession(id);
    setActiveId(id); setSession(session); setMessages(messages); setLiveRunId(null);
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  async function newSession() {
    const s = await api.createChatSession({ cwd: process.env.NEXT_PUBLIC_DEFAULT_CWD || '.' });
    await refreshSessions(); await loadSession(s.id);
  }
  async function renameSession(id: string) {
    const title = window.prompt('Rename session'); if (!title) return;
    await api.renameChatSession(id, title); await refreshSessions();
  }
  async function deleteSession(id: string) {
    await api.deleteChatSession(id); await refreshSessions();
    if (id === activeId) { setActiveId(null); setSession(null); setMessages([]); }
  }

  async function send(message: string) {
    if (!activeId) return;
    setBusy(true);
    try {
      const { runId, userMessage } = await api.chatTurn(activeId, message);
      setMessages((m) => [...m, userMessage]); setLiveRunId(runId);
    } finally { setBusy(false); }
  }
  async function command(line: string) {
    if (!activeId) return;
    await api.chatCommand(activeId, line);
    await loadSession(activeId); // re-pull persisted command + result messages
  }

  return (
    <div className="flex h-[calc(100vh-0px)]">
      <ChatSessionList sessions={sessions} activeId={activeId}
        onSelect={loadSession} onNew={newSession} onRename={renameSession} onDelete={deleteSession} />
      <div className="flex-1 flex flex-col min-w-0">
        {session ? (
          <>
            <div className="px-4 py-2 border-b hairline text-[12px]">
              {session.title} · {session.engine} · {session.model} · {session.cwd}
              {session.engine !== 'claude' && <span className="ml-2 opacity-60">(one-shot per turn · limited memory)</span>}
            </div>
            <ChatThread messages={messages} liveRunId={liveRunId} />
            <ChatComposer disabled={busy} onSend={send} onCommand={command} />
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-[13px] opacity-50">Select or create a session</div>
        )}
      </div>
      <RunningAgentsPanel />
    </div>
  );
}
```

> The default cwd uses `NEXT_PUBLIC_DEFAULT_CWD` or `.`; if the project exposes a default working dir via `/api/meta` or config, prefer that. The assistant-message persistence on stream-terminal (plan note 1) can be added in `ChatThread` by calling `api.addChatMessage` when `useRunStream` reports a terminal run status — wire it where `useRunStream` exposes the run/status. Confirm the terminal signal in `live.ts` and call `api.addChatMessage(activeId, { role:'assistant', kind:'text', content: finalText, runId })` once per turn.

- [ ] **Step 2: Add the nav entry in `Shell.tsx`**

Add to the `NAV` array (after the Inbox entry):
```typescript
  { href: '/chat', label: 'Chat', glyph: '✦' },
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @fleet/web build`
Expected: PASS — `/chat` listed in the route output.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/chat/page.tsx apps/web/components/Shell.tsx
git commit -m "feat(web): /chat dashboard page + nav entry"
```

---

## Task 12: Full verification

**Files:** none

- [ ] **Step 1: Server tests** — `pnpm --filter @fleet/server test` → PASS (incl. chat + commands).
- [ ] **Step 2: Workspace typecheck** — `pnpm -r typecheck` → PASS (shared, server, web).
- [ ] **Step 3: Web build** — `pnpm --filter @fleet/web build` → PASS, `/chat` present.
- [ ] **Step 4: Manual smoke** (optional) — `pnpm dev`, open `/chat`, create a session, send a message (streams a Claude turn), run `/agents` and `/help`, confirm the running-agents panel updates and an engine session shows the one-shot badge.
- [ ] **Step 5: Final commit (if fixups needed)**

```bash
git add -A
git commit -m "chore(chat): verification fixups"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** ① live multi-session chat → Tasks 2/4/9/10/11; ② running-agents panel → Task 9/11; ③ slash-commands → Tasks 5/6/7 (+ composer in 10, page wiring in 11); ④ engine chat → Tasks 3/4 (+ badge in 11). Persistence/restart → Task 2 (sqlite) + page reload re-pulls. Transport (resume-per-turn, DC §D-029) → Task 4. Error handling → typed 4xx across routes + inline messages. Deferred items (voice/uploads/multi-user/FTS) correctly absent.
- **Placeholder scan:** no TBD/TODO; every code step is complete. The two flagged refinements (client-persists-assistant-message; `/schedule` as a pointer) are explicit decisions with full code, not placeholders.
- **Type consistency:** `ChatSession`/`ChatMessage`/`CreateChatSessionRequest`/`ChatTurnResponse`/`AddChatMessageRequest`/`ChatCommandResult` defined in Task 1, used verbatim in Tasks 2/4/6/7/8. `chatRepo` method names (`createSession`/`listSessions`/`getSession`/`renameSession`/`setSessionRun`/`deleteSession`/`addMessage`/`listMessages`), `startTurn`, `buildEnginePrompt`, `dispatchCommand`, `listAddonInfos`/`setAddonEnabledById` consistent across tasks. `registry.launch/resume/launchEngine/stop/listRuns` match confirmed signatures.
