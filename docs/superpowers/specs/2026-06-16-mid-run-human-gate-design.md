# Mid-run Human Gate (`ask_human` MCP tool) — Design

**Date:** 2026-06-16
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** `apps/server` (control plane), `apps/web` (Inbox UI)

## Problem

When an agent run needs a decision from the operator *mid-run* — e.g. `/deep-research`
asking the user to pick a research scope — there is no way for the operator to answer.
Observed in session `d43cfe2c`: the deep-research skill called `AskUserQuestion`, got no
answer, and proceeded with defaults; then ran a single ~35-min autonomous turn that the
operator killed before it produced a result.

### Why the existing gates don't cover this (investigation findings)

- **The Inbox / `awaiting-input` gate works** but is **end-of-turn only**. A run reaches
  `awaiting-input` only when `resultSeen && interactive` (`registry.ts:845`), i.e. *between*
  turns. A long single autonomous turn (deep-research spawns subagents + synthesizes,
  emitting no `result` until the end) never reaches it mid-run. Verified: a held
  `claude -p --input-format stream-json --verbose` process stays alive after a result and
  handles multiple turns, so the end-of-turn gate itself is sound.
- **`AskUserQuestion` cannot be intercepted in headless mode.** Under `-p` it auto-resolves
  (no TTY) and the agent proceeds with defaults — exactly what happened in `d43cfe2c`.
- **Permission-gating is unavailable.** Per `registry.ts:1192`, this CLI has no
  `--permission-prompt-tool` and `can_use_tool` "may not fire under `-p` at all" — the
  permission path is dormant headless.
- **MCP tools DO work under `-p`.** The portal already injects MCP servers
  (`mcp__personal-rag`, `context7`, the SearXNG add-on via `claude mcp add`), and
  `learner.ts` already passes inline `--mcp-config`. claude **2.1.178 supports HTTP-transport
  MCP** (`--transport http`). A blocking MCP tool is therefore the one viable primitive.

**Key consequence:** because the agent blocks on the *tool call* (answered over HTTP), the
gate works for **one-shot and interactive runs alike** — it does not depend on stdin or the
interactive launch mode.

## Goal

Give agents a first-class way to ask the operator a structured question mid-run and block
until answered, surfaced as a gate in the Inbox. Specifically unblock the deep-research
scope-question case.

### Non-goals (v1)

- Intercepting/replacing `AskUserQuestion` itself (we route around it via a system-prompt
  nudge + a dedicated tool).
- Persisting pending gates across server restarts.
- Multi-question batches (one question per call).
- Changing the launch interactive/one-shot model (orthogonal; not needed here).

## Architecture

The fleet server (Fastify, already running) hosts an **in-process HTTP MCP endpoint**
exposing a single tool, `ask_human`. At launch the portal injects this server **per-run**
via `--mcp-config` (the inline-config mechanism `learner.ts` already uses), with the run's
**session id baked into the URL path** so the handler can attribute the call to a run.

When an agent calls `ask_human`, the handler creates a pending gate, surfaces it in the
Inbox, and **awaits an in-process promise**. Answering the gate in the Inbox resolves the
promise; the tool returns the selection as its result and the agent continues with the real
answer.

```
launch ── buildArgs injects --mcp-config(fleet-gate, url=/mcp/gate/<sessionId>)
          + allowedTools += mcp__fleet-gate__ask_human
          + appended system-prompt nudge
   │
agent calls ask_human(question, options[], multiSelect?, allowFreeText?)
   │  (HTTP MCP → fleet, in-process)
gate.ts: create pending gate {id, sessionId, question, options, resolve}; await promise
   │
Inbox shows kind:'question' for the run  ──►  operator picks option(s)
   │
POST /api/inbox/questions/:id/answer { selection }  →  resolveGate(id, selection)
   │
ask_human tool returns selection  →  agent continues
```

## Components

New module **`apps/server/src/gate.ts`** owns the gate logic so `inbox.ts` stays small.

1. **Pending-gate store** (`gate.ts`) — `Map<id, PendingGate>` where
   `PendingGate = { id, sessionId, question, options, multiSelect, allowFreeText, createdAt, resolve, reject }`.
   Bounded like `pendingApprovals` (drop/oldest cap) as a runaway guard.
2. **HTTP MCP endpoint** — `POST /mcp/gate/:sessionId` served in-process, advertising the
   tool `ask_human({ question: string, options: string[], multiSelect?: boolean, allowFreeText?: boolean })`.
   Handler resolves `sessionId` → run, parks a gate, awaits its promise, returns the
   selection as MCP tool-result content.
3. **Inbox integration** (`inbox.ts`) — `getInboxItems()` appends `kind: 'question'` items
   from `gate.ts` (run slim shape + question + options), alongside `permission` / `input` /
   `command`.
4. **Resolve route** (`inbox.ts`) — `POST /api/inbox/questions/:id/answer { selection }` →
   `resolveGate(id, selection)`. Unknown id → no-op (mirrors `resolveApproval`).
5. **Launch wiring** (`registry.ts` / `processManager.ts` `buildArgs`) — inject the
   `--mcp-config` for `fleet-gate`, add `mcp__fleet-gate__ask_human` to `allowedTools`, and
   append a system-prompt nudge:
   > "To ask the operator a question, call the `ask_human` tool — `AskUserQuestion` will not
   > reach them in this environment. Block on `ask_human` for any decision you need from a human."
6. **Inbox UI** (`apps/web/app/inbox/page.tsx`) — render `question` items: the prompt + option
   buttons (and a free-text field when `allowFreeText`), POSTing to the answer route.

## Data flow & lifecycle

- **Happy path:** as in the diagram above.
- **Run killed while a gate is pending:** registry stop/terminal path notifies `gate.ts` to
  **reject** that run's pending gate(s) → the MCP call returns a tool error → the gate leaves
  the Inbox. (Hook into the existing terminal notification, e.g. `notifyTerminal`.)
- **Gate TTL (optional, configurable):** a long default timeout (e.g. `FLEET_GATE_TTL_MS`,
  default off or generous) resolves with a "no answer — proceeding" result so an agent can't
  hang forever; surfaced in the tool result text.
- **Server restart:** in-memory gates are lost; the agent's blocked MCP call ends when the run
  is killed. Documented limitation (matches today's `pendingApprovals` behavior).

## Security

- Endpoint bound to `127.0.0.1` only (local desktop app).
- The session id in the URL path acts as a capability; the answer route is the existing
  same-origin control-plane API.

## Error handling

- Unknown answer id → no-op (idempotent, like `resolveApproval`).
- Malformed `ask_human` args → MCP tool returns a validation error to the agent.
- Duplicate concurrent gates for one run → allowed; each has its own id and Inbox item.

## Testing

- **Unit:** gate store enqueue/resolve/reject; `getInboxItems()` includes `question` items;
  answer route resolves and returns the selection; terminal-reject drops pending gates.
- **Integration:** start the HTTP MCP endpoint in-process, perform an MCP `ask_human` call,
  assert it blocks, answer via the route, assert the tool result carries the selection.
- **Spike (first implementation step):** drive a real `claude` run that calls `ask_human` over
  the injected HTTP MCP server; confirm it blocks and resumes on answer. (Extends the
  feasibility spike already run by hand.)
- **Manual E2E:** `/deep-research` in the portal → scope question appears in the Inbox →
  answer → research proceeds with the chosen scope.

## Open questions for the plan

- Exact in-process HTTP-MCP serving approach (Fastify route implementing the MCP HTTP
  protocol vs. a tiny embedded MCP server lib). The spike settles this.
- Whether to inject `fleet-gate` into **all** runs or gate it behind a setting. Default:
  all claude runs (cheap; the tool is only used when the agent calls it).
- Free-text answer shape in the MCP result (string vs `{ selection, text }`).
