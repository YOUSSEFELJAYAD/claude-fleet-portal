# Chat Surface Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are grouped by **Unit** (F = foundations, then build phases 1–6); within each unit, tasks are numbered from 1 and any "Task N" reference is local to that unit.

**Goal:** Turn the thin `/chat` MVP into an end-to-end, ChatGPT/Claude-grade conversational control-plane: always-live killable/resumable sessions, a `/` command palette, `@` file/folder mentions, and full-fidelity rendering.

**Architecture:** A dedicated chat-live process manager (separate `CHAT_LIVE_MAX` budget + idle auto-suspend) gives "always open" sessions without starving the 8-run fleet cap, with transparent `--resume` fallback. A single declarative command registry feeds dispatch + `GET /api/commands` + the `/` palette. A chat-scoped SSE channel survives kill→resume and reload. Rendering consumes the full stream event vocabulary the current UI discards.

**Tech Stack:** TypeScript monorepo (pnpm workspaces) · Fastify + better-sqlite3 (`@fleet/server`) · Next.js + React + Tailwind HUD design system (`@fleet/web`) · shared types (`@fleet/shared`) · vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-chat-surface-upgrade-design.md`

---

## Canonical Types (single source of truth — every task matches these verbatim)

// ═══════════════════════════════════════════════════════════════════════════════
// CANONICAL SHARED TYPES — Unit F (packages/shared/src/index.ts)
// Every other unit MUST import and match these verbatim. Do NOT redefine locally.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Command registry wire types (Unit 1: commands.ts + GET /api/commands; Unit 2: SlashMenu) ──

/** A single declared argument of a slash command. `source` marks an arg whose
 *  suggestions are fetched live on demand (e.g. `/kill ` → running run-ids). */
export interface CommandArg {
  name: string;
  required: boolean;
  type: 'string' | 'enum' | 'run-id' | 'project' | 'prompt';
  /** allowed literals when `type === 'enum'`. */
  enum?: string[];
  /** live-value autocomplete source for the `/` palette. */
  source?: 'running-runs' | 'addons' | 'templates';
  hint?: string;
}

/** WIRE shape of a slash command — the server-only `run()` is intentionally
 *  omitted (it never crosses the wire). `GET /api/commands` returns CommandDef[].
 *  NOTE for Unit 1: the in-memory registry type is `CommandDef & { run(ctx): Promise<ChatCommandResult> }`;
 *  the route strips `run` before serializing. */
export interface CommandDef {
  name: string;                 // 'kill'
  group: 'control' | 'project' | 'knowledge' | 'config' | 'meta';
  description: string;
  usage: string;                // '/kill <run-id>'
  args: CommandArg[];
  resultKind: 'text' | 'table' | 'error' | 'ack';
  /** routes through the existing Inbox approval queue when true. */
  danger?: boolean;
}

// ── Chat session lifecycle + attachments (Units 1/3/4/6) ──

/** Derived (never stored) session lifecycle, computed from the live manager +
 *  backing run status. live = a held interactive process; running = a turn is
 *  streaming; idle = resumable (no held process); killed = explicitly stopped. */
export type ChatSessionState = 'live' | 'running' | 'idle' | 'killed';

/** A `@`-mention attachment on a turn. file = path-reference the agent reads at
 *  runtime; dir = added to that turn's `--add-dir` set. */
export interface ChatAttachment {
  path: string;
  kind: 'file' | 'dir';
}

/** A result row from `GET /api/files/find` (the `@` picker). path is
 *  workspace-relative; score is the fuzzy-match rank (higher = better). */
export interface FileFindResult {
  path: string;
  kind: 'file' | 'dir';
  score: number;
}

// ── Additive changes to EXISTING chat types (only the changed/added members shown) ──

// ChatSession (read shape) — ADD these two OPTIONAL derived fields (not stored columns):
//   state?: ChatSessionState;
//   live?: boolean;
// Full interface after the change:
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
  /** §3 — derived lifecycle (NOT a stored column); present on session reads. */
  state?: ChatSessionState;
  /** §3 — derived: true iff a live interactive process is held for this session. */
  live?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ChatMessage — ADD the optional `attachments` field (additive; old rows have none):
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  runId: string | null;       // links an assistant turn to the run that produced it
  /** §6 — `@`-mention attachments carried by this message (additive; old rows null). */
  attachments?: ChatAttachment[];
  createdAt: number;
}

// ChatTurnRequest — ADD the optional `attachments` field:
export interface ChatTurnRequest {
  message: string;
  /** §6 — files = path-reference tokens; dirs = `--add-dir` for this turn. */
  attachments?: ChatAttachment[];
}

// ── Chat-stream wire event additions ──
// NO new top-level NormalizedEventType union member is added in Unit F. The chat-scoped
// SSE (Unit 1, GET /api/chat/sessions/:id/stream) re-uses the EXISTING NormalizedEventType
// vocabulary already exported (assistant_partial, assistant_text, tool_use, tool_result,
// thinking, permission_request, subagent_spawned, result, …). The ONE chat-control event the
// spec names — `session_state` — is a CHAT-STREAM-ONLY envelope, NOT a run event, and is
// therefore owned/defined by Unit 1 alongside the stream route (its payload carries
// { state: ChatSessionState; live: boolean }, reusing the ChatSessionState type defined here).
// Unit F does not add it to NormalizedEventType.

---

## Endpoint Contract (single source of truth)

UNIT F DEFINES NO HTTP ENDPOINTS. Routes are owned by Unit 1 (server.ts/chat.ts/commands.ts/fileview.ts). Unit F only ships the request/response *types* those routes serialize. Listed here so the contract Unit F's types must satisfy is visible to the route + client authors:

- GET  /api/commands
    → 200: CommandDef[]   (the server-only run() stripped). Uses Unit F's CommandDef.
- GET  /api/files/find?cwd=<abs>&q=<str>&limit=<n>
    → 200: FileFindResult[]   (paths workspace-relative; safePath-guarded). Uses Unit F's FileFindResult.
- POST /api/chat/sessions/:id/turn
    Request body: ChatTurnRequest  ({ message: string; attachments?: ChatAttachment[] }) — attachments NEW in Unit F.
    → 200: ChatTurnResponse ({ runId, userMessage: ChatMessage }) — userMessage may now carry attachments.
- GET  /api/chat/sessions/:id          → 200: { session: ChatSession; messages: ChatMessage[] }
    session.state / session.live are the Unit-F-defined derived fields (computed by Unit 4's live manager).
- GET  /api/chat/sessions/:id/stream   (SSE) — emits the existing run-event vocabulary + a chat-control
    `session_state` envelope { state: ChatSessionState; live: boolean }. Envelope type owned by Unit 1; the
    ChatSessionState literal it carries is Unit F's.
- POST /api/chat/sessions/:id/input        (mid-turn input / permission decisions) — 409 if not live. Unit 1.
- POST /api/chat/sessions/:id/interrupt    (stop current turn, keep process live if possible). Unit 1.

Config knobs Unit F adds (consumed by Unit 4's chatLive.ts, not by any route): CHAT_LIVE_MAX (default 4, env FLEET_CHAT_LIVE_MAX), CHAT_IDLE_SUSPEND_MS (default 600000, env FLEET_CHAT_IDLE_SUSPEND_MS).

---

## Unit F — Foundations (shared types · config knobs · chat_messages migration)

This unit lays the typed + persistence foundation the other six units build on. Nothing here touches HTTP routes (Unit 1 owns those), the live process manager (Unit 4), or any UI (Units 2/3). It is three small, independently-committable pieces:

1. **Shared types** in `packages/shared/src/index.ts` — the wire contracts (`CommandDef`, `CommandArg`, `ChatSessionState`, `ChatAttachment`, `FileFindResult`), the additive `attachments` field on `ChatMessage` + the turn request, and the derived `state`/`live` fields on `ChatSession`.
2. **Config knobs** in `apps/server/src/config.ts` — `CHAT_LIVE_MAX` (default 4) and `CHAT_IDLE_SUSPEND_MS` (default 600000), env-overridable, matching the existing `Number(process.env… || default)` idiom.
3. **DB migration** in `apps/server/src/chat.ts` — a nullable `attachments` TEXT (JSON) column on `chat_messages`, added idempotently behind a `PRAGMA table_info` guard, with the repo's row-mapper + insert statement extended to round-trip it; old rows stay `null`.

**Files:**
- Modify: `/Users/jd/Documents/agent-system/packages/shared/src/index.ts` (types)
- Modify: `/Users/jd/Documents/agent-system/apps/server/src/config.ts` (knobs)
- Modify: `/Users/jd/Documents/agent-system/apps/server/src/chat.ts` (migration + mappers + insert)
- Test: `/Users/jd/Documents/agent-system/apps/server/test/cov-config-chat.test.ts` (new — knobs)
- Test: `/Users/jd/Documents/agent-system/apps/server/test/chat-attachments.test.ts` (new — migration + round-trip)

> **Domain note for the implementer.** This repo is a TypeScript monorepo (pnpm workspaces). `@fleet/shared` is a pure-types package consumed by both the Fastify server (`@fleet/server`) and the Next.js web app (`@fleet/web`). The server persists to SQLite via `better-sqlite3` (synchronous API — no `await` on db calls). Tests run on **vitest**. The server test DB is the real `data/fleet.db` (tests create throwaway sessions and clean up), so migrations must be idempotent across repeated test runs. Run commands:
> - server tests: `pnpm --filter @fleet/server test <file>`
> - shared typecheck: `pnpm --filter @fleet/shared typecheck`
> - server typecheck: `pnpm --filter @fleet/server typecheck`

---

### Task 1: Add `CommandArg` + `CommandDef` wire types to shared

The command registry (Unit 1, `apps/server/src/commands.ts`) and the web composer (Unit 2, `SlashMenu.tsx`) both need the **wire shape** of a command — i.e. the declarative `CommandDef` *minus* the server-only `run()` function, which never crosses the wire. `GET /api/commands` (Unit 1) returns `CommandDef[]`. We define the wire type here so server and web agree.

There is no server-side behavior to test for a pure type (a type has no runtime), so this task is verified by **typecheck** (a compile-time "test"): we add a throwaway type-level assertion file, see `build` fail when the type is missing, add the type, see `build` pass, then remove the assertion file.

- [ ] **Step 1: Write a failing typecheck.** Create `/Users/jd/Documents/agent-system/packages/shared/src/__typecheck_cmd.ts`:
  ```ts
  import type { CommandDef, CommandArg } from './index.js';

  const arg: CommandArg = {
    name: 'run-id',
    required: true,
    type: 'run-id',
    source: 'running-runs',
    hint: 'a running run id',
  };

  const def: CommandDef = {
    name: 'kill',
    group: 'control',
    description: 'Stop a running run',
    usage: '/kill <run-id>',
    args: [arg],
    resultKind: 'ack',
    danger: true,
  };

  // exercise every CommandArg.type and group/resultKind literal so a wrong union fails to compile
  void ({ name: 'q', required: false, type: 'string' } satisfies CommandArg);
  void ({ name: 'e', required: false, type: 'enum', enum: ['a', 'b'] } satisfies CommandArg);
  void ({ name: 'p', required: false, type: 'project', source: 'templates' } satisfies CommandArg);
  void ({ name: 'pr', required: false, type: 'prompt' } satisfies CommandArg);
  void (def satisfies CommandDef);
  void (arg satisfies CommandArg);
  ```

- [ ] **Step 2: Run it, see it fail.** `pnpm --filter @fleet/shared typecheck`
  Expected: TypeScript errors `Module '"./index.js"' has no exported member 'CommandDef'` and `… 'CommandArg'`.

- [ ] **Step 3: Add the types.** In `/Users/jd/Documents/agent-system/packages/shared/src/index.ts`, immediately **after** the `ChatCommandResult` interface (the block ending at the `}` on the line with `runId?: string | null;      // when a command started a run`), insert:
  ```ts
  // ─────────────────────────────────────────────────────────────────────────────
  // Command registry (chat surface upgrade §5) — ONE declarative source of truth
  // feeding dispatch + GET /api/commands + /help + the `/` composer palette.
  // ─────────────────────────────────────────────────────────────────────────────

  /** A single declared argument of a slash command. `source` marks an arg whose
   *  suggestions are fetched live on demand (e.g. `/kill ` → running run-ids). */
  export interface CommandArg {
    name: string;
    required: boolean;
    type: 'string' | 'enum' | 'run-id' | 'project' | 'prompt';
    /** allowed literals when `type === 'enum'`. */
    enum?: string[];
    /** live-value autocomplete source for the `/` palette. */
    source?: 'running-runs' | 'addons' | 'templates';
    hint?: string;
  }

  /** WIRE shape of a slash command — the server-only `run()` is intentionally
   *  omitted (it never crosses the wire). `GET /api/commands` returns CommandDef[]. */
  export interface CommandDef {
    name: string;                 // 'kill'
    group: 'control' | 'project' | 'knowledge' | 'config' | 'meta';
    description: string;
    usage: string;                // '/kill <run-id>'
    args: CommandArg[];
    resultKind: 'text' | 'table' | 'error' | 'ack';
    /** routes through the existing Inbox approval queue when true. */
    danger?: boolean;
  }
  ```

- [ ] **Step 4: Run it, see it pass.** `pnpm --filter @fleet/shared typecheck`
  Expected: exit 0, no errors.

- [ ] **Step 5: Remove the throwaway assertion file.** `rm /Users/jd/Documents/agent-system/packages/shared/src/__typecheck_cmd.ts`, then re-run `pnpm --filter @fleet/shared typecheck` → exit 0.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(shared): add CommandDef/CommandArg wire types for chat command registry"`

---

### Task 2: Add `ChatSessionState`, `ChatAttachment`, `FileFindResult` + derived session/message fields

These are the remaining shared contracts: the four session-state literals, the attachment shape carried by messages and turns, the `@`-picker result shape, and the additive fields on `ChatSession`/`ChatMessage`/`ChatTurnRequest`. Verified by typecheck the same way as Task 1.

- [ ] **Step 1: Write a failing typecheck.** Create `/Users/jd/Documents/agent-system/packages/shared/src/__typecheck_state.ts`:
  ```ts
  import type {
    ChatSessionState, ChatAttachment, FileFindResult,
    ChatSession, ChatMessage, ChatTurnRequest,
  } from './index.js';

  const states: ChatSessionState[] = ['live', 'running', 'idle', 'killed'];
  void states;

  const att: ChatAttachment = { path: 'src/index.ts', kind: 'file' };
  void (att satisfies ChatAttachment);
  void ({ path: 'src', kind: 'dir' } satisfies ChatAttachment);

  const find: FileFindResult = { path: 'src/index.ts', kind: 'file', score: 0.9 };
  void (find satisfies FileFindResult);

  // derived (read-only) fields on the session read shape — both optional
  const sess = {} as ChatSession;
  const s: ChatSessionState | undefined = sess.state;
  const l: boolean | undefined = sess.live;
  void [s, l];

  // additive attachments on a stored message and on the turn request
  const msg = {} as ChatMessage;
  const ma: ChatAttachment[] | undefined = msg.attachments;
  void ma;
  const turn: ChatTurnRequest = { message: 'hi', attachments: [att] };
  void turn;
  ```

- [ ] **Step 2: Run it, see it fail.** `pnpm --filter @fleet/shared typecheck`
  Expected: errors `has no exported member 'ChatSessionState'`, `… 'ChatAttachment'`, `… 'FileFindResult'`, and `Property 'state'/'live'/'attachments' does not exist`.

- [ ] **Step 3: Add the new types.** In `/Users/jd/Documents/agent-system/packages/shared/src/index.ts`, immediately **after** the `CommandDef` interface you added in Task 1, insert:
  ```ts
  // ─────────────────────────────────────────────────────────────────────────────
  // Chat session lifecycle + attachments (chat surface upgrade §3, §6)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Derived (never stored) session lifecycle, computed from the live manager +
   *  backing run status. live = a held interactive process; running = a turn is
   *  streaming; idle = resumable (no held process); killed = explicitly stopped. */
  export type ChatSessionState = 'live' | 'running' | 'idle' | 'killed';

  /** A `@`-mention attachment on a turn. file = path-reference the agent reads at
   *  runtime; dir = added to that turn's `--add-dir` set. */
  export interface ChatAttachment {
    path: string;
    kind: 'file' | 'dir';
  }

  /** A result row from `GET /api/files/find` (the `@` picker). path is
   *  workspace-relative; score is the fuzzy-match rank (higher = better). */
  export interface FileFindResult {
    path: string;
    kind: 'file' | 'dir';
    score: number;
  }
  ```

- [ ] **Step 4: Add `attachments` to `ChatMessage`.** In the `ChatMessage` interface (currently ending with `createdAt: number;`), add a line **before** `createdAt`:
  ```ts
    /** §6 — `@`-mention attachments carried by this message (additive; old rows null). */
    attachments?: ChatAttachment[];
  ```

- [ ] **Step 5: Add `attachments` to the turn request.** Replace the line
  ```ts
  export interface ChatTurnRequest { message: string }
  ```
  with:
  ```ts
  export interface ChatTurnRequest {
    message: string;
    /** §6 — files = path-reference tokens; dirs = `--add-dir` for this turn. */
    attachments?: ChatAttachment[];
  }
  ```

- [ ] **Step 6: Add derived `state`/`live` to `ChatSession`.** In the `ChatSession` interface (the read shape), add two lines **before** `createdAt: number;`:
  ```ts
    /** §3 — derived lifecycle (NOT a stored column); present on session reads. */
    state?: ChatSessionState;
    /** §3 — derived: true iff a live interactive process is held for this session. */
    live?: boolean;
  ```

- [ ] **Step 7: Run it, see it pass.** `pnpm --filter @fleet/shared typecheck`
  Expected: exit 0.

- [ ] **Step 8: Remove the throwaway file + re-verify.** `rm /Users/jd/Documents/agent-system/packages/shared/src/__typecheck_state.ts` then `pnpm --filter @fleet/shared typecheck` → exit 0.

- [ ] **Step 9: Confirm downstream packages still typecheck.** `pnpm --filter @fleet/server typecheck` → exit 0 (the new optional fields are additive, so existing server code that constructs `ChatSession`/`ChatMessage` without them still compiles).

- [ ] **Step 10: Commit.** `git add -A && git commit -m "feat(shared): add ChatSessionState, ChatAttachment, FileFindResult + derived session/message fields"`

---

### Task 3: Add `CHAT_LIVE_MAX` + `CHAT_IDLE_SUSPEND_MS` config knobs

The live-process manager (Unit 4, `chatLive.ts`) needs a dedicated chat-process budget (`CHAT_LIVE_MAX`, default 4) distinct from `config.maxConcurrentRuns`, and an idle-suspend window (`CHAT_IDLE_SUSPEND_MS`, default 600000 = 10 min). These are top-level module constants in `config.ts`, env-overridable, matching the existing `Number(process.env.FOO || default)` idiom used by `PORT`/`WEB_PORT`. We test the **defaults** here (env-override is exercised by the env that sets it, which we don't mutate at import time).

- [ ] **Step 1: Write the failing test.** Create `/Users/jd/Documents/agent-system/apps/server/test/cov-config-chat.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { CHAT_LIVE_MAX, CHAT_IDLE_SUSPEND_MS } from '../src/config.js';

  describe('chat config knobs', () => {
    it('CHAT_LIVE_MAX defaults to 4 and is a positive integer', () => {
      expect(CHAT_LIVE_MAX).toBe(4);
      expect(Number.isInteger(CHAT_LIVE_MAX)).toBe(true);
      expect(CHAT_LIVE_MAX).toBeGreaterThan(0);
    });

    it('CHAT_IDLE_SUSPEND_MS defaults to 600000 (10 minutes)', () => {
      expect(CHAT_IDLE_SUSPEND_MS).toBe(600_000);
      expect(Number.isFinite(CHAT_IDLE_SUSPEND_MS)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.** `pnpm --filter @fleet/server test cov-config-chat`
  Expected: failure — `CHAT_LIVE_MAX`/`CHAT_IDLE_SUSPEND_MS` are `undefined` (no such export).

- [ ] **Step 3: Add the knobs.** In `/Users/jd/Documents/agent-system/apps/server/src/config.ts`, immediately **after** the `WEB_PORT` line (`export const WEB_PORT = Number(process.env.FLEET_WEB_PORT || 4318);`), insert:
  ```ts
  /**
   * Chat surface upgrade (§3.2) — live chat processes draw from a DEDICATED pool,
   * separate from `config.maxConcurrentRuns` (the fleet/batch cap), so chat can never
   * starve batch work and vice-versa. When this pool is exhausted, a newly-focused
   * session falls back to resumable mode (~1s slower per turn) rather than blocking.
   */
  export const CHAT_LIVE_MAX = Number(process.env.FLEET_CHAT_LIVE_MAX || 4);
  /**
   * Chat surface upgrade (§3.2) — a live chat process idle past this many ms is evicted,
   * dropping the session to resumable/idle and reclaiming its chat slot. Default 10 min.
   */
  export const CHAT_IDLE_SUSPEND_MS = Number(process.env.FLEET_CHAT_IDLE_SUSPEND_MS || 600_000);
  ```

- [ ] **Step 4: Run it, see it pass.** `pnpm --filter @fleet/server test cov-config-chat`
  Expected: 2 tests pass.

- [ ] **Step 5: Typecheck the server.** `pnpm --filter @fleet/server typecheck` → exit 0.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(server): add CHAT_LIVE_MAX + CHAT_IDLE_SUSPEND_MS config knobs"`

---

### Task 4: Migrate `chat_messages` to carry nullable `attachments` (JSON)

`chat_messages` is owned by `chat.ts` (its DDL + prepared statements live there, not in `db.ts`). We add a nullable `attachments TEXT` column holding a JSON array of `ChatAttachment`, guarded by a `PRAGMA table_info` check so the ALTER is idempotent across repeated test runs and never errors on an existing DB. Old rows stay `null`; the row-mapper returns `attachments: undefined` (not present) when the column is null, and the insert serializes the array when present. `addMessage`'s param type gains an optional `attachments`.

> **Why a `PRAGMA table_info` guard rather than the try/catch idiom in `db.ts`:** `db.ts` swallows the "duplicate column name" error in a loop because it batches many ALTERs; for the single `chat_messages` ALTER here, an explicit column-existence check is clearer and equally idempotent. Both are additive and safe on old DBs.

- [ ] **Step 1: Write the failing test.** Create `/Users/jd/Documents/agent-system/apps/server/test/chat-attachments.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import db, { chatRepo } from '../src/chat.js';
  import type { ChatAttachment } from '@fleet/shared';

  describe('chat_messages attachments migration', () => {
    it('adds a nullable attachments column (additive; old rows unaffected)', () => {
      const cols = (db.prepare("PRAGMA table_info('chat_messages')").all() as any[]).map((c) => c.name);
      expect(cols).toContain('attachments');
    });

    it('round-trips attachments through add/list; messages without them read back undefined', () => {
      const s = chatRepo.createSession({ cwd: '/tmp/att' });
      const atts: ChatAttachment[] = [
        { path: 'src/index.ts', kind: 'file' },
        { path: 'docs', kind: 'dir' },
      ];
      chatRepo.addMessage({ sessionId: s.id, role: 'user', kind: 'text', content: 'see these', runId: null, attachments: atts });
      chatRepo.addMessage({ sessionId: s.id, role: 'assistant', kind: 'text', content: 'ok', runId: 'r1' });

      const msgs = chatRepo.listMessages(s.id);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].attachments).toEqual(atts);
      // a message added WITHOUT attachments must read back undefined, not [] or null
      expect(msgs[1].attachments).toBeUndefined();

      chatRepo.deleteSession(s.id);
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.** `pnpm --filter @fleet/server test chat-attachments`
  Expected: failures — `expected [ ... ] to contain 'attachments'` (no column yet), and `attachments` undefined on the round-trip because `addMessage` drops it.

- [ ] **Step 3: Add the idempotent migration.** In `/Users/jd/Documents/agent-system/apps/server/src/chat.ts`, immediately **after** the `db.exec(` block that creates `chat_sessions`/`chat_messages` (the block ending at the `` ); `` after the `CREATE INDEX … idx_chat_messages_session` line), insert:
  ```ts
  // §6 — additive migration: nullable attachments (JSON array of ChatAttachment).
  // Guarded by table_info so it is idempotent (safe on existing DBs + repeated test runs);
  // old rows keep attachments = NULL.
  {
    const hasAttachments = (db.prepare("PRAGMA table_info('chat_messages')").all() as any[])
      .some((c) => c.name === 'attachments');
    if (!hasAttachments) db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT');
  }
  ```

- [ ] **Step 4: Extend the insert statement.** Replace the `insMessage` prepared statement:
  ```ts
  const insMessage = db.prepare(`INSERT INTO chat_messages
    (id,session_id,role,kind,content,run_id,created_at) VALUES (@id,@session_id,@role,@kind,@content,@run_id,@created_at)`);
  ```
  with:
  ```ts
  const insMessage = db.prepare(`INSERT INTO chat_messages
    (id,session_id,role,kind,content,run_id,attachments,created_at)
    VALUES (@id,@session_id,@role,@kind,@content,@run_id,@attachments,@created_at)`);
  ```

- [ ] **Step 5: Map the column back on read.** Replace `rowToMessage`:
  ```ts
  function rowToMessage(r: any): ChatMessage {
    return { id: r.id, sessionId: r.session_id, role: r.role as ChatRole, kind: r.kind as ChatMessageKind,
      content: r.content, runId: r.run_id ?? null, createdAt: r.created_at };
  }
  ```
  with:
  ```ts
  function rowToMessage(r: any): ChatMessage {
    const msg: ChatMessage = {
      id: r.id, sessionId: r.session_id, role: r.role as ChatRole, kind: r.kind as ChatMessageKind,
      content: r.content, runId: r.run_id ?? null, createdAt: r.created_at,
    };
    if (r.attachments) {
      try { msg.attachments = JSON.parse(r.attachments) as ChatAttachment[]; } catch { /* leave undefined on garbage */ }
    }
    return msg;
  }
  ```

- [ ] **Step 6: Persist `attachments` in `addMessage`.** Replace the `addMessage` method:
  ```ts
  addMessage(m: { sessionId: string; role: ChatRole; kind: ChatMessageKind; content: string; runId: string | null }): ChatMessage {
    const row = { id: randomUUID(), session_id: m.sessionId, role: m.role, kind: m.kind, content: m.content, run_id: m.runId, created_at: Date.now() };
    insMessage.run(row);
    return rowToMessage(row);
  },
  ```
  with:
  ```ts
  addMessage(m: { sessionId: string; role: ChatRole; kind: ChatMessageKind; content: string; runId: string | null; attachments?: ChatAttachment[] }): ChatMessage {
    const row = {
      id: randomUUID(), session_id: m.sessionId, role: m.role, kind: m.kind, content: m.content,
      run_id: m.runId,
      attachments: m.attachments && m.attachments.length ? JSON.stringify(m.attachments) : null,
      created_at: Date.now(),
    };
    insMessage.run(row);
    return rowToMessage(row);
  },
  ```

- [ ] **Step 7: Import the `ChatAttachment` type.** In the `import type { … } from '@fleet/shared';` block at the top of `chat.ts`, add `ChatAttachment` to the list (e.g. after `AddChatMessageRequest,`):
  ```ts
    ChatTurnResponse, AddChatMessageRequest, ChatAttachment,
  ```

- [ ] **Step 8: Run the test, see it pass.** `pnpm --filter @fleet/server test chat-attachments`
  Expected: both tests pass.

- [ ] **Step 9: Run the existing chat suite — no regressions.** `pnpm --filter @fleet/server test chat.test`
  Expected: all existing `chatRepo`/`buildEnginePrompt`/`startTurn` tests still pass (the column + mapper changes are additive; `rowToSession` and the session statements are untouched).

- [ ] **Step 10: Typecheck the server.** `pnpm --filter @fleet/server typecheck` → exit 0.

- [ ] **Step 11: Commit.** `git add -A && git commit -m "feat(server): add nullable attachments column to chat_messages + round-trip"`

---

## Unit 1 — Backend Services

These tasks implement the **server-side** of the chat-surface upgrade (spec `docs/superpowers/specs/2026-06-14-chat-surface-upgrade-design.md` §3,§4,§5,§6,§10). They depend on the canonical shared types from Unit F (`packages/shared/src/index.ts`): `CommandDef`, `CommandArg`, `ChatSessionState`, `ChatAttachment`, `FileFindResult`, and the additive `attachments` field on `ChatMessage`/`ChatTurnRequest`. **Do not redefine those types here — import them from `@fleet/shared`.** Each task is strict TDD: write a failing test, run it to watch it fail, write the minimal code, run it to watch it pass, then commit.

**Files:**
- Create: `apps/server/src/chatLive.ts` — live-process manager (sessionId→handle, CHAT_LIVE_MAX semaphore, idle auto-suspend, ensure/evict).
- Modify: `apps/server/src/commands.ts` — declarative `CommandDef` registry feeding `dispatchCommand` + new `listCommands()`.
- Modify: `apps/server/src/fileview.ts` — `GET /api/files/find` (workspace resolve + fuzzy file/dir search + recents + safePath).
- Modify: `apps/server/src/chat.ts` — chat-scoped SSE, `/input`, `/interrupt`, derived `state`/`live`, attachments through the turn.
- Modify: `apps/server/src/config.ts` — `CHAT_LIVE_MAX`, `CHAT_IDLE_SUSPEND_MS` env knobs.
- Modify: `apps/server/src/server.ts` — register `GET /api/commands`, `GET /api/files/find`, chat stream/input/interrupt routes.
- Modify: `apps/server/src/git.ts` — export a `repoRoot()` + `lsFiles()` helper (used by files/find).
- Tests: `apps/server/test/cov-commands-registry.test.ts`, `fn-commands-route.test.ts`, `fn-files-find.test.ts`, `cov-chatlive.test.ts`, `fn-chat-stream.test.ts`, `cov-chat-attachments.test.ts`.

**Conventions you MUST follow (observed in the existing suite):**
- Runner is **vitest** (`apps/server/vitest.config.ts`). Run a single server test file with `pnpm --filter @fleet/server test <file>` and typecheck with `pnpm --filter @fleet/server typecheck`.
- Every test file that touches the DB sets `process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-<name>-'))` **at module top, before any `src/` import** (see `fn-chat-routes.test.ts`, `fn-processmanager-kill.test.ts`).
- HTTP integration tests build the real app: `const { buildServer } = await import('../src/server.js'); app = buildServer(); await app.ready();` and inject with the `host` header `127.0.0.1:${cfg.PORT}` (see `fn-chat-routes.test.ts`).
- Function-level tests mock collaborators with `vi.mock('../src/registry.js', …)` (see `commands.test.ts`, `chat.test.ts`).
- Config env knobs are plain module-level `export const X = Number(process.env.FLEET_… || default)` (see `config.ts` `PORT`/`WEB_PORT`).

---

### Task 1: Add `CHAT_LIVE_MAX` / `CHAT_IDLE_SUSPEND_MS` config knobs

The live manager (Task 5) needs a separate chat budget and an idle-suspend window, both env-overridable, matching the `PORT`/`WEB_PORT` pattern in `config.ts`.

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/cov-chat-config.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { CHAT_LIVE_MAX, CHAT_IDLE_SUSPEND_MS } from '../src/config.js';

  describe('chat config knobs', () => {
    it('CHAT_LIVE_MAX defaults to 4 and is a positive integer', () => {
      expect(CHAT_LIVE_MAX).toBe(4);
      expect(Number.isInteger(CHAT_LIVE_MAX)).toBe(true);
    });
    it('CHAT_IDLE_SUSPEND_MS defaults to 600000 (10 min)', () => {
      expect(CHAT_IDLE_SUSPEND_MS).toBe(600_000);
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test cov-chat-config` → fails: `CHAT_LIVE_MAX` is `undefined` / not exported.
- [ ] **Step 3: Implement.**
  In `apps/server/src/config.ts`, immediately after the `export const WEB_PORT = …` line, add:
  ```ts
  /** §3 D-034 — separate live-chat process budget, independent of maxConcurrentRuns (the fleet/batch cap).
   *  Exhaustion → a newly-focused session falls back to resumable mode rather than blocking. */
  export const CHAT_LIVE_MAX = Number(process.env.FLEET_CHAT_LIVE_MAX || 4);
  /** §3 D-034 — a live chat process idle past this is evicted → session drops to resumable. Default 10 min. */
  export const CHAT_IDLE_SUSPEND_MS = Number(process.env.FLEET_CHAT_IDLE_SUSPEND_MS || 600_000);
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test cov-chat-config` → 2 passing.
- [ ] **Step 5: Commit.**
  `git commit -am "feat(server): add CHAT_LIVE_MAX / CHAT_IDLE_SUSPEND_MS config knobs"`

---

### Task 2: Refactor `commands.ts` into a declarative `CommandDef` registry

Replace the `switch` + static `HELP` string with a declarative array of `CommandDef & { run(ctx) }`. The in-memory registry carries a server-only `run(ctx)`; the wire type (Task 3) strips it. `dispatchCommand` looks up by name and calls `run`. Keep the existing 8 verbs (`help`, `agents`, `kill`, `launch`, `campaign`, `addons`, `addon`, `schedule`) behaving exactly as `commands.test.ts` asserts.

The canonical wire types come from Unit F:
```ts
// from @fleet/shared (DO NOT redefine):
interface CommandArg { name: string; required: boolean; type: 'string'|'enum'|'run-id'|'project'|'prompt'; enum?: string[]; source?: 'running-runs'|'addons'|'templates'; hint?: string; }
interface CommandDef { name: string; group: 'control'|'project'|'knowledge'|'config'|'meta'; description: string; usage: string; args: CommandArg[]; resultKind: 'text'|'table'|'error'|'ack'; danger?: boolean; }
```

- [ ] **Step 1: Write the failing test for `listCommands()`.**
  Create `apps/server/test/cov-commands-registry.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';

  vi.mock('../src/registry.js', () => ({
    registry: {
      listRuns: vi.fn(() => [{ id: 'a1', status: 'running', model: 'opus', task: 'do x', cwd: '/r' }]),
      stop: vi.fn(),
      launch: vi.fn(async () => ({ id: 'new-run' })),
    },
  }));
  vi.mock('../src/addons.js', () => ({
    listAddonInfos: vi.fn(async () => [{ id: 'compression', enabled: true, status: 'running' }]),
    setAddonEnabledById: vi.fn(async (id: string, en: boolean) => ({ id, enabled: en, status: en ? 'running' : 'disabled' })),
  }));
  vi.mock('../src/campaigns.js', () => ({ campaigns: { create: vi.fn(async () => ({ id: 'camp-1' })) } }));

  import { listCommands } from '../src/commands.js';

  describe('listCommands', () => {
    it('returns wire CommandDefs with NO run() field', () => {
      const cmds = listCommands();
      expect(cmds.length).toBeGreaterThanOrEqual(8);
      for (const c of cmds) {
        expect(typeof c.name).toBe('string');
        expect(['control', 'project', 'knowledge', 'config', 'meta']).toContain(c.group);
        expect(typeof c.usage).toBe('string');
        expect(Array.isArray(c.args)).toBe(true);
        expect((c as any).run).toBeUndefined(); // server-only fn is stripped
      }
    });
    it('the kill command declares a run-id arg sourced from running-runs', () => {
      const kill = listCommands().find((c) => c.name === 'kill')!;
      expect(kill).toBeTruthy();
      expect(kill.args[0]).toMatchObject({ name: 'run-id', required: true, type: 'run-id', source: 'running-runs' });
    });
    it('marks at least one destructive verb danger:true', () => {
      expect(listCommands().some((c) => c.danger === true)).toBe(true);
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test cov-commands-registry` → fails: `listCommands` is not exported.
- [ ] **Step 3: Rewrite `commands.ts` as a declarative registry.**
  Replace the entire body of `apps/server/src/commands.ts` with:
  ```ts
  /**
   * §30/§5 — declarative slash-command control-plane. ONE registry feeds both dispatchCommand
   * AND the GET /api/commands wire (Task 3). Each entry carries a server-only run(ctx); the wire
   * shape (CommandDef) omits it. Commands inherit the permission posture of the calls they make
   * (DC §D-031); destructive verbs are flagged danger:true and route through the Inbox queue.
   */
  import { registry } from './registry.js';
  import { listAddonInfos, setAddonEnabledById } from './addons.js';
  import { campaigns } from './campaigns.js';
  import type { ChatCommandResult, CommandDef } from '@fleet/shared';

  const TERMINAL = new Set(['completed', 'failed', 'killed']);
  const ok = (text: string, extra: Partial<ChatCommandResult> = {}): ChatCommandResult => ({ ok: true, kind: 'text', text, ...extra });
  const err = (text: string): ChatCommandResult => ({ ok: false, kind: 'error', text });

  /** Context handed to every command's run(). `args` is the raw arg tokens; `arg` is them joined. */
  export interface CommandContext { args: string[]; arg: string; cwd: string; }

  /** In-memory registry entry: a wire CommandDef plus the server-only executor. */
  export type CommandEntry = CommandDef & { run(ctx: CommandContext): Promise<ChatCommandResult> };

  const COMMANDS: CommandEntry[] = [
    {
      name: 'help', group: 'meta', description: 'List available slash commands',
      usage: '/help', args: [], resultKind: 'text',
      run: async () => ok(COMMANDS.map((c) => `${c.usage} — ${c.description}`).join('\n')),
    },
    {
      name: 'agents', group: 'control', description: 'List running agents',
      usage: '/agents', args: [], resultKind: 'table',
      run: async () => {
        const runs = (registry.listRuns() as any[]).filter((r) => !TERMINAL.has(r.status));
        return { ok: true, kind: 'table', columns: ['id', 'status', 'model', 'task'],
          rows: runs.map((r) => [r.id, r.status, r.model, String(r.task ?? '').slice(0, 60)]) };
      },
    },
    {
      name: 'kill', group: 'control', description: 'Stop a run', usage: '/kill <run-id>',
      args: [{ name: 'run-id', required: true, type: 'run-id', source: 'running-runs', hint: 'a running run id' }],
      resultKind: 'ack', danger: true,
      run: async ({ arg }) => {
        if (!arg) return err('usage: /kill <run-id>');
        try { registry.stop(arg); return ok(`stopped ${arg}`); }
        catch (e: any) { return err(e?.message ?? 'kill failed'); }
      },
    },
    {
      name: 'launch', group: 'control', description: 'Start an agent in the chat cwd',
      usage: '/launch <prompt>',
      args: [{ name: 'prompt', required: true, type: 'prompt', hint: 'what the agent should do' }],
      resultKind: 'ack',
      run: async ({ arg, cwd }) => {
        if (!arg) return err('usage: /launch <prompt>');
        try {
          const run = await registry.launch({ prompt: arg, cwd, model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default' } as any);
          return ok(`launched run ${run.id}`, { runId: run.id });
        } catch (e: any) { return err(e?.message ?? 'launch failed'); }
      },
    },
    {
      name: 'campaign', group: 'control', description: 'Start a campaign', usage: '/campaign <objective>',
      args: [{ name: 'objective', required: true, type: 'string', hint: 'campaign objective' }],
      resultKind: 'ack', danger: true,
      run: async ({ arg, cwd }) => {
        if (!arg) return err('usage: /campaign <objective>');
        try { const c = await campaigns.create({ objective: arg, cwd }); return ok(`started campaign ${c.id}`); }
        catch (e: any) { return err(e?.message ?? 'campaign failed'); }
      },
    },
    {
      name: 'addons', group: 'config', description: 'List add-ons', usage: '/addons',
      args: [], resultKind: 'table',
      run: async () => {
        const infos = await listAddonInfos();
        return { ok: true, kind: 'table', columns: ['id', 'enabled', 'status'],
          rows: infos.map((a) => [a.id, String(a.enabled), a.status]) };
      },
    },
    {
      name: 'addon', group: 'config', description: 'Enable or disable an add-on',
      usage: '/addon enable|disable <id>',
      args: [
        { name: 'action', required: true, type: 'enum', enum: ['enable', 'disable'] },
        { name: 'id', required: true, type: 'string', source: 'addons', hint: 'add-on id' },
      ],
      resultKind: 'ack',
      run: async ({ args }) => {
        const [action, id] = args;
        if ((action !== 'enable' && action !== 'disable') || !id) return err('usage: /addon enable|disable <id>');
        try { const info = await setAddonEnabledById(id, action === 'enable'); return ok(`${id} → ${info.status}`); }
        catch (e: any) { return err(e?.message ?? 'addon toggle failed'); }
      },
    },
    {
      name: 'schedule', group: 'project', description: 'Open the Schedules page', usage: '/schedule',
      args: [], resultKind: 'text',
      run: async () => ok('Open the Schedules page to create or manage schedules: /schedules'),
    },
  ];

  /** Wire view: the CommandDefs the GET /api/commands route serializes (run() stripped). */
  export function listCommands(): CommandDef[] {
    return COMMANDS.map(({ run, ...wire }) => wire);
  }

  /** Parse and run one slash-command line. `cwd` is the chat session's working dir. */
  export async function dispatchCommand(line: string, cwd: string): Promise<ChatCommandResult> {
    const trimmed = line.trim().replace(/^\//, '');
    const [name, ...rest] = trimmed.split(/\s+/);
    const cmd = COMMANDS.find((c) => c.name === name);
    if (!cmd) return err(`unknown command: /${name} — try /help`);
    return cmd.run({ args: rest, arg: rest.join(' '), cwd });
  }
  ```
- [ ] **Step 4: Run the new registry test AND the existing `commands.test.ts` to prove the refactor preserves the 8 verbs.**
  `pnpm --filter @fleet/server test cov-commands-registry` → 3 passing.
  `pnpm --filter @fleet/server test commands` → the EXISTING `commands.test.ts` still passes (`/agents`, `/kill`, `/launch`, `/addon enable`, unknown-command all green). If `cov-commands.test.ts` also runs under that filter, it must stay green too.
- [ ] **Step 5: Typecheck.**
  `pnpm --filter @fleet/server typecheck` → no errors (confirms `CommandDef`/`CommandArg` are exported from `@fleet/shared` by Unit F; if the build fails because they are missing, that is a Unit F dependency — note it for reconciliation and stop).
- [ ] **Step 6: Commit.**
  `git commit -am "refactor(server): declarative CommandDef registry feeding dispatch + listCommands"`

---

### Task 3: `GET /api/commands` route (returns wire CommandDefs)

Surface the registry over HTTP for the `/` palette. The route returns `listCommands()` directly — `run()` is already stripped.

- [ ] **Step 1: Write the failing HTTP test.**
  Create `apps/server/test/fn-commands-route.test.ts`:
  ```ts
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-commands-route-'));

  let app: any; let PORT: number;
  const HOST = () => ({ host: `127.0.0.1:${PORT}` });

  beforeAll(async () => {
    const cfg = await import('../src/config.js');
    PORT = cfg.PORT;
    const { buildServer } = await import('../src/server.js');
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  describe('GET /api/commands', () => {
    it('returns an array of wire CommandDefs (no run field)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/commands', headers: HOST() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((c: any) => c.name === 'kill')).toBe(true);
      for (const c of body) expect(c.run).toBeUndefined();
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test fn-commands-route` → fails: 404 (route not registered).
- [ ] **Step 3: Register the route in `server.ts`.**
  Add the import near the other chat import at the top of `apps/server/src/server.ts`:
  ```ts
  import { listCommands } from './commands.js';
  ```
  Then inside `buildServer()`, immediately AFTER the line `registerChatRoutes(app); // §30 — chat dashboard`, add:
  ```ts
  app.get('/api/commands', async () => listCommands());
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test fn-commands-route` → 1 passing.
- [ ] **Step 5: Commit.**
  `git commit -am "feat(server): GET /api/commands serves the wire command registry"`

---

### Task 4: `git.ts` helpers — `repoRoot()` + `lsFiles()` for files/find

`files/find` (Task 5/6) needs (a) the git toplevel for a cwd and (b) the tracked file list. Add two thin, never-throwing helpers next to the existing `lsTree`/`gitExec`, reusing `gitExec`.

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/cov-git-lsfiles.test.ts`:
  ```ts
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
  import { execFileSync } from 'node:child_process';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { repoRoot, lsFiles } from '../src/git.js';

  let repo: string; let bare: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'fleet-git-lsfiles-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    writeFileSync(join(repo, 'a.txt'), 'a');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'b.ts'), 'b');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    bare = mkdtempSync(join(tmpdir(), 'fleet-nonrepo-'));
  });
  afterAll(() => {});

  describe('repoRoot', () => {
    it('returns the git toplevel for a path inside a repo', async () => {
      const root = await repoRoot(join(repo, 'src'));
      expect(root).toBeTruthy();
      // realpath-normalize both sides (macOS /tmp → /private/tmp)
      const { realpathSync } = await import('node:fs');
      expect(realpathSync(root!)).toBe(realpathSync(repo));
    });
    it('returns null outside any repo', async () => {
      expect(await repoRoot(bare)).toBeNull();
    });
  });

  describe('lsFiles', () => {
    it('lists tracked files relative to the repo root', async () => {
      const files = await lsFiles(repo);
      expect(files).toContain('a.txt');
      expect(files).toContain('src/b.ts');
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test cov-git-lsfiles` → fails: `repoRoot`/`lsFiles` not exported.
- [ ] **Step 3: Implement the helpers.**
  In `apps/server/src/git.ts`, immediately AFTER the `lsTree` function (ends at the line returning `{ entries }`), add:
  ```ts
  /**
   * Git toplevel for an arbitrary directory (the `@`-mention workspace resolver, SPEC §6.1).
   * Returns the absolute repo root, or null when `dir` is not inside a git work tree. Never throws.
   */
  export async function repoRoot(dir: string): Promise<string | null> {
    const r = await gitExec(dir, ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (!r.ok) return null;
    const top = r.stdout.trim();
    return top ? top : null;
  }

  /**
   * Tracked files of a repo, repo-root-relative, '/'-separated (the fast `@`-mention path source).
   * Uses `ls-files -z` so paths with spaces/newlines survive. Never throws; [] on failure.
   */
  export async function lsFiles(root: string): Promise<string[]> {
    const r = await gitExec(root, ['-C', root, 'ls-files', '-z']);
    if (!r.ok) return [];
    return r.stdout.split('\0').filter((p) => p.length > 0);
  }
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test cov-git-lsfiles` → 3 passing.
- [ ] **Step 5: Commit.**
  `git commit -am "feat(server): git repoRoot() + lsFiles() helpers for @-mention workspace resolve"`

---

### Task 5: `GET /api/files/find` — fuzzy file/dir search in `fileview.ts`

Resolve the workspace from `cwd` (git root via `repoRoot()` → `lsFiles()`; else a `.gitignore`-naive bounded walk), fuzzy-match files **and** dirs against `q`, float recents, and guard every candidate with `safePath()` containment. Paths returned are **workspace-relative**. Response shape is Unit F's `FileFindResult[]` (`{ path, kind:'file'|'dir', score }`).

The fuzzy scorer is a small subsequence matcher (a common pattern; spelled out below so there is no ambiguity). Higher score = better; non-matches return -1 and are dropped.

- [ ] **Step 1: Write the failing test (function-level fuzzy + route-level safePath).**
  Create `apps/server/test/fn-files-find.test.ts`:
  ```ts
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
  import { execFileSync } from 'node:child_process';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-files-find-'));

  let app: any; let PORT: number; let repo: string;
  const HOST = () => ({ host: `127.0.0.1:${PORT}` });

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'fleet-find-repo-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'chatLive.ts'), '');
    writeFileSync(join(repo, 'src', 'commands.ts'), '');
    writeFileSync(join(repo, 'README.md'), '');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

    const cfg = await import('../src/config.js');
    PORT = cfg.PORT;
    const { buildServer } = await import('../src/server.js');
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  const find = (q: string, cwd = repo, limit = 20) =>
    app.inject({ method: 'GET', url: `/api/files/find?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}&limit=${limit}`, headers: HOST() });

  describe('GET /api/files/find', () => {
    it('fuzzy-matches tracked files and returns workspace-relative paths', async () => {
      const res = await find('chatlive');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const top = body[0];
      expect(top.path).toBe('src/chatLive.ts');
      expect(top.kind).toBe('file');
      expect(typeof top.score).toBe('number');
    });
    it('includes directories as kind:dir', async () => {
      const body = (await find('src')).json();
      expect(body.some((r: any) => r.path === 'src' && r.kind === 'dir')).toBe(true);
    });
    it('an empty q returns results (recents/all, capped by limit)', async () => {
      const body = (await find('', repo, 2)).json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeLessThanOrEqual(2);
    });
    it('400s when cwd is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/files/find?q=x', headers: HOST() });
      expect(res.statusCode).toBe(400);
    });
    it('every returned path is containment-safe (no leading slash, no ..)', async () => {
      const body = (await find('a')).json();
      for (const r of body) {
        expect(r.path.startsWith('/')).toBe(false);
        expect(r.path.includes('..')).toBe(false);
      }
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test fn-files-find` → fails: 404 (route not registered).
- [ ] **Step 3: Implement the scorer + collector + route in `fileview.ts`.**
  At the top of `apps/server/src/fileview.ts`, extend the existing `git.js` import to include the new helpers and `safePath` is already imported. Change the import block:
  ```ts
  import {
    safePath,
    lsTree,
    showFile,
    statusPorcelain,
    changedDiff,
    gitLog,
    gitShow,
    gitExec,
    repoRoot,
    lsFiles,
  } from './git.js';
  ```
  Also add at the top with the other node imports:
  ```ts
  import { readdirSync } from 'node:fs';
  import type { FileFindResult } from '@fleet/shared';
  ```
  Then, ABOVE `export function registerFileviewRoutes(app)`, add the helpers:
  ```ts
  const FIND_WALK_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo']);

  /**
   * Subsequence fuzzy score: every char of `q` (lowercased) must appear in order in `hay`.
   * Returns -1 on no match. Rewards contiguous runs and a basename hit, so 'chatlive' ranks
   * 'src/chatLive.ts' above an incidental 'c…h…a…t…l…i…v…e' scatter. Empty q → 0 (everything matches).
   */
  function fuzzyScore(hay: string, q: string): number {
    if (!q) return 0;
    const h = hay.toLowerCase();
    let score = 0, run = 0, qi = 0;
    for (let i = 0; i < h.length && qi < q.length; i++) {
      if (h[i] === q[qi]) { run++; score += 1 + run; qi++; } else { run = 0; }
    }
    if (qi < q.length) return -1; // not all of q consumed → no match
    // basename bonus: a hit late in the path (the filename) reads as more relevant.
    const base = hay.slice(hay.lastIndexOf('/') + 1).toLowerCase();
    if (base.includes(q)) score += 10;
    return score;
  }

  /**
   * Workspace path list for `@`-mention search (SPEC §6.1): git ls-files when in a repo (fast,
   * tracked-only), else a bounded gitignore-naive walk capped at `cap`. Returns repo/cwd-relative
   * paths with their kind. Dirs are synthesized from file path prefixes so folders are mentionable.
   */
  async function collectWorkspace(root: string, cap: number): Promise<Array<{ path: string; kind: 'file' | 'dir' }>> {
    const files = await lsFiles(root);
    let rels: string[];
    if (files.length > 0) {
      rels = files;
    } else {
      // non-repo (or empty repo): bounded walk.
      rels = [];
      const walk = (dir: string, prefix: string) => {
        if (rels.length >= cap) return;
        let entries: ReturnType<typeof readdirSync> = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (rels.length >= cap) return;
          if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
          if (FIND_WALK_DIRS.has(e.name)) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
          else rels.push(rel);
        }
      };
      walk(root, '');
    }
    const out: Array<{ path: string; kind: 'file' | 'dir' }> = [];
    const dirs = new Set<string>();
    for (const rel of rels) {
      out.push({ path: rel, kind: 'file' });
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!dirs.has(d)) { dirs.add(d); out.push({ path: d, kind: 'dir' }); }
      }
    }
    return out;
  }
  ```
  Then, INSIDE `registerFileviewRoutes(app)` (before the closing `}`), register the route:
  ```ts
  /**
   * GET /api/files/find?cwd=<abs>&q=<str>&limit=<n> → FileFindResult[] (SPEC §6.1).
   * Resolves the workspace (git root else the raw cwd), fuzzy-matches files+dirs, floats nothing
   * special in v1 (recents are a client concern), guards each candidate with safePath containment,
   * and returns workspace-relative paths. Disk I/O is bounded by `limit` (walk cap) + the scorer sort.
   */
  app.get('/api/files/find', async (req, reply) => {
    const q = (req.query as any) ?? {};
    const cwd = typeof q.cwd === 'string' ? q.cwd : '';
    const query = typeof q.q === 'string' ? q.q.toLowerCase() : '';
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    if (!cwd) { reply.code(400); return { error: 'cwd is required' }; }

    const root = (await repoRoot(cwd)) ?? cwd;
    const candidates = await collectWorkspace(root, 2000);

    const scored: Array<FileFindResult> = [];
    for (const c of candidates) {
      const score = fuzzyScore(c.path, query);
      if (score < 0) continue;
      // containment guard: a tracked path could in principle be a symlink escape.
      const safe = await safePath(root, c.path);
      if (!safe) continue;
      scored.push({ path: c.path, kind: c.kind, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return scored.slice(0, limit);
  });
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test fn-files-find` → 5 passing.
- [ ] **Step 5: Typecheck (confirms `FileFindResult` is exported by Unit F).**
  `pnpm --filter @fleet/server typecheck` → no errors. If it fails on the missing `FileFindResult` import, that is a Unit F dependency — note it and stop.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): GET /api/files/find fuzzy @-mention workspace search"`

---

### Task 6: `chatLive.ts` — live-process manager (semaphore + idle auto-suspend + ensure/evict)

The live manager owns `sessionId → live handle`, a `CHAT_LIVE_MAX` semaphore (separate from `maxConcurrentRuns`), idle timers, and `ensureLive()` / `evict()`. `ensureLive` returns a handle when a slot is free, else signals **fallback-to-resumable**. It launches an interactive run via `registry.launch({ interactive:true, … })`. Idle past `CHAT_IDLE_SUSPEND_MS` → `evict()` (which `registry.stop()`s the backing run and frees the slot).

This task tests the **pure semaphore/eviction logic** with a mocked `registry` (no real spawns), mirroring `commands.test.ts`/`chat.test.ts` mocking style.

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/cov-chatlive.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  const launched: any[] = [];
  vi.mock('../src/registry.js', () => ({
    registry: {
      launch: vi.fn((req: any) => { const id = `run-${launched.length}`; launched.push({ id, ...req }); return { id }; }),
      stop: vi.fn(),
      getRun: vi.fn(() => ({ status: 'running' })),
    },
  }));
  // tiny idle window so the eviction test is fast
  vi.mock('../src/config.js', async (orig) => ({ ...(await orig() as any), CHAT_LIVE_MAX: 2, CHAT_IDLE_SUSPEND_MS: 50 }));

  import { chatLive } from '../src/chatLive.js';
  import { registry } from '../src/registry.js';

  beforeEach(() => { launched.length = 0; (registry.launch as any).mockClear(); (registry.stop as any).mockClear(); chatLive._resetForTest(); });

  const session = (id: string) => ({ id, cwd: '/tmp', model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default', allowedTools: null, skills: null } as any);

  describe('chatLive', () => {
    it('ensureLive launches an interactive run and tracks the handle', async () => {
      const r = await chatLive.ensureLive(session('s1'));
      expect(r.live).toBe(true);
      expect(r.runId).toBe('run-0');
      expect((registry.launch as any).mock.calls[0][0].interactive).toBe(true);
      expect(chatLive.isLive('s1')).toBe(true);
    });

    it('a second ensureLive for the same session reuses the handle (no new launch)', async () => {
      await chatLive.ensureLive(session('s1'));
      await chatLive.ensureLive(session('s1'));
      expect((registry.launch as any)).toHaveBeenCalledTimes(1);
    });

    it('falls back to resumable when CHAT_LIVE_MAX is exhausted', async () => {
      await chatLive.ensureLive(session('s1'));
      await chatLive.ensureLive(session('s2')); // fills the 2 slots
      const r = await chatLive.ensureLive(session('s3'));
      expect(r.live).toBe(false); // fallback signal
      expect(r.runId).toBeNull();
      expect((registry.launch as any)).toHaveBeenCalledTimes(2); // s3 did NOT launch
    });

    it('evict frees the slot and stops the backing run', async () => {
      const a = await chatLive.ensureLive(session('s1'));
      chatLive.evict('s1');
      expect((registry.stop as any)).toHaveBeenCalledWith(a.runId);
      expect(chatLive.isLive('s1')).toBe(false);
      // slot freed → a previously-blocked session can now go live
      await chatLive.ensureLive(session('s2'));
      await chatLive.ensureLive(session('s3'));
      const r = await chatLive.ensureLive(session('s4'));
      expect(r.live).toBe(false); // back at the cap again
    });

    it('auto-suspends an idle session after CHAT_IDLE_SUSPEND_MS', async () => {
      await chatLive.ensureLive(session('s1'));
      expect(chatLive.isLive('s1')).toBe(true);
      await new Promise((res) => setTimeout(res, 90)); // > 50ms idle window
      expect(chatLive.isLive('s1')).toBe(false);
      expect((registry.stop as any)).toHaveBeenCalled();
    });

    it('touch resets the idle timer (keeps a busy session live)', async () => {
      await chatLive.ensureLive(session('s1'));
      await new Promise((res) => setTimeout(res, 30));
      chatLive.touch('s1'); // activity → restart the 50ms window
      await new Promise((res) => setTimeout(res, 30)); // 60ms total but only 30 since touch
      expect(chatLive.isLive('s1')).toBe(true);
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test cov-chatlive` → fails: cannot find `../src/chatLive.js`.
- [ ] **Step 3: Implement `chatLive.ts`.**
  Create `apps/server/src/chatLive.ts`:
  ```ts
  /**
   * §3.3 / §10 — live-process manager for chat sessions. Owns the sessionId→live-handle map, the
   * CHAT_LIVE_MAX semaphore (a budget SEPARATE from maxConcurrentRuns so chat can never starve the
   * batch fleet and vice-versa), idle auto-suspend timers, and ensure/evict logic.
   *
   * ensureLive(session) returns { live:true, runId } when a slot is free (launches an interactive
   * run held open for instant turns + mid-turn input), or { live:false, runId:null } to signal
   * FALLBACK-TO-RESUMABLE when the budget is exhausted (the caller then resumes per-turn, ~1s slower).
   * Kill / server-restart / idle-eviction all drop the session to resumable without data loss
   * (the transcript lives in SQLite; the live process is ephemeral).
   */
  import { registry } from './registry.js';
  import { CHAT_LIVE_MAX, CHAT_IDLE_SUSPEND_MS } from './config.js';
  import type { ChatSession } from '@fleet/shared';

  interface LiveHandle { runId: string; idleTimer: ReturnType<typeof setTimeout> | null; }

  /** Result of ensureLive: live=true means a held process (runId set); live=false = resumable fallback. */
  export interface EnsureResult { live: boolean; runId: string | null; }

  class ChatLiveManager {
    private handles = new Map<string, LiveHandle>();

    /** A session is "live" iff a held interactive process is tracked for it. */
    isLive(sessionId: string): boolean { return this.handles.has(sessionId); }

    /** Run-id of the held process for a live session, else null. */
    liveRunId(sessionId: string): string | null { return this.handles.get(sessionId)?.runId ?? null; }

    /**
     * Ensure a live process for `session`. Reuses an existing handle; otherwise launches an
     * interactive run if a CHAT_LIVE_MAX slot is free; otherwise signals resumable fallback.
     */
    async ensureLive(session: ChatSession): Promise<EnsureResult> {
      const existing = this.handles.get(session.id);
      if (existing) { this.touch(session.id); return { live: true, runId: existing.runId }; }
      if (this.handles.size >= CHAT_LIVE_MAX) return { live: false, runId: null };
      const run = await registry.launch({
        prompt: session.title || 'Chat session',
        cwd: session.cwd,
        model: session.model,
        effort: session.effort,
        permissionMode: session.permissionMode,
        allowedTools: session.allowedTools ?? undefined,
        skills: session.skills ?? undefined,
        interactive: true,
      } as any);
      const handle: LiveHandle = { runId: run.id, idleTimer: null };
      this.handles.set(session.id, handle);
      this.arm(session.id);
      return { live: true, runId: run.id };
    }

    /** Mark activity on a live session — restarts its idle-suspend timer. No-op if not live. */
    touch(sessionId: string): void { if (this.handles.has(sessionId)) this.arm(sessionId); }

    /** Stop the held process and free the slot; the session drops to resumable. Idempotent. */
    evict(sessionId: string): void {
      const h = this.handles.get(sessionId);
      if (!h) return;
      if (h.idleTimer) clearTimeout(h.idleTimer);
      this.handles.delete(sessionId);
      try { registry.stop(h.runId); } catch { /* already terminal */ }
    }

    private arm(sessionId: string): void {
      const h = this.handles.get(sessionId);
      if (!h) return;
      if (h.idleTimer) clearTimeout(h.idleTimer);
      h.idleTimer = setTimeout(() => this.evict(sessionId), CHAT_IDLE_SUSPEND_MS);
      h.idleTimer.unref?.();
    }

    /** Test-only: clear all timers + handles between cases (no process side effects beyond stop). */
    _resetForTest(): void {
      for (const h of this.handles.values()) if (h.idleTimer) clearTimeout(h.idleTimer);
      this.handles.clear();
    }
  }

  export const chatLive = new ChatLiveManager();
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test cov-chatlive` → 6 passing. (The idle-timer tests rely on the mocked `CHAT_IDLE_SUSPEND_MS: 50`.)
- [ ] **Step 5: Typecheck.**
  `pnpm --filter @fleet/server typecheck` → no errors.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): chatLive manager — CHAT_LIVE_MAX semaphore + idle auto-suspend"`

---

### Task 7: Thread `attachments` through the turn (`--add-dir` for dirs, path-reference for files)

`startTurn` gains an optional `attachments: ChatAttachment[]`. Files become path-reference tokens appended to the prompt (the agent reads them at runtime); dirs are added to that turn's launch/resume `--add-dir` set. The persisted user `ChatMessage` carries the `attachments`. This requires persisting `attachments` JSON on `chat_messages` (additive column, old rows null) and forwarding `addDirs` to the registry call.

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/cov-chat-attachments.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-attach-'));

  vi.mock('../src/registry.js', () => ({
    registry: {
      launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
      resume: vi.fn(async (id: string) => ({ id: 'run-resume', sessionId: 's', status: 'running' })),
      launchEngine: vi.fn(async (req: any) => ({ id: 'run-engine', ...req })),
    },
  }));

  describe('startTurn with attachments', () => {
    it('appends file path-references to the prompt and passes dirs as addDirs', async () => {
      const { registry } = await import('../src/registry.js');
      const { chatRepo, startTurn } = await import('../src/chat.js');
      const s = chatRepo.createSession({ cwd: '/tmp/a' });
      const t = await startTurn(s.id, 'review this', [
        { path: 'src/x.ts', kind: 'file' },
        { path: 'src', kind: 'dir' },
      ]);
      const launchArg = (registry.launch as any).mock.calls.at(-1)[0];
      expect(launchArg.prompt).toContain('review this');
      expect(launchArg.prompt).toContain('src/x.ts'); // file → path reference in the prompt
      expect(launchArg.addDirs).toContain('src'); // dir → --add-dir set
      // persisted on the user message
      expect(t.userMessage.attachments).toEqual([
        { path: 'src/x.ts', kind: 'file' },
        { path: 'src', kind: 'dir' },
      ]);
    });

    it('a turn with no attachments persists none and adds no addDirs', async () => {
      const { registry } = await import('../src/registry.js');
      const { chatRepo, startTurn } = await import('../src/chat.js');
      const s = chatRepo.createSession({ cwd: '/tmp/b' });
      const t = await startTurn(s.id, 'plain');
      const launchArg = (registry.launch as any).mock.calls.at(-1)[0];
      expect(launchArg.addDirs).toBeUndefined();
      expect(t.userMessage.attachments).toBeUndefined();
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test cov-chat-attachments` → fails: `startTurn` ignores the 3rd arg; `attachments` not persisted.
- [ ] **Step 3: Implement attachment persistence + threading in `chat.ts`.**
  First, the schema. The existing `db.exec` creates `chat_messages` without an `attachments` column. Add an idempotent migration immediately AFTER the `db.exec(\`…\`)` block (additive — old rows get NULL):
  ```ts
  // §6 — additive attachments column (old rows null). ALTER is idempotent-guarded.
  try { db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT'); } catch { /* already added */ }
  ```
  Update the import to include `ChatAttachment`:
  ```ts
  import type {
    ChatSession, ChatMessage, ChatRole, ChatMessageKind,
    CreateChatSessionRequest, RunEngine, EffortLevel, PermissionMode,
    ChatTurnResponse, AddChatMessageRequest, ChatAttachment,
  } from '@fleet/shared';
  ```
  Update `insMessage` to write the new column:
  ```ts
  const insMessage = db.prepare(`INSERT INTO chat_messages
    (id,session_id,role,kind,content,run_id,attachments,created_at) VALUES (@id,@session_id,@role,@kind,@content,@run_id,@attachments,@created_at)`);
  ```
  Update `rowToMessage` to surface the column:
  ```ts
  function rowToMessage(r: any): ChatMessage {
    return { id: r.id, sessionId: r.session_id, role: r.role as ChatRole, kind: r.kind as ChatMessageKind,
      content: r.content, runId: r.run_id ?? null,
      attachments: r.attachments ? JSON.parse(r.attachments) : undefined,
      createdAt: r.created_at };
  }
  ```
  Update `chatRepo.addMessage` to accept + persist attachments:
  ```ts
  addMessage(m: { sessionId: string; role: ChatRole; kind: ChatMessageKind; content: string; runId: string | null; attachments?: ChatAttachment[] }): ChatMessage {
    const row = { id: randomUUID(), session_id: m.sessionId, role: m.role, kind: m.kind, content: m.content, run_id: m.runId,
      attachments: m.attachments?.length ? JSON.stringify(m.attachments) : null, created_at: Date.now() };
    insMessage.run(row);
    return rowToMessage(row);
  },
  ```
  Now thread attachments through `startTurn`. Change its signature and body:
  ```ts
  export async function startTurn(sessionId: string, message: string, attachments?: ChatAttachment[]): Promise<ChatTurnResponse> {
    const session = chatRepo.getSession(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('message is required'), { statusCode: 400 });

    const userMessage = chatRepo.addMessage({ sessionId, role: 'user', kind: 'text', content: message, runId: null, attachments });

    // §6.2 — files become path-reference tokens in the prompt; dirs become --add-dir for this turn.
    const files = (attachments ?? []).filter((a) => a.kind === 'file').map((a) => a.path);
    const addDirs = (attachments ?? []).filter((a) => a.kind === 'dir').map((a) => a.path);
    const refSuffix = files.length ? `\n\nReferenced files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';
    const prompt = message + refSuffix;

    const opts: Record<string, unknown> = {
      cwd: session.cwd, model: session.model, effort: session.effort, permissionMode: session.permissionMode,
      allowedTools: session.allowedTools ?? undefined, skills: session.skills ?? undefined,
    };
    if (addDirs.length) opts.addDirs = addDirs;

    let run: { id: string };
    if (session.engine && session.engine !== 'claude') {
      const history = chatRepo.listMessages(sessionId).slice(0, -1);
      const enginePrompt = buildEnginePrompt(history.map((m) => ({ role: m.role, content: m.content })), prompt);
      run = await registry.launchEngine({ ...opts, engine: session.engine, prompt: enginePrompt });
    } else if (!session.runId) {
      run = await registry.launch({ ...opts, prompt });
    } else {
      run = await registry.resume(session.runId, prompt, undefined);
    }
    chatRepo.setSessionRun(sessionId, run.id);
    return { runId: run.id, userMessage };
  }
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test cov-chat-attachments` → 2 passing.
- [ ] **Step 5: Run the existing `chat.test.ts` to prove the turn refactor is non-breaking.**
  `pnpm --filter @fleet/server test chat` → the existing `startTurn`/`buildEnginePrompt`/`chatRepo` tests stay green. (`registry.resume` is still called with the message as the 2nd arg and `undefined` as the 3rd — for an attachment-free turn the prompt equals the message, so the existing `toHaveBeenCalledWith('run-launch', 'second', undefined)` assertion holds.)
- [ ] **Step 6: Typecheck (confirms `ChatAttachment` + `attachments` on `ChatMessage`/`ChatTurnRequest` exist in Unit F).**
  `pnpm --filter @fleet/server typecheck` → no errors.
- [ ] **Step 7: Commit.**
  `git commit -am "feat(server): thread @-mention attachments through the chat turn (--add-dir for dirs)"`

> **Reconciliation note for the assembler:** `addDirs` is passed to `registry.launch`/`resume`/`launchEngine` as a new optional `LaunchRequest` field. If `LaunchRequest` in `@fleet/shared` does not yet carry `addDirs` (and `registry`/`buildArgs` does not translate it to the CLI `--add-dir` flag), that is an out-of-unit dependency — see the global notes.

---

### Task 8: Derived session `state` / `live` on read + `/turn` accepts attachments

`GET /api/chat/sessions/:id` must compute the Unit-F derived fields `state: ChatSessionState` and `live: boolean` from the live manager + backing run status (never stored). `POST /api/chat/sessions/:id/turn` must accept the `attachments` field of `ChatTurnRequest` and forward it to `startTurn`. After every turn, `chatLive.touch()` keeps the session warm.

State derivation rule (spec §3.1): `live` if `chatLive.isLive(id)`; else `running` if the backing run is non-terminal; else `killed` if the backing run's status is `killed`; else `idle`.

- [ ] **Step 1: Write the failing HTTP test.**
  Create `apps/server/test/fn-chat-state.test.ts`:
  ```ts
  import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-state-'));

  // No backing run yet → getRun returns null; chatLive not live → state must be 'idle'.
  vi.mock('../src/registry.js', async (orig) => {
    const actual = await orig() as any;
    return { ...actual, registry: { ...actual.registry, getRun: vi.fn(() => null) } };
  });

  let app: any; let PORT: number;
  const HOST = () => ({ host: `127.0.0.1:${PORT}` });
  const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

  beforeAll(async () => {
    const cfg = await import('../src/config.js');
    PORT = cfg.PORT;
    const { buildServer } = await import('../src/server.js');
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  describe('derived session state/live', () => {
    it('a fresh session (no backing run, not live) reads state:idle live:false', async () => {
      const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
      const got = await get('/api/chat/sessions/' + id);
      expect(got.statusCode).toBe(200);
      expect(got.json().session.state).toBe('idle');
      expect(got.json().session.live).toBe(false);
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test fn-chat-state` → fails: `session.state` is `undefined`.
- [ ] **Step 3: Implement state derivation + attachments on `/turn`.**
  In `apps/server/src/chat.ts`, add the import at the top with the others:
  ```ts
  import { chatLive } from './chatLive.js';
  import type { ChatSessionState } from '@fleet/shared';
  ```
  Add a derivation helper just above `registerChatRoutes`:
  ```ts
  const TERMINAL_RUN = new Set(['completed', 'failed', 'killed']);

  /** §3.1 — derive (never store) a session's lifecycle from the live manager + backing run status. */
  export function deriveSessionState(session: ChatSession): { state: ChatSessionState; live: boolean } {
    const live = chatLive.isLive(session.id);
    if (live) return { state: 'live', live: true };
    const run = session.runId ? registry.getRun(session.runId) : null;
    if (run && !TERMINAL_RUN.has(run.status)) return { state: 'running', live: false };
    if (run && run.status === 'killed') return { state: 'killed', live: false };
    return { state: 'idle', live: false };
  }
  ```
  In the `GET /api/chat/sessions/:id` handler, replace `return { session, messages: chatRepo.listMessages(id) };` with:
  ```ts
  return { session: { ...session, ...deriveSessionState(session) }, messages: chatRepo.listMessages(id) };
  ```
  Replace the `/turn` handler body to forward attachments and warm the session:
  ```ts
  app.post('/api/chat/sessions/:id/turn', async (req, reply) => {
    try {
      const id = (req.params as any).id;
      const body = (req.body ?? {}) as { message?: string; attachments?: import('@fleet/shared').ChatAttachment[] };
      const res = await startTurn(id, body.message as string, body.attachments);
      chatLive.touch(id); // a turn is activity — keep a live session warm
      return res;
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'turn failed' });
    }
  });
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test fn-chat-state` → 1 passing.
- [ ] **Step 5: Re-run the existing route + chat suites to confirm no regression.**
  `pnpm --filter @fleet/server test fn-chat-routes` and `pnpm --filter @fleet/server test chat` → both green.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): derive session state/live on read + accept turn attachments"`

---

### Task 9: Chat-scoped SSE `GET /api/chat/sessions/:id/stream`

A chat-scoped stream subscribes to the *session*, proxying whichever run currently backs it (survives kill→resume and page reload). It re-uses the existing run-event vocabulary via `registry.subscribeRun(session.runId, send)` and emits a chat-control `session_state` envelope `{ state, live }` (owned by this unit; the `ChatSessionState` literal is Unit F's). On connect it sends the current `session_state`, then proxies the backing run's stream. If the session has no backing run yet, it stays open and only emits `session_state`.

- [ ] **Step 1: Write the failing HTTP test.**
  Create `apps/server/test/fn-chat-stream.test.ts`:
  ```ts
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-stream-'));

  let app: any; let PORT: number;
  const HOST = () => ({ host: `127.0.0.1:${PORT}` });

  beforeAll(async () => {
    const cfg = await import('../src/config.js');
    PORT = cfg.PORT;
    const { buildServer } = await import('../src/server.js');
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  describe('GET /api/chat/sessions/:id/stream', () => {
    it('404s for an unknown session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/chat/sessions/nope/stream', headers: HOST() });
      expect(res.statusCode).toBe(404);
    });

    it('opens an SSE stream and emits an initial session_state envelope', async () => {
      const id = (await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: HOST(), payload: { cwd: '/tmp' } })).json().id;
      // inject() resolves once the hijacked response is written; the no-backing-run path writes the
      // initial session_state synchronously then leaves the socket open, so we read the buffered body.
      const res = await app.inject({ method: 'GET', url: `/api/chat/sessions/${id}/stream`, headers: HOST() });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.payload).toContain('session_state');
      expect(res.payload).toContain('"state":"idle"');
    });
  });
  ```
  > Implementation note for the test author: a session with no backing run never opens a long-lived run subscription, so `inject()` returns after the initial frames are flushed. If your local fastify version blocks on the open socket for this case, switch this assertion to a raw `http.get` against `app.server.address()` after `await app.listen({ port: 0 })`, reading the first chunk — but try `inject()` first (it is the suite's default and works for the board/fleet streams).
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test fn-chat-stream` → fails: 404 on the stream route (not registered).
- [ ] **Step 3: Add a registrar in `chat.ts` that takes the shared `sse` helper.**
  `server.ts` owns the `sse(reply, req)` helper (connection cap + headers + hijack). Export a registrar from `chat.ts` that accepts it, so the SSE plumbing stays DRY. Add to `apps/server/src/chat.ts`, after `registerChatRoutes`:
  ```ts
  /** The chat-control envelope the chat-scoped SSE emits alongside run events (§4). Owned here; the
   *  ChatSessionState literal is from @fleet/shared. */
  export interface SessionStateEnvelope { kind: 'session_state'; state: ChatSessionState; live: boolean; }

  /**
   * §4 — chat-scoped SSE. Subscribes to the SESSION (not a run id): proxies whichever run currently
   * backs it, so a kill→resume (run id changes underneath) and a page reload both re-attach cleanly.
   * `mkSse` is server.ts's connection-capped SSE factory (passed in to keep the hijack plumbing there).
   */
  export function registerChatStreamRoute(
    app: FastifyInstance,
    mkSse: (reply: any, req: any) => { send: (obj: unknown) => void; stop: () => void } | null,
  ) {
    app.get('/api/chat/sessions/:id/stream', (req, reply) => {
      const id = (req.params as any).id;
      const session = chatRepo.getSession(id);
      if (!session) { reply.code(404).send({ error: 'not found' }); return; }
      const s = mkSse(reply, req);
      if (!s) return; // 503 already sent (connection cap)
      const { send, stop } = s;

      // initial chat-control frame
      const st = deriveSessionState(session);
      send({ kind: 'session_state', state: st.state, live: st.live } satisfies SessionStateEnvelope);

      // proxy the current backing run, if any (re-resolve per connect so reload re-attaches).
      const runId = chatLive.liveRunId(id) ?? session.runId;
      let unsub: (() => void) | null = null;
      if (runId) unsub = registry.subscribeRun(runId, send);

      reply.raw.on('close', () => { unsub?.(); stop(); });
    });
  }
  ```
- [ ] **Step 4: Wire it in `server.ts` (the `sse` helper lives there).**
  In `apps/server/src/server.ts`, change the chat import to also pull the registrar:
  ```ts
  import { registerChatRoutes, registerChatStreamRoute } from './chat.js'; // §30 — chat dashboard
  ```
  Then, immediately after `registerChatRoutes(app);` inside `buildServer()`, add:
  ```ts
  registerChatStreamRoute(app, sse); // §4 — chat-scoped SSE (proxies the backing run)
  ```
- [ ] **Step 5: Run it, see it pass.**
  `pnpm --filter @fleet/server test fn-chat-stream` → 2 passing.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): chat-scoped SSE proxying the backing run + session_state envelope"`

---

### Task 10: `POST /api/chat/sessions/:id/input` and `POST /api/chat/sessions/:id/interrupt`

`/input` writes mid-turn input / permission decisions to the live process (409 if the session is not live). `/interrupt` stops the current turn but keeps the process live if possible (else marks killed). Both resolve the backing run via `chatLive` first, then the session's `runId`.

- [ ] **Step 1: Write the failing HTTP test.**
  Create `apps/server/test/fn-chat-input-interrupt.test.ts`:
  ```ts
  import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-input-'));

  // Not-live by default: sendInput throws 409 (mirrors registry.sendInput's contract).
  vi.mock('../src/registry.js', async (orig) => {
    const actual = await orig() as any;
    return { ...actual, registry: {
      ...actual.registry,
      getRun: vi.fn(() => null),
      sendInput: vi.fn(() => { throw Object.assign(new Error('Run is not live; use Resume instead.'), { statusCode: 409 }); }),
      stop: vi.fn(),
    } };
  });

  let app: any; let PORT: number;
  const HOST = () => ({ host: `127.0.0.1:${PORT}` });
  const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });

  beforeAll(async () => {
    const cfg = await import('../src/config.js');
    PORT = cfg.PORT;
    const { buildServer } = await import('../src/server.js');
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  describe('chat input / interrupt', () => {
    it('POST /input 404s for an unknown session', async () => {
      expect((await post('/api/chat/sessions/nope/input', { text: 'hi' })).statusCode).toBe(404);
    });
    it('POST /input 400s without text', async () => {
      const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
      expect((await post(`/api/chat/sessions/${id}/input`, {})).statusCode).toBe(400);
    });
    it('POST /input 409s when the session is not live', async () => {
      const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
      expect((await post(`/api/chat/sessions/${id}/input`, { text: 'hi' })).statusCode).toBe(409);
    });
    it('POST /interrupt 404s for an unknown session', async () => {
      expect((await post('/api/chat/sessions/nope/interrupt', {})).statusCode).toBe(404);
    });
    it('POST /interrupt with no backing run is a 200 no-op ack', async () => {
      const id = (await post('/api/chat/sessions', { cwd: '/tmp' })).json().id;
      const res = await post(`/api/chat/sessions/${id}/interrupt`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });
  ```
- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test fn-chat-input-interrupt` → fails: 404 on `/input` and `/interrupt` (routes not registered).
- [ ] **Step 3: Implement both routes inside `registerChatRoutes` in `chat.ts`.**
  Add `sendInput`-backed input + interrupt handlers before the closing `}` of `registerChatRoutes` (just after the existing `/command` route):
  ```ts
  // §3.3 — mid-turn input / permission decisions, written to the live process stdin. 409 if not live.
  app.post('/api/chat/sessions/:id/input', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const text = (req.body as any)?.text;
    if (typeof text !== 'string' || text.length === 0) return reply.code(400).send({ error: 'text must be a non-empty string' });
    const runId = chatLive.liveRunId(id) ?? session.runId;
    if (!runId) return reply.code(409).send({ error: 'session is not live; send a normal turn instead' });
    try {
      registry.sendInput(runId, text);
      chatLive.touch(id);
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'input failed' });
    }
  });

  // §3.3 — stop the current turn. Keeps the held process live where possible; else the stop marks it
  // killed (the session stays resumable either way). No backing run → a harmless ack.
  app.post('/api/chat/sessions/:id/interrupt', async (req, reply) => {
    const id = (req.params as any).id;
    const session = chatRepo.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const runId = chatLive.liveRunId(id) ?? session.runId;
    if (!runId) return { ok: true };
    try {
      registry.stop(runId);
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'interrupt failed' });
    }
  });
  ```
- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/server test fn-chat-input-interrupt` → 5 passing.
- [ ] **Step 5: Full server suite sanity (the refactors touched shared modules).**
  `pnpm --filter @fleet/server test fn-chat-routes` and `pnpm --filter @fleet/server test commands` and `pnpm --filter @fleet/server test chat` → all green; then `pnpm --filter @fleet/server typecheck` → no type errors.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): chat /input (mid-turn, 409 if not live) + /interrupt routes"`

> **Reconciliation note for the assembler:** v1 wires `/interrupt` to `registry.stop(runId)` (kill→resumable), which is the spec's documented fallback ("keeps the process live if possible — else marks killed"). A true keep-process-live interrupt requires a registry method that signals the live child to abort the current turn without killing the process; if Unit 4/registry later adds `registry.interrupt(runId)`, swap the `registry.stop(runId)` call here for it. Flagged so the assembler can reconcile if that method lands.

---

### Task R: Registry `--add-dir` support for `@`-folder attachments (assembler-added; owns spec §6.2/D7)

The `@`-mention picker attaches folders that the spec (§6.2, D7) says are passed to the turn as `--add-dir <dir>`. The chat turn (Task 7 above) forwards an `addDirs: string[]` derived from the turn's folder attachments into `registry.launch`/`registry.resume`, but **no other unit owns the registry plumbing** that turns `addDirs` into the actual `--add-dir` CLI flags. This task adds it. It is small because `buildArgs` already emits `--add-dir` for `req.cwd` (`processManager.ts:135`) and `buildResumeArgs` delegates to `buildArgs` (`processManager.ts:171`), so a single `buildArgs` change covers both launch and resume; the only other change is threading `addDirs` through `registry.resume`'s rebuilt request.

**Files:**
- Modify: `packages/shared/src/index.ts` (add `addDirs?: string[]` to `LaunchRequest`, near line 185)
- Modify: `apps/server/src/processManager.ts` (`buildArgs`, after line 135)
- Modify: `apps/server/src/registry.ts` (`resume` signature + rebuilt `req`, lines 1080 & 1105-1118)
- Test: `apps/server/test/cov-adddirs.test.ts` (new)

- [ ] **Step 1: Write the failing test.** Create `apps/server/test/cov-adddirs.test.ts`:
  ```ts
  /**
   * cov-adddirs — buildArgs/buildResumeArgs emit one `--add-dir <dir>` per req.addDirs entry,
   * in addition to the cwd add-dir, and never duplicate the cwd. Covers @-folder attachments (§6.2).
   */
  import { describe, it, expect } from 'vitest';
  import { buildArgs, buildResumeArgs } from '../src/processManager.js';
  import type { LaunchRequest } from '@fleet/shared';

  const base: LaunchRequest = {
    prompt: 'hi', cwd: '/repo', model: 'claude-opus-4-8',
    effort: 'high', permissionMode: 'default',
  } as LaunchRequest;

  // collect the value after each `--add-dir` occurrence
  function addDirs(args: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') out.push(args[i + 1]);
    return out;
  }

  describe('buildArgs --add-dir', () => {
    it('emits cwd plus each extra addDirs entry', () => {
      const args = buildArgs({ ...base, addDirs: ['/repo/src', '/repo/docs'] }, 'sess-1', false);
      expect(addDirs(args)).toEqual(['/repo', '/repo/src', '/repo/docs']);
    });
    it('does not duplicate the cwd if it appears in addDirs', () => {
      const args = buildArgs({ ...base, addDirs: ['/repo', '/repo/src'] }, 'sess-1', false);
      expect(addDirs(args)).toEqual(['/repo', '/repo/src']);
    });
    it('resume args inherit the extra add-dirs (delegates to buildArgs)', () => {
      const args = buildResumeArgs({ ...base, addDirs: ['/repo/src'] }, 'sess-1', false);
      expect(addDirs(args)).toEqual(['/repo', '/repo/src']);
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/server test cov-adddirs`
  Expected: FAIL — `addDirs` extras absent (only `['/repo']`), and a TS error that `addDirs` is not a property of `LaunchRequest`.

- [ ] **Step 3: Add `addDirs` to `LaunchRequest`.** In `packages/shared/src/index.ts`, inside the `LaunchRequest` interface (starts at line 185), add the field (place it near `cwd`):
  ```ts
    /** Extra directories granted to the agent via repeated `--add-dir` — e.g. @-folder
     *  attachments from the chat composer (chat surface upgrade §6.2). cwd is always added
     *  separately; entries equal to cwd are skipped to avoid a duplicate flag. */
    addDirs?: string[];
  ```

- [ ] **Step 4: Emit the flags in `buildArgs`.** In `apps/server/src/processManager.ts`, replace the single cwd line (135):
  ```ts
  if (req.cwd) args.push('--add-dir', req.cwd);
  ```
  with:
  ```ts
  if (req.cwd) args.push('--add-dir', req.cwd);
  for (const dir of req.addDirs ?? []) {
    if (dir && dir !== req.cwd) args.push('--add-dir', dir);
  }
  ```

- [ ] **Step 5: Run it, see it pass.**
  `pnpm --filter @fleet/server test cov-adddirs`
  Expected: PASS (3 tests). `buildResumeArgs` passes for free because it calls `buildArgs`.

- [ ] **Step 6: Thread `addDirs` through `registry.resume`.** A resume turn rebuilds its `LaunchRequest` from the stored run, so it must accept and forward `addDirs`. In `apps/server/src/registry.ts`, change the `resume` signature (line 1080) from:
  ```ts
  resume(runId: string, prompt?: string, interactive?: boolean): Run {
  ```
  to:
  ```ts
  resume(runId: string, prompt?: string, interactive?: boolean, addDirs?: string[]): Run {
  ```
  and in the rebuilt `req` object (the literal starting at line 1105), add the field after `interactive: interactive ?? false,`:
  ```ts
      addDirs,
  ```
  (Launch already accepts `addDirs` via `LaunchRequest`, so `registry.launch` needs no signature change — the chat turn passes it in the request object.)

- [ ] **Step 7: Typecheck both affected packages.**
  `pnpm --filter @fleet/shared typecheck && pnpm --filter @fleet/server typecheck`
  Expected: no errors. (The chat-turn caller in Task 7 passes `addDirs` as the 4th arg to `resume` for resume turns and as `req.addDirs` for launch turns — confirm that call site compiles against the new signature.)

- [ ] **Step 8: Commit.**
  `git commit -am "feat(server): --add-dir support in LaunchRequest/buildArgs/resume for @-folder attachments"`

> **Reconciliation note:** Unit 1 Task 7 (chat-turn attachment threading) is the producer of `addDirs`; this task is the consumer plumbing. If Task 7 already added `addDirs` to `LaunchRequest`, keep one definition (this task's) and skip Step 3. The `registry.resume` 4th-param change is backward-compatible (optional), so existing 3-arg callers (e.g. the runs page resume button) are unaffected.

---

## Unit 2 — Composer + autocomplete menus

This unit builds the chat **input surface**: a new HUD-canon `FloatingMenu`/`Combobox` overlay primitive, a rewritten multiline `ChatComposer`, the `/` `SlashMenu` and `@` `MentionMenu` that sit over the primitive, and the client `api.ts` / `live.ts` helpers they call. It is **frontend-only**; it imports the canonical wire types (`CommandDef`, `CommandArg`, `ChatAttachment`, `FileFindResult`, `ChatSessionState`) from `@fleet/shared` and the route shapes from Unit 1 — see the **reconciliation notes** for the exact dependency.

**Files:**
- Modify: `/Users/jd/Documents/agent-system/apps/web/components/ui.tsx` — add `FloatingMenu` HUD primitive (caret-anchored popover, grouped, keyboard nav, click-outside).
- Create: `/Users/jd/Documents/agent-system/apps/web/components/SlashMenu.tsx` — `/` command palette over `FloatingMenu`.
- Create: `/Users/jd/Documents/agent-system/apps/web/components/MentionMenu.tsx` — `@` file/folder picker over `FloatingMenu`.
- Rewrite: `/Users/jd/Documents/agent-system/apps/web/components/ChatComposer.tsx` — multiline auto-grow textarea, `/`+`@` trigger detection, attachment chips, Stop button.
- Modify: `/Users/jd/Documents/agent-system/apps/web/lib/api.ts` — `listCommands`, `findFiles`, chat `input`/`interrupt`/`kill`/`resume` helpers.
- Modify: `/Users/jd/Documents/agent-system/apps/web/lib/live.ts` — `useChatStream(sessionId)` chat-scoped SSE hook.
- Create (tests): `/Users/jd/Documents/agent-system/apps/web/test/fn-floatingmenu.test.tsx`, `fn-slashmenu.test.tsx`, `fn-mentionmenu.test.tsx`, `fn-chatcomposer.test.tsx`, `fn-chat-trigger.test.ts`, `fn-api-chat.test.ts`, `fn-usechatstream.test.ts`.

**Test runner facts (verified by reading `apps/web/vitest.config.ts` + `apps/web/test/setup.ts` + `apps/web/package.json`):**
- Runner is **vitest** (`environment: 'jsdom'`, `globals: true`, `setupFiles: ['./test/setup.ts']`, `include: ['test/**/*.test.{ts,tsx}']`). Run web tests with `pnpm --filter @fleet/web test <file>` and typecheck/build with `pnpm --filter @fleet/web typecheck`.
- `@testing-library/react` (v16) provides `render`, `renderHook`, `act`, `waitFor`, `fireEvent`, `screen`, and re-exports `@testing-library/dom`. There is **no `@testing-library/user-event`** and **no `jest-dom`** — so assert on DOM directly (`container.querySelector`, `el.textContent`, `getByText`) and drive interaction with `fireEvent`. Do **not** use `toBeInTheDocument`/`toHaveTextContent` matchers (not installed).
- `test/setup.ts` installs a controllable `FakeEventSource` on `globalThis` (drivers `emitOpen()`, `emit(json)`, `emitError()`, statics `FakeEventSource.last()`, `FakeEventSource.reset()`). `beforeEach` resets it; `afterEach` calls `cleanup()`. SSE-hook tests reuse this transport — do not re-mock EventSource.
- `fetch` is **not** mocked globally. For `api.ts` tests, stub `globalThis.fetch` with `vi.fn()` inside the test and restore it after.
- Existing test naming convention is `fn-*.test.ts(x)`; match it. Frames in stream tests are cast `as any` (vitest does not typecheck test bodies).

---

### Task 1: `FloatingMenu` HUD primitive — render + grouped sections

- [ ] **Step 1: Write the failing render/group test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-floatingmenu.test.tsx`:
  ```tsx
  /**
   * FloatingMenu — the new HUD-canon caret-anchored popover reused by the `/` and `@`
   * menus. These tests render the real component (no user-event lib: we drive with fireEvent
   * and assert on the DOM directly, since jest-dom matchers are not installed).
   */
  import { describe, it, expect, vi } from 'vitest';
  import { render, fireEvent } from '@testing-library/react';
  import { FloatingMenu, type FloatingItem } from '../components/ui';

  const items: FloatingItem[] = [
    { id: 'launch', label: '/launch', hint: 'start a run', group: 'control' },
    { id: 'stop', label: '/stop', hint: 'stop a run', group: 'control' },
    { id: 'mem', label: '/memory', hint: 'fleet memory', group: 'knowledge' },
  ];

  describe('FloatingMenu — rendering', () => {
    it('renders nothing when closed', () => {
      const { container } = render(
        <FloatingMenu open={false} items={items} activeIndex={0} onPick={() => {}} onClose={() => {}} />,
      );
      expect(container.querySelector('[data-floating-menu]')).toBeNull();
    });

    it('renders grouped items under uppercase group headers when open', () => {
      const { container, getByText } = render(
        <FloatingMenu open items={items} activeIndex={0} onPick={() => {}} onClose={() => {}} />,
      );
      expect(container.querySelector('[data-floating-menu]')).not.toBeNull();
      // group headers in first-appearance order
      const headers = [...container.querySelectorAll('[data-group-header]')].map((h) => h.textContent);
      expect(headers).toEqual(['control', 'knowledge']);
      // all three item rows present
      expect(container.querySelectorAll('[data-menu-item]').length).toBe(3);
      expect(getByText('/launch')).toBeTruthy();
    });

    it('renders the empty text when there are no items', () => {
      const { getByText } = render(
        <FloatingMenu open items={[]} activeIndex={0} onPick={() => {}} onClose={() => {}} emptyText="no matches" />,
      );
      expect(getByText('no matches')).toBeTruthy();
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-floatingmenu` → fails to import `FloatingMenu`/`FloatingItem` (does not exist yet).
- [ ] **Step 3: Implement `FloatingMenu` (render + grouping only).**
  In `/Users/jd/Documents/agent-system/apps/web/components/ui.tsx`, add at the end of the file (after `ErrorBanner`):
  ```tsx
  // ─────────────────────────────────────────────────────────────────────────────
  // §9 — HUD-canon FloatingMenu / Combobox: a caret-anchored popover reused by the
  // `/` (SlashMenu) and `@` (MentionMenu) chat surfaces. The HUD has no overlay
  // primitive; this is the one. Styled to canon (charcoal #101217 surface, amber
  // #ffb000 active row, JetBrains Mono rows, uppercase group headers). The OWNER of
  // the item list / filtering / selection is the caller — this component only renders
  // the popover, paints the active row, wires click-outside, and forwards clicks.
  // Keyboard nav (arrow/enter/escape) is owned by the caller's input via `activeIndex`
  // + `onPick`/`onClose`, because the trigger char lives in the caller's <textarea>.
  // ─────────────────────────────────────────────────────────────────────────────

  /** One selectable row. `group` headers render in first-appearance order. */
  export interface FloatingItem {
    id: string;
    label: React.ReactNode;
    hint?: React.ReactNode;
    /** optional right-aligned trailing note (e.g. an arg-hint chip). */
    trailing?: React.ReactNode;
    group?: string;
  }

  export function FloatingMenu({
    open,
    items,
    activeIndex,
    onPick,
    onClose,
    emptyText = 'no matches',
    header,
    footer,
    className = '',
  }: {
    open: boolean;
    items: FloatingItem[];
    /** index into the FLAT `items` array of the currently-highlighted row. */
    activeIndex: number;
    onPick: (item: FloatingItem, index: number) => void;
    onClose: () => void;
    emptyText?: string;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    className?: string;
  }) {
    const rootRef = React.useRef<HTMLDivElement | null>(null);

    // click-outside dismiss — mirrors MultiPicker's mousedown listener
    React.useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
      };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [open, onClose]);

    // scroll the active row into view as the caller moves the selection
    React.useEffect(() => {
      if (!open || !rootRef.current) return;
      const el = rootRef.current.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    }, [open, activeIndex]);

    if (!open) return null;

    // group → rows, preserving first-appearance group order ('' = ungrouped). We keep
    // each row's FLAT index so the caller's activeIndex (over the flat list) lines up.
    const grouped: Array<[string, Array<{ item: FloatingItem; idx: number }>]> = [];
    const seen = new Map<string, Array<{ item: FloatingItem; idx: number }>>();
    items.forEach((item, idx) => {
      const g = item.group ?? '';
      if (!seen.has(g)) {
        const bucket: Array<{ item: FloatingItem; idx: number }> = [];
        seen.set(g, bucket);
        grouped.push([g, bucket]);
      }
      seen.get(g)!.push({ item, idx });
    });

    return (
      <div
        ref={rootRef}
        data-floating-menu
        className={`absolute left-0 bottom-full mb-1 z-50 w-full border border-line2 overflow-auto ${className}`}
        style={{ background: '#101217', maxHeight: 280, boxShadow: '0 -12px 32px -8px rgba(0,0,0,0.8)' }}
      >
        {header && <div className="px-3 py-1.5 border-b hairline font-mono text-[10px] text-faint">{header}</div>}
        {items.length === 0 && <div className="px-3 py-2 font-mono text-[11px] text-faint">{emptyText}</div>}
        {grouped.map(([group, rows]) => (
          <div key={group || '∅'}>
            {group && (
              <div
                data-group-header
                className="px-3 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-faint sticky top-0"
                style={{ background: '#101217' }}
              >
                {group}
              </div>
            )}
            {rows.map(({ item, idx }) => {
              const active = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-menu-item
                  data-idx={idx}
                  // onMouseDown (not onClick) so the row fires BEFORE the textarea blurs
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(item, idx);
                  }}
                  className="w-full text-left px-3 py-1.5 font-mono text-[11.5px] flex items-baseline gap-2"
                  style={{
                    color: active ? '#ffb000' : '#e9e7df',
                    background: active ? 'rgba(255,176,0,0.10)' : 'transparent',
                  }}
                >
                  <span className="shrink-0">{item.label}</span>
                  {item.hint && <span className="text-faint text-[10px] truncate flex-1">{item.hint}</span>}
                  {item.trailing && <span className="text-faint text-[10px] shrink-0 ml-auto">{item.trailing}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {footer && <div className="px-3 py-1.5 border-t hairline font-mono text-[10px] text-faint">{footer}</div>}
      </div>
    );
  }
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-floatingmenu` → 3 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): add HUD-canon FloatingMenu primitive (render + grouping)"`

---

### Task 2: `FloatingMenu` — active-row paint, pick-on-click, click-outside dismiss

- [ ] **Step 1: Write the failing interaction test.**
  Append to `/Users/jd/Documents/agent-system/apps/web/test/fn-floatingmenu.test.tsx`:
  ```tsx
  describe('FloatingMenu — interaction', () => {
    const items: FloatingItem[] = [
      { id: 'a', label: 'alpha', group: 'g1' },
      { id: 'b', label: 'beta', group: 'g1' },
      { id: 'c', label: 'gamma', group: 'g2' },
    ];

    it('paints the active row amber and others default', () => {
      const { container } = render(
        <FloatingMenu open items={items} activeIndex={1} onPick={() => {}} onClose={() => {}} />,
      );
      const rows = [...container.querySelectorAll('[data-menu-item]')] as HTMLElement[];
      expect(rows[1].style.color).toBe('rgb(255, 176, 0)'); // #ffb000 active
      expect(rows[0].style.color).not.toBe('rgb(255, 176, 0)');
    });

    it('fires onPick with the item and its flat index on mousedown', () => {
      const onPick = vi.fn();
      const { container } = render(
        <FloatingMenu open items={items} activeIndex={0} onPick={onPick} onClose={() => {}} />,
      );
      const rows = [...container.querySelectorAll('[data-menu-item]')] as HTMLElement[];
      fireEvent.mouseDown(rows[2]);
      expect(onPick).toHaveBeenCalledWith(items[2], 2);
    });

    it('calls onClose on an outside mousedown', () => {
      const onClose = vi.fn();
      render(<FloatingMenu open items={items} activeIndex={0} onPick={() => {}} onClose={onClose} />);
      fireEvent.mouseDown(document.body);
      expect(onClose).toHaveBeenCalled();
    });
  });
  ```
- [ ] **Step 2: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-floatingmenu` — the implementation from Task 1 already satisfies these (it asserts the contract end-to-end). If the active-row color assertion fails on hex serialization, confirm jsdom normalizes `#ffb000` → `rgb(255, 176, 0)` (it does). All 6 tests pass.
- [ ] **Step 3: Typecheck.**
  `pnpm --filter @fleet/web typecheck` → compiles (the new export is wired). If it fails, the cause is a missing `React` import — `ui.tsx` already imports `React` at the top, so `React.useRef`/`React.useEffect` resolve.
- [ ] **Step 4: Commit.**
  `git add -A && git commit -m "test(web): cover FloatingMenu active-row + pick + click-outside"`

---

### Task 3: `api.ts` — `listCommands` + `findFiles` client helpers

- [ ] **Step 1: Write the failing helper test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-api-chat.test.ts`:
  ```ts
  /**
   * api.ts chat-surface helpers (Unit 2). `fetch` is NOT globally mocked, so we stub
   * globalThis.fetch per-test and assert the URL/method/body the helper builds, then
   * restore. We import the singleton `api` object.
   */
  import { describe, it, expect, vi, afterEach } from 'vitest';
  import { api } from '../lib/api';

  const okJson = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body, statusText: 'OK' }) as any);

  afterEach(() => { vi.restoreAllMocks(); });

  describe('api.listCommands', () => {
    it('GETs /api/commands and returns the CommandDef[]', async () => {
      const defs = [{ name: 'kill', group: 'control', usage: '/kill <run-id>', args: [], description: 'x', resultKind: 'ack' }];
      const f = okJson(defs);
      vi.stubGlobal('fetch', f);
      const out = await api.listCommands();
      expect(f.mock.calls[0][0]).toContain('/api/commands');
      expect(out).toEqual(defs);
    });
  });

  describe('api.findFiles', () => {
    it('GETs /api/files/find with cwd, q and limit query params (url-encoded)', async () => {
      const rows = [{ path: 'src/a.ts', kind: 'file', score: 9 }];
      const f = okJson(rows);
      vi.stubGlobal('fetch', f);
      const out = await api.findFiles('/work/space', 'a.ts', 20);
      const url = String(f.mock.calls[0][0]);
      expect(url).toContain('/api/files/find');
      expect(url).toContain('cwd=' + encodeURIComponent('/work/space'));
      expect(url).toContain('q=' + encodeURIComponent('a.ts'));
      expect(url).toContain('limit=20');
      expect(out).toEqual(rows);
    });

    it('omits limit from the query when not supplied', async () => {
      const f = okJson([]);
      vi.stubGlobal('fetch', f);
      await api.findFiles('/c', 'x');
      expect(String(f.mock.calls[0][0])).not.toContain('limit=');
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-api-chat` → fails: `api.listCommands`/`api.findFiles` are not functions.
- [ ] **Step 3: Implement the helpers.**
  In `/Users/jd/Documents/agent-system/apps/web/lib/api.ts`, add `CommandDef` and `FileFindResult` to the existing `@fleet/shared` import block (keep the block alphabetical-ish; add the two names):
  ```ts
    CommandDef,
    FileFindResult,
  ```
  Then add these properties to the `api` object (place them in the `// ── §30 chat dashboard ──` section, just after `chatCommand`):
  ```ts
    // ── chat-surface upgrade (§5/§6) ──
    /** §5.3 — `/` palette catalog (server strips CommandDef.run before serializing). */
    listCommands: () => j<CommandDef[]>('/api/commands'),
    /** §6.1 — `@` fuzzy file/folder search scoped to the session cwd. */
    findFiles: (cwd: string, q: string, limit?: number) =>
      j<FileFindResult[]>('/api/files/find' + qs({ cwd, q, limit: limit != null ? String(limit) : undefined })),
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-api-chat` → 3 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): api listCommands + findFiles helpers"`

---

### Task 4: `api.ts` — chat `input` / `interrupt` / `kill` / `resume`

- [ ] **Step 1: Write the failing test.**
  Append to `/Users/jd/Documents/agent-system/apps/web/test/fn-api-chat.test.ts`:
  ```ts
  describe('api chat control helpers', () => {
    const captured = () => {
      const f = vi.fn(async () => ({ ok: true, json: async () => ({}), statusText: 'OK' }) as any);
      vi.stubGlobal('fetch', f);
      return f;
    };

    it('chatInput POSTs the mid-turn text to /input with attachments', async () => {
      const f = captured();
      await api.chatInput('sess1', 'approve', [{ path: 'a.ts', kind: 'file' }]);
      const [url, init] = f.mock.calls[0];
      expect(String(url)).toContain('/api/chat/sessions/sess1/input');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ message: 'approve', attachments: [{ path: 'a.ts', kind: 'file' }] });
    });

    it('chatInterrupt POSTs to /interrupt with an empty body', async () => {
      const f = captured();
      await api.chatInterrupt('sess1');
      const [url, init] = f.mock.calls[0];
      expect(String(url)).toContain('/api/chat/sessions/sess1/interrupt');
      expect(init.method).toBe('POST');
    });

    it('chatKill DELETEs the session-backing run', async () => {
      const f = captured();
      await api.chatKill('sess1');
      const [url, init] = f.mock.calls[0];
      expect(String(url)).toContain('/api/chat/sessions/sess1');
      expect(init.method).toBe('DELETE');
    });

    it('chatTurn carries attachments in the body when supplied', async () => {
      const f = captured();
      await api.chatTurn('sess1', 'hello @a.ts', [{ path: 'a.ts', kind: 'file' }]);
      const [url, init] = f.mock.calls[0];
      expect(String(url)).toContain('/api/chat/sessions/sess1/turn');
      expect(JSON.parse(init.body)).toEqual({ message: 'hello @a.ts', attachments: [{ path: 'a.ts', kind: 'file' }] });
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-api-chat` → fails: `chatInput`/`chatInterrupt`/`chatKill` undefined, and the existing `chatTurn` ignores attachments (wrong body shape).
- [ ] **Step 3: Implement.**
  In `/Users/jd/Documents/agent-system/apps/web/lib/api.ts`, add `ChatAttachment` to the `@fleet/shared` import block:
  ```ts
    ChatAttachment,
  ```
  Replace the existing `chatTurn` line:
  ```ts
    chatTurn: (id: string, message: string) => j<ChatTurnResponse>(`/api/chat/sessions/${id}/turn`, { method: 'POST', body: JSON.stringify({ message }) }),
  ```
  with the attachment-carrying version plus the new control helpers:
  ```ts
    chatTurn: (id: string, message: string, attachments?: ChatAttachment[]) =>
      j<ChatTurnResponse>(`/api/chat/sessions/${id}/turn`, {
        method: 'POST',
        body: JSON.stringify(attachments?.length ? { message, attachments } : { message }),
      }),
    /** §3 — mid-turn input / permission decision to the live process (409 if not live). */
    chatInput: (id: string, message: string, attachments?: ChatAttachment[]) =>
      j(`/api/chat/sessions/${id}/input`, {
        method: 'POST',
        body: JSON.stringify(attachments?.length ? { message, attachments } : { message }),
      }),
    /** §3 — stop the current turn, keep the process live if possible. */
    chatInterrupt: (id: string) =>
      j(`/api/chat/sessions/${id}/interrupt`, { method: 'POST', body: JSON.stringify({}) }),
    /** §3 — explicit kill: stops the live process; session becomes killed/resumable. */
    chatKill: (id: string) => j(`/api/chat/sessions/${id}`, { method: 'DELETE' }),
  ```
  > Note: `chatKill` DELETEs `/api/chat/sessions/:id` per the kill→resume model (§3.3 "Kill: DELETE semantics … session becomes killed/resumable"). There is **no** dedicated resume endpoint — the next normal `chatTurn`/`chatInput` transparently re-spawns via `--resume` (§3.1 idle/killed both resume on next message). The Stop button calls `chatInterrupt`; an explicit kill control (Unit on session-list) calls `chatKill`. **See reconciliation note 4** — confirm with Unit 1 whether `DELETE /api/chat/sessions/:id` is repurposed for kill vs. session-delete.
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-api-chat` → all 7 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): api chat input/interrupt/kill + attachment-carrying turn"`

---

### Task 5: `live.ts` — `useChatStream(sessionId)` chat-scoped SSE hook (open + connected + session_state)

- [ ] **Step 1: Write the failing hook test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-usechatstream.test.ts`:
  ```ts
  /**
   * useChatStream(sessionId) — subscribes to the SESSION (not a run id) at
   * /api/chat/sessions/:id/stream and reduces the existing run-event vocabulary
   * (assistant_partial/assistant_text/tool_use/...) PLUS the chat-control `session_state`
   * envelope { state, live }. The FakeEventSource (test/setup.ts) is the transport.
   */
  import { describe, it, expect } from 'vitest';
  import { renderHook, act } from '@testing-library/react';
  import { useChatStream } from '../lib/live';
  import { FakeEventSource } from './setup';

  const ev = (type: string, nodeId: string, payload: any = {}): any => ({
    sessionId: 's', runId: 'run1', nodeId, parentNodeId: null, nodeType: 'root', seq: 0, ts: 0, type, payload,
  });

  describe('useChatStream — connection + session_state', () => {
    it('opens the chat-scoped SSE channel and toggles connected', () => {
      const { result } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      expect(es.url).toContain('/api/chat/sessions/sess1/stream');
      expect(result.current.connected).toBe(false);
      act(() => es.emitOpen());
      expect(result.current.connected).toBe(true);
      act(() => es.emitError());
      expect(result.current.connected).toBe(false);
    });

    it('reduces the session_state envelope into state + live', () => {
      const { result } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      expect(result.current.state).toBe('idle'); // default before any frame
      act(() => es.emit({ kind: 'session_state', state: 'running', live: true } as any));
      expect(result.current.state).toBe('running');
      expect(result.current.live).toBe(true);
      act(() => es.emit({ kind: 'session_state', state: 'killed', live: false } as any));
      expect(result.current.state).toBe('killed');
      expect(result.current.live).toBe(false);
    });

    it('closes the stream on unmount and ignores malformed frames', () => {
      const { unmount } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      act(() => es.emit('not json{'));
      unmount();
      expect(es.closed).toBe(true);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-usechatstream` → fails: `useChatStream` is not exported from `../lib/live`.
- [ ] **Step 3: Implement the hook (connection + session_state only).**
  In `/Users/jd/Documents/agent-system/apps/web/lib/live.ts`, add `ChatSessionState` to the `@fleet/shared` import block, then append this hook after `useCampaign` (before `useAsync`):
  ```ts
  // ── per-chat-session live channel (§4 chat-scoped SSE) ──────────────────────
  // Subscribes to the SESSION, not a run id, so it survives kill→resume (the backing
  // run id changes underneath) and page reload. Re-uses the EXISTING run-event
  // vocabulary (assistant_partial/text, tool_use, tool_result, thinking,
  // permission_request, subagent_spawned, result) plus the chat-only `session_state`
  // control envelope { state, live } owned by Unit 1's stream route.
  export interface ChatLiveState {
    /** appended run events for this session's CURRENT backing run. */
    events: NormalizedEvent[];
    /** nodeId → currently-streaming assistant text (token deltas). */
    partials: Record<string, string>;
    /** §3 — derived session lifecycle from the latest session_state frame. */
    state: ChatSessionState;
    /** §3 — true iff a live interactive process is held. */
    live: boolean;
    connected: boolean;
    error: string | null;
  }

  export function useChatStream(sessionId: string): ChatLiveState {
    const [events, setEvents] = useState<NormalizedEvent[]>([]);
    const [partials, setPartials] = useState<Record<string, string>>({});
    const [state, setState] = useState<ChatSessionState>('idle');
    const [live, setLive] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const partialRef = useRef<Record<string, string>>({});

    useEffect(() => {
      partialRef.current = {};
      setEvents([]);
      setPartials({});
      setState('idle');
      setLive(false);
      setError(null);
      const es = new EventSource(`${API}/api/chat/sessions/${sessionId}/stream`);
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.error) {
          setError(String(m.error));
          es.close();
          return;
        }
        // chat-control envelope (Unit 1) — not a run event
        if (m.kind === 'session_state') {
          setState(m.state as ChatSessionState);
          setLive(Boolean(m.live));
          return;
        }
        if (m.kind === 'event') {
          const evt = m.event as NormalizedEvent;
          if (evt.type === 'assistant_partial') {
            const text = String((evt.payload as any)?.text ?? '');
            const cur = partialRef.current[evt.nodeId] ?? '';
            partialRef.current = { ...partialRef.current, [evt.nodeId]: cur + text };
            setPartials(partialRef.current);
          } else {
            if (evt.type === 'assistant_text' && partialRef.current[evt.nodeId]) {
              partialRef.current = { ...partialRef.current, [evt.nodeId]: '' };
              setPartials(partialRef.current);
            }
            setEvents((prev) => [...prev, evt]);
          }
        }
      };
      return () => es.close();
    }, [sessionId]);

    return { events, partials, state, live, connected, error };
  }
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-usechatstream` → 3 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): useChatStream chat-scoped SSE hook (connect + session_state)"`

---

### Task 6: `useChatStream` — event vocabulary reduction (partials, full text, generic events)

- [ ] **Step 1: Write the failing event-reduction test.**
  Append to `/Users/jd/Documents/agent-system/apps/web/test/fn-usechatstream.test.ts`:
  ```ts
  describe('useChatStream — event reduction', () => {
    it('accumulates assistant_partial deltas per node and clears on assistant_text', () => {
      const { result } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'Hel' }) }));
      act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'lo' }) }));
      expect(result.current.partials).toEqual({ n1: 'Hello' });
      // full message arrives → partial buffer for that node clears, event lands in events
      act(() => es.emit({ kind: 'event', event: ev('assistant_text', 'n1', { text: 'Hello' }) }));
      expect(result.current.partials).toEqual({ n1: '' });
      expect(result.current.events.map((e) => e.type)).toEqual(['assistant_text']);
    });

    it('appends non-partial run events (tool_use, tool_result, permission_request, result)', () => {
      const { result } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      act(() => es.emit({ kind: 'event', event: ev('tool_use', 'n1', { name: 'Bash' }) }));
      act(() => es.emit({ kind: 'event', event: ev('tool_result', 'n1', { ok: true }) }));
      act(() => es.emit({ kind: 'event', event: ev('permission_request', 'n1', { id: 'p1' }) }));
      act(() => es.emit({ kind: 'event', event: ev('result', 'n1', {}) }));
      expect(result.current.events.map((e) => e.type)).toEqual([
        'tool_use', 'tool_result', 'permission_request', 'result',
      ]);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-usechatstream` — the Task 5 implementation already reduces these. All 5 tests pass. (This task locks the event-vocabulary contract that Unit 3's `ChatThread` consumes.)
- [ ] **Step 3: Typecheck.**
  `pnpm --filter @fleet/web typecheck` → compiles (`NormalizedEvent` and `ChatSessionState` are imported; `ChatSessionState` arrives from Unit F — **see reconciliation note 1**).
- [ ] **Step 4: Commit.**
  `git add -A && git commit -m "test(web): lock useChatStream event-vocabulary reduction"`

---

### Task 7: Trigger detection — pure `detectTrigger()` helper

This is the keyboard-position logic the composer uses to decide when `/` or `@` should open a menu and what query to filter by. Isolating it as a pure function makes it unit-testable without rendering.

- [ ] **Step 1: Write the failing pure-function test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-chat-trigger.test.ts`:
  ```ts
  /**
   * detectTrigger(text, caret) — the composer's pure `/`+`@` detection. A `/` only
   * triggers the SlashMenu at the very start of the input (token-start = position 0);
   * an `@` triggers the MentionMenu when it starts a whitespace-delimited token. The
   * returned `query` is the chars between the trigger and the caret (no spaces).
   */
  import { describe, it, expect } from 'vitest';
  import { detectTrigger } from '../components/ChatComposer';

  describe('detectTrigger — slash', () => {
    it('opens slash only at input start', () => {
      expect(detectTrigger('/kil', 4)).toEqual({ kind: 'slash', query: 'kil', start: 0 });
      expect(detectTrigger('/', 1)).toEqual({ kind: 'slash', query: '', start: 0 });
    });
    it('does NOT treat a mid-text slash as a command', () => {
      expect(detectTrigger('see src/a.ts', 12)).toBeNull();
      expect(detectTrigger('hi /kill', 8)).toBeNull(); // slash not at position 0
    });
    it('closes slash once a space is typed after the verb', () => {
      expect(detectTrigger('/kill ', 6)).toBeNull();
    });
  });

  describe('detectTrigger — mention', () => {
    it('opens mention when @ starts a whitespace-delimited token', () => {
      expect(detectTrigger('look at @src', 12)).toEqual({ kind: 'mention', query: 'src', start: 8 });
      expect(detectTrigger('@a', 2)).toEqual({ kind: 'mention', query: 'a', start: 0 });
    });
    it('does NOT trigger on an email-like @ in the middle of a token', () => {
      expect(detectTrigger('me@x.com', 8)).toBeNull();
    });
    it('closes mention when a space follows the path', () => {
      expect(detectTrigger('@src/a.ts ', 10)).toBeNull();
    });
    it('only considers the token immediately left of the caret', () => {
      expect(detectTrigger('@one @two', 4)).toEqual({ kind: 'mention', query: 'one', start: 0 });
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-chat-trigger` → fails: `detectTrigger` not exported (ChatComposer is still the old one-liner).
- [ ] **Step 3: Implement `detectTrigger` (export it from the composer module).**
  Begin the rewrite of `/Users/jd/Documents/agent-system/apps/web/components/ChatComposer.tsx`. Replace the whole file's top with the pure helper (the full component arrives in Task 8 — for now export the function and keep a minimal placeholder default so the module compiles):
  ```tsx
  'use client';
  import { useRef, useState, useLayoutEffect } from 'react';
  import type { ChatAttachment } from '@fleet/shared';

  /** What the caret is currently "inside": a `/` command token at input start, or an
   *  `@` mention token. `start` is the index of the trigger char; `query` is the text
   *  between the trigger and the caret. Returns null when no menu should be open. */
  export type TriggerMatch =
    | { kind: 'slash'; query: string; start: number }
    | { kind: 'mention'; query: string; start: number };

  export function detectTrigger(text: string, caret: number): TriggerMatch | null {
    const upto = text.slice(0, caret);
    // slash: only at the very start of the input, no whitespace after the verb yet
    if (upto.startsWith('/')) {
      const seg = upto.slice(1);
      if (!/\s/.test(seg)) return { kind: 'slash', query: seg, start: 0 };
    }
    // mention: the `@` must START the token immediately left of the caret. Find the
    // last whitespace before the caret; the token after it must begin with `@`.
    const ws = Math.max(upto.lastIndexOf(' '), upto.lastIndexOf('\n'), upto.lastIndexOf('\t'));
    const tokenStart = ws + 1;
    const token = upto.slice(tokenStart);
    if (token.startsWith('@')) {
      const q = token.slice(1);
      if (!/\s/.test(q)) return { kind: 'mention', query: q, start: tokenStart };
    }
    return null;
  }
  ```
  Keep the existing default `ChatComposer` export below it **temporarily unchanged** so the page still compiles (Task 8 replaces it). To do that, paste the original component body (the current `export function ChatComposer(...)`) directly beneath `detectTrigger`, leaving its imports satisfied (`Btn`, `Input` from `@/components/ui` — add them back to the import line). The composer rewrite in Task 8 supersedes this.
  > Concretely, the temporary top imports become:
  > ```tsx
  > import { useRef, useState, useLayoutEffect } from 'react';
  > import { Btn, Input } from '@/components/ui';
  > import type { ChatAttachment } from '@fleet/shared';
  > ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-chat-trigger` → 7 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): pure detectTrigger for composer / and @ menus"`

---

### Task 8: `ChatComposer` rewrite — multiline auto-grow, Enter/Shift+Enter, send contract

- [ ] **Step 1: Write the failing composer test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-chatcomposer.test.tsx`:
  ```tsx
  /**
   * ChatComposer — multiline auto-grow input. Enter sends; Shift+Enter inserts a newline.
   * `/...` at start routes to onCommand; plain text routes to onSend (with attachments).
   * Stop is shown while running and calls onStop. No user-event lib — fireEvent only.
   */
  import { describe, it, expect, vi } from 'vitest';
  import { render, fireEvent } from '@testing-library/react';
  import { ChatComposer } from '../components/ChatComposer';

  function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
    const onSend = vi.fn();
    const onCommand = vi.fn();
    const onStop = vi.fn();
    const utils = render(
      <ChatComposer
        disabled={false}
        running={false}
        cwd="/work"
        onSend={onSend}
        onCommand={onCommand}
        onStop={onStop}
        {...props}
      />,
    );
    const ta = utils.container.querySelector('textarea') as HTMLTextAreaElement;
    return { ...utils, ta, onSend, onCommand, onStop };
  }

  describe('ChatComposer — send semantics', () => {
    it('Enter sends plain text via onSend with no attachments and clears the field', () => {
      const { ta, onSend } = setup();
      fireEvent.change(ta, { target: { value: 'hello world' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledWith('hello world', []);
      expect(ta.value).toBe('');
    });

    it('Shift+Enter does NOT send (newline behavior)', () => {
      const { ta, onSend } = setup();
      fireEvent.change(ta, { target: { value: 'line1' } });
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('a /command line routes to onCommand, not onSend', () => {
      const { ta, onSend, onCommand } = setup();
      fireEvent.change(ta, { target: { value: '/sessions' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(onCommand).toHaveBeenCalledWith('/sessions');
      expect(onSend).not.toHaveBeenCalled();
    });

    it('does not send when the trimmed text is empty', () => {
      const { ta, onSend } = setup();
      fireEvent.change(ta, { target: { value: '   ' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('ChatComposer — Stop button', () => {
    it('shows Stop while running and calls onStop', () => {
      const { container, onStop, getByText } = setup({ running: true });
      const stop = getByText(/stop/i);
      expect(stop).toBeTruthy();
      fireEvent.click(stop);
      expect(onStop).toHaveBeenCalled();
    });

    it('shows the send affordance (not Stop) while idle', () => {
      const { container } = setup({ running: false });
      expect(container.querySelector('[data-stop]')).toBeNull();
      expect(container.querySelector('[data-send]')).not.toBeNull();
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-chatcomposer` → fails: the placeholder composer has the wrong props/contract (no `running`/`onStop`/attachments).
- [ ] **Step 3: Implement the composer body (menus wired in Tasks 9–10).**
  Replace the temporary component in `/Users/jd/Documents/agent-system/apps/web/components/ChatComposer.tsx` (keep `detectTrigger`/`TriggerMatch` from Task 7 at the top) with the full implementation. Final top imports:
  ```tsx
  'use client';
  import { useRef, useState, useLayoutEffect } from 'react';
  import { Btn } from '@/components/ui';
  import type { ChatAttachment } from '@fleet/shared';
  import { SlashMenu } from '@/components/SlashMenu';
  import { MentionMenu } from '@/components/MentionMenu';
  ```
  (Create empty stub modules now so the import resolves; Tasks 9–10 fill them. Minimal stubs: `export function SlashMenu(_: any) { return null; }` in `SlashMenu.tsx`, same for `MentionMenu.tsx`.)
  Then the component:
  ```tsx
  export function ChatComposer({
    disabled,
    running,
    cwd,
    onSend,
    onCommand,
    onStop,
  }: {
    disabled: boolean;
    /** §7 — a turn is currently streaming; swap the send affordance for Stop. */
    running: boolean;
    /** §6 — session workspace, scopes the `@` file search. */
    cwd: string;
    /** plain message + its `@` attachments. */
    onSend: (message: string, attachments: ChatAttachment[]) => void;
    /** a `/command` line (verbatim, leading slash kept). */
    onCommand: (line: string) => void;
    /** §7 — Stop the streaming turn. */
    onStop: () => void;
  }) {
    const [text, setText] = useState('');
    const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
    const [caret, setCaret] = useState(0);
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    // auto-grow: reset to single-row height then grow to scrollHeight (capped)
    useLayoutEffect(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }, [text]);

    const trigger = detectTrigger(text, caret);

    function reset() {
      setText('');
      setAttachments([]);
      setCaret(0);
    }

    function submit() {
      const t = text.trim();
      if (!t) return;
      if (t.startsWith('/')) {
        onCommand(t);
      } else {
        onSend(t, attachments);
      }
      reset();
    }

    /** Replace the active trigger token (from `start` to caret) with `insert`. */
    function replaceToken(start: number, insert: string) {
      const before = text.slice(0, start);
      const after = text.slice(caret);
      const next = before + insert + after;
      setText(next);
      const pos = (before + insert).length;
      setCaret(pos);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    }

    function addAttachment(a: ChatAttachment, tokenStart: number) {
      // drop the `@query` token, keep the chip in the row
      replaceToken(tokenStart, '');
      setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]));
    }

    function pickCommand(name: string) {
      // replace the `/query` with `/<name> ` ready for args
      replaceToken(0, `/${name} `);
    }

    return (
      <div className="border-t hairline p-3">
        {/* attachment chips row (§6.2) */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <span
                key={a.path}
                data-chip
                className="inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 border"
                style={{ borderColor: 'rgba(255,176,0,0.45)', color: '#ffb000', background: 'rgba(255,176,0,0.08)' }}
              >
                {a.kind === 'dir' ? '▣' : '▦'} {a.path}
                <button
                  type="button"
                  className="text-faint hover:text-ink leading-none"
                  onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                  title={`remove ${a.path}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative flex gap-2 items-end">
          {/* `/` palette */}
          {trigger?.kind === 'slash' && (
            <SlashMenu
              query={trigger.query}
              cwd={cwd}
              onPick={(name) => pickCommand(name)}
              onClose={() => setCaret(-1)}
            />
          )}
          {/* `@` picker */}
          {trigger?.kind === 'mention' && (
            <MentionMenu
              query={trigger.query}
              cwd={cwd}
              onPick={(att) => addAttachment(att, trigger.start)}
              onClose={() => setCaret(-1)}
            />
          )}

          <textarea
            ref={taRef}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder="Message…  (/ for commands · @ to attach)"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="flex-1 bg-black/40 border border-line2 text-ink font-mono text-[13px] px-2.5 py-2 focus:border-amber/70 outline-none placeholder:text-faint resize-none overflow-auto"
            style={{ maxHeight: 200 }}
          />

          {running ? (
            <Btn data-stop variant="danger" onClick={onStop} title="Stop generating">
              ■ Stop
            </Btn>
          ) : (
            <Btn
              data-send
              variant="solid"
              onClick={submit}
              disabled={disabled || !text.trim()}
              title="Send"
            >
              ▶
            </Btn>
          )}
        </div>
      </div>
    );
  }
  ```
  > Note: `Btn` forwards `title`/`onClick` but not arbitrary `data-*` props. The `data-stop`/`data-send`/`data-chip` hooks the tests use must therefore be on the **rendered DOM**. `Btn` renders a single `<button>` and the tests query `getByText(/stop/i)` for Stop and `[data-send]`/`[data-stop]` for presence — since `Btn` does **not** pass `data-*` through, wrap the affordance so the attribute lands on a real element. Implement the send/stop block as:
  > ```tsx
  > {running ? (
  >   <span data-stop>
  >     <Btn variant="danger" onClick={onStop} title="Stop generating">■ Stop</Btn>
  >   </span>
  > ) : (
  >   <span data-send>
  >     <Btn variant="solid" onClick={submit} disabled={disabled || !text.trim()} title="Send">▶</Btn>
  >   </span>
  > )}
  > ```
  > Use the `<span data-*>` wrapper form (it satisfies the `[data-send]`/`[data-stop]` queries without touching `Btn`'s signature). Drop the inline `data-stop`/`data-send` from the `Btn` calls.
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-chatcomposer` → 6 tests pass.
- [ ] **Step 5: Typecheck.**
  `pnpm --filter @fleet/web typecheck` → compiles. (`SlashMenu`/`MentionMenu` stubs accept `any` props for now; Tasks 9–10 give them real signatures matching the call sites above.)
- [ ] **Step 6: Commit.**
  `git add -A && git commit -m "feat(web): rewrite ChatComposer — multiline auto-grow, Enter/Shift+Enter, Stop, chips"`

---

### Task 9: `SlashMenu` — fetch + cache + debounced client filter over commands/skills/subagents

- [ ] **Step 1: Write the failing SlashMenu test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-slashmenu.test.tsx`:
  ```tsx
  /**
   * SlashMenu — the `/` palette. Fetches GET /api/commands once, merges GET /api/skills
   * + GET /api/subagents, groups (control/project/knowledge/config/meta · Skills ·
   * Subagents), and filters CLIENT-SIDE over the cached list by the `query` prop. We
   * mock the `api` module so no network happens.
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, waitFor, fireEvent } from '@testing-library/react';

  const commands = [
    { name: 'launch', group: 'control', description: 'start a run', usage: '/launch <prompt>', args: [], resultKind: 'ack' },
    { name: 'kill', group: 'control', description: 'stop a run', usage: '/kill <run-id>', args: [{ name: 'run-id', required: true, type: 'run-id' }], resultKind: 'ack' },
    { name: 'memory', group: 'knowledge', description: 'fleet memory', usage: '/memory', args: [], resultKind: 'text' },
  ];
  const skills = [{ name: 'graphify', scope: 'user', path: '/x', description: 'to graph', kind: 'skill' }];
  const subagents = [{ name: 'reviewer', scope: 'project', path: '/y', description: 'reviews' }];

  vi.mock('../lib/api', () => ({
    api: {
      listCommands: vi.fn(async () => commands),
      skills: vi.fn(async () => skills),
      subagents: vi.fn(async () => subagents),
    },
  }));

  import { SlashMenu } from '../components/SlashMenu';

  beforeEach(() => { vi.clearAllMocks(); });

  describe('SlashMenu', () => {
    it('loads the merged catalog and renders grouped rows (empty query = all)', async () => {
      const { container } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
      const headers = [...container.querySelectorAll('[data-group-header]')].map((h) => h.textContent);
      expect(headers).toEqual(['control', 'knowledge', 'Skills', 'Subagents']);
    });

    it('filters client-side by the query prop across name + description', async () => {
      const { container, rerender } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
      rerender(<SlashMenu query="kil" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      await waitFor(() => {
        const labels = [...container.querySelectorAll('[data-menu-item]')].map((r) => r.textContent);
        expect(labels.length).toBe(1);
        expect(labels[0]).toContain('/kill');
      });
    });

    it('only fetches the catalog ONCE even as the query changes (cached)', async () => {
      const { api } = await import('../lib/api');
      const { container, rerender } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      await waitFor(() => expect((api.listCommands as any).mock.calls.length).toBe(1));
      rerender(<SlashMenu query="k" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      rerender(<SlashMenu query="ki" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      expect((api.listCommands as any).mock.calls.length).toBe(1);
    });

    it('picks a command by name on row mousedown', async () => {
      const onPick = vi.fn();
      const { container } = render(<SlashMenu query="mem" cwd="/work" onPick={onPick} onClose={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
      fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
      expect(onPick).toHaveBeenCalledWith('memory');
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-slashmenu` → fails: `SlashMenu` is a stub returning `null`.
- [ ] **Step 3: Implement `SlashMenu`.**
  Replace `/Users/jd/Documents/agent-system/apps/web/components/SlashMenu.tsx`:
  ```tsx
  'use client';
  import { useEffect, useMemo, useRef, useState } from 'react';
  import type { CommandDef, SkillInfo, SubagentInfo } from '@fleet/shared';
  import { FloatingMenu, type FloatingItem } from '@/components/ui';
  import { api } from '@/lib/api';

  /** §5.3 — the merged `/` catalog: typed Portal verbs (grouped by CommandDef.group),
   *  plus Skills and Subagents under their own headers. Fetched ONCE per mount and
   *  cached; the `query` prop filters CLIENT-SIDE over the cached flat list. */
  interface CatalogRow extends FloatingItem {
    /** the bare command/skill/subagent name handed back to the composer. */
    name: string;
    /** lowercased haystack for the client filter (name + description + usage). */
    haystack: string;
  }

  export function SlashMenu({
    query,
    cwd,
    onPick,
    onClose,
  }: {
    query: string;
    cwd: string;
    onPick: (name: string) => void;
    onClose: () => void;
  }) {
    const [rows, setRows] = useState<CatalogRow[]>([]);
    const [active, setActive] = useState(0);
    const loadedRef = useRef(false);

    // fetch + merge ONCE per mount (catalog scans are disk I/O — §5.3 says cache it)
    useEffect(() => {
      if (loadedRef.current) return;
      loadedRef.current = true;
      let alive = true;
      (async () => {
        const [cmds, sks, subs] = await Promise.all([
          api.listCommands().catch(() => [] as CommandDef[]),
          api.skills(cwd).catch(() => [] as SkillInfo[]),
          api.subagents(cwd).catch(() => [] as SubagentInfo[]),
        ]);
        if (!alive) return;
        const out: CatalogRow[] = [];
        for (const c of cmds) {
          out.push({
            id: `cmd:${c.name}`,
            name: c.name,
            label: `/${c.name}`,
            hint: c.description,
            trailing: c.args.length ? c.usage.replace(`/${c.name}`, '').trim() : undefined,
            group: c.group,
            haystack: `${c.name} ${c.description} ${c.usage}`.toLowerCase(),
          });
        }
        for (const s of sks) {
          out.push({
            id: `skill:${s.name}`,
            name: s.name,
            label: `/${s.name}`,
            hint: s.description,
            group: 'Skills',
            haystack: `${s.name} ${s.description ?? ''}`.toLowerCase(),
          });
        }
        for (const a of subs) {
          out.push({
            id: `sub:${a.name}`,
            name: a.name,
            label: `@${a.name}`,
            hint: a.description,
            group: 'Subagents',
            haystack: `${a.name} ${a.description ?? ''}`.toLowerCase(),
          });
        }
        setRows(out);
      })();
      return () => {
        alive = false;
      };
    }, [cwd]);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((r) => r.haystack.includes(q));
    }, [rows, query]);

    // keep the active row in range as the filter shrinks the list
    useEffect(() => {
      setActive((a) => (a >= filtered.length ? 0 : a));
    }, [filtered.length]);

    // keyboard nav: arrow/enter/escape on the document while the menu is open. The
    // trigger char lives in the composer's textarea, which keeps focus, so we listen
    // at the document (capture) and act on the menu.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(a + 1, filtered.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter') {
          if (filtered[active]) {
            e.preventDefault();
            onPick(filtered[active].name);
          }
        } else if (e.key === 'Escape') {
          onClose();
        }
      };
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, [filtered, active, onPick, onClose]);

    return (
      <FloatingMenu
        open
        items={filtered}
        activeIndex={active}
        onPick={(item) => onPick((item as CatalogRow).name)}
        onClose={onClose}
        emptyText="no commands"
        footer="↑↓ navigate · ↵ select · esc dismiss"
      />
    );
  }
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-slashmenu` → 4 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): SlashMenu — cached merged /commands+skills+subagents palette"`

---

### Task 10: `MentionMenu` — debounced `findFiles` + chip insert

- [ ] **Step 1: Write the failing MentionMenu test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-mentionmenu.test.tsx`:
  ```tsx
  /**
   * MentionMenu — the `@` file/folder picker. Debounces GET /api/files/find (scoped to
   * the session cwd) on the `query` prop and renders ranked results. Picking a row hands
   * a ChatAttachment {path, kind} back to the composer. We use fake timers to step past
   * the debounce and mock the `api` module.
   */
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { render, fireEvent, waitFor } from '@testing-library/react';

  const results = [
    { path: 'src/a.ts', kind: 'file', score: 9 },
    { path: 'src/', kind: 'dir', score: 8 },
  ];
  const findFiles = vi.fn(async () => results);
  vi.mock('../lib/api', () => ({ api: { findFiles: (...a: any[]) => (findFiles as any)(...a) } }));

  import { MentionMenu } from '../components/MentionMenu';

  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('MentionMenu', () => {
    it('debounces the search and renders the ranked results', async () => {
      const { container } = render(<MentionMenu query="a" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      // before the debounce window elapses, no fetch has fired
      expect(findFiles).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(findFiles).toHaveBeenCalledWith('/work', 'a', expect.any(Number));
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
    });

    it('picks a result as a ChatAttachment with its kind', async () => {
      const onPick = vi.fn();
      const { container } = render(<MentionMenu query="a" cwd="/work" onPick={onPick} onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
      const rows = container.querySelectorAll('[data-menu-item]');
      fireEvent.mouseDown(rows[1]); // the dir
      expect(onPick).toHaveBeenCalledWith({ path: 'src/', kind: 'dir' });
    });

    it('coalesces rapid query changes into a single trailing fetch', async () => {
      const { rerender } = render(<MentionMenu query="a" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      rerender(<MentionMenu query="ab" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      rerender(<MentionMenu query="abc" cwd="/work" onPick={() => {}} onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(200);
      expect(findFiles).toHaveBeenCalledTimes(1);
      expect(findFiles).toHaveBeenLastCalledWith('/work', 'abc', expect.any(Number));
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/web test fn-mentionmenu` → fails: `MentionMenu` is a stub.
- [ ] **Step 3: Implement `MentionMenu`.**
  Replace `/Users/jd/Documents/agent-system/apps/web/components/MentionMenu.tsx`:
  ```tsx
  'use client';
  import { useEffect, useState } from 'react';
  import type { ChatAttachment, FileFindResult } from '@fleet/shared';
  import { FloatingMenu, type FloatingItem } from '@/components/ui';
  import { api } from '@/lib/api';

  const DEBOUNCE_MS = 150;
  const LIMIT = 30;

  /** §6 — the `@` file/folder picker. Debounces a server-side fuzzy search scoped to the
   *  session `cwd`; a pick becomes a removable attachment chip in the composer. */
  export function MentionMenu({
    query,
    cwd,
    onPick,
    onClose,
  }: {
    query: string;
    cwd: string;
    onPick: (att: ChatAttachment) => void;
    onClose: () => void;
  }) {
    const [results, setResults] = useState<FileFindResult[]>([]);
    const [active, setActive] = useState(0);

    // debounce the search on (query, cwd); a trailing timer coalesces rapid keystrokes
    useEffect(() => {
      let alive = true;
      const t = setTimeout(async () => {
        try {
          const rows = await api.findFiles(cwd, query, LIMIT);
          if (alive) {
            setResults(rows);
            setActive(0);
          }
        } catch {
          if (alive) setResults([]);
        }
      }, DEBOUNCE_MS);
      return () => {
        alive = false;
        clearTimeout(t);
      };
    }, [query, cwd]);

    const items: FloatingItem[] = results.map((r) => ({
      id: r.path,
      label: r.path,
      trailing: r.kind === 'dir' ? 'dir' : 'file',
    }));

    // keyboard nav at the document (the textarea keeps focus — same model as SlashMenu)
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(a + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter') {
          if (results[active]) {
            e.preventDefault();
            onPick({ path: results[active].path, kind: results[active].kind });
          }
        } else if (e.key === 'Escape') {
          onClose();
        }
      };
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, [results, active, onPick, onClose]);

    return (
      <FloatingMenu
        open
        items={items}
        activeIndex={active}
        onPick={(item) => {
          const hit = results.find((r) => r.path === item.id);
          if (hit) onPick({ path: hit.path, kind: hit.kind });
        }}
        onClose={onClose}
        emptyText="no files"
        footer="↑↓ navigate · ↵ attach · esc dismiss"
      />
    );
  }
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-mentionmenu` → 3 tests pass.
- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): MentionMenu — debounced @ file/folder picker → attachment chips"`

---

### Task 11: Composer ↔ menus integration — `/` opens SlashMenu, `@` opens MentionMenu, chip add/remove

- [ ] **Step 1: Write the failing integration test.**
  Create `/Users/jd/Documents/agent-system/apps/web/test/fn-composer-menus.test.tsx`:
  ```tsx
  /**
   * Integration: typing `/` at start opens the SlashMenu; typing `@token` opens the
   * MentionMenu; picking a file adds a chip and removing it drops the attachment. We
   * mock the `api` module so the menus resolve deterministically.
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, fireEvent, waitFor } from '@testing-library/react';

  vi.mock('../lib/api', () => ({
    api: {
      listCommands: vi.fn(async () => [
        { name: 'sessions', group: 'control', description: 'list sessions', usage: '/sessions', args: [], resultKind: 'table' },
      ]),
      skills: vi.fn(async () => []),
      subagents: vi.fn(async () => []),
      findFiles: vi.fn(async () => [{ path: 'src/a.ts', kind: 'file', score: 9 }]),
    },
  }));

  import { ChatComposer } from '../components/ChatComposer';

  function mount() {
    const onSend = vi.fn();
    const utils = render(
      <ChatComposer disabled={false} running={false} cwd="/work" onSend={onSend} onCommand={() => {}} onStop={() => {}} />,
    );
    const ta = utils.container.querySelector('textarea') as HTMLTextAreaElement;
    return { ...utils, ta, onSend };
  }

  beforeEach(() => { vi.clearAllMocks(); });

  describe('composer ↔ menus', () => {
    it('typing "/" at start opens the SlashMenu', async () => {
      const { ta, container } = mount();
      fireEvent.change(ta, { target: { value: '/' } });
      await waitFor(() => expect(container.querySelector('[data-floating-menu]')).not.toBeNull());
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
    });

    it('typing "@a" opens the MentionMenu and a pick adds + removes a chip', async () => {
      const { ta, container } = mount();
      fireEvent.change(ta, { target: { value: 'see @a' } });
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
      fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
      // chip appears
      await waitFor(() => expect(container.querySelector('[data-chip]')?.textContent).toContain('src/a.ts'));
      // remove it
      fireEvent.click(container.querySelector('[data-chip] button')!);
      await waitFor(() => expect(container.querySelector('[data-chip]')).toBeNull());
    });

    it('sending after attaching passes the attachments to onSend', async () => {
      const { ta, container, onSend } = mount();
      fireEvent.change(ta, { target: { value: '@a' } });
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(1));
      fireEvent.mouseDown(container.querySelector('[data-menu-item]')!);
      await waitFor(() => expect(container.querySelector('[data-chip]')).not.toBeNull());
      fireEvent.change(ta, { target: { value: 'read this file' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledWith('read this file', [{ path: 'src/a.ts', kind: 'file' }]);
    });
  });
  ```
  > Note: the MentionMenu debounce (`150ms`) runs under **real timers** here. `waitFor` polls up to its default 1000ms timeout, which comfortably covers the debounce — no fake timers needed in this integration test.
- [ ] **Step 2: Run it, watch it fail then pass.**
  `pnpm --filter @fleet/web test fn-composer-menus`. If a test fails because the chip's `@a` token wasn't cleared on attach, verify `addAttachment` calls `replaceToken(trigger.start, '')` (it does, per Task 8). All 3 tests pass.
- [ ] **Step 3: Full web test sweep + typecheck.**
  `pnpm --filter @fleet/web test` → all unit-2 suites green. `pnpm --filter @fleet/web typecheck` → typechecks.
- [ ] **Step 4: Commit.**
  `git add -A && git commit -m "test(web): composer ↔ SlashMenu/MentionMenu integration + chip lifecycle"`

---

### Task 12: Keyboard-nav coverage for SlashMenu/MentionMenu (arrow/enter/escape)

- [ ] **Step 1: Write the failing keyboard test.**
  Append to `/Users/jd/Documents/agent-system/apps/web/test/fn-slashmenu.test.tsx`:
  ```tsx
  describe('SlashMenu — keyboard nav', () => {
    it('ArrowDown/ArrowUp move the active row and Enter picks it', async () => {
      const onPick = vi.fn();
      const { container } = render(<SlashMenu query="" cwd="/work" onPick={onPick} onClose={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      fireEvent.keyDown(document, { key: 'Enter' });
      // started at 0, +1 +1 -1 = index 1 → the second catalog row ('kill')
      expect(onPick).toHaveBeenCalledWith('kill');
    });
    it('Escape calls onClose', async () => {
      const onClose = vi.fn();
      const { container } = render(<SlashMenu query="" cwd="/work" onPick={() => {}} onClose={onClose} />);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(5));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });
  });
  ```
  And append the analogous block to `/Users/jd/Documents/agent-system/apps/web/test/fn-mentionmenu.test.tsx` (note this suite uses fake timers — advance them before asserting):
  ```tsx
  describe('MentionMenu — keyboard nav', () => {
    it('ArrowDown + Enter picks the highlighted result', async () => {
      const onPick = vi.fn();
      const { container } = render(<MentionMenu query="a" cwd="/work" onPick={onPick} onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => expect(container.querySelectorAll('[data-menu-item]').length).toBe(2));
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'Enter' });
      expect(onPick).toHaveBeenCalledWith({ path: 'src/', kind: 'dir' });
    });
  });
  ```
- [ ] **Step 2: Run it, watch it pass.**
  `pnpm --filter @fleet/web test fn-slashmenu` and `pnpm --filter @fleet/web test fn-mentionmenu` — the document-level keydown handlers from Tasks 9–10 satisfy these. All green.
- [ ] **Step 3: Commit.**
  `git add -A && git commit -m "test(web): SlashMenu/MentionMenu arrow/enter/escape keyboard nav"`

---

### Task 13: Final integration sweep — full web suite + build, wire page contract note

- [ ] **Step 1: Run the entire web test suite.**
  `pnpm --filter @fleet/web test` → every suite (existing `fn-useasync-usefleet`, `fn-userunstream`, `fn-usecampaign` + the seven new unit-2 suites) passes.
- [ ] **Step 2: Typecheck the whole web package.**
  `pnpm --filter @fleet/web typecheck`. The one expected break point is `apps/web/app/chat/page.tsx`, which still calls the OLD `ChatComposer` signature (`onSend(message)`, no `running`/`cwd`/`onStop`/attachments) and `api.chatTurn(id, message)` (now optionally takes attachments — additive, still compiles). Update the page's `<ChatComposer>` usage to the new props:
  ```tsx
  <ChatComposer
    disabled={busy}
    running={chatState === 'running'}
    cwd={session.cwd}
    onSend={(message, attachments) => sendTurn(message, attachments)}
    onCommand={(line) => runCommand(line)}
    onStop={() => api.chatInterrupt(session.id)}
  />
  ```
  Wire `chatState` from `useChatStream(session.id).state` (Unit 3 owns the full `ChatThread`/page rewrite — keep this edit minimal: just satisfy the composer's new contract so the build is green). **See reconciliation note 5.**
- [ ] **Step 3: Confirm green build.**
  `pnpm --filter @fleet/web typecheck` exits 0. If `ChatSessionState`/`CommandDef`/`FileFindResult`/`ChatAttachment` are reported as missing exports from `@fleet/shared`, Unit F has not landed yet — **see reconciliation note 1** (do not stub them locally; block on Unit F).
- [ ] **Step 4: Commit.**
  `git add -A && git commit -m "feat(web): wire ChatComposer new contract into chat page; green web build"`

---

## Unit 3 — Rendering: full ChatGPT-grade message rendering

This unit rewrites `ChatThread.tsx` and its `LiveTurn` subcomponent so the chat surface stops discarding stream events and renders everything ChatGPT-grade: assistant text through Markdown, live token streaming, collapsible tool-call and thinking cards, inline permission approve/deny, subagent chips, search-result cards, real tables for `ChatCommandResult kind:'table'`, an `ErrorBanner` for `kind:'error'`, and a Stop button while the turn is running.

**Domain context (read before starting — the implementer knows React/Next/vitest but not this app):**

- The chat thread today (`apps/web/components/ChatThread.tsx`) renders persisted `ChatMessage[]` as `<b>role:</b>{content}` and a single `LiveTurn` that calls `useRunStream(runId)` and *filters events down to `assistant_text|result`*, throwing away tool calls, thinking, permissions, and subagents. This unit replaces that.
- **The live data source changes.** Unit 2 adds a chat-scoped hook `useChatStream(sessionId)` to `apps/web/lib/live.ts`. It subscribes to `GET /api/chat/sessions/:id/stream` and returns the SAME reducer shape `useRunStream` already returns plus a chat-control `state` field. The shape this unit consumes is:
  ```ts
  interface ChatStreamState {
    run: Run | null;                         // backing run (id changes across kill→resume)
    events: NormalizedEvent[];               // full vocabulary, in arrival order
    partials: Record<string, string>;        // nodeId → currently-streaming assistant text
    state: ChatSessionState;                 // 'live' | 'running' | 'idle' | 'killed'
    connected: boolean;
    error: string | null;
  }
  ```
  `NormalizedEvent` (from `@fleet/shared`) has `{ type: NormalizedEventType; payload: Record<string,unknown>; nodeId: string; seq: number; ts: number; runId: string; ... }`. The vocabulary you render: `assistant_partial`, `assistant_text`, `thinking`, `tool_use`, `tool_result`, `permission_request`, `subagent_spawned`, `result` (others are ignored by this unit). This MATCHES `lib/live.ts` lines 79-170 verbatim — `assistant_partial` is folded into `partials[nodeId]` by the hook (it never lands in `events`); `assistant_text` clears that node's partial buffer and appends the event.
- **Until Unit 2 lands**, `useChatStream` will not exist. To keep this unit independently testable and committable, Task 1 adds a thin local fallback in `lib/live.ts` ONLY IF the export is missing; if Unit 2's `useChatStream` is already present, skip the implementation step and just consume it (the contract is identical). Tests in this unit stub the hook directly, so they do not depend on Unit 2.
- **HUD design system (match exactly):** charcoal background, amber `#ffb000` (accent / assistant / `text-amber`), teal `#39d4cf` (tools / running / `sig-running`), purple `#7b6db0`/`#b08cff` (thinking / awaiting), green `#54e08a` (success), red `#ff5d5d` (`sig-failed`). Reuse `Badge`, `Dot`, `Chip`, `StatusBadge`, `Btn`, `ErrorBanner` from `apps/web/components/ui.tsx`; `MarkdownView` from `apps/web/components/MarkdownView.tsx`; `ShikiCode` from `apps/web/components/ShikiCode.tsx`. Fonts: `font-display` (Chakra Petch) for labels/kickers, `font-mono` (JetBrains Mono) for code/ids. Card boxes use `border border-line2 bg-black/40`. Do NOT reuse `Waterfall.tsx`/`Timeline.tsx` wholesale — build compact, chat-native cards (they are heavy run-debugger renderers, wrong altitude for a chat bubble).
- **Test harness (existing, reuse it):** vitest + jsdom + `@testing-library/react`. `apps/web/test/setup.ts` installs a `FakeEventSource` on the global and runs `cleanup()` after each test. `apps/web/vitest.config.ts` includes `test/**/*.test.{ts,tsx}`. **This unit's tests are component tests** (`.test.tsx`) using `render` + `screen` from `@testing-library/react`; they stub `useChatStream` with `vi.mock`. Existing tests follow the `fn-*`/`cov-*` naming — use `cov-*` for these component tests to match the spec's §13 convention.
- **Run commands:** web tests `pnpm --filter @fleet/web test <file>` (e.g. `pnpm --filter @fleet/web test test/cov-chatthread.test.tsx`); web typecheck/build `pnpm --filter @fleet/web typecheck`. The runner is vitest (confirmed in `apps/web/vitest.config.ts`); `pnpm --filter @fleet/web test` maps to `vitest run`.

**Files:**
- Create: `apps/web/components/ToolCallCard.tsx` — collapsible tool_use/tool_result card.
- Create: `apps/web/components/ThinkingBlock.tsx` — collapsible dim/monospace reasoning block.
- Create: `apps/web/components/PermissionCard.tsx` — inline approve/deny card → `POST …/input`.
- Create: `apps/web/components/SubagentChip.tsx` — compact subagent chip linking to its run.
- Create: `apps/web/components/SearchResultCard.tsx` — compact search-result card.
- Create: `apps/web/components/ChatTable.tsx` — real `<table>` for `ChatCommandResult kind:'table'`.
- Modify: `apps/web/components/ChatThread.tsx` — Markdown + event-driven cards + tables + live tokens + inline permissions + Stop button.
- Modify: `apps/web/lib/live.ts` — local `useChatStream` fallback IF Unit 2's is absent (no-op otherwise).
- Modify: `apps/web/lib/api.ts` — `chatInput`, `chatInterrupt` helpers.
- Tests: `apps/web/test/cov-toolcallcard.test.tsx`, `cov-thinkingblock.test.tsx`, `cov-permissioncard.test.tsx`, `cov-subagentchip.test.tsx`, `cov-chattable.test.tsx`, `cov-chatthread.test.tsx`.

---

### Task 1: `chatInput` + `chatInterrupt` API helpers

The permission card and Stop button POST to two new chat routes (owned by Unit 1). Add typed client helpers now so cards can import them; the routes exist server-side by the time this ships.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-chatapi.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
  import { api } from '../lib/api';

  describe('chat input/interrupt helpers', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
      (globalThis as any).fetch = fetchMock;
    });
    afterEach(() => vi.restoreAllMocks());

    it('chatInput POSTs the input body to /input', async () => {
      await api.chatInput('s1', { type: 'permission', requestId: 'r9', decision: 'allow' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('/api/chat/sessions/s1/input');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ type: 'permission', requestId: 'r9', decision: 'allow' });
    });

    it('chatInterrupt POSTs to /interrupt with no body', async () => {
      await api.chatInterrupt('s1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('/api/chat/sessions/s1/interrupt');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-chatapi.test.ts` → fails: `api.chatInput is not a function`.

- [ ] **Step 3: Minimal implementation.**
  In `apps/web/lib/api.ts`, inside the `export const api = { ... }` object, directly after the `chatCommand` line (currently line 453), add:
  ```ts
  chatInput: (id: string, body: { type: string; requestId?: string; decision?: 'allow' | 'deny'; text?: string }) =>
    j(`/api/chat/sessions/${id}/input`, { method: 'POST', body: JSON.stringify(body) }),
  chatInterrupt: (id: string) =>
    j(`/api/chat/sessions/${id}/interrupt`, { method: 'POST' }),
  ```
  (Note: `chatInterrupt` passes no `body`, so the `j` helper omits the JSON content-type header — required because Fastify 400s an empty JSON body, exactly as the comment on `j` documents.)

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-chatapi.test.ts` → 2 passing.

- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): chatInput + chatInterrupt api helpers"`

---

### Task 2: `useChatStream` consumption contract in `lib/live.ts`

This unit's `ChatThread` consumes `useChatStream(sessionId)`. Unit 2 owns its real implementation. To stay independently buildable, add a guard: only define a local fallback if the export does not already exist. The fallback subscribes to `GET /api/chat/sessions/:id/stream` and reduces the SAME frames `useRunStream` reduces (it re-uses the identical reducer), plus a `session_state` chat-control frame that sets `state`.

- [ ] **Step 1: Check whether Unit 2 already shipped it.**
  `grep -n "export function useChatStream" apps/web/lib/live.ts`. If it prints a line, **Unit 2 is present — skip Steps 2-5 of this task entirely** (its contract is identical to below; do NOT redefine it) and move to Task 3. If it prints nothing, continue.

- [ ] **Step 2: Write the failing test.**
  Create `apps/web/test/cov-usechatstream.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { renderHook, act } from '@testing-library/react';
  import { useChatStream } from '../lib/live';
  import { FakeEventSource } from './setup';

  const ev = (type: string, nodeId: string, payload: any = {}): any =>
    ({ sessionId: 's', runId: 'run1', nodeId, parentNodeId: null, nodeType: 'root', seq: 0, ts: 0, type, payload });

  describe('useChatStream', () => {
    it('subscribes to the chat-scoped stream and reduces events + partials + state', () => {
      const { result } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      expect(es.url).toContain('/api/chat/sessions/sess1/stream');

      act(() => es.emit({ kind: 'session_state', state: 'running', live: true } as any));
      expect(result.current.state).toBe('running');

      act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'Hel' }) } as any));
      act(() => es.emit({ kind: 'event', event: ev('assistant_partial', 'n1', { text: 'lo' }) } as any));
      expect(result.current.partials).toEqual({ n1: 'Hello' });

      act(() => es.emit({ kind: 'event', event: ev('tool_use', 'n1', { name: 'Read' }) } as any));
      expect(result.current.events.map((e: any) => e.type)).toEqual(['tool_use']);
    });

    it('session_state to idle clears nothing but updates state', () => {
      const { result } = renderHook(() => useChatStream('sess1'));
      const es = FakeEventSource.last();
      act(() => es.emit({ kind: 'session_state', state: 'idle', live: false } as any));
      expect(result.current.state).toBe('idle');
    });
  });
  ```

- [ ] **Step 3: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-usechatstream.test.ts` → fails: `useChatStream is not exported`.

- [ ] **Step 4: Minimal implementation.**
  In `apps/web/lib/live.ts`, after the `useRunStream` function (after line 170), add the chat-scoped hook. It mirrors `useRunStream`'s reducer (partials accumulation, assistant_text clears the node's partial, non-partial events append) and adds a `session_state` frame:
  ```ts
  import type { ChatSessionState } from '@fleet/shared';

  export interface ChatStreamState {
    run: Run | null;
    events: NormalizedEvent[];
    partials: Record<string, string>;
    state: ChatSessionState;
    connected: boolean;
    error: string | null;
  }

  /** Chat-scoped SSE (spec §4): subscribe to the SESSION, not a run id, so the channel
   *  survives kill→resume (run id changes underneath) and page reload. Re-uses the run-event
   *  vocabulary plus a `session_state` chat-control frame. */
  export function useChatStream(sessionId: string | null): ChatStreamState {
    const [run, setRun] = useState<Run | null>(null);
    const [events, setEvents] = useState<NormalizedEvent[]>([]);
    const [partials, setPartials] = useState<Record<string, string>>({});
    const [state, setState] = useState<ChatSessionState>('idle');
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const partialRef = useRef<Record<string, string>>({});

    useEffect(() => {
      if (!sessionId) return;
      partialRef.current = {};
      setRun(null); setEvents([]); setPartials({}); setError(null); setState('idle');
      const es = new EventSource(`${API}/api/chat/sessions/${sessionId}/stream`);
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.error) { setError(String(m.error)); es.close(); return; }
        if (m.kind === 'session_state') {
          setState(m.state as ChatSessionState);
        } else if (m.kind === 'hello') {
          setRun(m.run ?? null);
          setEvents(m.events ?? []);
          partialRef.current = {};
          setPartials({});
          if (m.state) setState(m.state as ChatSessionState);
        } else if (m.kind === 'run') {
          setRun(m.run);
        } else if (m.kind === 'event') {
          const evt = m.event as NormalizedEvent;
          if (evt.type === 'assistant_partial') {
            const text = String((evt.payload as any)?.text ?? '');
            const cur = partialRef.current[evt.nodeId] ?? '';
            partialRef.current = { ...partialRef.current, [evt.nodeId]: cur + text };
            setPartials(partialRef.current);
          } else {
            if (evt.type === 'assistant_text' && partialRef.current[evt.nodeId]) {
              partialRef.current = { ...partialRef.current, [evt.nodeId]: '' };
              setPartials(partialRef.current);
            }
            setEvents((prev) => [...prev, evt]);
          }
        }
      };
      return () => es.close();
    }, [sessionId]);

    return { run, events, partials, state, connected, error };
  }
  ```
  Add `ChatSessionState` to the existing `import type { ... } from '@fleet/shared'` block at the top of the file rather than a second import statement (merge it into the existing list on lines 3-13).

- [ ] **Step 5: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-usechatstream.test.ts` → 2 passing.

- [ ] **Step 6: Commit.**
  `git add -A && git commit -m "feat(web): useChatStream chat-scoped SSE fallback"`

---

### Task 3: `ToolCallCard` — collapsible tool_use/tool_result card

A compact, chat-native, collapsible card pairing a `tool_use` event with its matching `tool_result`. Collapsed shows tool name + a one-line args summary + a status dot. Expanded shows full args (JSON) and the result output (through `ShikiCode` if it looks like code/JSON, else `MarkdownView`).

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-toolcallcard.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/react';
  import { ToolCallCard } from '../components/ToolCallCard';

  describe('ToolCallCard', () => {
    it('renders tool name and a collapsed args summary; expands on click', () => {
      render(<ToolCallCard name="Read" input={{ file_path: '/a/b.ts' }} result="line1\nline2" isError={false} />);
      expect(screen.getByText('Read')).toBeTruthy();
      // collapsed: result text not shown yet
      expect(screen.queryByText(/line1/)).toBeNull();
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText(/line1/)).toBeTruthy();
    });

    it('shows a running state (no result yet) and an error state', () => {
      const { rerender } = render(<ToolCallCard name="Bash" input={{ command: 'ls' }} result={null} isError={false} />);
      expect(screen.getByText(/running|pending|…/i)).toBeTruthy();
      rerender(<ToolCallCard name="Bash" input={{ command: 'ls' }} result="boom" isError={true} />);
      expect(screen.getByText('Bash')).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-toolcallcard.test.tsx` → fails: cannot find `../components/ToolCallCard`.

- [ ] **Step 3: Minimal implementation.**
  Create `apps/web/components/ToolCallCard.tsx`:
  ```tsx
  'use client';
  import React, { useState } from 'react';
  import { Dot } from './ui';
  import { ShikiCode } from './ShikiCode';
  import { MarkdownView } from './MarkdownView';

  /** Compact chat-native tool-call card (spec §7): collapsed = name + args summary + status dot;
   *  expanded = full args (JSON via ShikiCode) + result. Not the heavy Waterfall/Timeline row. */
  function summarize(input: unknown, max = 80): string {
    if (input == null) return '';
    if (typeof input === 'string') return input.length > max ? input.slice(0, max) + '…' : input;
    const s = JSON.stringify(input);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  /** Heuristic: render result as code when it looks like JSON/multiline/code, else markdown. */
  function looksLikeCode(text: string): boolean {
    const t = text.trim();
    return t.startsWith('{') || t.startsWith('[') || t.includes('\n');
  }

  export function ToolCallCard({
    name, input, result, isError,
  }: { name: string; input: unknown; result: string | null; isError: boolean }) {
    const [open, setOpen] = useState(false);
    const teal = '#39d4cf';
    const statusColor = result == null ? teal : isError ? '#ff5d5d' : '#54e08a';
    const statusLabel = result == null ? 'running…' : isError ? 'error' : 'done';
    const argsJson = (() => {
      try { return JSON.stringify(input, null, 2); } catch { return String(input); }
    })();
    return (
      <div className="border border-line2 bg-black/40 my-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-amber/[0.03] transition-colors"
        >
          <span className="font-mono text-[11px]" style={{ color: open ? '#ffb000' : '#9aa1ab' }}>{open ? '▾' : '▸'}</span>
          <span className="font-mono text-[11px]" style={{ color: teal }}>{name}</span>
          <span className="font-mono text-[10px] text-faint truncate min-w-0 flex-1">{summarize(input)}</span>
          <span className="inline-flex items-center gap-1 shrink-0">
            <Dot color={statusColor} live={result == null} size={6} />
            <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color: statusColor }}>{statusLabel}</span>
          </span>
        </button>
        {open && (
          <div className="px-2.5 pb-2.5 pt-0.5 space-y-2">
            <div>
              <div className="font-display uppercase tracking-wider text-[9px] text-faint mb-1">args</div>
              <ShikiCode code={argsJson} lang="json" />
            </div>
            {result != null && (
              <div>
                <div className="font-display uppercase tracking-wider text-[9px] text-faint mb-1">{isError ? 'error' : 'result'}</div>
                {looksLikeCode(result)
                  ? <ShikiCode code={result} lang="text" />
                  : <MarkdownView source={result} />}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-toolcallcard.test.tsx` → 2 passing.

- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): collapsible ToolCallCard for chat tool calls"`

---

### Task 4: `ThinkingBlock` — collapsible dim reasoning block

A collapsed-by-default, dim, monospace block for `thinking` events. Header shows a "thinking" label + a char count; expanded shows the reasoning text.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-thinkingblock.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/react';
  import { ThinkingBlock } from '../components/ThinkingBlock';

  describe('ThinkingBlock', () => {
    it('is collapsed by default and reveals the reasoning on click', () => {
      render(<ThinkingBlock text="step one then step two" />);
      expect(screen.queryByText(/step one then step two/)).toBeNull();
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText(/step one then step two/)).toBeTruthy();
    });

    it('labels itself as thinking', () => {
      render(<ThinkingBlock text="x" />);
      expect(screen.getByText(/thinking/i)).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-thinkingblock.test.tsx` → fails: cannot find module.

- [ ] **Step 3: Minimal implementation.**
  Create `apps/web/components/ThinkingBlock.tsx`:
  ```tsx
  'use client';
  import React, { useState } from 'react';
  import { Dot } from './ui';

  /** Collapsible reasoning block (spec §7): dim, monospace, collapsed by default.
   *  Purple (#7b6db0) keyed to the run-debugger's `thinking` color for consistency. */
  export function ThinkingBlock({ text }: { text: string }) {
    const [open, setOpen] = useState(false);
    const purple = '#7b6db0';
    return (
      <div className="border border-line2 bg-black/40 my-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-amber/[0.03] transition-colors"
        >
          <span className="font-mono text-[11px]" style={{ color: open ? '#ffb000' : '#9aa1ab' }}>{open ? '▾' : '▸'}</span>
          <Dot color={purple} size={6} />
          <span className="font-display uppercase tracking-wider text-[10px]" style={{ color: purple }}>thinking</span>
          <span className="font-mono text-[9px] text-faint ml-auto tnum">{text.length} chars</span>
        </button>
        {open && (
          <div className="px-2.5 pb-2.5 pt-0.5">
            <pre className="font-mono text-[11px] leading-[1.6] text-dim whitespace-pre-wrap break-words m-0">{text}</pre>
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-thinkingblock.test.tsx` → 2 passing.

- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): collapsible ThinkingBlock for chat reasoning"`

---

### Task 5: `PermissionCard` — inline approve/deny → POST …/input

An inline card for `permission_request` events. Shows the tool/action being requested and Allow / Deny buttons that `POST /api/chat/sessions/:id/input` via `api.chatInput`. After a decision is sent it shows a settled state and disables the buttons.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-permissioncard.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen, fireEvent, waitFor } from '@testing-library/react';
  import { PermissionCard } from '../components/PermissionCard';
  import { api } from '../lib/api';

  describe('PermissionCard', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('renders the requested tool and posts allow on approve', async () => {
      const spy = vi.spyOn(api, 'chatInput').mockResolvedValue({} as any);
      render(<PermissionCard sessionId="s1" requestId="r9" toolName="Bash" input={{ command: 'rm -rf x' }} />);
      expect(screen.getByText('Bash')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /allow/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', { type: 'permission', requestId: 'r9', decision: 'allow' }));
    });

    it('posts deny on deny and then disables the controls', async () => {
      const spy = vi.spyOn(api, 'chatInput').mockResolvedValue({} as any);
      render(<PermissionCard sessionId="s1" requestId="r9" toolName="Write" input={{}} />);
      fireEvent.click(screen.getByRole('button', { name: /deny/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', { type: 'permission', requestId: 'r9', decision: 'deny' }));
      await waitFor(() => expect((screen.getByRole('button', { name: /deny/i }) as HTMLButtonElement).disabled).toBe(true));
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-permissioncard.test.tsx` → fails: cannot find module.

- [ ] **Step 3: Minimal implementation.**
  Create `apps/web/components/PermissionCard.tsx`:
  ```tsx
  'use client';
  import React, { useState } from 'react';
  import { Btn, Dot, ErrorBanner } from './ui';
  import { api } from '@/lib/api';

  /** Inline permission approve/deny (spec §7) — works because the chat session is live;
   *  the decision is written to the live process stdin via POST …/input. */
  function summarize(input: unknown, max = 120): string {
    if (input == null) return '';
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  export function PermissionCard({
    sessionId, requestId, toolName, input,
  }: { sessionId: string; requestId: string; toolName: string; input: unknown }) {
    const [decision, setDecision] = useState<'allow' | 'deny' | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const purple = '#b08cff';

    async function decide(d: 'allow' | 'deny') {
      setBusy(true); setErr(null);
      try {
        await api.chatInput(sessionId, { type: 'permission', requestId, decision: d });
        setDecision(d);
      } catch (e: any) {
        setErr(e?.message ?? 'failed to send decision');
      } finally {
        setBusy(false);
      }
    }

    return (
      <div className="border my-2 px-3 py-2.5" style={{ borderColor: `${purple}55`, background: `${purple}10` }}>
        <div className="flex items-center gap-2 mb-2">
          <Dot color={purple} live={decision == null} size={7} />
          <span className="font-display uppercase tracking-wider text-[10px]" style={{ color: purple }}>permission request</span>
          <span className="font-mono text-[11px] text-ink">{toolName}</span>
        </div>
        <div className="font-mono text-[11px] text-dim mb-2.5 break-words">{summarize(input)}</div>
        {decision ? (
          <div className="font-display uppercase tracking-wider text-[10px]" style={{ color: decision === 'allow' ? '#54e08a' : '#ff5d5d' }}>
            {decision === 'allow' ? 'allowed' : 'denied'}
          </div>
        ) : (
          <div className="flex gap-2">
            <Btn variant="amber" disabled={busy} onClick={() => decide('allow')}>allow</Btn>
            <Btn variant="danger" disabled={busy} onClick={() => decide('deny')}>deny</Btn>
          </div>
        )}
        {err && <ErrorBanner className="mt-2">{err}</ErrorBanner>}
      </div>
    );
  }
  ```
  Note: after a decision the buttons are removed from the DOM (replaced by the settled label), so the test's `getByRole('button', { name: /deny/i })` after a deny would not find a button — adjust: keep the buttons rendered but disabled when `decision` is set. Replace the `decision ? (...) : (...)` block with always-rendered, disabled-on-settle controls:
  ```tsx
        <div className="flex items-center gap-2">
          <Btn variant="amber" disabled={busy || decision != null} onClick={() => decide('allow')}>allow</Btn>
          <Btn variant="danger" disabled={busy || decision != null} onClick={() => decide('deny')}>deny</Btn>
          {decision && (
            <span className="font-display uppercase tracking-wider text-[10px] ml-1" style={{ color: decision === 'allow' ? '#54e08a' : '#ff5d5d' }}>
              {decision === 'allow' ? 'allowed' : 'denied'}
            </span>
          )}
        </div>
  ```
  (Use this always-rendered-and-disabled version so the post-decision `getByRole('button')` assertions in the test resolve. Delete the earlier `decision ? (...)` snippet.)

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-permissioncard.test.tsx` → 2 passing.

- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): inline PermissionCard wired to chat input"`

---

### Task 6: `SubagentChip` + `SearchResultCard` — compact cards

Two small compact components. `SubagentChip` renders a `subagent_spawned` event as a chip linking to `/agents/<childId>`. `SearchResultCard` renders one search result (title + url + snippet) as a compact card.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-subagentchip.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import { SubagentChip } from '../components/SubagentChip';
  import { SearchResultCard } from '../components/SearchResultCard';

  describe('SubagentChip', () => {
    it('renders the label and links to the child run', () => {
      render(<SubagentChip label="research-bot" childId="abc12345xyz" />);
      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toBe('/agents/abc12345xyz');
      expect(screen.getByText(/research-bot/)).toBeTruthy();
    });
  });

  describe('SearchResultCard', () => {
    it('renders title, url and snippet', () => {
      render(<SearchResultCard title="MDN" url="https://mdn.dev/x" snippet="docs here" />);
      expect(screen.getByText('MDN')).toBeTruthy();
      expect(screen.getByText(/docs here/)).toBeTruthy();
      expect(screen.getByText(/mdn\.dev/)).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-subagentchip.test.tsx` → fails: cannot find modules.

- [ ] **Step 3: Minimal implementation.**
  Create `apps/web/components/SubagentChip.tsx`:
  ```tsx
  'use client';
  import React from 'react';
  import { Dot } from './ui';

  /** Compact subagent chip (spec §7) — a spawned subagent linking to its run page. */
  export function SubagentChip({ label, childId }: { label: string; childId: string }) {
    return (
      <a
        href={`/agents/${childId}`}
        className="inline-flex items-center gap-1.5 my-1 px-2 py-0.5 border border-line2 hover:border-amber/60 hover:bg-amber/5 transition-colors"
      >
        <Dot color="#ffb000" size={6} />
        <span className="font-mono text-[11px] text-ink">{label}</span>
        <span className="font-mono text-[9px] text-faint">{childId.slice(0, 8)}</span>
      </a>
    );
  }
  ```
  Create `apps/web/components/SearchResultCard.tsx`:
  ```tsx
  'use client';
  import React from 'react';

  /** Compact search-result card (spec §7) — title + host + snippet, read-only link. */
  function host(url: string): string {
    try { return new URL(url).host; } catch { return url; }
  }
  function safe(url: string): string | null {
    return /^https?:/i.test(url.trim()) ? url.trim() : null;
  }

  export function SearchResultCard({ title, url, snippet }: { title: string; url: string; snippet?: string }) {
    const href = safe(url);
    return (
      <div className="border border-line2 bg-black/40 px-2.5 py-2 my-1">
        <div className="flex items-baseline gap-2">
          {href
            ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-display text-[12px] text-amber hover:underline truncate">{title}</a>
            : <span className="font-display text-[12px] text-dim truncate">{title}</span>}
          <span className="font-mono text-[9px] text-faint shrink-0">{host(url)}</span>
        </div>
        {snippet && <div className="font-mono text-[11px] text-dim mt-1 leading-[1.6] line-clamp-3">{snippet}</div>}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-subagentchip.test.tsx` → 2 passing.

- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): SubagentChip + SearchResultCard chat cards"`

---

### Task 7: `ChatTable` — real table for `ChatCommandResult kind:'table'`

`ChatCommandResult` (`@fleet/shared`) carries `{ kind: 'table'; columns?: string[]; rows?: string[][] }`. The current thread discards it. Render a real `<table>` in HUD style.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-chattable.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import { ChatTable } from '../components/ChatTable';

  describe('ChatTable', () => {
    it('renders headers and rows', () => {
      render(<ChatTable columns={['id', 'status']} rows={[['run-1', 'running'], ['run-2', 'done']]} />);
      expect(screen.getByText('id')).toBeTruthy();
      expect(screen.getByText('run-1')).toBeTruthy();
      expect(screen.getByText('done')).toBeTruthy();
      // it is a real <table>
      expect(document.querySelector('table')).toBeTruthy();
      expect(document.querySelectorAll('tbody tr').length).toBe(2);
    });

    it('renders an empty-state note when there are no rows', () => {
      render(<ChatTable columns={['id']} rows={[]} />);
      expect(screen.getByText(/no rows/i)).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-chattable.test.tsx` → fails: cannot find module.

- [ ] **Step 3: Minimal implementation.**
  Create `apps/web/components/ChatTable.tsx`:
  ```tsx
  'use client';
  import React from 'react';

  /** Real table for ChatCommandResult kind:'table' (spec §7) — HUD-styled, replaces the
   *  discarded result. columns/rows come straight off ChatCommandResult. */
  export function ChatTable({ columns, rows }: { columns?: string[]; rows?: string[][] }) {
    const cols = columns ?? [];
    const data = rows ?? [];
    if (data.length === 0) {
      return <div className="font-mono text-[11px] text-faint my-1.5 border border-dashed border-line2 px-2.5 py-2">no rows</div>;
    }
    return (
      <div className="overflow-auto my-2 border border-line2 bg-black/40">
        <table className="border-collapse text-[12px] text-dim w-full">
          <thead className="text-ink">
            <tr>
              {cols.map((c, i) => (
                <th key={i} className="border-b border-line2 px-2 py-1 text-left font-display uppercase tracking-wider text-[10px] text-amber">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => (
              <tr key={ri} className="hover:bg-amber/[0.03]">
                {row.map((cell, ci) => (
                  <td key={ci} className="border-t border-white/[0.04] px-2 py-1 align-top font-mono">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-chattable.test.tsx` → 2 passing.

- [ ] **Step 5: Commit.**
  `git add -A && git commit -m "feat(web): ChatTable for command-result tables"`

---

### Task 8: Rewrite `ChatThread` — Markdown, event-driven cards, live tokens, Stop

Replace `ChatThread.tsx` so: (a) persisted messages render through `MarkdownView` (assistant/`command-result` text), tables (`command-result` whose content is a serialized `ChatCommandResult kind:'table'`), and `ErrorBanner` (`kind:'error'`); (b) the live turn consumes `useChatStream(sessionId)` and renders the full event stream as ordered cards (assistant Markdown + live token streaming, `ToolCallCard`, `ThinkingBlock`, `PermissionCard`, `SubagentChip`); (c) a Stop button shows while `state === 'running'` and calls `api.chatInterrupt`.

This is the integration task — it depends on Tasks 1-7. It also changes the component's props: it now needs `sessionId` (for `useChatStream` and `api.chatInput`/`chatInterrupt`) instead of `liveRunId`. The chat page (`apps/web/app/chat/page.tsx`) wiring change is Step 6.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-chatthread.test.tsx`. It stubs `useChatStream` via `vi.mock` so the thread's rendering logic runs without a real SSE:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen } from '@testing-library/react';

  // Stub the chat stream so we drive the thread's event rendering directly.
  const streamState: any = { run: null, events: [], partials: {}, state: 'idle', connected: true, error: null };
  vi.mock('../lib/live', () => ({ useChatStream: () => streamState }));

  import { ChatThread } from '../components/ChatThread';
  import type { ChatMessage } from '@fleet/shared';

  const msg = (over: Partial<ChatMessage>): ChatMessage => ({
    id: 'm' + Math.random(), sessionId: 's1', role: 'assistant', kind: 'text',
    content: '', runId: null, createdAt: 0, ...over,
  });

  beforeEach(() => {
    streamState.events = []; streamState.partials = {}; streamState.state = 'idle'; streamState.run = null;
  });

  describe('ChatThread', () => {
    it('renders assistant text as markdown (a code fence becomes a code block, not raw)', () => {
      render(<ChatThread sessionId="s1" messages={[msg({ role: 'assistant', content: '# Hello\n\nworld' })]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(screen.getByText('Hello')).toBeTruthy();
      expect(screen.getByText('world')).toBeTruthy();
    });

    it('renders a command-result error message via ErrorBanner', () => {
      render(<ChatThread sessionId="s1" messages={[msg({ role: 'system', kind: 'error', content: 'boom failed' })]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(screen.getByText(/boom failed/)).toBeTruthy();
    });

    it('renders a serialized table command-result as a real table', () => {
      const payload = JSON.stringify({ ok: true, kind: 'table', columns: ['id'], rows: [['x1']] });
      render(<ChatThread sessionId="s1" messages={[msg({ role: 'system', kind: 'command-result', content: payload })]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(document.querySelector('table')).toBeTruthy();
      expect(screen.getByText('x1')).toBeTruthy();
    });

    it('renders live tool_use as a ToolCallCard from the stream', () => {
      streamState.run = { id: 'run1', status: 'running' };
      streamState.state = 'running';
      streamState.events = [
        { type: 'tool_use', nodeId: 'n1', seq: 1, ts: 0, runId: 'run1', payload: { id: 't1', name: 'Read', input: { file_path: '/a' } } },
      ];
      render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(screen.getByText('Read')).toBeTruthy();
    });

    it('streams partial assistant tokens into the live bubble', () => {
      streamState.state = 'running';
      streamState.run = { id: 'run1', status: 'running' };
      streamState.partials = { n1: 'partial answer' };
      render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(screen.getByText(/partial answer/)).toBeTruthy();
    });

    it('shows a Stop button while state is running', () => {
      streamState.state = 'running';
      streamState.run = { id: 'run1', status: 'running' };
      render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
    });

    it('renders a permission_request as an inline PermissionCard', () => {
      streamState.state = 'running';
      streamState.run = { id: 'run1', status: 'running' };
      streamState.events = [
        { type: 'permission_request', nodeId: 'n1', seq: 1, ts: 0, runId: 'run1', payload: { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } } },
      ];
      render(<ChatThread sessionId="s1" messages={[]} onTurnComplete={() => {}} onTurnError={() => {}} />);
      expect(screen.getByText(/permission request/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /allow/i })).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test test/cov-chatthread.test.tsx` → fails (old `ChatThread` has no `sessionId` prop, doesn't render markdown/cards/stop).

- [ ] **Step 3: Minimal implementation.**
  Replace the ENTIRE contents of `apps/web/components/ChatThread.tsx` with:
  ```tsx
  'use client';
  import React, { useEffect, useRef } from 'react';
  import type { ChatMessage, NormalizedEvent, ChatCommandResult } from '@fleet/shared';
  import { useChatStream } from '@/lib/live';
  import { api } from '@/lib/api';
  import { MarkdownView } from './MarkdownView';
  import { ToolCallCard } from './ToolCallCard';
  import { ThinkingBlock } from './ThinkingBlock';
  import { PermissionCard } from './PermissionCard';
  import { SubagentChip } from './SubagentChip';
  import { ChatTable } from './ChatTable';
  import { ErrorBanner, Btn } from './ui';

  const TERMINAL = new Set(['completed', 'failed', 'killed']);
  const roleLabelColor = (role: string) => (role === 'user' ? '#39d4cf' : role === 'system' ? '#9aa1ab' : '#ffb000');

  /** Try to parse a persisted command-result message body as a serialized ChatCommandResult. */
  function parseCommandResult(content: string): ChatCommandResult | null {
    try {
      const o = JSON.parse(content);
      if (o && typeof o === 'object' && 'kind' in o) return o as ChatCommandResult;
    } catch { /* not JSON → plain text */ }
    return null;
  }

  /** One persisted message → markdown / table / error, per its kind. */
  function PersistedMessage({ m }: { m: ChatMessage }) {
    if (m.kind === 'error') {
      return <div className="my-1"><ErrorBanner>{m.content}</ErrorBanner></div>;
    }
    if (m.kind === 'command-result') {
      const res = parseCommandResult(m.content);
      if (res?.kind === 'table') return <ChatTable columns={res.columns} rows={res.rows} />;
      if (res?.kind === 'error') return <div className="my-1"><ErrorBanner>{res.text ?? m.content}</ErrorBanner></div>;
      return <MarkdownView source={res?.text ?? m.content} />;
    }
    if (m.kind === 'command') {
      // the user's slash command echo — keep it terse + monospace
      return <div className="font-mono text-[12px] text-dim my-1">{m.content}</div>;
    }
    return (
      <div className="my-1">
        <div className="font-display uppercase tracking-wider text-[9px] mb-0.5" style={{ color: roleLabelColor(m.role) }}>{m.role}</div>
        <MarkdownView source={m.content} />
      </div>
    );
  }

  /** The live turn — consumes the chat-scoped stream and renders the full event vocabulary
   *  as ordered, chat-native cards. Fires onComplete once when the backing run goes terminal. */
  function LiveTurn({
    sessionId, onComplete, onError,
  }: { sessionId: string; onComplete: (runId: string, finalText: string) => void; onError: (runId: string) => void }) {
    const { run, events, partials, state, error } = useChatStream(sessionId);
    const done = useRef<string | null>(null);

    // Final assistant text = concatenation of assistant_text + result payloads (matches the old contract).
    const finalText = events
      .filter((e) => e.type === 'assistant_text' || e.type === 'result')
      .map((e) => String((e.payload as any)?.text ?? (e.payload as any)?.result ?? ''))
      .join('');

    useEffect(() => {
      if (!run || done.current === run.id || !TERMINAL.has(run.status)) return;
      done.current = run.id;
      onComplete(run.id, run.resultText ?? finalText);
    }, [run, finalText, onComplete]);

    if (error) {
      return (
        <ErrorBanner>
          live stream lost — {error}
          <button type="button" onClick={() => onError(run?.id ?? '')} className="ml-2 underline hover:text-ink transition-colors">dismiss</button>
        </ErrorBanner>
      );
    }

    // Live streaming token text (any node currently mid-message).
    const streaming = Object.values(partials).filter(Boolean).join('');
    const nothingYet = events.length === 0 && !streaming;

    return (
      <div className="space-y-1">
        {events.map((ev: NormalizedEvent, i: number) => {
          const p: any = ev.payload ?? {};
          switch (ev.type) {
            case 'assistant_text':
              return <div key={i} className="my-1"><MarkdownView source={String(p.text ?? '')} /></div>;
            case 'thinking':
              return <ThinkingBlock key={i} text={String(p.text ?? '')} />;
            case 'tool_use': {
              // pair with its tool_result (matched on the tool_use id) if present later in the stream
              const result = events.find((e) => e.type === 'tool_result' && (e.payload as any)?.forId === p.id);
              const rp: any = result?.payload ?? null;
              return (
                <ToolCallCard
                  key={i}
                  name={String(p.name ?? 'tool')}
                  input={p.input}
                  result={rp ? String(rp.text ?? '') : null}
                  isError={!!rp?.isError}
                />
              );
            }
            case 'tool_result':
              return null; // rendered inside its paired ToolCallCard
            case 'permission_request':
              return (
                <PermissionCard
                  key={i}
                  sessionId={sessionId}
                  requestId={String(p.requestId ?? p.id ?? '')}
                  toolName={String(p.toolName ?? p.name ?? 'tool')}
                  input={p.input}
                />
              );
            case 'subagent_spawned':
              return <SubagentChip key={i} label={String(p.label ?? 'subagent')} childId={String(p.childId ?? '')} />;
            case 'result':
              return null; // folded into finalText / onComplete
            default:
              return null;
          }
        })}
        {streaming && (
          <div className="my-1">
            <MarkdownView source={streaming} />
            <span className="caret" />
          </div>
        )}
        {nothingYet && state === 'running' && <div className="text-[13px] text-faint">⟳ thinking…</div>}
      </div>
    );
  }

  export function ChatThread({
    sessionId, messages, onTurnComplete, onTurnError,
  }: {
    sessionId: string | null;
    messages: ChatMessage[];
    onTurnComplete: (runId: string, finalText: string) => void;
    onTurnError: (runId: string) => void;
  }) {
    const endRef = useRef<HTMLDivElement>(null);
    const { state } = useChatStream(sessionId);

    useEffect(() => {
      const end = endRef.current;
      if (!end) return;
      let sc: HTMLElement | null = end.parentElement;
      while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
      if (!sc) return;
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120) sc.scrollTop = sc.scrollHeight;
    }, [messages.length, state]);

    return (
      <div className="flex-1 overflow-auto p-4">
        {messages.map((m) => <PersistedMessage key={m.id} m={m} />)}
        {sessionId && <LiveTurn sessionId={sessionId} onComplete={onTurnComplete} onError={onTurnError} />}
        {state === 'running' && (
          <div className="sticky bottom-0 flex justify-center py-2">
            <Btn variant="danger" onClick={() => { if (sessionId) api.chatInterrupt(sessionId).catch(() => {}); }}>stop</Btn>
          </div>
        )}
        <div ref={endRef} />
      </div>
    );
  }
  ```
  Note on the test mock: `useChatStream` is mocked to return a single shared object, so both the `ChatThread` and inner `LiveTurn` calls see the same state — that is intentional and matches how the hook behaves (one subscription per session). The `run.resultText` field exists on `Run` (`@fleet/shared`); `finalText` is the fallback.

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test test/cov-chatthread.test.tsx` → 7 passing.

- [ ] **Step 5: Typecheck the whole web app.**
  `pnpm --filter @fleet/web typecheck` → completes with no type errors. If it errors on `run.resultText` or `run.status`, confirm those fields exist on `Run` in `@fleet/shared` (they do — `useRunStream`/old `LiveTurn` used them).

- [ ] **Step 6: Wire the new props in the chat page.**
  In `apps/web/app/chat/page.tsx`, the old `ChatThread` was called as:
  ```tsx
  <ChatThread messages={messages} liveRunId={liveRunId} onTurnComplete={onTurnComplete} onTurnError={onTurnError} />
  ```
  Change it to pass `sessionId` instead of `liveRunId` (the thread now derives liveness from the chat-scoped stream, not a local run id):
  ```tsx
  <ChatThread sessionId={activeId} messages={messages} onTurnComplete={onTurnComplete} onTurnError={onTurnError} />
  ```
  Leave the rest of `page.tsx` (the `send`/`command`/`onTurnComplete` handlers, `liveRunId` state) untouched for now — `liveRunId` is simply no longer threaded into the thread. (Unit 4 owns the broader page/session-state rewire; this step only keeps the page compiling.)

- [ ] **Step 7: Build again to confirm the page compiles.**
  `pnpm --filter @fleet/web typecheck` → no type errors (the `liveRunId` prop is gone; `sessionId={activeId}` is `string | null`, which matches).

- [ ] **Step 8: Commit.**
  `git add -A && git commit -m "feat(web): ChatThread renders full ChatGPT-grade message stream"`

---

### Task 9: Full unit test sweep + typecheck gate

Confirm every component test and the build pass together (no cross-file regressions).

- [ ] **Step 1: Run all this unit's tests.**
  `pnpm --filter @fleet/web test test/cov-chatapi.test.ts test/cov-toolcallcard.test.tsx test/cov-thinkingblock.test.tsx test/cov-permissioncard.test.tsx test/cov-subagentchip.test.tsx test/cov-chattable.test.tsx test/cov-chatthread.test.tsx` → all green (and `test/cov-usechatstream.test.ts` if Task 2 created it).

- [ ] **Step 2: Run the full web test suite** to catch regressions in the existing `fn-*` tests.
  `pnpm --filter @fleet/web test` → all passing.

- [ ] **Step 3: Typecheck/build.**
  `pnpm --filter @fleet/web typecheck` → no errors.

- [ ] **Step 4: Commit (if any fixups were needed).**
  `git add -A && git commit -m "test(web): chat rendering unit test sweep green"` (skip if nothing changed).

---

## Unit 4 — Session Sidebar, Scoped Panel, Page Wiring & Concurrency UX

This unit covers the **Session UI + concurrency** slice of the Chat Surface Upgrade (spec §3, §8, §12; build-sequence phase 4). It upgrades the left **session sidebar** (`ChatSessionList`), makes the right **running-agents panel** session-scoped (`RunningAgentsPanel`), wires the new state derivation + kill/resume/resumable flow into `chat/page.tsx`, and adds the concurrency-UX hook + tests.

**Domain orientation (read this — the implementer knows React/Next/vitest but NOT this app's chat model):**

- A **chat session** is a persisted conversation row (`ChatSession`). Its lifecycle state is **derived, never stored**: `ChatSessionState = 'live' | 'running' | 'idle' | 'killed'` (canonical type from `@fleet/shared`). `live` = a held interactive process exists; `running` = a turn is streaming; `idle` = resumable, no held process (this is the "budget-exhausted" / post-restart / idle-suspended state); `killed` = explicitly stopped. A session read now carries optional derived fields `state?: ChatSessionState` and `live?: boolean`.
- A session is backed by a **run** (`session.runId`, nullable until the first turn). Today the right-hand `RunningAgentsPanel` shows the *fleet-wide* list via `useFleet()`. The spec wants it **session-scoped**: only the active session's backing run + its subagents, sourced from a **chat-scoped SSE stream** (`GET /api/chat/sessions/:id/stream`). That stream re-uses the existing `NormalizedEventType` vocabulary (`subagent_spawned`, `result`, …) and adds one chat-control envelope `session_state` carrying `{ state: ChatSessionState; live: boolean }`.
- **Concurrency UX (the load-bearing behavior, spec §3.2 + §12):** live chat processes draw from a separate pool `CHAT_LIVE_MAX` (default 4). When it's exhausted, a newly-focused session does NOT error — it silently runs in **resumable** mode (`state==='idle'`, ~1s slower per turn) and shows a subtle "resumable" badge. A live session left idle past `CHAT_IDLE_SUSPEND_MS` (default 600000) transitions `live → idle`. Both transitions arrive over the chat stream as `session_state` envelopes.
- **Reload safety:** `liveRunId` is currently local React state, so a streaming turn is orphaned on refresh. The chat-scoped stream re-attaches to whatever run backs the session, so on reload the page must re-subscribe by **session id** (not by a remembered run id).

**Existing primitives to REUSE (do not re-implement):**
- `Dot`, `Badge`, `StatusBadge`, `Btn`, `Input` from `@/components/ui` (read in prep). `Badge` = `{ label, color, live?, big? }`; `Dot` = `{ color, live?, size? }`.
- `ago(ts)` relative-time formatter from `@/lib/format` (e.g. `ago(updatedAt)` → `"3m ago"`).
- `statusMeta(status)` from `@/lib/status` maps a **RunStatus** → `{label,color,live}`. It does NOT know the chat `ChatSessionState` enum (`live`/`idle` aren't RunStatuses), so this unit adds a small chat-state→color/label map (Task 1).
- SSE test harness: `FakeEventSource` in `apps/web/test/setup.ts` (installed on `globalThis.EventSource`); drive it with `.emitOpen()`, `.emit(obj)`, `.emitError()`, read with `FakeEventSource.last()`. Existing hook tests live in `apps/web/test/fn-*.test.ts`.

**Canonical types (from Unit F — match VERBATIM, import from `@fleet/shared`, never redefine):**
```ts
export type ChatSessionState = 'live' | 'running' | 'idle' | 'killed';
// ChatSession gains: state?: ChatSessionState;  live?: boolean;
// ChatAttachment: { path: string; kind: 'file' | 'dir' }
// session_state chat-stream envelope payload: { state: ChatSessionState; live: boolean }
```

**Dependencies / assumptions on sibling units (reconcile at assembly):**
- Unit F adds `state?`/`live?` to `ChatSession` and `attachments?` to `ChatMessage`/`ChatTurnRequest` in `packages/shared/src/index.ts`. **This unit's typechecks depend on those fields existing.** If Unit F hasn't landed, the web typecheck step (`pnpm --filter @fleet/web typecheck`) will fail on `session.state`/`session.live`.
- The chat-scoped stream route (`GET /api/chat/sessions/:id/stream`) and the `session_state` envelope are owned by Unit 1 (server). This unit's `useChatStream` hook + tests exercise the *client* reducer against `FakeEventSource`, so they pass without a live server.
- API helpers `api.killChatSession`, `api.resumeChatSession`, `api.renameChatSession` (rename already exists) are assumed present in `apps/web/lib/api.ts` (Unit owning `lib/api.ts` per spec §10). This unit adds **only** the ones it needs if absent (Task 6 guards), but prefer the api-layer unit to own them. **Note for assembler:** if the api-layer unit also defines `killChatSession`/`resumeChatSession`, dedupe.

**Files:**
- Create: `apps/web/lib/chatState.ts` (chat-state → `{label,color,live}` map; pure, testable)
- Modify: `apps/web/lib/live.ts` (add `useChatStream(sessionId)` chat-scoped SSE hook)
- Modify: `apps/web/components/ChatSessionList.tsx` (status dot, preview, timestamp, kill/resume, inline rename)
- Modify: `apps/web/components/RunningAgentsPanel.tsx` (session-scoped run + subagents)
- Modify: `apps/web/app/chat/page.tsx` (wire derived state, kill→resume, resumable badge, re-attach by session id)
- Test: `apps/web/test/fn-chatstate.test.ts` (chat-state map)
- Test: `apps/web/test/fn-usechatstream.test.ts` (chat-scoped stream reducer: subagents + `session_state` concurrency transitions)
- Test: `apps/web/test/cov-chatsessionlist.test.tsx` (row status mapping + kill/resume + inline rename render)
- Test: `apps/web/test/cov-runningagentspanel.test.tsx` (session-scoped render)

---

### Task 1: Chat-state → label/color map (pure helper) — TDD

The session list and page need to map a `ChatSessionState` to a HUD color + label for `Dot`/`Badge`. `statusMeta` only knows `RunStatus`, so we add a sibling map. Palette: live = teal `#39d4cf` (active, like running), running = amber `#ffb000`, idle = dim `#9aa1ab`, killed = orange `#ff7a45` (matches `statusMeta('killed')`).

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/fn-chatstate.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { chatStateMeta } from '../lib/chatState';

  describe('chatStateMeta', () => {
    it('maps each ChatSessionState to a HUD label/color/live triple', () => {
      expect(chatStateMeta('live')).toEqual({ label: 'LIVE', color: '#39d4cf', live: true });
      expect(chatStateMeta('running')).toEqual({ label: 'RUNNING', color: '#ffb000', live: true });
      expect(chatStateMeta('idle')).toEqual({ label: 'RESUMABLE', color: '#9aa1ab', live: false });
      expect(chatStateMeta('killed')).toEqual({ label: 'KILLED', color: '#ff7a45', live: false });
    });

    it('falls back to a dim idle-like triple for an unknown state', () => {
      // @ts-expect-error — exercising the runtime fallback for a value outside the union
      expect(chatStateMeta('bogus')).toEqual({ label: 'IDLE', color: '#9aa1ab', live: false });
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test fn-chatstate`
  Expected: `FAIL` — `Failed to resolve import "../lib/chatState"` (module does not exist yet).

- [ ] **Step 3: Minimal implementation.**
  Create `apps/web/lib/chatState.ts`:
  ```ts
  import type { ChatSessionState } from '@fleet/shared';

  export interface ChatStateMeta {
    label: string;
    color: string; // hex (HUD status palette)
    live: boolean; // drives the pulsing Dot glow
  }

  // Chat lifecycle is its own enum (not RunStatus), so it gets its own palette map —
  // mirrors lib/status.ts statusMeta but keyed by ChatSessionState (spec §3.1 / §8).
  const MAP: Record<ChatSessionState, ChatStateMeta> = {
    live: { label: 'LIVE', color: '#39d4cf', live: true },     // teal — held interactive process
    running: { label: 'RUNNING', color: '#ffb000', live: true }, // amber — a turn is streaming
    idle: { label: 'RESUMABLE', color: '#9aa1ab', live: false }, // dim — resumable fallback (~1s spin-up)
    killed: { label: 'KILLED', color: '#ff7a45', live: false },  // orange — explicitly stopped
  };

  export const chatStateMeta = (s: ChatSessionState): ChatStateMeta =>
    MAP[s] ?? { label: 'IDLE', color: '#9aa1ab', live: false };
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test fn-chatstate`
  Expected: `PASS` — `Test Files 1 passed`, `Tests 2 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/web/lib/chatState.ts apps/web/test/fn-chatstate.test.ts && git commit -m "feat(web): chat-state HUD label/color map"`

---

### Task 2: `useChatStream(sessionId)` — chat-scoped SSE hook with concurrency transitions — TDD

The session-scoped panel and the page both need a hook that subscribes to `GET /api/chat/sessions/:id/stream`, accumulates the backing run + spawned subagents, and tracks the derived `state`/`live` from `session_state` envelopes. This is where the **concurrency UX** is observed on the client: a `session_state` `{state:'idle'}` envelope = budget-exhausted/idle-suspend; `{state:'live'}` = a live process was claimed. The hook reduces frames against `FakeEventSource` exactly like the existing `useRunStream`/`useFleet` hooks.

The stream frames it consumes (server-shaped, Unit 1 owns the wire side):
- `{ kind: 'hello', state, live, runId, subagents: [...] }` — initial snapshot.
- `{ kind: 'session_state', state, live }` — chat-control envelope (concurrency transitions).
- `{ kind: 'event', event: NormalizedEvent }` — a run event; `event.type === 'subagent_spawned'` appends a subagent chip; `event.runId` updates the current backing run id (survives kill→resume where the run id changes underneath).

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/fn-usechatstream.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { renderHook, act } from '@testing-library/react';
  import { useChatStream } from '../lib/live';
  import { FakeEventSource } from './setup';

  describe('useChatStream', () => {
    it('subscribes to the chat-scoped stream by session id', () => {
      renderHook(() => useChatStream('sess-1'));
      const es = FakeEventSource.last();
      expect(es.url).toContain('/api/chat/sessions/sess-1/stream');
    });

    it('reduces hello → state/live/runId/subagents and toggles connected', () => {
      const { result } = renderHook(() => useChatStream('sess-1'));
      const es = FakeEventSource.last();
      expect(result.current.connected).toBe(false);
      act(() => es.emitOpen());
      expect(result.current.connected).toBe(true);
      act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [{ runId: 'sub-1', name: 'reviewer' }] }));
      expect(result.current.state).toBe('live');
      expect(result.current.live).toBe(true);
      expect(result.current.runId).toBe('run-a');
      expect(result.current.subagents).toEqual([{ runId: 'sub-1', name: 'reviewer' }]);
    });

    it('budget exhaustion: a session_state idle envelope flips a live session to resumable (no error)', () => {
      const { result } = renderHook(() => useChatStream('sess-1'));
      const es = FakeEventSource.last();
      act(() => es.emitOpen());
      act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [] }));
      expect(result.current.state).toBe('live');
      // CHAT_LIVE_MAX exhausted / idle-suspend → server pushes a state transition, never an error frame
      act(() => es.emit({ kind: 'session_state', state: 'idle', live: false }));
      expect(result.current.state).toBe('idle');
      expect(result.current.live).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('appends subagents from subagent_spawned events and follows the run id across kill→resume', () => {
      const { result } = renderHook(() => useChatStream('sess-1'));
      const es = FakeEventSource.last();
      act(() => es.emitOpen());
      act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [] }));
      act(() => es.emit({ kind: 'event', event: { type: 'subagent_spawned', runId: 'run-a', nodeId: 'n1', payload: { name: 'tester' } } }));
      expect(result.current.subagents).toEqual([{ runId: 'n1', name: 'tester' }]);
      // kill→resume: the backing run id changes; the stream follows it (spec §4)
      act(() => es.emit({ kind: 'event', event: { type: 'result', runId: 'run-b', nodeId: 'run-b', payload: {} } }));
      expect(result.current.runId).toBe('run-b');
    });

    it('ignores malformed frames and closes on unmount', () => {
      const { result, unmount } = renderHook(() => useChatStream('sess-1'));
      const es = FakeEventSource.last();
      act(() => es.emit('not json{'));
      expect(result.current.subagents).toEqual([]);
      unmount();
      expect(es.closed).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test fn-usechatstream`
  Expected: `FAIL` — `useChatStream` is not exported from `../lib/live`.

- [ ] **Step 3: Minimal implementation.**
  In `apps/web/lib/live.ts`, add the import for the canonical type at the top of the existing `import type { … } from '@fleet/shared'` block:
  ```ts
  import type {
    Run,
    RunNode,
    NormalizedEvent,
    SpendSummary,
    FleetMessage,
    StreamMessage,
    Campaign,
    CampaignTask,
    CampaignMessage,
    ChatSessionState,
  } from '@fleet/shared';
  ```
  Then append the new hook to the end of `apps/web/lib/live.ts` (after `useCampaign`, before `useAsync`):
  ```ts
  // ── per-session chat-scoped live channel (spec §4) ──────────────────────────
  /** A subagent chip surfaced from a subagent_spawned event (or the hello snapshot). */
  export interface ChatSubagent { runId: string; name: string }

  export interface ChatStreamState {
    /** derived session lifecycle from the server's session_state envelopes (spec §3). */
    state: ChatSessionState | null;
    /** true iff a live interactive process is held for the session. */
    live: boolean;
    /** id of the run currently backing the session — changes under us across kill→resume. */
    runId: string | null;
    subagents: ChatSubagent[];
    connected: boolean;
    error: string | null;
  }

  export function useChatStream(sessionId: string | null): ChatStreamState {
    const [state, setState] = useState<ChatSessionState | null>(null);
    const [live, setLive] = useState(false);
    const [runId, setRunId] = useState<string | null>(null);
    const [subagents, setSubagents] = useState<ChatSubagent[]>([]);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      // reset per-session so switching sessions never bleeds prior state
      setState(null); setLive(false); setRunId(null); setSubagents([]);
      setConnected(false); setError(null);
      if (!sessionId) return;
      const es = new EventSource(`${API}/api/chat/sessions/${sessionId}/stream`);
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.error) { setError(String(m.error)); es.close(); return; }
        if (m.kind === 'hello') {
          setState(m.state ?? null);
          setLive(Boolean(m.live));
          setRunId(m.runId ?? null);
          setSubagents(Array.isArray(m.subagents) ? m.subagents : []);
        } else if (m.kind === 'session_state') {
          // chat-control envelope — the concurrency transition channel (budget exhaustion,
          // idle-suspend, kill→resume). Never an error; just a derived-state push (spec §12).
          setState(m.state ?? null);
          setLive(Boolean(m.live));
        } else if (m.kind === 'event' && m.event) {
          const ev = m.event as NormalizedEvent;
          if (ev.runId) setRunId(ev.runId); // follow the backing run across kill→resume
          if (ev.type === 'subagent_spawned') {
            setSubagents((prev) =>
              prev.some((s) => s.runId === ev.nodeId)
                ? prev
                : [...prev, { runId: ev.nodeId, name: String((ev.payload as any)?.name ?? ev.nodeId) }],
            );
          }
        }
      };
      return () => es.close();
    }, [sessionId]);

    return { state, live, runId, subagents, connected, error };
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test fn-usechatstream`
  Expected: `PASS` — `Tests 5 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/web/lib/live.ts apps/web/test/fn-usechatstream.test.ts && git commit -m "feat(web): chat-scoped SSE hook with session_state concurrency transitions"`

---

### Task 3: `ChatSessionList` — status dot, preview, timestamp, kill/resume, inline rename — TDD

Upgrade each sidebar row per spec §8: a per-row **status dot** keyed to `ChatSessionState`, a **last-message preview**, a **relative timestamp** (`ago`), per-row **Kill** (when live/running) and **Resume** (when idle/killed) buttons, and an **inline rename** input replacing the `rename` text-button that today calls `window.prompt` in the page.

The component's props change: it gains `previews` (a `sessionId → string` map the page supplies from the last message), `onKill`, `onResume`, and `onRename` becomes `(id, title) => void` (the page no longer prompts). `onSelect`/`onNew`/`onDelete` are unchanged.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-chatsessionlist.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen, fireEvent, within } from '@testing-library/react';
  import { ChatSessionList } from '../components/ChatSessionList';
  import type { ChatSession } from '@fleet/shared';

  const base: Omit<ChatSession, 'id' | 'title' | 'state' | 'live' | 'updatedAt'> = {
    engine: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'default',
    cwd: '/w', allowedTools: null, skills: null, runId: null, createdAt: 0,
  } as any;
  const sess = (over: Partial<ChatSession>): ChatSession => ({ ...(base as any), id: 'a', title: 'Alpha', updatedAt: Date.now(), ...over });

  describe('ChatSessionList', () => {
    const noop = () => {};
    function renderList(sessions: ChatSession[], handlers: Partial<Record<string, any>> = {}) {
      return render(
        <ChatSessionList
          sessions={sessions} activeId={sessions[0]?.id ?? null}
          previews={{ a: 'last assistant line' }}
          onSelect={noop} onNew={noop} onDelete={noop}
          onRename={handlers.onRename ?? noop}
          onKill={handlers.onKill ?? noop}
          onResume={handlers.onResume ?? noop}
        />,
      );
    }

    it('shows the last-message preview and a relative timestamp', () => {
      renderList([sess({ state: 'idle', updatedAt: Date.now() - 60_000 })]);
      expect(screen.getByText('last assistant line')).toBeTruthy();
      expect(screen.getByText(/ago|now/)).toBeTruthy();
    });

    it('a live session shows a Kill control; an idle session shows Resume', () => {
      const onKill = vi.fn();
      const { rerender } = renderList([sess({ id: 'a', state: 'live', live: true })], { onKill });
      fireEvent.click(screen.getByText(/kill/i));
      expect(onKill).toHaveBeenCalledWith('a');

      const onResume = vi.fn();
      rerender(
        <ChatSessionList sessions={[sess({ id: 'a', state: 'idle' })]} activeId="a"
          previews={{}} onSelect={() => {}} onNew={() => {}} onDelete={() => {}}
          onRename={() => {}} onKill={() => {}} onResume={onResume} />,
      );
      fireEvent.click(screen.getByText(/resume/i));
      expect(onResume).toHaveBeenCalledWith('a');
    });

    it('inline rename: editing the active row and pressing Enter calls onRename(id, title) — no window.prompt', () => {
      const onRename = vi.fn();
      renderList([sess({ id: 'a', state: 'idle' })], { onRename });
      fireEvent.click(screen.getByText(/rename/i));
      const input = screen.getByDisplayValue('Alpha') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Renamed' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onRename).toHaveBeenCalledWith('a', 'Renamed');
    });

    it('renders a status dot region for a killed session', () => {
      renderList([sess({ id: 'a', state: 'killed' })]);
      // killed rows expose a Resume affordance (kill is not delete)
      expect(within(screen.getByText('Alpha').closest('div')!.parentElement!).queryByText(/resume/i)).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test cov-chatsessionlist`
  Expected: `FAIL` — TS/props errors (`previews`/`onKill`/`onResume` not on the component) and missing rendered text.

- [ ] **Step 3: Implementation — rewrite `ChatSessionList.tsx`.**
  Replace the entire contents of `apps/web/components/ChatSessionList.tsx`:
  ```tsx
  'use client';
  import { useEffect, useState } from 'react';
  import type { ChatSession } from '@fleet/shared';
  import { Btn, Dot, Input } from '@/components/ui';
  import { chatStateMeta } from '@/lib/chatState';
  import { ago } from '@/lib/format';

  export function ChatSessionList({
    sessions, activeId, previews, onSelect, onNew, onRename, onKill, onResume, onDelete,
  }: {
    sessions: ChatSession[];
    activeId: string | null;
    /** sessionId → last-message preview text (supplied by the page). */
    previews: Record<string, string>;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, title: string) => void;
    onKill: (id: string) => void;
    onResume: (id: string) => void;
    onDelete: (id: string) => void;
  }) {
    // inline-rename edit buffer: the id being renamed + its draft title (replaces window.prompt).
    const [editId, setEditId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');

    useEffect(() => { setEditId(null); }, [activeId]);

    function startRename(s: ChatSession) { setEditId(s.id); setDraft(s.title); }
    function commitRename(id: string) {
      const t = draft.trim();
      setEditId(null);
      if (t) onRename(id, t);
    }

    return (
      <div className="w-56 shrink-0 border-r hairline flex flex-col">
        <div className="flex items-center justify-between p-2 border-b hairline">
          <span className="kicker">sessions</span>
          <Btn onClick={onNew}>+ New</Btn>
        </div>
        <div className="flex-1 overflow-auto">
          {sessions.map((s) => {
            const meta = chatStateMeta(s.state ?? 'idle');
            const active = s.id === activeId;
            const canKill = s.state === 'live' || s.state === 'running';
            return (
              <div key={s.id}
                className={`px-2 py-2 text-[12px] cursor-pointer border-b hairline transition-colors ${active ? 'bg-amber/[0.06]' : 'hover:bg-white/5'}`}
                onClick={() => onSelect(s.id)}>
                <div className="flex items-center gap-1.5">
                  <Dot color={meta.color} live={meta.live} size={6} />
                  {editId === s.id ? (
                    <Input autoFocus value={draft} className="!py-0.5 !text-[12px]"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditId(null); }
                      }}
                      onBlur={() => commitRename(s.id)} />
                  ) : (
                    <div className="truncate text-ink flex-1">{s.title}</div>
                  )}
                </div>
                {previews[s.id] && (
                  <div className="truncate text-[10px] text-dim mt-0.5">{previews[s.id]}</div>
                )}
                <div className="flex items-center justify-between font-mono text-[10px] text-faint mt-0.5">
                  <span>{s.engine} · {s.model}</span>
                  <span>{ago(s.updatedAt)}</span>
                </div>
                {active && editId !== s.id && (
                  <div className="flex gap-2 mt-1.5 font-mono text-[10px]">
                    <button className="text-faint hover:text-ink transition-colors" onClick={(e) => { e.stopPropagation(); startRename(s); }}>rename</button>
                    {canKill && (
                      <button className="text-faint hover:text-sig-killed transition-colors" onClick={(e) => { e.stopPropagation(); onKill(s.id); }}>kill</button>
                    )}
                    {(s.state === 'idle' || s.state === 'killed') && (
                      <button className="text-faint hover:text-amber transition-colors" onClick={(e) => { e.stopPropagation(); onResume(s.id); }}>resume</button>
                    )}
                    <button className="text-faint hover:text-sig-failed transition-colors" onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>delete</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test cov-chatsessionlist`
  Expected: `PASS` — `Tests 4 passed`.
  (If the matcher `toBeTruthy()` on a query is fine; this repo's tests do not import `@testing-library/jest-dom`, so use `getBy*`/`queryBy*` truthiness as shown, NOT `toBeInTheDocument`.)

- [ ] **Step 5: Commit.**
  `git add apps/web/components/ChatSessionList.tsx apps/web/test/cov-chatsessionlist.test.tsx && git commit -m "feat(web): session-list status dot, preview, timestamp, kill/resume, inline rename"`

---

### Task 4: `RunningAgentsPanel` — make it session-scoped — TDD

Per spec §8, the panel stops using the fleet-wide `useFleet()` and instead shows the **active session's** backing run + its subagents, sourced from `useChatStream(sessionId)` (Task 2). It takes a `sessionId` prop (the active chat session). When there's no active session it shows an empty state. The fleet-wide view stays on `/fleet` (unchanged).

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/cov-runningagentspanel.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest';
  import { render, screen, act } from '@testing-library/react';
  import { RunningAgentsPanel } from '../components/RunningAgentsPanel';
  import { FakeEventSource } from './setup';

  describe('RunningAgentsPanel (session-scoped)', () => {
    it('with no active session, shows an idle empty state and opens no stream', () => {
      FakeEventSource.reset();
      render(<RunningAgentsPanel sessionId={null} />);
      expect(FakeEventSource.instances.length).toBe(0);
      expect(screen.getByText(/no active session|none/i)).toBeTruthy();
    });

    it('subscribes to the active session stream and lists its backing run + subagents', () => {
      render(<RunningAgentsPanel sessionId="sess-1" />);
      const es = FakeEventSource.last();
      expect(es.url).toContain('/api/chat/sessions/sess-1/stream');
      act(() => es.emitOpen());
      act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [{ runId: 'sub-1', name: 'reviewer' }] }));
      expect(screen.getByText(/run-a/)).toBeTruthy();
      expect(screen.getByText(/reviewer/)).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test cov-runningagentspanel`
  Expected: `FAIL` — `RunningAgentsPanel` does not accept a `sessionId` prop (current signature is `()`), and the new text isn't rendered.

- [ ] **Step 3: Implementation — rewrite `RunningAgentsPanel.tsx`.**
  Replace the entire contents of `apps/web/components/RunningAgentsPanel.tsx`:
  ```tsx
  'use client';
  import Link from 'next/link';
  import { useChatStream } from '@/lib/live';
  import { chatStateMeta } from '@/lib/chatState';
  import { Dot } from '@/components/ui';

  /** Session-scoped (spec §8): the active session's backing run + its subagents from the
   *  chat-scoped stream — NOT the fleet-wide list (that view stays on /fleet). */
  export function RunningAgentsPanel({ sessionId }: { sessionId: string | null }) {
    const { state, live, runId, subagents } = useChatStream(sessionId);
    const meta = chatStateMeta(state ?? 'idle');
    return (
      <div className="w-64 shrink-0 border-l hairline flex flex-col">
        <div className="p-2 border-b hairline flex items-center gap-1.5">
          <span className="kicker">session agents</span>
          {sessionId && <Dot color={meta.color} live={meta.live} size={6} />}
        </div>
        <div className="flex-1 overflow-auto">
          {!sessionId && <div className="p-3 font-mono text-[11px] text-faint">no active session</div>}
          {sessionId && !runId && <div className="p-3 font-mono text-[11px] text-faint">none running</div>}
          {sessionId && runId && (
            <Link href={`/runs/${runId}`}
              className="block px-2 py-2 text-[12px] border-b hairline hover:bg-white/5 transition-colors">
              <div className="font-mono text-ink">{runId.slice(0, 8)} · {meta.label.toLowerCase()}{live ? ' · live' : ''}</div>
              <div className="font-mono text-[10px] text-faint mt-0.5">backing run</div>
            </Link>
          )}
          {subagents.map((s) => (
            <Link key={s.runId} href={`/runs/${s.runId}`}
              className="block px-2 py-1.5 text-[12px] border-b hairline hover:bg-white/5 transition-colors">
              <div className="font-mono text-dim">↳ {s.name}</div>
              <div className="font-mono text-[10px] text-faint truncate mt-0.5">{s.runId}</div>
            </Link>
          ))}
        </div>
      </div>
    );
  }
  ```
  Note the test asserts `getByText(/run-a/)` — the backing-run line renders `runId.slice(0,8)` which for `'run-a'` is `'run-a'` (5 chars), so the match holds. The subagent line renders the raw `s.runId` (`'sub-1'`) and `s.name` (`'reviewer'`).

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test cov-runningagentspanel`
  Expected: `PASS` — `Tests 2 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/web/components/RunningAgentsPanel.tsx apps/web/test/cov-runningagentspanel.test.tsx && git commit -m "feat(web): make RunningAgentsPanel session-scoped via chat stream"`

---

### Task 5: Wire `chat/page.tsx` — derived state, resumable badge, kill→resume, re-attach by session id

Now wire the new pieces into the page (spec §3/§8/§12). Changes:
1. Pass `previews` (built from each session's last persisted message) + `onKill`/`onResume` + the new `(id,title)` rename to `ChatSessionList`; drop the `window.prompt` rename.
2. Pass the active `sessionId` to `RunningAgentsPanel`.
3. Subscribe the page to `useChatStream(activeId)` for the active session's `state`/`live`; render the **"resumable" badge** when `state==='idle'` (the budget-exhausted/idle-suspend case — spec §12: "no error shown, a subtle resumable badge").
4. On reload there's no remembered run id to orphan — the panel/stream re-attach by `activeId`. This task only needs to ensure the page does NOT depend on `liveRunId` for the panel and that switching `activeId` drives the subscription.

This task is mostly an integration wiring; the behavioral assertion is covered by Task 6's concurrency test against the hook. Verify via typecheck.

- [ ] **Step 1: Update the page imports + state.**
  In `apps/web/app/chat/page.tsx`, replace the import line for live and add `Badge`:
  - Change `import { ErrorBanner } from '@/components/ui';` to:
    ```ts
    import { ErrorBanner, Badge } from '@/components/ui';
    import { useChatStream } from '@/lib/live';
    import { chatStateMeta } from '@/lib/chatState';
    ```

- [ ] **Step 2: Derive previews + active session state.**
  Inside `ChatPage`, after the existing `const [err, setErr] = useState<string | null>(null);` line, add:
  ```ts
  const { state: liveState, live } = useChatStream(activeId);
  // previews for the sidebar: last persisted message per session (cheap client derivation).
  const previews = sessions.reduce<Record<string, string>>((acc, s) => {
    if (s.id === activeId) acc[s.id] = messages[messages.length - 1]?.content?.slice(0, 60) ?? '';
    return acc;
  }, {});
  // Prefer the live-streamed state; fall back to the session read's derived field (spec §3).
  const effectiveState = liveState ?? session?.state ?? 'idle';
  ```

- [ ] **Step 3: Replace the rename handler (drop window.prompt) and add kill/resume.**
  Replace the existing `async function renameSession(id: string) { … }` with:
  ```ts
  async function renameSession(id: string, title: string) {
    setErr(null);
    try { await api.renameChatSession(id, title); await refreshSessions(); }
    catch (e: any) { setErr(e.message); }
  }
  async function killSession(id: string) {
    setErr(null);
    try { await api.killChatSession(id); await refreshSessions(); if (id === activeId) await loadSession(id); }
    catch (e: any) { setErr(e.message); }
  }
  async function resumeSession(id: string) {
    setErr(null);
    try { await api.resumeChatSession(id); await refreshSessions(); if (id === activeId) await loadSession(id); }
    catch (e: any) { setErr(e.message); }
  }
  ```

- [ ] **Step 4: Wire the components in the JSX.**
  - Replace the `<ChatSessionList … />` element with:
    ```tsx
    <ChatSessionList sessions={sessions} activeId={activeId} previews={previews}
      onSelect={loadSession} onNew={newSession} onRename={renameSession}
      onKill={killSession} onResume={resumeSession} onDelete={deleteSession} />
    ```
  - In the session header line (the `<div className="px-4 py-2 border-b hairline text-[12px]">…`), add the resumable badge after the engine note. Replace that header `<div>`'s contents tail so it reads:
    ```tsx
    <div className="px-4 py-2 border-b hairline text-[12px] flex items-center gap-2">
      <span>{session.title} · {session.engine} · {session.model} · {session.cwd}</span>
      {session.engine !== 'claude' && <span className="text-faint">(one-shot per turn · limited memory)</span>}
      {effectiveState === 'idle' && (
        <Badge label="RESUMABLE" color={chatStateMeta('idle').color} />
      )}
      {(effectiveState === 'live' || live) && (
        <Badge label="LIVE" color={chatStateMeta('live').color} live />
      )}
    </div>
    ```
  - Replace `<RunningAgentsPanel />` with `<RunningAgentsPanel sessionId={activeId} />`.

- [ ] **Step 5: Typecheck.**
  `pnpm --filter @fleet/web typecheck`
  Expected: a successful Next build (no type errors). If it fails on `api.killChatSession`/`api.resumeChatSession`, those helpers are not yet in `lib/api.ts` — proceed to Task 6 which adds guarded fallbacks, then re-run. If it fails on `session.state`/`session.live`, Unit F's `ChatSession` change has not landed (see assembly notes).

- [ ] **Step 6: Commit.**
  `git add apps/web/app/chat/page.tsx && git commit -m "feat(web): wire chat page — derived state, resumable badge, kill/resume, session-scoped panel"`

---

### Task 6: API helpers `killChatSession` / `resumeChatSession` (if absent) — TDD-guard

The page (Task 5) and sidebar call kill/resume. The spec assigns `lib/api.ts` helpers to the api-layer unit, but to keep this unit self-contained and typecheck-green, add the two helpers **only if they are not already present** (the assembler will dedupe). They map to the server routes from the endpoint contract: kill via `DELETE`-semantics (`registry.stop`) on the session's interrupt route, resume via the resume route. Per spec §3.3: interrupt = `POST /api/chat/sessions/:id/interrupt`; the next turn transparently resumes. We expose them as named helpers.

- [ ] **Step 1: Check presence.**
  `grep -n "killChatSession\|resumeChatSession" apps/web/lib/api.ts`
  If both already exist, **skip this task** (the api-layer unit owns them). Otherwise continue.

- [ ] **Step 2: Add the helpers.**
  In `apps/web/lib/api.ts`, inside the `export const api = { … }` object, right after the existing `chatCommand:` line, add:
  ```ts
    // §3.3 — kill keeps the transcript (resume-able); interrupt stops the current turn.
    killChatSession: (id: string) => j(`/api/chat/sessions/${id}/interrupt`, { method: 'POST', body: JSON.stringify({ kill: true }) }),
    // §3.1 — resume re-spawns via --resume on the next turn; this primes the live process.
    resumeChatSession: (id: string) => j<ChatSession>(`/api/chat/sessions/${id}/resume`, { method: 'POST', body: JSON.stringify({}) }),
  ```

- [ ] **Step 3: Typecheck.**
  `pnpm --filter @fleet/web typecheck`
  Expected: successful build. This confirms Task 5's wiring now resolves.

- [ ] **Step 4: Commit.**
  `git add apps/web/lib/api.ts && git commit -m "feat(web): chat kill/resume api helpers"`

---

### Task 7: Concurrency UX integration test (budget-exhausted resumable + idle-suspend) — TDD

This is the spec §13 "concurrency UX" assertion, end-to-end on the client reducer. It proves two things against the chat stream: (1) when `CHAT_LIVE_MAX` is exhausted a session presents as **resumable** (`idle`) with **no error**; (2) an **idle-suspend** transition flips a previously-live session to `idle`. We assert these at the hook level (the source of truth the page/panel/badge read from), which keeps the test deterministic and server-free.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/fn-chat-concurrency.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { renderHook, act } from '@testing-library/react';
  import { useChatStream } from '../lib/live';
  import { chatStateMeta } from '../lib/chatState';
  import { FakeEventSource } from './setup';

  describe('chat concurrency UX (spec §3.2/§12)', () => {
    it('budget exhausted: a brand-new session opens in resumable mode, never an error', () => {
      const { result } = renderHook(() => useChatStream('sess-new'));
      const es = FakeEventSource.last();
      act(() => es.emitOpen());
      // CHAT_LIVE_MAX is full → the server hands back idle (resumable), NOT an error frame
      act(() => es.emit({ kind: 'hello', state: 'idle', live: false, runId: null, subagents: [] }));
      expect(result.current.state).toBe('idle');
      expect(result.current.live).toBe(false);
      expect(result.current.error).toBeNull();
      // the badge the page renders for this state is the subtle "RESUMABLE" pill
      expect(chatStateMeta(result.current.state!).label).toBe('RESUMABLE');
    });

    it('idle-suspend: a live session transitions to idle after CHAT_IDLE_SUSPEND_MS (server push)', () => {
      const { result } = renderHook(() => useChatStream('sess-live'));
      const es = FakeEventSource.last();
      act(() => es.emitOpen());
      act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [] }));
      expect(result.current.state).toBe('live');
      expect(result.current.live).toBe(true);
      // idle-suspend eviction reclaims the chat slot → server pushes a session_state envelope
      act(() => es.emit({ kind: 'session_state', state: 'idle', live: false }));
      expect(result.current.state).toBe('idle');
      expect(result.current.live).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('kill→resume: state goes live → killed → live without losing the subscription', () => {
      const { result } = renderHook(() => useChatStream('sess-kr'));
      const es = FakeEventSource.last();
      act(() => es.emitOpen());
      act(() => es.emit({ kind: 'hello', state: 'live', live: true, runId: 'run-a', subagents: [] }));
      act(() => es.emit({ kind: 'session_state', state: 'killed', live: false }));
      expect(result.current.state).toBe('killed');
      act(() => es.emit({ kind: 'session_state', state: 'live', live: true }));
      expect(result.current.state).toBe('live');
      expect(es.closed).toBe(false); // one durable subscription across the whole flow
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail (or pass — it depends only on Tasks 1+2).**
  `pnpm --filter @fleet/web test fn-chat-concurrency`
  Expected: if Tasks 1+2 landed, this should **PASS** immediately — that is the intent (it locks in the behavior the prior tasks built). If it fails, the failure pinpoints a reducer gap in `useChatStream` (Task 2) or the label map (Task 1) — fix there, do not weaken the test.

- [ ] **Step 3: Full unit test sweep.**
  `pnpm --filter @fleet/web test`
  Expected: all chat tests green — `fn-chatstate`, `fn-usechatstream`, `fn-chat-concurrency`, `cov-chatsessionlist`, `cov-runningagentspanel`, plus the pre-existing `fn-*` suites still passing.

- [ ] **Step 4: Final typecheck.**
  `pnpm --filter @fleet/web typecheck`
  Expected: clean build.

- [ ] **Step 5: Commit.**
  `git add apps/web/test/fn-chat-concurrency.test.ts && git commit -m "test(web): concurrency UX — budget-exhausted resumable + idle-suspend + kill→resume"`

---

## Unit 5 — Command registry population (curated verbs + Inbox-gated danger)

This unit EXTENDS the declarative command registry that **Unit 1 already built** (`apps/server/src/commands.ts`): an in-memory array of `CommandDef & { run(ctx): Promise<ChatCommandResult> }`, the `dispatchCommand(line, cwd)` that looks a verb up in that array and calls its `run`, `listCommands()` that returns the array as wire `CommandDef[]` (stripping `run`), and `GET /api/commands`. **Do not re-refactor those.** You only (a) add new `CommandDef` entries to the array, (b) add a real Inbox **enqueue** mechanism so destructive verbs queue an approval instead of executing, and (c) document the NL long-tail convention.

**CANONICAL shape Unit 1 ALREADY shipped (RECONCILED — use these exact names; do NOT re-declare them, this unit only adds array entries + the danger branch):**
- The registry lives in `apps/server/src/commands.ts` as `const COMMANDS: CommandEntry[]` where `export type CommandEntry = CommandDef & { run(ctx: CommandContext): Promise<ChatCommandResult> }`.
- `export interface CommandContext { args: string[]; arg: string; cwd: string; }` — `args` is the raw arg tokens, `arg` is them joined, `cwd` is the chat session's working dir. (Unit 1's `dispatchCommand` builds this ctx as `{ args: rest, arg: rest.join(' '), cwd }`; every `run` below destructures from it. NOTE: earlier drafts of this unit called these `ChatCommand`/`CommandCtx` and assumed ctx was `{ cwd }` only — those names are WRONG; the real names are `CommandEntry`/`CommandContext` and the ctx already carries `arg`/`args`, so no ctx extension is needed.)
- `CommandDef` and `ChatCommandResult` are imported from `@fleet/shared` (canonical Unit F types). `CommandDef.resultKind` may be `'text' | 'table' | 'error' | 'ack'`; `ChatCommandResult.kind` is only `'text' | 'table' | 'error'` (an `ack` command returns `kind:'text'`).
- `export async function dispatchCommand(line: string, cwd: string): Promise<ChatCommandResult>` parses the leading verb and finds the matching `COMMANDS` entry, then calls `entry.run(ctx)` **directly** — Unit 1 ships NO danger branch (its `commands.test.ts` asserts `/kill` executes immediately). **THIS unit (Task 2) owns adding the `danger:true` → `enqueueApproval()` branch to `dispatchCommand`**, before the `entry.run(ctx)` call.
- `export function listCommands(): CommandDef[]` maps `COMMANDS` to wire shape (omit `run`).

**Files:**
- Modify: `apps/server/src/inbox.ts` — add `enqueueApproval()` + an in-memory pending-approval queue merged into `getInboxItems()`.
- Modify: `apps/server/src/commands.ts` — add ~18 `CommandDef` entries + the danger→Inbox dispatch branch + a long-tail-convention doc comment.
- Test: `apps/server/test/fn-inbox-enqueue.test.ts` — the new enqueue queue.
- Test: `apps/server/test/cov-commands-registry.test.ts` — a safe verb (`/git status`), a danger verb routing to Inbox, and `listCommands()` shape/coverage.

Helper module read map (exact exported signatures the `run` functions call — all verified to exist):
- `registry` (`./registry.js`): `listRuns(): Run[]`, `launch(req): Run | Promise<Run>`, `resume(runId, prompt?, interactive?): Run`, `stop(runId, reason?): void`, `stopAll(): number`, `spend(): { todayUsd; activeRuns; totalRunsToday }`.
- `git` (`./git.js`): `statusPorcelain(root): Promise<{ entries: { code; path; origPath }[]; error? }>`, `gitLog(root, opts): Promise<{ entries: { hash; author; time; subject; isMerge }[]; error? }>`.
- `research` (`./research.js`): `searchWeb(opts): Promise<WebResult[]>` (opts has `searxngUrl`, `query`, …); `researchConfig()` from `./addons.js` supplies `searxngUrl`/`maxResults`/`engines`/`safeSearch`/`language`.
- `planboardRepo` (`./planboard.js`): `list(projectId): PlanDraft[]`. `kanbanRepo` (`./kanban.js`): `listTasks(projectId): KanbanTask[]`.
- `repo` (`./db.js`): `listTemplates(): AgentTemplate[]`.
- `listAddonInfos()` (`./addons.js`): `Promise<{ id; enabled; status }[]>`.

Verbs whose backing module keeps its data **private behind a Fastify route** (`/schedule`, `/memory`, `/releases`, `/search` history) follow the **existing `/schedule` convention**: the `run` returns a `kind:'text'` deep-link pointer to the page rather than re-reaching into a private helper. This keeps the plan honest and compiling without exporting new accessors from those modules.

---

### Task 1: Add a real Inbox enqueue queue (so danger verbs can park an approval)

The current `inbox.ts` only *derives* items from live runs awaiting permission/input — there is no way to *enqueue* a pending approval for a command. Add an in-memory queue + an `enqueueApproval()` and merge it into `getInboxItems()`. This is the mechanism every danger verb uses.

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/fn-inbox-enqueue.test.ts`:
  ```ts
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
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/server test fn-inbox-enqueue`
  Expected: fails — `inbox.enqueueApproval is not a function` (and `__clearApprovalsForTests` missing).
- [ ] **Step 3: Add the queue + types to `inbox.ts`.**
  In `apps/server/src/inbox.ts`, extend the `kind` union and add the `approval` field to `InboxItem`, then add the queue. Replace:
  ```ts
  export interface InboxItem {
    run: SlimRun;
    kind: 'permission' | 'input';
    request?: InboxPermissionRequest;
    lastText?: string;
  }
  ```
  with:
  ```ts
  /** A destructive slash-command parked for operator approval (it did NOT execute). */
  export interface CommandApproval {
    id: string;
    command: string;   // the verb, e.g. 'stop-all'
    summary: string;   // human-readable description of what will happen on approve
    cwd: string;
    createdAt: number;
  }

  export interface InboxItem {
    /** present for derived run items; omitted for parked command approvals. */
    run?: SlimRun;
    kind: 'permission' | 'input' | 'command';
    request?: InboxPermissionRequest;
    lastText?: string;
    /** present iff kind === 'command'. */
    approval?: CommandApproval;
  }
  ```
  Add the in-memory queue + API above `getInboxItems` (use `node:crypto`'s `randomUUID`, already a common import in this repo — add `import { randomUUID } from 'node:crypto';` at the top):
  ```ts
  // ── command-approval queue (destructive slash commands park here, see commands.ts) ──
  const pendingApprovals: CommandApproval[] = [];

  /** Park a destructive command for operator approval. Returns the approval id.
   *  The command does NOT execute here — approving it (existing inbox actions) does. */
  export function enqueueApproval(input: { command: string; summary: string; cwd: string }): string {
    const approval: CommandApproval = {
      id: randomUUID(),
      command: input.command,
      summary: input.summary,
      cwd: input.cwd,
      createdAt: Date.now(),
    };
    pendingApprovals.push(approval);
    return approval.id;
  }

  /** Test-only: reset the queue between cases. */
  export function __clearApprovalsForTests(): void {
    pendingApprovals.length = 0;
  }
  ```
  Then, at the **end** of `getInboxItems()` (just before `return items;`), merge the parked approvals in:
  ```ts
    for (const approval of pendingApprovals) {
      items.push({ kind: 'command', approval });
    }
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/server test fn-inbox-enqueue` → 2 passing.
- [ ] **Step 5: Typecheck (the existing `fn-inbox.test.ts` asserts `item.run` has props — confirm the optional `run` change didn't break it).**
  `pnpm --filter @fleet/server test fn-inbox` → still green (its items are all derived run items, so `run` is present).
  `pnpm --filter @fleet/server typecheck` → no type errors.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): add command-approval enqueue to the inbox queue"`

---

### Task 2: Add the danger→Inbox dispatch branch + helper to `commands.ts`

Before adding any danger verbs, make `dispatchCommand` route a `danger:true` verb to `enqueueApproval()` instead of calling its `run`. (Unit 1 ships dispatch WITHOUT this branch — it calls `entry.run(ctx)` directly — so this branch is wholly owned here; there is nothing to dedupe.)

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/cov-commands-registry.test.ts` with just the danger case first (the file grows in later tasks). Mock the inbox so we can assert the enqueue without a live run:
  ```ts
  /**
   * cov-commands-registry — the EXTENDED verb set: a safe verb renders a result, a danger
   * verb parks an Inbox approval (never executes), and listCommands() exposes the full set.
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  const enqueueSpy = vi.fn((_i: any) => 'appr-1');
  vi.mock('../src/inbox.js', () => ({ enqueueApproval: enqueueSpy }));

  // stopAll must NOT be called when /stop-all is danger-gated.
  const stopAllSpy = vi.fn(() => 3);
  vi.mock('../src/registry.js', () => ({
    registry: {
      listRuns: vi.fn(() => []),
      stopAll: stopAllSpy,
      stop: vi.fn(),
      launch: vi.fn(async () => ({ id: 'r1' })),
      resume: vi.fn(() => ({ id: 'r1' })),
      spend: vi.fn(() => ({ todayUsd: 1.5, activeRuns: 0, totalRunsToday: 4 })),
    },
  }));

  import { dispatchCommand, listCommands } from '../src/commands.js';

  beforeEach(() => { enqueueSpy.mockClear(); stopAllSpy.mockClear(); });

  describe('danger verbs route to the Inbox', () => {
    it('/stop-all parks an approval and does NOT execute', async () => {
      const r = await dispatchCommand('/stop-all', '/repo');
      expect(r.ok).toBe(true);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0][0]).toMatchObject({ command: 'stop-all', cwd: '/repo' });
      expect(stopAllSpy).not.toHaveBeenCalled();
      expect(String(r.text)).toMatch(/approv/i);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/server test cov-commands-registry`
  Expected: fails — either `/stop-all` is unknown, or it executes `stopAll` instead of enqueuing.
- [ ] **Step 3: Add the danger branch to `dispatchCommand` in `commands.ts`.**
  Add the import at the top of `apps/server/src/commands.ts`:
  ```ts
  import { enqueueApproval } from './inbox.js';
  ```
  In `dispatchCommand`, **after** the entry is found but **before** calling `entry.run(...)`, insert:
  ```ts
    if (entry.danger) {
      const id = enqueueApproval({ command: entry.name, summary: entry.description, cwd });
      return { ok: true, kind: 'text', text: `Queued “/${entry.name}” for approval (Inbox · ${id}). It will run once approved.` };
    }
  ```
  (If Unit 1's `dispatchCommand` still uses a `switch`, reconcile: it must be the array-driven form — look up `COMMANDS.find(c => c.name === name)`; this unit ASSUMES that shape. If it is not, that is a Unit-1 gap to flag, not a thing to re-refactor here.)
- [ ] **Step 4: Add the `/stop-all` CommandDef** so the test's verb exists (full entry — the other danger verbs come in Task 6). In the `COMMANDS` array add:
  ```ts
  {
    name: 'stop-all',
    group: 'control',
    description: 'Stop every running agent in the fleet',
    usage: '/stop-all',
    args: [],
    resultKind: 'ack',
    danger: true,
    async run() {
      // never reached while danger:true (dispatchCommand parks it); kept for when an
      // approved action replays the command. Returns a text ack of the count stopped.
      const n = registry.stopAll();
      return { ok: true, kind: 'text', text: `stopped ${n} run(s)` };
    },
  },
  ```
- [ ] **Step 5: Run it, watch it pass.**
  `pnpm --filter @fleet/server test cov-commands-registry` → 1 passing.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(server): route danger slash-verbs through the Inbox approval queue"`

---

### Task 3: Add the safe control + read verbs that map to `registry` (`/launch /resume /sessions /stop /agents /spend`)

These dispatch straight to existing `registry` methods. `/agents` and `/sessions` are tables; `/spend` is a one-line text; `/launch`/`/resume` start runs; `/stop` is a single-run control. (`/stop` is **not** danger — stopping one named run mirrors the already-shipped `/kill` and is reversible via resume; only `/stop-all` is danger.)

- [ ] **Step 1: Write the failing test** — append to `apps/server/test/cov-commands-registry.test.ts` inside a new `describe`:
  ```ts
  describe('safe registry verbs', () => {
    it('/agents returns a table of non-terminal runs', async () => {
      const r = await dispatchCommand('/agents', '/repo');
      expect(r.kind).toBe('table');
      expect(r.columns).toEqual(['id', 'status', 'model', 'task']);
    });
    it('/spend returns a text line with today’s spend', async () => {
      const r = await dispatchCommand('/spend', '/repo');
      expect(r.kind).toBe('text');
      expect(String(r.text)).toMatch(/\$1\.50/);
      expect(String(r.text)).toMatch(/4 run/);
    });
    it('/launch with no prompt errors', async () => {
      const r = await dispatchCommand('/launch', '/repo');
      expect(r.ok).toBe(false);
      expect(r.kind).toBe('error');
    });
    it('/launch <prompt> starts a run and returns its id', async () => {
      const r = await dispatchCommand('/launch fix the build', '/work');
      expect(r.ok).toBe(true);
      expect(r.runId).toBe('r1');
    });
    it('/stop <id> stops a single run', async () => {
      const r = await dispatchCommand('/stop r1', '/repo');
      expect(r.ok).toBe(true);
    });
    it('/stop with no id errors', async () => {
      const r = await dispatchCommand('/stop', '/repo');
      expect(r.ok).toBe(false);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/server test cov-commands-registry` → new cases fail (verbs unknown).
- [ ] **Step 3: Add the CommandDefs** to the `COMMANDS` array in `commands.ts`. The existing file has `ok`/`err` helpers and a `TERMINAL` set — reuse them (do not redefine).
  ```ts
  {
    name: 'launch',
    group: 'control',
    description: 'Launch an agent in the chat working directory',
    usage: '/launch <prompt>',
    args: [{ name: 'prompt', required: true, type: 'prompt', hint: 'what the agent should do' }],
    resultKind: 'text',
    async run({ cwd }) {
      // the parsed arg string is passed by dispatchCommand; reuse the existing arg-extraction.
      return launchRun(cwd);
    },
  },
  ```
  The verb's free-text argument arrives via the ctx. Unit 1's `CommandContext` ALREADY carries the parsed remainder — `{ args: string[]; arg: string; cwd: string }`, built by `dispatchCommand` as `const ctx = { args: rest, arg: rest.join(' '), cwd }` — so no ctx extension is needed; just destructure `arg`/`args` in each `run`. (Unit 1's dispatch already ends with `return cmd.run(ctx)`; Task 2 above inserts the danger branch immediately before that call.)

  Then the verbs (full code; `CommandContext = { args; arg; cwd }`):
  ```ts
  {
    name: 'launch',
    group: 'control',
    description: 'Launch an agent in the chat working directory',
    usage: '/launch <prompt>',
    args: [{ name: 'prompt', required: true, type: 'prompt', hint: 'what the agent should do' }],
    resultKind: 'text',
    async run({ cwd, arg }) {
      if (!arg) return err('usage: /launch <prompt>');
      try {
        const run = await registry.launch({ prompt: arg, cwd, model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default' });
        return ok(`launched run ${run.id}`, { runId: run.id });
      } catch (e: any) { return err(e?.message ?? 'launch failed'); }
    },
  },
  {
    name: 'resume',
    group: 'control',
    description: 'Resume a finished run with an optional follow-up prompt',
    usage: '/resume <run-id> [prompt]',
    args: [
      { name: 'run-id', required: true, type: 'run-id', hint: 'a finished run' },
      { name: 'prompt', required: false, type: 'prompt' },
    ],
    resultKind: 'text',
    async run({ args }) {
      const [id, ...rest] = args;
      if (!id) return err('usage: /resume <run-id> [prompt]');
      try { const run = registry.resume(id, rest.join(' ') || undefined); return ok(`resumed run ${run.id}`, { runId: run.id }); }
      catch (e: any) { return err(e?.message ?? 'resume failed'); }
    },
  },
  {
    name: 'sessions',
    group: 'control',
    description: 'List active runs (sessions) in the fleet',
    usage: '/sessions',
    args: [],
    resultKind: 'table',
    async run() {
      const runs = (registry.listRuns() as any[]).filter((r) => !TERMINAL.has(r.status));
      return { ok: true, kind: 'table', columns: ['id', 'status', 'model', 'task'],
        rows: runs.map((r) => [r.id, r.status, r.model, String(r.task ?? '').slice(0, 60)]) };
    },
  },
  {
    name: 'agents',
    group: 'control',
    description: 'List running agents',
    usage: '/agents',
    args: [],
    resultKind: 'table',
    async run() {
      const runs = (registry.listRuns() as any[]).filter((r) => !TERMINAL.has(r.status));
      return { ok: true, kind: 'table', columns: ['id', 'status', 'model', 'task'],
        rows: runs.map((r) => [r.id, r.status, r.model, String(r.task ?? '').slice(0, 60)]) };
    },
  },
  {
    name: 'stop',
    group: 'control',
    description: 'Stop one run by id',
    usage: '/stop <run-id>',
    args: [{ name: 'run-id', required: true, type: 'run-id', source: 'running-runs' }],
    resultKind: 'ack',
    async run({ arg }) {
      if (!arg) return err('usage: /stop <run-id>');
      try { registry.stop(arg); return ok(`stopped ${arg}`); }
      catch (e: any) { return err(e?.message ?? 'stop failed'); }
    },
  },
  {
    name: 'spend',
    group: 'control',
    description: 'Today’s spend + active-run count',
    usage: '/spend',
    args: [],
    resultKind: 'text',
    async run() {
      const s = registry.spend();
      return ok(`Today: $${s.todayUsd.toFixed(2)} · ${s.activeRuns} active · ${s.totalRunsToday} run(s) today`);
    },
  },
  ```
  (`/sessions` and `/agents` intentionally share output — `/sessions` is the chat-native name in the spec's verb list, `/agents` is the existing alias. Both are kept so `listCommands()` reports the full set.)
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/server test cov-commands-registry` → safe-registry cases green.
- [ ] **Step 5: Typecheck.** `pnpm --filter @fleet/server typecheck`.
- [ ] **Step 6: Commit.** `git commit -am "feat(server): add launch/resume/sessions/stop/agents/spend slash-verbs"`

---

### Task 4: Add `/git` (the representative safe verb that renders a table)

`/git status` → table of working-tree changes; `/git log` → table of recent commits. Dispatches to the existing `git.ts` helpers. This is the unit's primary "safe verb → table" test target.

- [ ] **Step 1: Write the failing test** — append a `describe` to `cov-commands-registry.test.ts`. Mock `git.js` so no real repo is needed:
  ```ts
  vi.mock('../src/git.js', () => ({
    statusPorcelain: vi.fn(async () => ({ entries: [
      { code: ' M', path: 'src/a.ts', origPath: null },
      { code: '??', path: 'new.ts', origPath: null },
    ] })),
    gitLog: vi.fn(async () => ({ entries: [
      { hash: 'abc1234def', author: 'jd', time: 1700000000, subject: 'fix thing', isMerge: false },
    ] })),
  }));
  ```
  (Place this `vi.mock` with the other mocks at the top of the file, not inside `describe`.) Then:
  ```ts
  describe('/git', () => {
    it('/git status renders a 2-column change table', async () => {
      const r = await dispatchCommand('/git status', '/repo');
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('table');
      expect(r.columns).toEqual(['status', 'path']);
      expect(r.rows).toEqual([[' M', 'src/a.ts'], ['??', 'new.ts']]);
    });
    it('/git log renders a commit table', async () => {
      const r = await dispatchCommand('/git log', '/repo');
      expect(r.kind).toBe('table');
      expect(r.columns).toEqual(['hash', 'subject', 'author']);
      expect(r.rows![0][0]).toBe('abc1234');
    });
    it('/git with no subcommand errors', async () => {
      const r = await dispatchCommand('/git', '/repo');
      expect(r.ok).toBe(false);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/server test cov-commands-registry` → `/git` cases fail.
- [ ] **Step 3: Implement.** Add the import to `commands.ts`:
  ```ts
  import { statusPorcelain, gitLog } from './git.js';
  ```
  Add the CommandDef:
  ```ts
  {
    name: 'git',
    group: 'project',
    description: 'Git status / log for the chat working directory',
    usage: '/git status | /git log',
    args: [{ name: 'subcommand', required: true, type: 'enum', enum: ['status', 'log'] }],
    resultKind: 'table',
    async run({ cwd, args }) {
      const sub = args[0];
      if (sub === 'status') {
        const { entries, error } = await statusPorcelain(cwd);
        if (error) return err(error);
        return { ok: true, kind: 'table', columns: ['status', 'path'],
          rows: entries.map((e) => [e.code, e.path]) };
      }
      if (sub === 'log') {
        const { entries, error } = await gitLog(cwd, { max: 20 });
        if (error) return err(error);
        return { ok: true, kind: 'table', columns: ['hash', 'subject', 'author'],
          rows: entries.map((c) => [c.hash.slice(0, 7), c.subject, c.author]) };
      }
      return err('usage: /git status | /git log');
    },
  },
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/server test cov-commands-registry` → `/git` cases green.
- [ ] **Step 5: Commit.** `git commit -am "feat(server): add /git status|log slash-verb (safe table)"`

---

### Task 5: Add the remaining read/project verbs (`/research /search /files /board /task /template /memory /schedule /releases /addons /help`)

`/research` and `/addons` reach real exported helpers; `/board` and `/task` reach `planboardRepo`/`kanbanRepo` (require a project id arg); `/template` reaches `repo.listTemplates()`; `/search`, `/files`, `/memory`, `/schedule`, `/releases` follow the **page-pointer convention** (their data lives behind a Fastify route, not an exported accessor — pointing at the page matches the already-shipped `/schedule` behavior and avoids exporting new private internals). `/help` renders from the registry itself.

- [ ] **Step 1: Write the failing test** — append to `cov-commands-registry.test.ts`. Add these mocks at the top with the others:
  ```ts
  vi.mock('../src/research.js', () => ({ searchWeb: vi.fn(async () => [{ title: 'T', url: 'https://x', content: 'c' }]) }));
  vi.mock('../src/addons.js', () => ({
    researchConfig: vi.fn(() => ({ searxngUrl: 'http://s', maxResults: 5, engines: '', safeSearch: 1, language: 'en' })),
    listAddonInfos: vi.fn(async () => [{ id: 'searxng', enabled: true, status: 'running' }]),
  }));
  vi.mock('../src/planboard.js', () => ({ planboardRepo: { list: vi.fn(() => [{ id: 'd1', status: 'ready', tasks: [1, 2] }]) } }));
  vi.mock('../src/kanban.js', () => ({ kanbanRepo: { listTasks: vi.fn(() => [{ id: 'k1', column: 'Backlog', title: 'do x' }]) } }));
  vi.mock('../src/db.js', () => ({ repo: { listTemplates: vi.fn(() => [{ id: 't1', name: 'orchestrator', role: 'orchestrator' }]) } }));
  ```
  Then:
  ```ts
  describe('read + project verbs', () => {
    it('/research <topic> returns a results table', async () => {
      const r = await dispatchCommand('/research vector dbs', '/repo');
      expect(r.kind).toBe('table');
      expect(r.columns).toEqual(['title', 'url']);
    });
    it('/research with no topic errors', async () => {
      expect((await dispatchCommand('/research', '/repo')).ok).toBe(false);
    });
    it('/addons lists add-ons', async () => {
      const r = await dispatchCommand('/addons', '/repo');
      expect(r.kind).toBe('table');
      expect(r.columns).toEqual(['id', 'enabled', 'status']);
    });
    it('/board <projectId> lists plan drafts', async () => {
      const r = await dispatchCommand('/board p1', '/repo');
      expect(r.kind).toBe('table');
    });
    it('/board with no project errors', async () => {
      expect((await dispatchCommand('/board', '/repo')).ok).toBe(false);
    });
    it('/task <projectId> lists kanban tasks', async () => {
      const r = await dispatchCommand('/task p1', '/repo');
      expect(r.kind).toBe('table');
    });
    it('/template lists templates', async () => {
      const r = await dispatchCommand('/template', '/repo');
      expect(r.kind).toBe('table');
      expect(r.columns).toEqual(['id', 'name', 'role']);
    });
    it('/files points at the workspace picker (text)', async () => {
      expect((await dispatchCommand('/files', '/repo')).kind).toBe('text');
    });
    it('/search points at the search page (text)', async () => {
      expect((await dispatchCommand('/search foo', '/repo')).kind).toBe('text');
    });
    it('/memory points at the memory page (text)', async () => {
      expect((await dispatchCommand('/memory', '/repo')).kind).toBe('text');
    });
    it('/schedule points at the schedules page (text)', async () => {
      expect((await dispatchCommand('/schedule', '/repo')).kind).toBe('text');
    });
    it('/releases points at the releases page (text)', async () => {
      expect((await dispatchCommand('/releases', '/repo')).kind).toBe('text');
    });
    it('/help lists the registry verbs', async () => {
      const r = await dispatchCommand('/help', '/repo');
      expect(r.kind).toBe('text');
      expect(String(r.text)).toMatch(/\/launch/);
      expect(String(r.text)).toMatch(/\/git/);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/server test cov-commands-registry`.
- [ ] **Step 3: Implement.** Add imports to `commands.ts`:
  ```ts
  import { searchWeb } from './research.js';
  import { researchConfig, listAddonInfos } from './addons.js';
  import { planboardRepo } from './planboard.js';
  import { kanbanRepo } from './kanban.js';
  import { repo } from './db.js';
  ```
  (Note: `listAddonInfos` may already be imported by Unit 1's existing `/addons` carry-over — if so, do not double-import; reuse it.) Add the CommandDefs:
  ```ts
  {
    name: 'research',
    group: 'knowledge',
    description: 'Web search via the Web Research add-on (SearXNG)',
    usage: '/research <topic>',
    args: [{ name: 'topic', required: true, type: 'string' }],
    resultKind: 'table',
    async run({ arg }) {
      if (!arg) return err('usage: /research <topic>');
      try {
        const cfg = researchConfig();
        const results = await searchWeb({ searxngUrl: cfg.searxngUrl, query: arg, maxResults: cfg.maxResults, engines: cfg.engines, safeSearch: cfg.safeSearch, language: cfg.language });
        return { ok: true, kind: 'table', columns: ['title', 'url'], rows: results.map((w: any) => [String(w.title ?? '').slice(0, 80), String(w.url ?? '')]) };
      } catch (e: any) { return err(e?.message ?? 'research failed'); }
    },
  },
  {
    name: 'search',
    group: 'knowledge',
    description: 'Full-text search across run events',
    usage: '/search <query>',
    args: [{ name: 'query', required: true, type: 'string' }],
    resultKind: 'text',
    async run({ arg }) {
      if (!arg) return err('usage: /search <query>');
      return ok(`Open the Search page to query “${arg}” across run history: /search?q=${encodeURIComponent(arg)}`);
    },
  },
  {
    name: 'files',
    group: 'project',
    description: 'Browse the chat workspace files',
    usage: '/files',
    args: [],
    resultKind: 'text',
    async run({ cwd }) { return ok(`Use @ to mention files, or open the file browser for ${cwd}.`); },
  },
  {
    name: 'board',
    group: 'project',
    description: 'List plan drafts for a project',
    usage: '/board <projectId>',
    args: [{ name: 'projectId', required: true, type: 'project' }],
    resultKind: 'table',
    async run({ arg }) {
      if (!arg) return err('usage: /board <projectId>');
      const drafts = planboardRepo.list(arg) as any[];
      return { ok: true, kind: 'table', columns: ['id', 'status', 'tasks'], rows: drafts.map((d) => [d.id, String(d.status ?? ''), String(d.tasks?.length ?? 0)]) };
    },
  },
  {
    name: 'task',
    group: 'project',
    description: 'List kanban tasks for a project',
    usage: '/task <projectId>',
    args: [{ name: 'projectId', required: true, type: 'project' }],
    resultKind: 'table',
    async run({ arg }) {
      if (!arg) return err('usage: /task <projectId>');
      const tasks = kanbanRepo.listTasks(arg) as any[];
      return { ok: true, kind: 'table', columns: ['id', 'column', 'title'], rows: tasks.map((t) => [t.id, t.column, String(t.title ?? '').slice(0, 60)]) };
    },
  },
  {
    name: 'schedule',
    group: 'config',
    description: 'Open the Schedules page',
    usage: '/schedule',
    args: [],
    resultKind: 'text',
    async run() { return ok('Open the Schedules page to create or manage schedules: /schedules'); },
  },
  {
    name: 'template',
    group: 'config',
    description: 'List agent templates',
    usage: '/template',
    args: [],
    resultKind: 'table',
    async run() {
      const tpls = repo.listTemplates() as any[];
      return { ok: true, kind: 'table', columns: ['id', 'name', 'role'], rows: tpls.map((t) => [t.id, t.name, t.role]) };
    },
  },
  {
    name: 'memory',
    group: 'knowledge',
    description: 'Fleet memory status + config',
    usage: '/memory',
    args: [],
    resultKind: 'text',
    async run() { return ok('Open the Memory page to view stats or configure the fleet-memory dir: /memory'); },
  },
  {
    name: 'addons',
    group: 'config',
    description: 'List add-ons and their status',
    usage: '/addons',
    args: [],
    resultKind: 'table',
    async run() {
      const infos = await listAddonInfos();
      return { ok: true, kind: 'table', columns: ['id', 'enabled', 'status'], rows: infos.map((a) => [a.id, String(a.enabled), a.status]) };
    },
  },
  {
    name: 'releases',
    group: 'meta',
    description: 'Portal version + available updates',
    usage: '/releases',
    args: [],
    resultKind: 'text',
    async run() { return ok('Open the Releases page for the current version and available updates: /releases'); },
  },
  {
    name: 'help',
    group: 'meta',
    description: 'List the available slash commands',
    usage: '/help',
    args: [],
    resultKind: 'text',
    async run() {
      const lines = COMMANDS
        .filter((c) => c.name !== 'help')
        .map((c) => `/${c.name} — ${c.description}`);
      return ok(['/help — this list', ...lines].join('\n'));
    },
  },
  ```
  (`/help` reads the `COMMANDS` array it lives in — declare `COMMANDS` with `const` before any `run` references it at call time; the closure runs after module init, so the forward reference is fine. If Unit 1 named the array differently, use that name.)
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/server test cov-commands-registry` → all read/project cases green.
- [ ] **Step 5: Commit.** `git commit -am "feat(server): add research/search/files/board/task/template/memory/schedule/addons/releases/help verbs"`

---

### Task 6: Add the remaining danger verbs + assert `listCommands()` covers the full ~18 set

`/stop-all` (Task 2) is the first danger verb. The spec's NL long-tail mutations — *delete project, reset-data, self-update, file-commit* — are the other destructive actions; expose `/reset-data` and `/self-update` as explicit danger verbs so the curated set has a coherent destructive surface, all gated identically. Then lock the full-set coverage.

- [ ] **Step 1: Write the failing test** — append to `cov-commands-registry.test.ts`:
  ```ts
  describe('full registry coverage', () => {
    const EXPECTED = [
      'launch','resume','sessions','stop','stop-all','agents','research','search','git','files',
      'board','task','schedule','template','memory','spend','addons','releases','help',
      'reset-data','self-update',
    ];
    it('listCommands() exposes every curated verb and strips run()', () => {
      const cmds = listCommands();
      const names = cmds.map((c) => c.name);
      for (const v of EXPECTED) expect(names).toContain(v);
      expect(names.length).toBeGreaterThanOrEqual(18);
      for (const c of cmds) expect((c as any).run).toBeUndefined();
    });
    it('every danger verb carries danger:true and resultKind ack', () => {
      const cmds = listCommands();
      for (const name of ['stop-all', 'reset-data', 'self-update']) {
        const c = cmds.find((x) => x.name === name)!;
        expect(c.danger).toBe(true);
        expect(c.resultKind).toBe('ack');
      }
    });
    it('/reset-data and /self-update both park approvals (never execute)', async () => {
      enqueueSpy.mockClear();
      await dispatchCommand('/reset-data', '/repo');
      await dispatchCommand('/self-update', '/repo');
      expect(enqueueSpy).toHaveBeenCalledTimes(2);
      expect(enqueueSpy.mock.calls.map((c) => c[0].command)).toEqual(['reset-data', 'self-update']);
    });
  });
  ```
- [ ] **Step 2: Run it, watch it fail.**
  `pnpm --filter @fleet/server test cov-commands-registry`.
- [ ] **Step 3: Implement.** Add the two danger CommandDefs to `COMMANDS` (their `run` is a stub that is never reached while `danger:true`, but is real/compiling so an approved replay path can call it later — it returns a text pointer rather than wiring destructive internals this unit doesn't own):
  ```ts
  {
    name: 'reset-data',
    group: 'config',
    description: 'Wipe all portal runs/history and reset config (destructive)',
    usage: '/reset-data',
    args: [],
    resultKind: 'ack',
    danger: true,
    async run() {
      return ok('Confirm the destructive reset from the Settings → Danger Zone page.');
    },
  },
  {
    name: 'self-update',
    group: 'meta',
    description: 'Pull and apply the latest portal release (destructive)',
    usage: '/self-update',
    args: [],
    resultKind: 'ack',
    danger: true,
    async run() {
      return ok('Confirm the self-update from the Releases page.');
    },
  },
  ```
- [ ] **Step 4: Run it, watch it pass.**
  `pnpm --filter @fleet/server test cov-commands-registry` → full-set cases green. Then run the whole file plus the inbox + legacy commands tests to confirm nothing regressed:
  `pnpm --filter @fleet/server test cov-commands-registry fn-inbox-enqueue fn-inbox cov-commands`
- [ ] **Step 5: Typecheck.** `pnpm --filter @fleet/server typecheck` → clean.
- [ ] **Step 6: Commit.** `git commit -am "feat(server): add reset-data/self-update danger verbs + lock full registry coverage"`

---

### Task 7: Document the NL long-tail convention (agent-as-tools + Inbox-gated mutations)

A non-test documentation task: record, in code where future authors see it, the convention that the ~100 routes NOT in the curated set are reached by the chat agent as natural-language tool-calls, and that any mutation among them is gated by the same Inbox approval queue (preserving DC D-031). No new behavior — a single authoritative doc block.

- [ ] **Step 1: Add the doc block** at the top of `apps/server/src/commands.ts`, immediately below the existing file header comment:
  ```ts
  /**
   * NL LONG-TAIL CONVENTION (spec §5.2 / D-036)
   * ------------------------------------------------------------------------------
   * The curated CommandDef[] below is the TYPED, autocomplete-backed verb set (~18).
   * Every OTHER portal capability (~100 routes) is intentionally NOT a slash verb:
   * the chat agent invokes those routes as natural-language tool-calls at runtime.
   *
   * MUTATION GATING — the invariant that keeps this safe:
   *   • A read (GET-shaped) long-tail call may run directly.
   *   • A MUTATION long-tail call (delete project, reset-data, self-update, file-commit,
   *     …) MUST route through the SAME Inbox approval queue these danger verbs use —
   *     i.e. it parks an approval via inbox.enqueueApproval() and only executes once an
   *     operator approves it. No mutation gets a new privileged surface (preserves DC D-031).
   *
   * So: a slash verb with danger:true and a long-tail mutation are two doors into ONE
   * approval queue. New destructive capability ⇒ add danger:true here OR enqueueApproval()
   * at the call site; never a direct unapproved mutation from chat.
   * ------------------------------------------------------------------------------
   */
  ```
- [ ] **Step 2: Verify the doc references real symbols** (no dangling names): `enqueueApproval` is exported from `inbox.ts` (Task 1), `danger` is a `CommandDef` field, `COMMANDS` is the registry array. Build to confirm the comment didn't break parsing:
  `pnpm --filter @fleet/server typecheck` → clean.
- [ ] **Step 3: Commit.** `git commit -am "docs(server): document the NL long-tail + Inbox-gated-mutation convention"`

---

## Unit 6 — Engine (codex/opencode) degradation + final test/polish pass (Phase 6)

This unit completes Phase 6 of the chat-surface upgrade (spec §14.6, §3 D8, §12, §13). It makes engine (codex/opencode) sessions degrade **honestly**: the live-only controls (Kill / Resume) are hidden or disabled, the session is badged **"one-shot · limited memory"**, and "resume" is emulated by re-launching the engine with the reconstructed `buildEnginePrompt` transcript (which `startTurn` already does for every engine turn). It then locks down the cross-cutting test/typecheck/QA pass and records decisions D-033…D-041.

**Context the implementer must know (this codebase's domain):**
- An "engine" session is one whose `session.engine !== 'claude'` (`'codex' | 'opencode'`). Engines are one-shot per turn: they cannot take stdin and cannot `--resume`. `apps/server/src/registry.ts` `resume()` (line ~1080) throws **HTTP 409** with `code: 'engine-unsupported'` for any run whose `engine` is not `'claude'`.
- `apps/server/src/chat.ts` already routes engine turns through `registry.launchEngine({ ...opts, engine, prompt })` where `prompt` is built by `buildEnginePrompt(history, message)` — i.e. **every** engine turn is already an emulated-resume one-shot. Engine sessions therefore never call `registry.resume()` and never hold a live process, so there is nothing for a Kill button to kill and nothing for a Resume button to resume.
- The canonical derived session lifecycle type is `ChatSessionState = 'live' | 'running' | 'idle' | 'killed'` and `ChatSession` carries optional derived `state?` / `live?` fields (added by Unit F in `packages/shared/src/index.ts`). Engine sessions are **never** `'live'` (spec §3.2) — `live` is always `false`/absent for them.
- HUD design system (from `apps/web/components/ui.tsx`): `Badge({ label, color })` is the canonical pill; amber is `#ffb000`; `Btn({ variant, disabled, title })` is the canonical button. Match these — do not hand-roll.
- Test conventions: server tests live in `apps/server/test/` named `fn-*.test.ts` (focused function/route tests) or `cov-*.test.ts` (broad coverage); web tests live in `apps/web/test/` named `fn-*.test.ts`. The runner is **vitest** (confirmed via `apps/server/vitest.config.ts` and `apps/web/vitest.config.ts`; web uses jsdom + `@testing-library/react`, setup in `apps/web/test/setup.ts`). Vitest does **not** typecheck — frames/props may be cast `as any` and asserted against the contract.
- Run commands: server tests `pnpm --filter @fleet/server test <file>`; web tests `pnpm --filter @fleet/web test <file>`; typecheck/build `pnpm --filter @fleet/server typecheck` and `pnpm --filter @fleet/web typecheck`.

**Files:**
- Create: `apps/server/test/fn-chat-engine-resume.test.ts` (server: engine still 409s on resume; chat layer falls back to emulated one-shot)
- Create: `apps/web/test/fn-chatsessionlist-engine.test.ts` (web: engine row hides/disables Kill+Resume and shows the one-shot badge)
- Modify: `apps/web/components/ChatSessionList.tsx` (per-row Kill/Resume controls gated on engine; engine badge)
- Modify: `apps/web/components/ChatComposer.tsx` (Stop button gated off for engine sessions)
- Modify: `apps/server/src/chat.ts` (only if Step verifies a gap — engine sessions must report `state` honest + never `live:true`; see Task 2)
- Modify: `DC.md` (append decisions; supersede PRD §11 line)
- Modify: `PRD-Claude-Fleet-Portal.md` (mark §11 abort/resume line superseded)

> **IMPORTANT — decision-numbering collision (reconcile with assembler):** Spec §15 names the new decisions **D-033…D-041**, but `DC.md` **already contains** a different D-033 ("Hybrid registry, writes delegated by source", line 1165) and D-034 ("env loads before config", line 1171) from the settings-env work. The chat-spec decision numbers therefore collide. Task 7 below renumbers the chat decisions to **D-035…D-043** (the next free block) and keeps the spec's *titles/content* verbatim, with a one-line note mapping spec-§15 D-033→DC D-035, …, D-041→DC D-043. If the assembler has already reserved a different block for another unit, it must re-reconcile; the content is what matters, not the literal numbers.

---

### Task 1: Server test — `resume()` still 409s for an engine run, and `startTurn` never calls `resume()` for an engine session (it falls back to emulated one-shot)

This proves the load-bearing degradation invariant: even though the chat UX presents "resume" uniformly, an engine session never reaches `registry.resume()` (which would 409) — it always re-launches via `launchEngine` with the reconstructed transcript.

- [ ] **Step 1: Write the failing test.**
  Create `apps/server/test/fn-chat-engine-resume.test.ts`:

  ```ts
  /**
   * Engine degradation invariant (spec §3 D8, §12): an engine (codex/opencode) chat session
   * presents a uniform "resume" UX but is honestly one-shot. This test pins two facts:
   *   1. registry.resume() STILL rejects an engine run with HTTP 409 (code 'engine-unsupported').
   *   2. chat.startTurn() NEVER calls registry.resume() for an engine session — every turn
   *      re-launches via registry.launchEngine() with the reconstructed buildEnginePrompt
   *      transcript (emulated resume), so the 409 path is unreachable from chat.
   */
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-engine-'));

  vi.mock('../src/registry.js', () => ({
    registry: {
      launch: vi.fn(async (req: any) => ({ id: 'run-launch', sessionId: 's', status: 'running', ...req })),
      resume: vi.fn(async () => { throw Object.assign(new Error('Resume is not supported on engine add-on runs.'), { statusCode: 409, code: 'engine-unsupported' }); }),
      launchEngine: vi.fn(async (req: any) => ({ id: 'run-engine', sessionId: 's', status: 'running', ...req })),
    },
  }));

  describe('engine chat resume degradation', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('re-launches via launchEngine every turn and never calls registry.resume() for an engine session', async () => {
      const { registry } = await import('../src/registry.js');
      const { chatRepo, startTurn } = await import('../src/chat.js');
      const s = chatRepo.createSession({ cwd: '/tmp/eng', engine: 'codex', model: 'gpt-5-codex' });

      // Turn 1
      const t1 = await startTurn(s.id, 'first engine turn');
      expect(t1.runId).toBe('run-engine');
      expect((registry.launchEngine as any)).toHaveBeenCalledTimes(1);
      expect((registry.resume as any)).not.toHaveBeenCalled();

      // Turn 2 — even though a runId is now stored, it must NOT resume; it re-launches.
      const t2 = await startTurn(s.id, 'second engine turn');
      expect(t2.runId).toBe('run-engine');
      expect((registry.launchEngine as any)).toHaveBeenCalledTimes(2);
      expect((registry.resume as any)).not.toHaveBeenCalled();

      // The emulated-resume prompt of turn 2 carries the reconstructed transcript prefix.
      const turn2Arg = (registry.launchEngine as any).mock.calls.at(-1)[0];
      expect(turn2Arg.engine).toBe('codex');
      expect(turn2Arg.prompt).toContain('first engine turn');   // prior turn reconstructed
      expect(turn2Arg.prompt).toContain('second engine turn');  // current message
    });

    it('registry.resume() still rejects an engine run with 409 engine-unsupported (the path chat avoids)', async () => {
      const { registry } = await import('../src/registry.js');
      await expect((registry.resume as any)('any-engine-run')).rejects.toMatchObject({ statusCode: 409, code: 'engine-unsupported' });
    });
  });
  ```

- [ ] **Step 2: Run it, see it pass immediately.**
  `pnpm --filter @fleet/server test fn-chat-engine-resume.test.ts`
  Expected: `Test Files  1 passed (1)` / `Tests  2 passed (2)`.
  This is a **characterization test** — `chat.ts` already routes engines through `launchEngine` (line ~133-136), so it passes against current code. It exists to lock the invariant so a future refactor of `startTurn` cannot silently start calling `resume()` for engines (which would 409 at runtime).

- [ ] **Step 3: Prove the test has teeth (red check, then revert).**
  Temporarily edit `apps/server/src/chat.ts` `startTurn`: change the engine branch guard `if (session.engine && session.engine !== 'claude')` to `if (false)` so engine turns fall through to `registry.resume`. Re-run the test; confirm it now FAILS on `registry.resume() ... not.toHaveBeenCalled()`. Revert the edit. Re-run; confirm green again.

- [ ] **Step 4: Commit.**
  ```
  git add apps/server/test/fn-chat-engine-resume.test.ts
  git commit -m "test(chat): pin engine session emulated-resume (never calls registry.resume, 409 unreachable)"
  ```

---

### Task 2: Server — guarantee engine sessions report an honest derived `state` and are never `live:true`

The session-read derives `state`/`live` (Unit 4's live manager + Unit 1's route own the wiring). This task adds a **defensive unit test** that whatever derivation runs, an engine session can never be reported `live:true` (spec §3.2: "Engines (codex/opencode) never go live"). If the derivation is already engine-safe, this is a characterization test; if not, it forces a one-line guard.

- [ ] **Step 1: Locate the session-state derivation.**
  ```
  grep -rn "live:" apps/server/src/chat.ts apps/server/src/chatLive.ts 2>/dev/null
  grep -rn "ChatSessionState\|deriveState\|sessionState\|\.live" apps/server/src/chat.ts apps/server/src/chatLive.ts 2>/dev/null
  ```
  Identify the exported function that computes `{ state, live }` for a session read (added by Unit 1/4). Call it `deriveSessionState(session)` below — **substitute the real exported name** you find. If no such helper is exported yet (Unit 1/4 inlined it in the route handler), extract the engine guard into a tiny pure exported helper in `chat.ts` so it is unit-testable:

  ```ts
  /** Engines (codex/opencode) never hold a live process (spec §3.2 D8). Force live:false and
   *  collapse 'live'/'running' down to a one-shot-honest state for engine sessions. */
  export function engineSafeState(engine: string, derived: { state?: import('@fleet/shared').ChatSessionState; live?: boolean }):
    { state?: import('@fleet/shared').ChatSessionState; live?: boolean } {
    if (engine === 'claude') return derived;
    const state = derived.state === 'live' ? 'idle' : derived.state;
    return { state, live: false };
  }
  ```
  Then apply it where the route builds the session read: `const safe = engineSafeState(session.engine, { state, live });` and serialize `{ ...session, ...safe }`.

- [ ] **Step 2: Write the failing test** (append to `apps/server/test/fn-chat-engine-resume.test.ts`):

  ```ts
  describe('engineSafeState — engines never go live', () => {
    it('forces live:false and demotes a "live" derived state to idle for engines', async () => {
      const { engineSafeState } = await import('../src/chat.js');
      expect(engineSafeState('codex', { state: 'live', live: true })).toEqual({ state: 'idle', live: false });
      expect(engineSafeState('opencode', { state: 'running', live: true })).toEqual({ state: 'running', live: false });
    });
    it('passes claude session state through untouched', async () => {
      const { engineSafeState } = await import('../src/chat.js');
      expect(engineSafeState('claude', { state: 'live', live: true })).toEqual({ state: 'live', live: true });
    });
  });
  ```

- [ ] **Step 3: Run it.**
  `pnpm --filter @fleet/server test fn-chat-engine-resume.test.ts`
  If `engineSafeState` did not exist, the test fails (import undefined) → add the helper from Step 1 → re-run → green. Expected final: `Tests  4 passed (4)`.

- [ ] **Step 4: Wire it into the route + typecheck.**
  Ensure the `GET /api/chat/sessions/:id` handler (and the session-list/`session_state` SSE envelope if it carries `live`) applies `engineSafeState`. Then:
  `pnpm --filter @fleet/server typecheck`
  Expected: no TypeScript errors.

- [ ] **Step 5: Commit.**
  ```
  git add apps/server/src/chat.ts apps/server/test/fn-chat-engine-resume.test.ts
  git commit -m "fix(chat): engine sessions never report live:true; demote 'live' state to idle"
  ```

---

### Task 3: Web test — engine session rows hide/disable Kill+Resume and show the "one-shot · limited memory" badge

`ChatSessionList.tsx` is where per-row controls are badged/hidden (spec §8, §12). This is the first **component render** test in `apps/web/test/` — `@testing-library/react` is already a dependency (`render`/`cleanup` used in `setup.ts`).

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/fn-chatsessionlist-engine.test.ts`:

  ```ts
  /**
   * ChatSessionList engine degradation (spec §8, §12, D8): an engine (codex/opencode) session row
   * must NOT offer live-only controls (Kill / Resume) and must carry the honest
   * "one-shot · limited memory" badge. A claude session keeps its Kill/Resume controls.
   * Props are cast `as any` — vitest does not typecheck; the contract is what we assert.
   */
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen, fireEvent } from '@testing-library/react';
  import { ChatSessionList } from '../components/ChatSessionList';

  const session = (over: any) => ({
    id: 's1', title: 'demo', engine: 'claude', model: 'claude-opus-4-8', effort: 'high',
    permissionMode: 'default', cwd: '/repo', allowedTools: null, skills: null, runId: null,
    state: 'idle', live: false, createdAt: 0, updatedAt: 0, ...over,
  });

  const baseProps = {
    activeId: 's1', onSelect: vi.fn(), onNew: vi.fn(), onRename: vi.fn(),
    onDelete: vi.fn(), onKill: vi.fn(), onResume: vi.fn(),
  };

  describe('ChatSessionList — engine degradation', () => {
    it('a claude session exposes Kill and Resume controls', () => {
      render(<ChatSessionList {...(baseProps as any)} sessions={[session({ engine: 'claude', state: 'live', live: true })] as any} />);
      expect(screen.queryByText(/kill/i)).not.toBeNull();
      expect(screen.queryByText(/resume/i)).not.toBeNull();
      expect(screen.queryByText(/one-shot/i)).toBeNull();
    });

    it('an engine session hides Kill/Resume and shows the one-shot · limited memory badge', () => {
      render(<ChatSessionList {...(baseProps as any)} sessions={[session({ id: 's1', engine: 'codex' })] as any} />);
      expect(screen.queryByText(/^kill$/i)).toBeNull();
      expect(screen.queryByText(/^resume$/i)).toBeNull();
      expect(screen.queryByText(/one-shot · limited memory/i)).not.toBeNull();
    });

    it('Kill / Resume on a claude row fire their callbacks with the session id', () => {
      const onKill = vi.fn(); const onResume = vi.fn();
      render(<ChatSessionList {...(baseProps as any)} onKill={onKill} onResume={onResume}
        sessions={[session({ engine: 'claude', state: 'live', live: true })] as any} />);
      fireEvent.click(screen.getByText(/^kill$/i));
      fireEvent.click(screen.getByText(/^resume$/i));
      expect(onKill).toHaveBeenCalledWith('s1');
      expect(onResume).toHaveBeenCalledWith('s1');
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test fn-chatsessionlist-engine.test.ts`
  Expected failure: the current `ChatSessionList` accepts no `onKill`/`onResume` and renders only `rename`/`delete`, so the "claude exposes Kill/Resume" assertions fail (queries return null).

- [ ] **Step 3: Add Kill/Resume props + engine gating to `ChatSessionList.tsx`.**
  Replace the component in `apps/web/components/ChatSessionList.tsx` with:

  ```tsx
  'use client';
  import type { ChatSession } from '@fleet/shared';
  import { Btn, Badge } from '@/components/ui';

  const AMBER = '#ffb000';

  export function ChatSessionList({ sessions, activeId, onSelect, onNew, onRename, onDelete, onKill, onResume }: {
    sessions: ChatSession[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string) => void;
    onDelete: (id: string) => void;
    onKill: (id: string) => void;
    onResume: (id: string) => void;
  }) {
    return (
      <div className="w-56 shrink-0 border-r hairline flex flex-col">
        <div className="flex items-center justify-between p-2 border-b hairline">
          <span className="kicker">sessions</span>
          <Btn onClick={onNew}>+ New</Btn>
        </div>
        <div className="flex-1 overflow-auto">
          {sessions.map((s) => {
            const isEngine = s.engine !== 'claude';
            return (
              <div key={s.id}
                className={`px-2 py-2 text-[12px] cursor-pointer border-b hairline transition-colors ${s.id === activeId ? 'bg-amber/[0.06]' : 'hover:bg-white/5'}`}
                onClick={() => onSelect(s.id)}>
                <div className="truncate text-ink">{s.title}</div>
                <div className="font-mono text-[10px] text-faint mt-0.5">{s.engine} · {s.model}</div>
                {isEngine && (
                  <div className="mt-1">
                    <Badge label="one-shot · limited memory" color={AMBER} />
                  </div>
                )}
                {s.id === activeId && (
                  <div className="flex gap-2 mt-1.5 font-mono text-[10px]">
                    {/* Kill / Resume are live-process controls — meaningless for one-shot engines (spec §12, D8). */}
                    {!isEngine && (
                      <>
                        <button className="text-faint hover:text-sig-killed transition-colors" onClick={(e) => { e.stopPropagation(); onKill(s.id); }}>kill</button>
                        <button className="text-faint hover:text-ink transition-colors" onClick={(e) => { e.stopPropagation(); onResume(s.id); }}>resume</button>
                      </>
                    )}
                    <button className="text-faint hover:text-ink transition-colors" onClick={(e) => { e.stopPropagation(); onRename(s.id); }}>rename</button>
                    <button className="text-faint hover:text-sig-failed transition-colors" onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>delete</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test fn-chatsessionlist-engine.test.ts`
  Expected: `Tests  3 passed (3)`.

- [ ] **Step 5: Wire `onKill`/`onResume` from the chat page.**
  In `apps/web/app/chat/page.tsx`, the `<ChatSessionList ... />` call now needs the two new required props. Add handlers that reuse the existing api helpers (`api.stop(runId)` to kill the backing run; `api.resume(runId)` to resume — both keyed off `session.runId`). Add near `deleteSession`:

  ```tsx
  async function killSession(id: string) {
    setErr(null);
    const target = sessions.find((s) => s.id === id);
    if (!target?.runId) return;
    try { await api.stop(target.runId); await refreshSessions(); }
    catch (e: any) { setErr(e.message); }
  }
  async function resumeSession(id: string) {
    setErr(null);
    const target = sessions.find((s) => s.id === id);
    if (!target?.runId) return;
    try { await api.resume(target.runId); await refreshSessions(); }
    catch (e: any) { setErr(e.message); }
  }
  ```
  And pass them: `onKill={killSession} onResume={resumeSession}` on the `<ChatSessionList>` element.

- [ ] **Step 6: Typecheck.**
  `pnpm --filter @fleet/web typecheck`
  Expected: compiles with no TypeScript errors (the new required props are satisfied).

- [ ] **Step 7: Commit.**
  ```
  git add apps/web/components/ChatSessionList.tsx apps/web/app/chat/page.tsx apps/web/test/fn-chatsessionlist-engine.test.ts
  git commit -m "feat(chat): engine session rows hide Kill/Resume + badge one-shot · limited memory"
  ```

---

### Task 4: Web — Stop button is suppressed on engine sessions (no live turn to stop)

The composer Stop button (spec §7) maps to `…/interrupt`, which only makes sense for a live Claude turn. An engine turn is a one-shot launch with no interruptible live process, so Stop must not render for engine sessions.

- [ ] **Step 1: Write the failing test.**
  Create `apps/web/test/fn-chatcomposer-engine.test.ts`:

  ```ts
  /**
   * ChatComposer Stop-button gating (spec §7, §12 D8): Stop maps to .../interrupt and is only
   * meaningful for a live, running Claude turn. An engine session has no interruptible process,
   * so Stop must never render for it — even while a turn is in flight.
   */
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import { ChatComposer } from '../components/ChatComposer';

  const base = { disabled: false, onSend: vi.fn(), onCommand: vi.fn(), onStop: vi.fn() };

  describe('ChatComposer — Stop gating by engine', () => {
    it('shows Stop for a running claude session', () => {
      render(<ChatComposer {...(base as any)} engine="claude" running={true} />);
      expect(screen.queryByText(/stop/i)).not.toBeNull();
    });
    it('never shows Stop for an engine session even when running', () => {
      render(<ChatComposer {...(base as any)} engine="codex" running={true} />);
      expect(screen.queryByText(/stop/i)).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run it, see it fail.**
  `pnpm --filter @fleet/web test fn-chatcomposer-engine.test.ts`
  Expected failure: `ChatComposer` currently takes no `engine`/`running`/`onStop` props and renders no Stop control, so the claude assertion fails.

- [ ] **Step 3: Add Stop gating to `ChatComposer.tsx`.**
  Modify `apps/web/components/ChatComposer.tsx` (keep the existing `/`-command behavior — Unit 2 rewrites the full composer; this is the minimal Stop-gating slice it must preserve):

  ```tsx
  'use client';
  import { useState } from 'react';
  import { Btn, Input } from '@/components/ui';
  import type { RunEngine } from '@fleet/shared';

  export function ChatComposer({ disabled, onSend, onCommand, onStop, engine = 'claude', running = false }: {
    disabled: boolean;
    onSend: (message: string) => void;
    onCommand: (line: string) => void;
    onStop?: () => void;
    engine?: RunEngine;
    running?: boolean;
  }) {
    const [text, setText] = useState('');
    function submit() {
      const t = text.trim();
      if (!t) return;
      if (t.startsWith('/')) onCommand(t); else onSend(t);
      setText('');
    }
    // Stop maps to .../interrupt — only meaningful for a live, running Claude turn (spec §7, §12 D8).
    const showStop = running && engine === 'claude';
    return (
      <div className="border-t hairline p-3 flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Message…  (/ for commands)"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        {showStop
          ? <Btn variant="ghost" onClick={() => onStop?.()} title="Stop generating">Stop</Btn>
          : <Btn variant="solid" onClick={submit} disabled={disabled || !text.trim()}>▶</Btn>}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run it, see it pass.**
  `pnpm --filter @fleet/web test fn-chatcomposer-engine.test.ts`
  Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Pass `engine`/`running` from the chat page.**
  In `apps/web/app/chat/page.tsx`, update the `<ChatComposer disabled={busy} onSend={send} onCommand={command} />` element to also pass `engine={session.engine} running={!!liveRunId}`. (Leave `onStop` wiring to Unit 1/2's interrupt route; passing it is optional here.)

- [ ] **Step 6: Typecheck + commit.**
  `pnpm --filter @fleet/web typecheck` → no errors.
  ```
  git add apps/web/components/ChatComposer.tsx apps/web/app/chat/page.tsx apps/web/test/fn-chatcomposer-engine.test.ts
  git commit -m "feat(chat): suppress Stop button on one-shot engine sessions"
  ```

---

### Task 5: Cross-cutting server + web test pass — run the key suites green

This task does not write new tests; it **runs the full set the chat-surface upgrade touches** and confirms they are green (spec §13). If any fail, stop and fix before proceeding — do not mark this unit complete with a red suite.

- [ ] **Step 1: Run the server chat/engine/registry/commands/files suites.**
  ```
  pnpm --filter @fleet/server test chat.test.ts
  pnpm --filter @fleet/server test fn-chat-routes.test.ts
  pnpm --filter @fleet/server test fn-chat-engine-resume.test.ts
  pnpm --filter @fleet/server test commands.test.ts
  pnpm --filter @fleet/server test cov-commands.test.ts
  pnpm --filter @fleet/server test cov-registry.test.ts
  pnpm --filter @fleet/server test fileview.test.ts
  pnpm --filter @fleet/server test cov-fileview.test.ts
  pnpm --filter @fleet/server test engines.test.ts
  pnpm --filter @fleet/server test cov-engines.test.ts
  ```
  Plus the new files added by the other chat units if present (substitute their actual names): `pnpm --filter @fleet/server test fn-chatlive.test.ts`, `pnpm --filter @fleet/server test fn-files-find.test.ts`, `pnpm --filter @fleet/server test fn-chat-stream.test.ts`.
  Expected for each: `Test Files  1 passed (1)` and `Tests  N passed (N)` — **0 failed**.

- [ ] **Step 2: Run the web chat suites.**
  ```
  pnpm --filter @fleet/web test fn-chatsessionlist-engine.test.ts
  pnpm --filter @fleet/web test fn-chatcomposer-engine.test.ts
  pnpm --filter @fleet/web test fn-userunstream.test.ts
  ```
  Plus the new web files from the other units if present (substitute actual names): `fn-chatcomposer.test.ts`, `fn-slashmenu.test.ts`, `fn-mentionmenu.test.ts`, `fn-chatthread.test.ts`.
  Expected for each: `Tests  N passed (N)` — **0 failed**.

- [ ] **Step 3: Run the whole server + web suites once, as a regression gate.**
  ```
  pnpm --filter @fleet/server test
  pnpm --filter @fleet/web test
  ```
  Expected: a final `Test Files  N passed (N)` line on each with **0 failed**. If a pre-existing unrelated test is red, note it explicitly in the commit/PR — do not silently leave the gate broken.

- [ ] **Step 4: Commit (if any quick fixes were needed to make a suite green).**
  ```
  git commit -am "test(chat): green the full chat-surface server + web suites"
  ```
  (Skip the commit if Steps 1-3 required no code changes.)

---

### Task 6: Typecheck both packages (server + web) clean

`vitest` does not typecheck (frames are cast `as any`), so a separate typecheck pass is mandatory before claiming completion (spec §14.6 "polish").

- [ ] **Step 1: Build the shared package first (server + web depend on its types).**
  ```
  pnpm --filter @fleet/shared typecheck
  ```
  Expected: no errors. (If `@fleet/shared` has no `build` script, run `pnpm -r typecheck` or `pnpm --filter @fleet/shared exec tsc --noEmit` per the repo's convention — confirm by reading `packages/shared/package.json` scripts.)

- [ ] **Step 2: Typecheck the server.**
  ```
  pnpm --filter @fleet/server typecheck
  ```
  Expected: completes with no TypeScript errors. Pay attention to `chat.ts` (`engineSafeState`, the `ChatSessionState` import) and the route serialization.

- [ ] **Step 3: Typecheck the web app.**
  ```
  pnpm --filter @fleet/web typecheck
  ```
  Expected: `next build` compiles every route with no TypeScript errors. Pay attention to `ChatSessionList.tsx` (new required `onKill`/`onResume` props) and `ChatComposer.tsx` (new optional props), and that `apps/web/app/chat/page.tsx` passes every now-required prop.

- [ ] **Step 4: Commit any type fixes.**
  ```
  git commit -am "chore(chat): typecheck server + web clean for engine degradation"
  ```
  (Skip if no changes were needed.)

---

### Task 7: HUD manual QA checklist — drive the chat surface end-to-end

A manual smoke pass over the full chat HUD (spec §14.6 "HUD QA"). This is a **checklist task**: start the app, then verify each item by hand. It is the human gate the automated tests cannot fully cover (real streaming, real menus, real charcoal/amber rendering).

- [ ] **Step 1: Start the stack.**
  Server: `pnpm --filter @fleet/server dev` (or the repo's documented dev command). Web: `pnpm --filter @fleet/web dev`. Open the portal and navigate to `/chat`. Create one **claude** session and one **codex** (engine) session.

- [ ] **Step 2: `/` slash menu.** In the composer, type `/`. Confirm the `FloatingMenu` palette opens, is grouped (Portal verbs · Skills · Subagents), filters as you type, navigates with ↑/↓, selects with Enter, dismisses with Esc and on click-outside. Styling is HUD-canon (charcoal surface, amber `#ffb000` highlight, JetBrains Mono).

- [ ] **Step 3: `@` mention picker.** Type `@` in the composer. Confirm the file/folder picker opens, fuzzy-matches against the session `cwd`, inserts a removable chip on select, and the chip can be removed with its ✕. A folder chip and a file chip both render distinctly.

- [ ] **Step 4: kill → resume (claude session).** Send a turn in the claude session; while it is `running`, click the row's **kill** — confirm the turn stops and the row state shows `killed`. Send another message — confirm it transparently resumes with full memory (no error, the thread continues). Confirm the **resume** control behaves the same after an idle suspend.

- [ ] **Step 5: inline permission.** Trigger a tool that needs approval (e.g. a write under a `default` permission mode). Confirm the inline approve/deny card renders in the thread and that clicking **approve** lets the turn proceed (POST `…/input` round-trip). Confirm deny is also honored.

- [ ] **Step 6: table render.** Run a command whose `ChatCommandResult.kind === 'table'` (e.g. `/agents` or `/sessions`). Confirm it renders as a real `<table>` (not raw JSON), with HUD borders/typography.

- [ ] **Step 7: idle-suspend badge.** Leave the claude session idle past `CHAT_IDLE_SUSPEND_MS` (or set `FLEET_CHAT_IDLE_SUSPEND_MS` low for the test). Confirm the row drops to `idle` and shows the subtle "resumable"/idle badge, and that the next message resumes (~1s) without error.

- [ ] **Step 8: engine degradation (the focus of this unit).** On the **codex** session row, confirm:
  - the **kill** and **resume** controls are **absent** (only rename/delete on the active row);
  - the amber **"one-shot · limited memory"** badge is present;
  - the composer shows **no Stop button** even while a turn is in flight;
  - sending several turns keeps full short-term memory (the reconstructed transcript) — ask a follow-up that references an earlier turn and confirm the engine answers coherently;
  - the session state never displays `live`.

- [ ] **Step 9: Record the result.** If every item passes, note "HUD QA ✓" in the PR description. If anything fails, file it as a follow-up and DO NOT claim Phase 6 complete.

---

### Task 8: Append decisions D-035…D-043 to DC.md and supersede the PRD §11 abort/resume line

Spec §15 lists the new decisions as D-033…D-041, but `DC.md` **already uses** D-033/D-034 for the settings-env work (verified at `DC.md` lines 1165 and 1171). The next free decision numbers are **D-035…D-043**. This task records the chat decisions under those numbers (content verbatim from spec §15) and marks the superseded PRD line.

- [ ] **Step 1: Confirm the collision and the next free number.**
  ```
  grep -n "^### D-0" DC.md | tail -8
  ```
  Confirm the highest existing is `D-034`. The chat block therefore starts at **D-035**.

- [ ] **Step 2: Append a new section to the end of `DC.md`** (after the current last line, line ~1205). Add:

  ```markdown

  ## 33. Chat surface upgrade — end-to-end conversational control-plane (2026-06-14) — spec docs/superpowers/specs/2026-06-14-chat-surface-upgrade-design.md

  > Numbering note: this spec's §15 names these D-033…D-041, but D-033/D-034 were already taken
  > by the settings-env work (§31). They are recorded here as **D-035…D-043** (spec D-033→D-035,
  > D-034→D-036, … D-041→D-043); content is unchanged.

  ### D-035 — Chat sessions are always-live with resumable fallback
  Reverses D-029's "resume-per-turn over a live process". A focused session holds a long-lived
  interactive Claude process (instant turns, mid-turn input, inline permissions); kill stops it;
  it resumes later with full memory. Made safe by D-036.

  ### D-036 — Separate chat budget + idle eviction
  Live chat processes draw from a dedicated pool CHAT_LIVE_MAX (default 4, env FLEET_CHAT_LIVE_MAX),
  distinct from config.maxConcurrentRuns. Exhaustion → resumable fallback (still usable, ~1s slower).
  A live process idle past CHAT_IDLE_SUSPEND_MS (default 600000, env FLEET_CHAT_IDLE_SUSPEND_MS) is
  evicted → session drops to idle and reclaims the slot. Chat can never consume batch slots.

  ### D-037 — One declarative command registry is the source of truth
  A single CommandDef[] feeds dispatchCommand + GET /api/commands + /help + the composer autocomplete.
  No switch/HELP-string duplication. The server-only run() is stripped before the wire shape.

  ### D-038 — Curated typed verb set (~18) + NL long-tail; mutations via Inbox
  Chat exposes ~18 typed slash verbs; the ~100-route long tail is invoked by the agent as
  natural-language tool-calls. Destructive actions (and the long-tail's mutations) route through the
  existing Inbox approval queue — no new privileged surface (preserves D-031).

  ### D-039 — Chat-scoped SSE replaces per-run subscription for chat
  GET /api/chat/sessions/:id/stream subscribes to the session, not a run id; the server proxies
  whichever run currently backs the session. Survives kill→resume (run id changes underneath) and
  page reload (no orphaned streaming turn). Carries the full run-event vocabulary plus a chat-control
  session_state envelope { state, live }.

  ### D-040 — `@` mentions resolve the workspace from session cwd
  Resolve workspace root from cwd (git root, else gitignore-aware walk). Files = a path-reference
  token the agent reads at runtime; folders = added to that turn's --add-dir set. safePath-guarded;
  paths workspace-relative. ChatMessage gains an optional additive attachments field.

  ### D-041 — Full-fidelity rendering + inline permissions
  The chat thread consumes the complete stream vocabulary: markdown, real tables, collapsible
  tool-call/thinking cards, live token streaming, subagent chips, and inline permission approve/deny
  (enabled by the live process via POST .../input), plus a Stop button while running.

  ### D-042 — One HUD-canon FloatingMenu/Combobox primitive
  A single keyboard-navigable, caret-anchored, click-outside-dismiss FloatingMenu/Combobox in
  components/ui.tsx (charcoal, amber #ffb000, status colors, Chakra Petch/JetBrains Mono), reused by
  both `/` and `@`.

  ### D-043 — Engine (codex/opencode) sessions degrade honestly (supersedes nothing; refines D-030)
  Engines never go live. A "resume" UX is presented uniformly but emulated: every engine turn
  re-launches via registry.launchEngine with a reconstructed buildEnginePrompt transcript; the chat
  layer never calls registry.resume() (which still 409s for engine runs). Engine session rows hide
  Kill/Resume, suppress the Stop button, and carry an amber "one-shot · limited memory" badge; the
  derived state is never `live`.

  ### D-044 — Supersedes PRD §11 ("abort and session-resume are mutually exclusive")
  No longer true: the registry resumes terminal/killed runs (kill is not delete). PRD §11's
  abort/resume bullet is marked superseded by this decision.
  ```

  (Note: the spec named the supersede as D-041, but since the chat block shifted up by two, the
  PRD-supersede decision lands at D-044. If the assembler prefers to keep exactly nine decisions
  D-035…D-043 by folding the supersede into D-043, do so — but record the supersede somewhere.)

- [ ] **Step 3: Mark the PRD §11 line superseded.**
  In `PRD-Claude-Fleet-Portal.md` line 217, change:
  ```
  - **Abort and session-resume are mutually exclusive** — "stop" is terminal, not pause-and-resume.
  ```
  to:
  ```
  - ~~**Abort and session-resume are mutually exclusive** — "stop" is terminal, not pause-and-resume.~~ **Superseded by DC D-044 (2026-06-14):** the registry resumes terminal/killed runs (kill is not delete); chat sessions are always-live with resumable fallback.
  ```

- [ ] **Step 4: Verify the edits landed.**
  ```
  grep -n "D-035\|D-043\|D-044" DC.md
  grep -n "Superseded by DC D-044" PRD-Claude-Fleet-Portal.md
  ```
  Expected: the new decisions and the strikethrough/supersede note are present.

- [ ] **Step 5: Commit.**
  ```
  git add DC.md PRD-Claude-Fleet-Portal.md
  git commit -m "docs(chat): record D-035..D-044 + supersede PRD §11 abort/resume line"
  ```

---

## Cross-Unit Reconciliation Notes (from authors)

> **Assembler reconciliation (read first — the plan body above is authoritative over the raw author notes below).** The following cross-unit concerns were resolved inline during assembly:
> - **Command registry naming + ctx** — pinned to Unit 1's actual shipped names: `const COMMANDS: CommandEntry[]`, `export interface CommandContext { args: string[]; arg: string; cwd: string }`. Unit 5's earlier `ChatCommand`/`CommandCtx`/`{ cwd }`-only assumptions were corrected in Unit 5's preamble + Task 3.
> - **Danger→Inbox routing ownership** — Unit 1 ships `dispatchCommand` calling `entry.run(ctx)` directly (no danger branch); **Unit 5 Task 2 wholly owns** adding the `danger:true → enqueueApproval()` branch. The "skip if Unit 1 added it" hedge was removed.
> - **`@`-folder `--add-dir` plumbing** — was unowned; added as **Unit 1 → Task R** with complete code (`LaunchRequest.addDirs`, `buildArgs`, `registry.resume` 4th param).
> - **DC decision-number collision** — Unit 6 correctly renumbers the spec's D-033…D-041 to **D-035…D-043** (D-033/D-034 are taken by settings-env work). That mapping is authoritative.
> - **Test filenames** — the per-unit `fn-*`/`cov-*` names referenced in Unit 6's final sweep (`fn-chatlive`, `fn-files-find`, `fn-chat-stream`, `fn-floatingmenu`, `fn-usechatstream`, `fn-chatcomposer`, `fn-slashmenu`, `fn-mentionmenu`, `fn-chatthread`…) match the names the owning units actually create — no substitution needed.
> - **`registry.interrupt`** — still an open enhancement: v1 `/interrupt` uses `registry.stop` (kill→resumable, per spec). A keep-process-live abort can replace it later (flagged in Unit 1).

**Backend Services — chat upgrade (command registry, files/find, chatLive, chat-scoped SSE/input/interrupt, attachments, route registration)**
- DEPENDS ON UNIT F: Tasks 2/3/5/7/8/9 import canonical types from @fleet/shared — CommandDef, CommandArg, FileFindResult, ChatAttachment, ChatSessionState, and the additive optional fields attachments (on ChatMessage and ChatTurnRequest). The server `pnpm --filter @fleet/server typecheck` typecheck steps will FAIL until Unit F has published these. If a build step fails solely on a missing import from @fleet/shared, that is the Unit F dependency, not a bug in these tasks.
- LaunchRequest.addDirs: Task 7 forwards an `addDirs: string[]` option to registry.launch/resume/launchEngine for @-mention folders (§6.2 --add-dir). The registry's LaunchRequest type and buildArgs/buildResumeArgs CLI translation must learn `addDirs` → `--add-dir <dir>` (repeated). This is currently OUTSIDE the files this unit edits (registry.ts buildArgs). The function-level tests mock registry so they pass regardless, but the end-to-end --add-dir behavior needs the registry/LaunchRequest change. Flag for the assembler to assign (likely Unit 4/registry owner). registry.resume's signature only accepts (runId, prompt, interactive) today, so an attachments-bearing resume turn cannot pass addDirs without a registry change.
- registry.interrupt: Task 10 wires /interrupt to registry.stop() (kill→resumable, the spec's documented fallback). A true keep-process-live turn-abort needs a new registry method (e.g. registry.interrupt(runId)). If Unit 4 adds it, swap the stop() call in the /interrupt handler.
- chatLive idle eviction is real (setTimeout/unref) but is NOT auto-driven by run-terminal events in v1 — eviction also fires on explicit evict()/kill. If the live process exits on its own (run completes/fails), chatLive still holds the handle until the idle timer fires; consider subscribing chatLive to registry's run-terminal signal (registry.onRunTerminal pattern used by notifier/memory/pm) so a finished live run frees its slot immediately. Out of scope for these tasks; flag for reconciliation.
- SSE plumbing: Task 9 passes server.ts's private `sse` factory into chat.ts's registerChatStreamRoute to avoid duplicating the hijack/connection-cap logic. The assembler must ensure the `sse` function in server.ts is in scope at the registerChatStreamRoute(app, sse) call site (it is a top-level function in server.ts, so this holds) and that the registrar is called AFTER registerChatRoutes(app).
- The chat-scoped stream re-resolves the backing run only at CONNECT time (chatLive.liveRunId(id) ?? session.runId). To survive a kill→resume WHILE a client is connected (run id changes underneath mid-connection), Unit 2/web should reconnect the EventSource on a session_state envelope change, OR a future server enhancement should re-subscribe on setSessionRun. v1 relies on client reconnect — note for the web unit and the assembler.
- Test fn-chat-stream.test.ts assumes fastify inject() returns after the no-backing-run SSE path flushes its initial frames and leaves the socket open. If the installed fastify version blocks inject() on the open hijacked socket for that case, the test author must fall back to a real http.get against app.listen({port:0}) reading the first chunk (noted inline in the task). Existing board/fleet stream tests in the repo should be consulted for the canonical pattern.

**Unit 2 — COMPOSER + autocomplete menus (FloatingMenu/Combobox primitive, ChatComposer rewrite, SlashMenu, MentionMenu, api/live helpers)**
- HARD DEPENDENCY ON UNIT F (packages/shared): The web code imports `CommandDef`, `CommandArg`, `ChatAttachment`, `FileFindResult`, and `ChatSessionState` from `@fleet/shared`. As of authoring, NONE of these exist in packages/shared/src/index.ts yet (verified: only `ChatTurnRequest`/`ChatTurnResponse`/`ChatSession`/`ChatMessage` are present, without the additive attachment/state fields). Unit 2 will NOT typecheck (`pnpm --filter @fleet/web typecheck`) until Unit F lands those exports verbatim. Vitest test BODIES do not typecheck (they cast `as any`), so the unit tests can pass before Unit F — but the build step in Tasks 6/8/11/13 is blocked on Unit F. Do not define these types locally in apps/web.
- HARD DEPENDENCY ON UNIT 1 (server routes): The client helpers assume Unit 1 ships these exact routes/shapes: GET /api/commands → CommandDef[] (run stripped); GET /api/files/find?cwd=&q=&limit= → FileFindResult[]; POST /api/chat/sessions/:id/turn accepting { message, attachments? }; POST /api/chat/sessions/:id/input accepting { message, attachments? } (409 if not live); POST /api/chat/sessions/:id/interrupt; and a chat-scoped SSE at GET /api/chat/sessions/:id/stream emitting `{ kind:'event', event: NormalizedEvent }` frames PLUS a `{ kind:'session_state', state, live }` control envelope. If Unit 1's SSE envelope differs (e.g. wraps run events under a different `kind`, or names the control event differently than `session_state`), `useChatStream` in lib/live.ts must be adjusted to match — flagged because the spec §4/§10 only names `session_state` without pinning the exact JSON envelope.
- useChatStream assumes the chat SSE reuses the run-stream envelope shape `{ kind:'event', event }` / `{ kind:'node' }` / etc. from StreamMessage. The existing useRunStream also handles `{ kind:'hello', run, nodes, events }` and `{ kind:'node' }` and an `{error}` terminator. I implemented the `{error}` terminator and `{ kind:'event' }` + `{ kind:'session_state' }` paths, but DID NOT implement a chat `hello` snapshot path (the transcript renders from SQLite per spec §3.1, and Unit 3 owns the ChatThread which loads history via api.chatSession). If Unit 1's chat stream sends a `hello`-style snapshot that should seed events, useChatStream needs a `hello` branch added — confirm with Unit 1.
- KILL vs DELETE ambiguity: I implemented `api.chatKill(id)` as `DELETE /api/chat/sessions/:id` per spec §3.3 ('Kill: DELETE semantics via registry.stop'). But the EXISTING api already has `deleteChatSession(id)` → `DELETE /api/chat/sessions/:id` for session DELETION. These collide on the same verb+path. Unit 1 must disambiguate: either (a) kill is a distinct route (e.g. POST /api/chat/sessions/:id/kill) — then chatKill must change — or (b) DELETE is repurposed to kill-the-run and session deletion moves elsewhere. The composer itself only calls `chatInterrupt` (Stop button); `chatKill` is for the session-list Kill control (a different unit), so this can be reconciled without touching the composer.
- PAGE WIRING (apps/web/app/chat/page.tsx) is shared surface with Unit 3 (ChatThread rewrite) and the session-UI unit. Task 13 makes the MINIMAL page edit needed to satisfy ChatComposer's new props (running/cwd/onStop/attachments) and keep the build green. Unit 3 will rewrite the same page for full-fidelity rendering. The assembler should sequence Unit 2's page edit BEFORE or MERGE WITH Unit 3's, and ensure `sendTurn(message, attachments)` / `runCommand(line)` / `chatState` exist (chatState should come from `useChatStream(session.id).state`). I did not author the page handlers in full because they straddle Unit 3's scope.
- TESTING LIB CONSTRAINTS: apps/web has @testing-library/react v16 + @testing-library/dom but NO @testing-library/user-event and NO jest-dom. All component tests therefore use `render` + `fireEvent` and assert via raw DOM (querySelector/textContent/getByText) — NOT `toBeInTheDocument`/`toHaveTextContent`. If the implementer prefers those matchers they must add `@testing-library/jest-dom` as a devDep and import it in test/setup.ts; otherwise keep the raw-DOM assertions as written.
- FloatingMenu keyboard nav is OWNED BY THE CALLER (SlashMenu/MentionMenu attach document-level keydown listeners), NOT by FloatingMenu itself — because the trigger char and focus stay in the composer's <textarea>. This is a deliberate split: FloatingMenu is a controlled presentational popover (open/items/activeIndex/onPick/onClose). If a future consumer wants self-contained keyboard handling, that's an additive prop, not a change to this contract. Both SlashMenu and MentionMenu register `keydown` with capture=true on document; if multiple menus could ever be open at once (they can't here — detectTrigger returns at most one), the handlers would conflict.
- DEBOUNCE/CACHE BEHAVIOR: SlashMenu fetches the catalog ONCE per mount (loadedRef guard) and filters client-side — matching spec §5.3 ('client caches the response and debounces keystroke filtering'). Because the menu mounts/unmounts as the `/` trigger toggles, the cache is per-open-session, not global; if Unit wants a cross-open cache, lift it to a module-level memo or React context. MentionMenu debounces server calls at 150ms. The spec's live-value arg sources (CommandArg.source: 'running-runs'|'addons'|'templates' fetched on demand when typing `/kill `) are NOT implemented in this unit's SlashMenu — the composer's pickCommand inserts `/<name> ` and stops; arg-value autocomplete after the verb is a follow-up (flagged as a known gap vs spec §5.3 'Args with a source fetch live values on demand').

**Unit 3 — Rendering (full ChatGPT-grade chat message rendering)**
- EVENT PAYLOAD SHAPES ASSUMED — reconcile with the server's normalizer (Unit 1/the run event producer). ChatThread reads: tool_use.payload = { id, name, input }; tool_result.payload = { forId, text, isError } (forId matches tool_use.id — this matches Waterfall.tsx's existing pairing on payload.id/forId); permission_request.payload = { requestId, toolName, input } (with fallbacks to id/name); subagent_spawned.payload = { label, childId } (matches Timeline.tsx). If the server emits different keys (e.g. permission_request carries `id` not `requestId`, or tool_result uses a different match field), update the payload accessors in ChatThread.tsx and PermissionCard's caller accordingly.
- useChatStream IS OWNED BY UNIT 2 (lib/live.ts). This unit ships a fallback ONLY if Unit 2's export is absent (Task 2 Step 1 guards on grep). Unit 2 must return the exact ChatStreamState shape consumed here: { run, events, partials, state, connected, error } where partials is nodeId→streaming-text and state is ChatSessionState. The session_state chat-control frame ({ kind:'session_state', state, live }) is owned by Unit 1's stream route — confirm its frame `kind` is literally 'session_state' and it carries `state`.
- POST /api/chat/sessions/:id/input BODY SHAPE for permission decisions is assumed to be { type:'permission', requestId, decision:'allow'|'deny' }. Unit 1 owns this route — reconcile the exact body it expects (it writes to the live process stdin). If Unit 1 expects a different envelope, update api.chatInput's callers in PermissionCard.tsx.
- POST /api/chat/sessions/:id/interrupt is assumed body-less (Stop button). Unit 1 owns it.
- PERSISTED command-result messages: ChatThread parses a `command-result` ChatMessage.content as a JSON-serialized ChatCommandResult to render tables/errors. This assumes Unit 1's command dispatch persists the ChatCommandResult as JSON in message.content. If command results are persisted as plain text instead, the parse falls back to MarkdownView (safe) but tables won't render from history — reconcile with Unit 1's persistence format.
- ChatThread's PROP CONTRACT CHANGED: it now takes `sessionId: string | null` instead of `liveRunId: string | null`. Unit 4 (which owns the chat page / session-state rewire per spec §10) must keep passing `sessionId={activeId}` and may remove the now-unused `liveRunId` state. The Stop button calls api.chatInterrupt directly; if Unit 4 centralizes interrupt handling, it can lift that out.
- Run.resultText and Run.status fields are consumed by LiveTurn's completion guard (same as the old LiveTurn used). Confirm both still exist on the Run type in @fleet/shared.
- SearchResultCard payload is not yet wired into ChatThread's switch (no canonical search-result event type exists in NormalizedEventType — search results arrive as tool_result content today). It is built and unit-tested standalone for Unit 5 (command coverage) / NL search to consume when the search-result event/shape is finalized. Reconcile where search results enter the stream.

**Session Sidebar, Scoped Panel, Page Wiring & Concurrency UX (web)**
- Depends on Unit F's packages/shared changes: ChatSession must gain optional `state?: ChatSessionState` and `live?: boolean`, and `ChatSessionState` must be exported. Tasks 2/3/5 import `ChatSessionState` from @fleet/shared and read `session.state`/`session.live`; if Unit F hasn't landed, `pnpm --filter @fleet/web typecheck` fails. ChatAttachment/attachments fields are NOT used by this unit (composer/thread unit owns them).
- The chat-scoped SSE route `GET /api/chat/sessions/:id/stream` and the `session_state` envelope `{state,live}` are owned by Unit 1 (server). This unit only implements/test the CLIENT reducer (`useChatStream`) against FakeEventSource, so its tests pass without a running server. The exact `hello` frame shape this unit assumes — `{kind:'hello', state, live, runId, subagents:[{runId,name}]}` and `{kind:'session_state', state, live}` and `{kind:'event', event: NormalizedEvent}` — must match what Unit 1 actually emits. RECONCILE the hello/subagents payload field names with Unit 1's stream serializer.
- API helpers `killChatSession`/`resumeChatSession` are added in Task 6 ONLY if absent (it greps first). Per spec §10 the api-layer unit owns `lib/api.ts`; if that unit also defines these, DEDUPE — keep one definition. The assumed routes are `POST /api/chat/sessions/:id/interrupt` (kill) and `POST /api/chat/sessions/:id/resume` (resume); confirm against Unit 1's actual route names (spec §3.3 names interrupt + input; a dedicated resume route may instead be the next turn auto-resuming — reconcile the kill/resume endpoint contract).
- `RunningAgentsPanel`'s prop changed from `()` to `{ sessionId }`. Any caller other than chat/page.tsx (none found in this repo) must be updated. The fleet-wide running view is intentionally left to `/fleet`.
- `ChatSessionList` props changed (added `previews`, `onKill`, `onResume`; `onRename` is now `(id,title)=>void`). The only caller is chat/page.tsx (updated in Task 5). The page's `previews` derivation is intentionally minimal (only the active session gets a preview from loaded messages); a richer per-session preview would require the session-list API to return a `lastMessage` field — flagged as a possible Unit F/server enhancement, not required for v1.
- Tests use plain truthiness (`getBy*/queryBy*` + `toBeTruthy()`), NOT `@testing-library/jest-dom` matchers like `toBeInTheDocument` — this repo's web test suite does not import jest-dom (verified: setup.ts only imports cleanup). Keep that convention.
- No existing component-render tests existed in apps/web/test (only fn-* hook tests); this unit introduces the first `render`/`screen` component tests via @testing-library/react, which is already a devDependency. The `cov-*` filename prefix follows the spec §13 `fn-*`/`cov-*` convention.

**Command registry population — curated verb set + Inbox-gated danger verbs**
- ASSUMED Unit 1 shape: COMMANDS array of `CommandDef & { run(ctx): Promise<ChatCommandResult> }`; dispatchCommand(line, cwd) finds the entry by verb and calls run; listCommands() strips run; GET /api/commands serves it. If Unit 1 named the array/ctx differently, the assembler must align my added entries to that name. I add the danger->Inbox branch in dispatchCommand (Task 2) — if Unit 1 already added it, dedupe.
- CommandCtx EXTENSION: the canonical Unit-F CommandDef has no run() ctx type. Commands need the parsed free-text argument, but the current dispatchCommand signature only passes cwd. Task 3 extends CommandCtx to { cwd; arg; args } (additive) and has dispatchCommand populate it. Unit 1 must expose this ctx, or the assembler must reconcile how the arg remainder reaches run().
- INBOX HAS NO ENQUEUE TODAY: inbox.ts is a derived read-only view (items from runs awaiting permission/input). I ADD enqueueApproval() + an in-memory pendingApprovals queue + a new InboxItem kind:'command' with an `approval` field, and make `run` OPTIONAL on InboxItem (command approvals have no backing run). The web Inbox UI (other unit) must handle kind:'command' items (render approval.command/summary, and an approve action that replays the command). The approve->execute wiring is OUT OF SCOPE here — flagged for the unit that owns inbox actions.
- ChatCommandResult (shared) has kind 'text'|'table'|'error' only — NO 'ack'. CommandDef.resultKind DOES include 'ack'. So danger/ack verbs set resultKind:'ack' on the DEF metadata but their run()/parked result returns kind:'text'. Consistent with canonical Unit-F types; do not add 'ack' to ChatCommandResult.
- PAGE-POINTER verbs (/search /files /memory /schedule /releases) return a text deep-link instead of live data, because those modules keep their data behind Fastify routes with no exported accessor (memory.ts, scheduler.ts, release.ts, metrics.ts). This matches the already-shipped /schedule behavior and avoids exporting new private internals. If a richer inline result is wanted, those modules must first export read accessors — flag to module owners.
- /sessions and /agents intentionally produce identical output (both list non-terminal runs). /agents is the existing shipped alias; /sessions is the spec's verb name. Kept both so listCommands() reports the full curated set. Assembler may collapse to one alias if desired.
- reset-data and self-update danger-verb run() bodies are SAFE STUBS (return a pointer to the confirm page) — they do NOT call registry.resetAllData() or any self-update internals, because with danger:true dispatchCommand parks the approval and run() is never reached. The actual approved-execution path is owned by the inbox-actions unit; wire it there.
- Test files use vi.mock for registry/inbox/git/etc. and dynamic import with FLEET_DATA_DIR tmp dir, matching existing conventions (cov-commands.test.ts, fn-inbox.test.ts). The legacy cov-commands.test.ts still targets the OLD switch-based commands.ts; if Unit 1 already replaced commands.ts with the array form, that legacy test may need updating by Unit 1 — my new cov-commands-registry.test.ts targets the array form.

**Unit 6 — Engine (codex/opencode) degradation + final test/polish pass (Phase 6)**
- DECISION-NUMBER COLLISION: spec §15 names new chat decisions D-033..D-041, but DC.md ALREADY uses D-033 (Hybrid registry, settings-env, line 1165) and D-034 (env loads before config, line 1171). I renumbered the chat decisions to D-035..D-044 (next free block) in Task 8, keeping spec content verbatim with an explicit mapping note. If the assembler reserved a different block or another unit also touches DC.md decisions, re-reconcile the numbers — content is what matters.
- engineSafeState helper (Task 2) is something I introduce ONLY IF Unit 1/4 did not already export a session-state derivation that is engine-safe. The implementer must grep for the real derivation (deriveSessionState / inline in the route) first and either test the existing one or extract engineSafeState. Coordinate with Unit 1 (chat-scoped SSE + GET /api/chat/sessions/:id) and Unit 4 (chatLive.ts live manager) which OWN the state/live derivation — do not duplicate it.
- ChatSessionList now requires onKill/onResume props (Task 3) and ChatComposer gains optional engine/running/onStop props (Task 4). Unit 8/whoever rewrites these components per spec §10 (ChatComposer is a full rewrite, ChatSessionList a modify) MUST preserve: (a) engine rows hide Kill/Resume + show the one-shot badge, (b) Stop suppressed for engine sessions. Keep these slices when integrating the larger rewrites.
- Task 3/4 wire onKill/onResume/engine/running from apps/web/app/chat/page.tsx using existing api.stop(runId)/api.resume(runId). The page edit collides with whatever Unit wires the chat-scoped stream + session_state into page.tsx — merge carefully; my handlers key off session.runId which may need updating once the live-state derivation lands.
- Task 5/6 list the key suites to run green but reference test files OTHER units create (fn-chatlive, fn-files-find, fn-chat-stream, fn-slashmenu, fn-mentionmenu, fn-chatthread, fn-chatcomposer). Those names are placeholders — substitute the actual filenames the other units ship. The assembler should reconcile the suite list once all units' test filenames are known.
- buildEnginePrompt and the engine branch in startTurn already exist and already implement emulated resume (chat.ts lines 107-144). Tasks 1-2 are largely characterization tests that LOCK existing behavior; no behavior change to startTurn is required for engine resume itself — the new behavior is purely the UI gating (Tasks 3-4) and the engineSafeState guard (Task 2).
- registry.resume() engine 409 is ALREADY covered at cov-registry.test.ts:508 ('throws 409 engine-unsupported'). Task 1's server test does not duplicate that registry-internal assertion as the primary subject; it asserts the CHAT LAYER never reaches that path. Avoid the assembler double-counting these as the same test.

**Foundations notes**
- Repo migration idiom: db.ts adds columns via a try/catch loop swallowing /duplicate column name/i (lines 169-199). For chat_messages (owned by chat.ts, NOT db.ts) I specced a PRAGMA table_info('chat_messages') existence-check guard instead — clearer for a single ALTER and equally idempotent across repeated test runs. Both are additive and safe on old DBs; either is acceptable, but the plan uses the table_info guard as the spec asked for a pragma/table-info check.
- ALL Unit F type changes are PURELY ADDITIVE — every new field on ChatSession/ChatMessage/ChatTurnRequest is optional, so existing server + web code that constructs these without the new fields keeps compiling. Task 2 Step 9 verifies this with `pnpm --filter @fleet/server typecheck`.
- Pure types have no runtime, so Tasks 1-2 are TDD-verified via a throwaway `__typecheck_*.ts` assertion file that makes `pnpm --filter @fleet/shared typecheck` fail first, then pass, then is deleted. This is the honest 'see it fail → see it pass' loop for compile-time contracts.
- NormalizedEventType is intentionally NOT extended in Unit F. The spec's `session_state` is a chat-stream control envelope (not a run event) and belongs to Unit 1's stream route; it reuses ChatSessionState (defined here). Flagging so Unit 1 does not assume Unit F added it to the run-event union.
- config.ts has TWO config surfaces: (a) the validated, persisted PortalConfig (maxConcurrentRuns etc., guarded by validateConfig) and (b) plain top-level env-number module constants (PORT, WEB_PORT). CHAT_LIVE_MAX / CHAT_IDLE_SUSPEND_MS are a DEDICATED chat budget separate from PortalConfig.maxConcurrentRuns by design (spec §3.2), so they are (b)-style constants — NOT added to PortalConfig/validateConfig. Do not route them through validateConfig.
- The server test DB is the real data/fleet.db; chat-attachments.test.ts creates a throwaway session and calls chatRepo.deleteSession to clean up (matching the existing chat.test.ts convention). The migration's table_info guard is what makes re-running the suite safe.
- chat.ts default-exports the better-sqlite3 `db` handle (`export default db;`) AND named-exports `chatRepo` — the attachments test imports both (`import db, { chatRepo } from '../src/chat.js'`). Confirmed db is the module's default export.
- Test command nuance: `pnpm --filter @fleet/server test <substr>` runs vitest with <substr> as a filename filter, so `test cov-config-chat` / `test chat-attachments` / `test chat.test` each scope to the intended file(s). `chat.test` is used (not bare `chat`) to avoid also matching chat-attachments.test.ts when checking regressions.
