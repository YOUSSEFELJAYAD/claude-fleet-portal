# PRD — Claude Fleet Portal (working title)

**A Next.js web portal to launch, monitor, and control a fleet of local Claude Code agents — including Dynamic Workflows, subagents, Agent Teams, and Skills.**

| | |
|---|---|
| **Author** | Youssef El Jayad |
| **Status** | Draft v2 — for review |
| **Date** | 2026-06-08 |
| **Target stack** | Next.js (App Router) · Node backend · Postgres · Redis · WebSocket/SSE |
| **Targets** | Claude Code ≥ v2.1.154 · Claude Opus 4.8 · Agent SDK |

> **v2 changelog:** Added first-class support for the capabilities Anthropic shipped around the Opus 4.8 launch (May 2026): **Dynamic Workflows** (up to 1,000 orchestrated subagents), the **ultracode / effort** controls, **Agent Teams**, and **Skills injection**. These turn the portal from a flat process list into a hierarchical fleet console with much stronger cost guardrails.

---

## 1. Summary

Developers running Claude Code locally have no single place to see what their agents are doing. Each `claude` run lives in its own terminal, progress is buried in scrolling output, and there is no way to start, stop, or steer several agents — let alone the **hundreds of subagents** a single Dynamic Workflow can now spawn — from one screen.

The Claude Fleet Portal is a locally-hosted web application that **owns** Claude Code sessions by spawning them as `claude -p --output-format stream-json` child processes. It parses the streamed events, relays them to a browser in real time, and exposes controls to start, stop, resume, and feed input to each session. Because the portal launches the processes, it gets genuine control. v2 extends this to the new orchestration primitives: it renders the **orchestrator → subagent** hierarchy of Dynamic Workflows, surfaces **Agent Team** coordination (shared task list + peer messages), exposes the **effort / ultracode** dial, and shows which **Skills** are injected into each agent.

---

## 2. Problem & motivation

- **No fleet view.** Multiple concurrent agents = multiple terminal windows. No aggregate "what's running right now."
- **Orchestration is invisible.** A single ultracode run can fan out to 1,000 subagents (16 concurrent). Today you cannot see that tree, only the final answer.
- **Progress is opaque.** Tool calls, results, and token/cost burn scroll past and are lost.
- **No remote control.** You cannot stop a runaway workflow, send a follow-up, or resume a finished session without returning to its terminal.
- **No cost guardrails.** ultracode and Dynamic Workflows consume substantially more tokens than a normal session, with no live budget ceiling or kill switch.
- **No history.** Once a terminal closes, the run context, the workflow tree, and the metrics are gone.

## 3. Goals & non-goals

### Goals
1. One dashboard listing every agent the portal manages, with live status and health.
2. **Hierarchical view** of a run: session → Dynamic Workflow → subagents, and Agent-Team peers.
3. Real-time progress per node: assistant output, tool calls, results, timing, token/cost.
4. Control: start a task, stop/kill, send follow-up input, resume a finished session.
5. Expose the new launch knobs: model (incl. Opus 4.8 + fast mode), **effort level / ultracode**, Dynamic Workflows toggle, attached **Skills**, and **subagent** profiles.
6. Cost & concurrency guardrails sized for workflow-scale token burn: per-run budget ceilings, max concurrent agents/workflows, auto-kill on breach.
7. Durable, searchable history of runs and their full subtree.

### Non-goals (v1/v2)
- Controlling an already-running **interactive** `claude` TUI session started outside the portal. (Not supported — see §11.)
- Re-implementing the Dynamic Workflows runtime. The portal **observes and controls** workflows that Claude Code runs; it does not execute the JS orchestration itself.
- Multi-user RBAC, cloud hosting. (Single-user, localhost first.)
- Building a custom token-tracing UI when OpenTelemetry already exports the metrics.
- Authoring Skills / subagent definitions through the UI (read + attach is enough; editing files is out of scope).

## 4. Users & personas

- **Primary — "The operator" (Youssef).** Runs several agents and workflows for payment/ops/dev tasks; wants one console to watch and intervene.
- **Secondary — "The reviewer."** Audits completed runs — including every subagent a workflow spawned — to see what tools were called and what changed.

## 5. User stories

- As an operator, I start a new agent by entering a prompt + working directory, choosing a model and **effort level (high / xhigh / ultracode)**, and clicking **Run**.
- As an operator, I see all active and recent agents in a grid with status, current step, elapsed, and cost.
- As an operator, I open one run and watch its **workflow tree** expand as subagents spawn, each streaming its own progress.
- As an operator, I watch an **Agent Team's** shared task list and peer messages update live.
- As an operator, I click **Stop** to terminate a misbehaving run (and its whole subtree) immediately.
- As an operator, I type a follow-up instruction into a live agent and it continues.
- As an operator, I **Resume** a finished session to keep working in its context.
- As an operator, I am warned and the run is auto-killed if it exceeds a token/cost ceiling — critical for ultracode runs.
- As a reviewer, I search past runs and replay their event timeline and subtree.

## 6. Platform capabilities the portal must support (verified June 2026)

This section pins the external features the portal integrates with, and the design implication of each. (Sources listed at the end of this PRD.)

| Capability | What it is | Portal implication |
|---|---|---|
| **Claude Opus 4.8** | Flagship model (released 2026-05-28); 1M-token context, 128k max output; strongest computer-use/agent model; regular pricing $5/$25 per M tokens, **fast mode** $10/$50. | Model picker must list Opus 4.8 and a fast-mode toggle; cost math uses the selected tier. |
| **Dynamic Workflows** | Claude writes a JavaScript orchestration script that a runtime executes in the background, fanning out **up to 1,000 subagents total, max 16 concurrent** per run. Plan + intermediate results live in script variables, not the context window. Requires Claude Code ≥ v2.1.154; on by default for Max/Team. | Fleet view becomes a **tree**; portal must track parent/child, concurrency (≤16 live), and the 1,000-total cap; "stop" must cascade to the subtree. |
| **ultracode / effort** | An effort setting (effort menu) that sends `xhigh` reasoning effort **and** auto-orchestrates Dynamic Workflows for substantive tasks. Session-scoped; resets on new session; `/effort high` to drop back. Burns substantially more tokens. | Launch form exposes an effort dial; UI flags ultracode runs and applies stricter budget defaults. |
| **Subagents** | Specialized assistants with isolated context, own tools and permissions; defined as markdown in `~/.claude/agents/*.md` (user) or `.claude/agents/*.md` (project). Report up to parent; cannot talk to each other. | Portal reads available subagent definitions and lets the operator attach a profile; renders each subagent as a child node. |
| **Agent Teams** | 2–16 coordinated Claude Code sessions with a team lead; coordinate via a shared task list at `~/.claude/tasks/{team}/` and peer-to-peer messaging. Experimental; enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. | A "team" view that reads the shared task list + mailbox to show task ownership, dependencies, and messages between peers. |
| **Skills** | `SKILL.md` folders of instructions/scripts loaded dynamically ("skills injection"); work across Claude Code, Agent SDK, Claude.ai. | Per-agent panel shows which Skills are injected; launch form lets the operator attach Skills. |

## 7. Functional requirements

### 7.1 Fleet dashboard
- Grid/list of runs: short `session_id`, task summary, status badge, model + effort, elapsed, tokens, cost, last-activity, **subagent count / max-depth**.
- Status states: `starting`, `running`, `awaiting-input`, `awaiting-permission`, `orchestrating` (workflow active), `completed`, `failed`, `killed`.
- Filter by status/effort/team; sort by start time / cost. Preferences persist locally.
- Push-based auto-refresh.

### 7.2 Launch an agent
- Form fields: prompt, working directory, **model** (Opus 4.8 / others) + **fast-mode** toggle, **effort level** (`high` / `xhigh` / `ultracode`), **Dynamic Workflows** allow/deny, **Skills** to attach, **subagent profile** (optional), permission mode, allowed tools, **budget ceiling**.
- Backend spawns `claude -p` with the chosen flags (§9.2) and registers the run.

### 7.3 Live run detail — hierarchical
- **Tree view**: root session → Dynamic Workflow → subagents (lazy-expand; respects 16-concurrent / 1,000-total reality).
- Each node streams its own timeline: assistant text (incl. partial deltas), `tool_use` (name + input), `tool_result` (output + `duration_ms`), and a final `result` (cost/tokens/duration).
- Aggregated run totals roll up from the subtree: tokens in/out, estimated cost, elapsed, live-subagent count.
- Raw event log (collapsible) per node for debugging.

### 7.4 Agent Teams view
- Render the **shared task list** (`~/.claude/tasks/{team}/`): tasks with status, owner, dependencies.
- Render the **mailbox**: peer-to-peer messages between teammates.
- Show each teammate session as a node with its own live timeline.

### 7.5 Skills visibility
- Per-agent panel listing injected Skills (name, source/scope). Read-only display; attach-at-launch only.

### 7.6 Control actions
- **Stop** → SIGINT/SIGTERM to the run's process; **cascades** to terminate an active workflow's subtree; mark `killed`.
- **Send input** → write a stream-json user message to stdin (requires `--input-format stream-json`).
- **Resume** → relaunch with `--resume <session_id>`.
- **Approve / Deny** → respond to `awaiting-permission` events when not in skip-permissions mode.

### 7.7 Cost & concurrency guardrails
- Configurable caps: max concurrent **runs**, and awareness of the **16-concurrent / 1,000-total subagent** ceilings within a workflow.
- Per-run budget ceiling (USD or tokens); on breach → warn, then auto-kill the run + subtree. **Stricter default ceilings for ultracode runs.**
- Global daily-spend display; per-run and per-subtree cost breakdown.

### 7.8 History & persistence
- Every run persisted (metadata + event stream + subtree topology) and searchable by date, status, cwd, effort, team, text.
- Replay a completed run's timeline and tree.

## 8. System architecture

```
┌────────────────────────┐      WebSocket / SSE      ┌──────────────────────────────┐
│  Next.js portal (UI)   │ ◀───────live events──────│  Backend / control plane     │
│  - Fleet grid          │ ──────REST commands─────▶ │  - Process manager           │
│  - Run tree (workflow/ │                           │  - stream-json line parser   │
│    subagents)          │                           │  - Hierarchy/tree builder    │
│  - Agent Teams view    │                           │  - Team-state watcher        │
│  - Controls + effort   │                           │  - Registry + guardrails     │
└────────────────────────┘                           └───────────┬──────────────────┘
                                                                  │ spawn() / stdin / signals
                                                                  ▼
                                              ┌──────────────────────────────────────┐
                                              │  claude -p child processes            │
                                              │   └─ Dynamic Workflow runtime (bg JS)  │
                                              │        └─ subagents (≤16 concurrent)   │
                                              └──────────────────────────────────────┘
   Postgres (runs, events, subtree, teams, config)  ·  Redis (live status, heartbeats, queue)
   Filesystem watchers:  ~/.claude/tasks/{team}/  (team task list + mailbox)
   OpenTelemetry (CLAUDE_CODE_ENABLE_TELEMETRY=1 → tokens, cost, counts)
```

**Why the portal owns the processes:** spawning via `claude -p` is the only path that yields real control (stop via signal, input via stdin, resume via `--resume`) plus a machine-readable event stream. Workflow subagents are observed through that stream and rolled into the tree; Agent-Team coordination is observed by watching the shared task-list directory.

### 8.1 Components
- **Next.js (App Router)** — UI; route handlers / server actions for commands; SSE/WebSocket client for live events.
- **Process manager** (Node) — `child_process.spawn('claude', [...])`, one process per run; tracks PID; handles stdout/stderr buffering, stdin writes, signals; cascades kills.
- **Stream parser + tree builder** — buffers stdout, splits on `\n`, `JSON.parse` each line, normalizes events, and assembles the orchestrator→subagent hierarchy from parent/child identifiers in the stream.
- **Team-state watcher** — `fs.watch` on `~/.claude/tasks/{team}/` to surface shared tasks + mailbox for Agent Teams.
- **Registry & guardrails** — source of truth for runs/subtrees; enforces concurrency caps and budget ceilings; emits heartbeats to Redis.
- **Datastores** — Postgres (runs, events, subtree topology, teams, config); Redis (hot status, heartbeats, launch queue).

## 9. Technical design details

### 9.1 Event normalization
```
{ sessionId, runId, parentId, nodeType, seq, ts, type, payload }
nodeType ∈ { root, workflow, subagent, teammate }
type     ∈ { init, assistant_text, assistant_partial, tool_use, tool_result,
             permission_request, subagent_spawned, subagent_done, result, error, exit }
```
`parentId` + `nodeType` are what let the UI render the tree without parsing raw CLI JSON.

### 9.2 `claude -p` invocation (reference)
```
claude -p "<task>" \
  --output-format stream-json \
  --input-format stream-json \      # enables follow-up input via stdin
  --verbose \
  --include-partial-messages \      # token-delta streaming
  --model claude-opus-4-8 \         # + fast-mode tier where selected
  --permission-mode <mode> \        # or --dangerously-skip-permissions for unattended workers
  --allowedTools "<list>" \
  [--resume <session_id>]
```
Effort/ultracode and Dynamic Workflows are session/runtime concerns; confirm the exact CLI/settings switches against the installed Claude Code version (see §11, open question on flag surface). Implementation notes: **buffer stdout by newline**; capture `session_id` from `init`; treat `result` or process exit as completion; map non-zero exit to `failed`; detect subagent spawn/teardown events to grow/prune the tree.

### 9.3 Data model (Postgres, indicative)
- `runs` — `id, session_id, task, cwd, model, fast_mode, effort, workflows_enabled, team_id, status, started_at, ended_at, tokens_in, tokens_out, cost_usd, exit_code`
- `run_nodes` — `id, run_id, parent_id, node_type, label, status, tokens_in, tokens_out, cost_usd` *(subtree topology)*
- `events` — `id, run_id, node_id, seq, ts, type, payload_jsonb`
- `teams` — `id, name, lead_session_id, task_dir`
- `run_skills` — `run_id, skill_name, scope`
- `config` — `max_concurrent_runs, default_budget, ultracode_budget, permission_defaults, …`

### 9.4 API (indicative)
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/agents` | Launch a run (prompt, cwd, model, effort, workflows, skills, subagent, budget) |
| `GET` | `/api/agents` | List runs (fleet view) |
| `GET` | `/api/agents/:id` | Run detail + subtree |
| `GET` | `/api/agents/:id/tree` | Workflow/subagent hierarchy |
| `GET` | `/api/agents/:id/stream` | SSE/WebSocket live events (root + subtree) |
| `POST` | `/api/agents/:id/input` | Write follow-up input to stdin |
| `POST` | `/api/agents/:id/resume` | Resume a finished session |
| `DELETE` | `/api/agents/:id` | Stop/kill run + cascade subtree |
| `POST` | `/api/agents/:id/permission` | Approve/deny a pending tool call |
| `GET` | `/api/teams/:id` | Agent-Team task list + mailbox |
| `GET` | `/api/skills` | Available Skills to attach |
| `GET` | `/api/subagents` | Available subagent profiles (`~/.claude/agents`) |

## 10. Non-functional requirements
- **Performance** — live event latency < 250 ms emit→render; dashboard handles ≥ 25 concurrent runs and a 16-wide workflow subtree smoothly.
- **Reliability** — backend restart recovers registry + subtree from Postgres; orphaned PIDs reconciled on boot.
- **Security** — localhost-bound by default; auth required if exposed; never log secrets from payloads; treat file/edit tool actions as privileged.
- **Cost safety** — concurrency caps and per-run/subtree budget kills enforced server-side; ultracode runs get tighter defaults because they amplify token burn.
- **Observability** — enable `CLAUDE_CODE_ENABLE_TELEMETRY=1` for OpenTelemetry metrics rather than recomputing them.
- **Portability** — macOS/Linux dev machines; no cloud dependency.

## 11. Constraints & assumptions
- Claude Code **≥ v2.1.154** installed and authenticated; Dynamic Workflows availability depends on plan (Max/Team/Enterprise) and is a **research preview** — treat as feature-flagged.
- `stream-json` event schema and the exact **subagent/workflow event identifiers** are not fully documented — parse defensively; verify the tree-building fields against the installed version.
- The Dynamic Workflows **JS runtime runs in the background**; the portal observes its subagents via the event stream and does not run the orchestration itself.
- ~~**Abort and session-resume are mutually exclusive** — "stop" is terminal, not pause-and-resume.~~ **Superseded by DC D-044 (2026-06-14):** the registry resumes terminal/killed runs (kill is not delete); chat sessions are always-live with resumable fallback.
- ultracode is **session-scoped** and resets on a new session; the portal must model effort per-run, not globally.
- No supported API drives an already-running interactive TUI session — control is limited to portal-spawned runs.
- Agent Teams is **experimental** and gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`; the shared task-list path (`~/.claude/tasks/{team}/`) is the integration surface.

## 12. Phased delivery

**Phase 1 — Read-only MVP.** Spawn `claude -p`, parse stream-json, fleet grid + single-session live detail. *Proves the streaming pipeline.*

**Phase 2 — Control.** Stop (signal), send input (stdin), resume; full status lifecycle.

**Phase 3 — Hierarchy.** Render Dynamic Workflow trees (orchestrator → subagents), cascade-kill, subtree cost roll-ups. Add effort/ultracode + model/fast-mode to the launch form.

**Phase 4 — Teams & Skills.** Agent-Team view (shared task list + mailbox), Skills visibility + attach, subagent profiles.

**Phase 5 — Guardrails & history.** Budget ceilings + auto-kill (tight ultracode defaults), Postgres history, search & replay, OpenTelemetry metrics panel.

## 13. Success metrics
- Operator can start, watch, and stop a run end-to-end from the portal without a terminal.
- 100% of a workflow's spawned subagents appear in the tree with correct parent/child.
- Zero runs exceed their configured budget ceiling without being auto-killed.
- Live event latency consistently < 250 ms.
- Agent-Team task ownership and peer messages render within 1 s of the underlying files changing.

## 14. Open questions
1. **Backend runtime** — Node-only (simplest for spawn + stdin + fs.watch) vs Spring Boot to match your stack. Recommendation: Node for the agent-runner, optionally a Spring BFF if you want to reuse existing services.
2. **Workflow event surface** — confirm the exact stream-json fields that identify a subagent's parent and lifecycle on the installed Claude Code version; the tree builder depends on them.
3. **Effort/ultracode control path** — confirm whether effort is set via CLI flag, `settings.json`, or an in-session command in headless mode, so the launch form drives it correctly.
4. **SSE vs WebSocket** — SSE likely sufficient for one-directional streaming of a wide subtree; WebSocket only if we want a single bidirectional channel.
5. **Auth** — pure localhost for v1, or token-protected from day one for LAN access?

---

*Working title "Claude Fleet Portal" — rename as desired (e.g., to fit a CIPs-style naming convention). Capability facts in §6 verified via web research on 2026-06-08; re-verify against the installed Claude Code version before implementation, as these features are evolving quickly.*
