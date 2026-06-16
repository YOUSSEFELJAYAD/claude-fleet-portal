# Mid-run Human Gate (`ask_human` MCP tool) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent block mid-run on a structured question that the operator answers from the Inbox, via a portal-hosted `ask_human` MCP tool.

**Architecture:** The fleet process runs a small in-process HTTP MCP listener exposing one tool, `ask_human`. `gate.ts` holds an in-memory pending-gate store (shared with `inbox.ts`). A tool call parks a gate and awaits an in-process promise; an Inbox answer route resolves it and the tool returns the operator's selection. The server injects the gate server per-run via `--mcp-config`, adds the tool to `allowedTools`, and appends a system-prompt nudge.

**Tech Stack:** TypeScript, Fastify, Node `http`, vitest. MCP transport decided by the Task 1 spike (official `@modelcontextprotocol/sdk` HTTP transport vs. a hand-rolled JSON-RPC handler).

Spec: `docs/superpowers/specs/2026-06-16-mid-run-human-gate-design.md`

---

### Task 1: Spike — minimal HTTP MCP endpoint with run attribution

De-risk the transport before building anything. No tests; produces a decision + a thin working module.

**Files:**
- Create (scratch): `apps/server/scratch/gate-spike.mjs` (delete after)

- [ ] **Step 1: Stand up a minimal HTTP MCP listener.** Implement `initialize`, `notifications/initialized`, `tools/list` (advertising `ask_human`), and `tools/call` over Streamable HTTP on `127.0.0.1:<port>`. Try the official `@modelcontextprotocol/sdk` (`McpServer` + `StreamableHTTPServerTransport`) first: `cd apps/server && pnpm add @modelcontextprotocol/sdk`. If integration is heavy, fall back to a hand-rolled JSON-RPC 2.0 POST handler (the protocol is JSON-RPC; handle the four methods above, respond `application/json`, honor `Mcp-Session-Id`).

- [ ] **Step 2: Make `tools/call` for `ask_human` block, then return a canned result** after 3s (simulating an answer): `{ content: [{ type: 'text', text: 'A' }] }`.

- [ ] **Step 3: Drive a real claude run against it.** Use the verified FIFO harness:
```bash
PORT=<port>; mkfifo /tmp/gin
( claude -p --input-format stream-json --output-format stream-json --verbose \
   --model claude-haiku-4-5-20251001 \
   --mcp-config '{"mcpServers":{"fleet-gate":{"type":"http","url":"http://127.0.0.1:'$PORT'/mcp"}}}' \
   --allowedTools mcp__fleet-gate__ask_human </tmp/gin >/tmp/gout.log 2>&1 ) &
exec 3>/tmp/gin
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Call the ask_human tool with question \"A or B?\" and options [\"A\",\"B\"]. Then tell me what I picked."}]}}' >&3
```
Expected: `gout.log` shows a `tool_use` for `mcp__fleet-gate__ask_human`, the run blocks ~3s, then continues and reports "A".

- [ ] **Step 4: Decide run attribution.** Confirm whether the session id can ride the URL path (`/mcp/<sessionId>`) or a header (`--mcp-config` supports `headers`). Record the working shape.

- [ ] **Step 5: Write findings to the plan.** Append a short "Spike result" note here: chosen transport (SDK vs hand-rolled), endpoint shape, attribution mechanism, and the exact `--mcp-config` JSON. Delete `apps/server/scratch/`. Commit:
```bash
git rm -r apps/server/scratch 2>/dev/null; git add -A && git commit -m "spike: confirm ask_human HTTP MCP transport + run attribution"
```

> Tasks 2, 4, 5, 7 are transport-independent and can proceed even if Task 1 needs iteration.

---

### Task 2: Pending-gate store (`gate.ts`)

**Files:**
- Create: `apps/server/src/gate.ts`
- Test: `apps/server/test/fn-gate.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, enqueueGate, resolveGate, listGates } from '../src/gate.js';

describe('gate store', () => {
  beforeEach(() => __clearGatesForTests());

  it('enqueues a gate and lists it', () => {
    const { id } = enqueueGate({ sessionId: 's1', question: 'A or B?', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    const gates = listGates();
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ id, sessionId: 's1', question: 'A or B?', options: ['A', 'B'] });
  });

  it('resolveGate settles the awaited promise with the selection and removes the gate', async () => {
    const g = enqueueGate({ sessionId: 's1', question: 'q', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    const settled = g.answer; // Promise<{ selection: string[]; text?: string }>
    resolveGate(g.id, { selection: ['B'] });
    await expect(settled).resolves.toEqual({ selection: ['B'] });
    expect(listGates()).toHaveLength(0);
  });

  it('rejectGatesForSession rejects pending gates for a run', async () => {
    const g = enqueueGate({ sessionId: 's9', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    const { rejectGatesForSession } = await import('../src/gate.js');
    rejectGatesForSession('s9', 'run ended');
    await expect(g.answer).rejects.toThrow('run ended');
    expect(listGates()).toHaveLength(0);
  });

  it('resolveGate on an unknown id is a no-op', () => {
    expect(() => resolveGate('nope', { selection: ['A'] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/server && pnpm vitest run test/fn-gate.test.ts`
Expected: FAIL — `gate.js` not found.

- [ ] **Step 3: Write minimal implementation**
```ts
// apps/server/src/gate.ts
import { randomUUID } from 'node:crypto';

export interface GateAnswer { selection: string[]; text?: string }
export interface PendingGate {
  id: string;
  sessionId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  createdAt: number;
  answer: Promise<GateAnswer>;
}
interface GateInternal extends PendingGate {
  resolve: (a: GateAnswer) => void;
  reject: (e: Error) => void;
}

const gates = new Map<string, GateInternal>();
const MAX_GATES = 64; // runaway guard, mirrors inbox pendingApprovals

export function enqueueGate(input: {
  sessionId: string; question: string; options: string[]; multiSelect: boolean; allowFreeText: boolean;
}): PendingGate {
  let resolve!: (a: GateAnswer) => void;
  let reject!: (e: Error) => void;
  const answer = new Promise<GateAnswer>((res, rej) => { resolve = res; reject = rej; });
  const g: GateInternal = {
    id: randomUUID(), createdAt: Date.now(), answer, resolve, reject,
    sessionId: input.sessionId, question: input.question, options: input.options,
    multiSelect: input.multiSelect, allowFreeText: input.allowFreeText,
  };
  // swallow unhandled-rejection if no one awaits (e.g. immediate reject)
  answer.catch(() => {});
  gates.set(g.id, g);
  if (gates.size > MAX_GATES) {
    const oldest = [...gates.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) { oldest.reject(new Error('gate evicted (queue full)')); gates.delete(oldest.id); }
  }
  return g;
}

export function listGates(): PendingGate[] { return [...gates.values()]; }

export function resolveGate(id: string, answer: GateAnswer): void {
  const g = gates.get(id);
  if (!g) return;
  gates.delete(id);
  g.resolve(answer);
}

export function rejectGatesForSession(sessionId: string, reason: string): void {
  for (const g of [...gates.values()]) {
    if (g.sessionId === sessionId) { gates.delete(g.id); g.reject(new Error(reason)); }
  }
}

export function __clearGatesForTests(): void {
  for (const g of gates.values()) g.reject(new Error('cleared'));
  gates.clear();
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/server && pnpm vitest run test/fn-gate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/gate.ts apps/server/test/fn-gate.test.ts
git commit -m "feat(server): pending-gate store for ask_human mid-run gating"
```

---

### Task 3: `ask_human` MCP tool handler

Wire the Task 1 transport to `gate.ts`. The handler validates args, calls `enqueueGate`, awaits `answer`, and returns the selection as MCP tool-result content. Uses the endpoint shape recorded in the Task 1 spike note.

**Files:**
- Create: `apps/server/src/gateServer.ts` (the in-process HTTP MCP listener)
- Modify: `apps/server/src/server.ts` (start it in `buildServer`/boot; export its port)
- Test: `apps/server/test/fn-gate-tool.test.ts`

- [ ] **Step 1: Write the failing test** — exercise the tool handler directly (transport-agnostic), not the wire protocol:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, listGates, resolveGate } from '../src/gate.js';
import { handleAskHuman } from '../src/gateServer.js';

describe('ask_human handler', () => {
  beforeEach(() => __clearGatesForTests());

  it('parks a gate, blocks, and returns the selection as text content', async () => {
    const p = handleAskHuman('s1', { question: 'A or B?', options: ['A', 'B'] });
    // gate is now pending
    const g = listGates()[0];
    expect(g.sessionId).toBe('s1');
    resolveGate(g.id, { selection: ['B'] });
    const result = await p;
    expect(result).toEqual({ content: [{ type: 'text', text: 'B' }] });
  });

  it('joins multi-select answers and appends free text', async () => {
    const p = handleAskHuman('s1', { question: 'q', options: ['A', 'B'], multiSelect: true, allowFreeText: true });
    const g = listGates()[0];
    resolveGate(g.id, { selection: ['A', 'B'], text: 'also C' });
    const result = await p;
    expect(result.content[0].text).toBe('A, B\n\nNote: also C');
  });

  it('rejects malformed args with an error result (no throw to transport)', async () => {
    const result = await handleAskHuman('s1', { options: ['A'] } as any);
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/server && pnpm vitest run test/fn-gate-tool.test.ts`
Expected: FAIL — `gateServer.js` / `handleAskHuman` not found.

- [ ] **Step 3: Write minimal implementation** — `handleAskHuman` (pure, testable) + the listener using the spike's chosen transport:
```ts
// apps/server/src/gateServer.ts (excerpt — listener wiring per Task 1 result)
import { enqueueGate } from './gate.js';

export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }

export async function handleAskHuman(
  sessionId: string,
  args: { question?: string; options?: string[]; multiSelect?: boolean; allowFreeText?: boolean },
): Promise<ToolResult> {
  if (!args || typeof args.question !== 'string' || !Array.isArray(args.options) || args.options.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'ask_human requires { question: string, options: string[] }' }] };
  }
  const gate = enqueueGate({
    sessionId,
    question: args.question,
    options: args.options.map(String),
    multiSelect: !!args.multiSelect,
    allowFreeText: !!args.allowFreeText,
  });
  try {
    const a = await gate.answer;
    let text = a.selection.join(', ');
    if (a.text && a.text.trim()) text += `\n\nNote: ${a.text.trim()}`;
    return { content: [{ type: 'text', text: text || '(no selection)' }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: 'text', text: `ask_human cancelled: ${e?.message ?? 'run ended'}` }] };
  }
}

// startGateServer(): bind 127.0.0.1:<port> per the Task 1 spike; route ask_human tool calls to
// handleAskHuman(sessionIdFromRequest, toolArgs). Export GATE_PORT for buildArgs to inject.
```
Wire `startGateServer()` into the server boot in `server.ts` and expose its chosen port via `config.ts` (`GATE_PORT`, default `0` → ephemeral, stored after listen).

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/server && pnpm vitest run test/fn-gate-tool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/gateServer.ts apps/server/src/server.ts apps/server/src/config.ts apps/server/test/fn-gate-tool.test.ts
git commit -m "feat(server): ask_human MCP tool handler + in-process gate listener"
```

---

### Task 4: Inbox `question` items

**Files:**
- Modify: `apps/server/src/inbox.ts` (extend `InboxItem`, `getInboxItems`)
- Test: `apps/server/test/fn-inbox-question.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, enqueueGate } from '../src/gate.js';
import { getInboxItems } from '../src/inbox.js';

describe('inbox question items', () => {
  beforeEach(() => __clearGatesForTests());
  it('surfaces a pending gate as a question item', () => {
    enqueueGate({ sessionId: 's1', question: 'Scope?', options: ['narrow', 'wide'], multiSelect: false, allowFreeText: true });
    const items = getInboxItems();
    const q = items.find((i) => i.kind === 'question');
    expect(q).toBeTruthy();
    expect(q!.question).toMatchObject({ question: 'Scope?', options: ['narrow', 'wide'], allowFreeText: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/server && pnpm vitest run test/fn-inbox-question.test.ts`
Expected: FAIL — `kind` has no `'question'` / `item.question` undefined.

- [ ] **Step 3: Write minimal implementation** — in `inbox.ts`:
```ts
// add to imports
import { listGates } from './gate.js';

// extend the union + InboxItem
export interface InboxQuestion {
  id: string; sessionId: string; question: string; options: string[]; multiSelect: boolean; allowFreeText: boolean; createdAt: number;
}
// InboxItem.kind: 'permission' | 'input' | 'command' | 'question'
// InboxItem.question?: InboxQuestion

// at the end of getInboxItems(), before `return items;`
for (const g of listGates()) {
  items.push({
    kind: 'question',
    question: { id: g.id, sessionId: g.sessionId, question: g.question, options: g.options, multiSelect: g.multiSelect, allowFreeText: g.allowFreeText, createdAt: g.createdAt },
  });
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/server && pnpm vitest run test/fn-inbox-question.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/inbox.ts apps/server/test/fn-inbox-question.test.ts
git commit -m "feat(server): surface pending ask_human gates as inbox question items"
```

---

### Task 5: Answer route (`POST /api/inbox/questions/:id/answer`)

**Files:**
- Modify: `apps/server/src/inbox.ts` (`registerInboxRoutes`)
- Test: `apps/server/test/fn-gate-route.test.ts`

- [ ] **Step 1: Write the failing test** (Fastify `inject`)
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { __clearGatesForTests, enqueueGate, listGates } from '../src/gate.js';
import { registerInboxRoutes } from '../src/inbox.js';

describe('answer route', () => {
  beforeEach(() => __clearGatesForTests());
  it('resolves the gate with the posted selection', async () => {
    const app = Fastify(); registerInboxRoutes(app); await app.ready();
    const g = enqueueGate({ sessionId: 's1', question: 'q', options: ['A', 'B'], multiSelect: false, allowFreeText: false });
    const res = await app.inject({ method: 'POST', url: `/api/inbox/questions/${g.id}/answer`,
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ selection: ['A'] }) });
    expect(res.statusCode).toBe(200);
    await expect(g.answer).resolves.toEqual({ selection: ['A'] });
    expect(listGates()).toHaveLength(0);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/server && pnpm vitest run test/fn-gate-route.test.ts`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Write minimal implementation** — add to `registerInboxRoutes`:
```ts
import { resolveGate } from './gate.js';
// ...
app.post('/api/inbox/questions/:id/answer', async (req) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { selection?: string[]; text?: string };
  resolveGate(id, { selection: Array.isArray(body.selection) ? body.selection.map(String) : [], text: body.text });
  return { ok: true };
});
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/server && pnpm vitest run test/fn-gate-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/inbox.ts apps/server/test/fn-gate-route.test.ts
git commit -m "feat(server): POST /api/inbox/questions/:id/answer resolves a gate"
```

---

### Task 6: Launch wiring (`buildArgs` injects the gate server, tool, and nudge)

**Files:**
- Modify: `apps/server/src/processManager.ts:115` (`buildArgs`)
- Test: `apps/server/test/fn-buildargs-gate.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest';
import { buildArgs } from '../src/processManager.js';

describe('buildArgs gate injection', () => {
  it('injects fleet-gate mcp-config, the ask_human tool, and a nudge', () => {
    const args = buildArgs({ prompt: 'hi', cwd: '/tmp', permissionMode: 'default', effort: 'high', allowedTools: ['Read'] } as any, 'sess-1', false);
    const cfgIdx = args.indexOf('--mcp-config');
    expect(cfgIdx).toBeGreaterThan(-1);
    const cfg = JSON.parse(args[cfgIdx + 1]);
    expect(cfg.mcpServers['fleet-gate']).toBeTruthy();
    expect(JSON.stringify(cfg)).toContain('sess-1'); // session attribution baked in
    const tools = args[args.indexOf('--allowedTools') + 1];
    expect(tools).toContain('mcp__fleet-gate__ask_human');
    const sys = args[args.indexOf('--append-system-prompt') + 1];
    expect(sys).toMatch(/ask_human/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/server && pnpm vitest run test/fn-buildargs-gate.test.ts`
Expected: FAIL — no `--mcp-config`.

- [ ] **Step 3: Write minimal implementation** — in `buildArgs`, build the gate config from `GATE_PORT` and the `sessionId` (attribution shape from Task 1; URL-path form shown):
```ts
import { GATE_PORT } from './config.js';
// after allowedTools handling: append the gate tool
const gateTool = 'mcp__fleet-gate__ask_human';
const allowed = [...(req.allowedTools ?? [])];
if (!allowed.includes(gateTool)) allowed.push(gateTool);
// (replace the existing allowedTools push with `allowed`)

// add the mcp-config (merge with any future inline config carefully; gate-only for now)
const gateUrl = `http://127.0.0.1:${GATE_PORT}/mcp/${sessionId}`;
args.push('--mcp-config', JSON.stringify({ mcpServers: { 'fleet-gate': { type: 'http', url: gateUrl } } }));

// add to the appendSys array, before the `if (appendSys)` join:
const gateNudge = 'To ask the operator a question, call the ask_human tool — AskUserQuestion will NOT reach them in this environment. Block on ask_human for any decision you need from a human.';
// include gateNudge in the appendSys filter list
```
Note: keep `--strict-mcp-config` OFF so the user's other MCP servers still load (unlike `learner.ts`, which isolates).

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/server && pnpm vitest run test/fn-buildargs-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/processManager.ts apps/server/src/config.ts apps/server/test/fn-buildargs-gate.test.ts
git commit -m "feat(server): inject fleet-gate mcp server + ask_human tool + nudge on launch"
```

---

### Task 7: Reject pending gates when a run goes terminal

**Files:**
- Modify: `apps/server/src/registry.ts` (`notifyTerminal`, ~line 125)
- Test: `apps/server/test/fn-gate-terminal.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearGatesForTests, enqueueGate, listGates } from '../src/gate.js';
import { rejectGatesForSession } from '../src/gate.js';

describe('gate cleanup on terminal', () => {
  beforeEach(() => __clearGatesForTests());
  it('rejectGatesForSession clears a run\'s pending gates', async () => {
    const g = enqueueGate({ sessionId: 'sX', question: 'q', options: ['A'], multiSelect: false, allowFreeText: false });
    rejectGatesForSession('sX', 'run terminal');
    await expect(g.answer).rejects.toThrow('run terminal');
    expect(listGates()).toHaveLength(0);
  });
});
```
(The unit covers the mechanism; the `registry.ts` call-site is wired in Step 3 and covered by the manual E2E in Task 9.)

- [ ] **Step 2: Run to verify it fails / passes**
Run: `cd apps/server && pnpm vitest run test/fn-gate-terminal.test.ts`
Expected: PASS for the unit (already exists from Task 2's API) — then proceed to wire the call site.

- [ ] **Step 3: Wire the call site** — in `registry.ts` `notifyTerminal(lr)`, add:
```ts
import { rejectGatesForSession } from './gate.js';
// inside notifyTerminal(lr), after existing notifications:
rejectGatesForSession(lr.run.sessionId, `run ${lr.run.status}`);
```

- [ ] **Step 4: Run the server suite to confirm no regression**
Run: `cd apps/server && pnpm vitest run test/fn-gate-terminal.test.ts test/fn-teamwatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/registry.ts apps/server/test/fn-gate-terminal.test.ts
git commit -m "feat(server): drop pending ask_human gates when a run goes terminal"
```

---

### Task 8: Inbox UI renders `question` items

**Files:**
- Modify: `apps/web/app/inbox/page.tsx`
- Modify: `apps/web/lib/api.ts` (add `answerQuestion`)
- Test: `apps/web/test/cov-inbox-question.test.tsx` (follow the existing inbox test pattern)

- [ ] **Step 1: Write the failing test** — render an inbox with one `question` item; assert the prompt + an option button; clicking it POSTs the selection. Mirror the structure of the existing inbox component test (check `apps/web/test/` for the current pattern and matchers).

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/web && pnpm vitest run test/cov-inbox-question.test.tsx`
Expected: FAIL — no question rendering.

- [ ] **Step 3: Write minimal implementation** — add an `answerQuestion(id, { selection, text })` to `lib/api.ts` (POST the answer route), and a branch in `inbox/page.tsx` that, for `item.kind === 'question'`, renders `item.question.question`, a button per option (multi-select toggles when `multiSelect`), an optional free-text input when `allowFreeText`, and a submit that calls `answerQuestion`.

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/web && pnpm vitest run test/cov-inbox-question.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/app/inbox/page.tsx apps/web/lib/api.ts apps/web/test/cov-inbox-question.test.tsx
git commit -m "feat(web): render ask_human question gates in the Inbox"
```

---

### Task 9: Full-suite gate + manual E2E

**Files:** none (verification)

- [ ] **Step 1: Run the full server + web suites**
```bash
cd apps/server && pnpm vitest run
cd ../web && pnpm vitest run
cd ../.. && pnpm -r typecheck
```
Expected: all green.

- [ ] **Step 2: Manual E2E.** Launch the portal, run `/deep-research <topic>`; confirm the scope question appears in the Inbox as a gate, answer it, and confirm the research proceeds with the chosen scope. If deep-research still calls `AskUserQuestion` instead of `ask_human`, strengthen the nudge wording in `buildArgs` (Task 6) and re-run.

- [ ] **Step 3: Commit any nudge tweak**
```bash
git add -A && git commit -m "chore: tune ask_human nudge after E2E"
```

---

## Self-review notes

- **Spec coverage:** ask_human MCP tool (T1, T3), gate store (T2), inbox question kind (T4), answer route (T5), launch wiring incl. `--mcp-config` + tool + nudge (T6), terminal cleanup (T7), inbox UI (T8), tests + manual deep-research E2E (T9). Open spec questions resolved: inject into all claude runs (T6, default on, no strict-mcp-config); free-text shape = `{ selection: string[]; text?: string }` (T2); TTL deferred (not in v1 — terminal-reject covers the hang case; a timed TTL can be added later without API change).
- **Types:** `GateAnswer { selection: string[]; text? }`, `PendingGate`, `InboxQuestion` consistent across T2/T3/T4/T5/T8. Function names stable: `enqueueGate`, `resolveGate`, `rejectGatesForSession`, `listGates`, `handleAskHuman`, `answerQuestion`.
- **Transport caveat:** T1 is a real spike; T3's listener wiring depends on its outcome (SDK vs hand-rolled, path vs header attribution). All other tasks are transport-independent and TDD-complete.
