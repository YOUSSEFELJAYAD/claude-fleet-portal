/**
 * F6 — Approval inbox (PRD §F6).
 *
 * GET /api/inbox → derives items from registry live runs with status
 * awaiting-permission or awaiting-input.  No new mutation endpoints —
 * actions reuse the existing /api/agents/:id/permission and /input routes.
 *
 * Slim run shape: { id, task, cwd, model, status, startedAt, costUsd }
 * Permission items include the LATEST permission_request event payload.
 * Input items include a lastText preview (last assistant_text, 400 chars).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { NormalizedEvent, ChatCommandResult } from '@fleet/shared';
import { registry } from './registry.js';
import { repo } from './db.js';
import { listGates, resolveGate } from './gate.js';
import { listPermissions, resolvePermission } from './permissionGate.js';

/** Cap an agent-supplied permission tool_input for over-the-wire transport. The inbox is polled
 *  frequently and a single Write/Edit input can approach the 4MB body limit; the operator only
 *  needs a readable preview to decide, and the card truncates for display anyway. */
const MAX_INPUT_CHARS = 4000;
function truncateInput(input: unknown): unknown {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return '[unserializable tool input]';
  }
  if (s == null) return input; // undefined/null serialize to undefined — keep as-is
  return s.length > MAX_INPUT_CHARS ? `${s.slice(0, MAX_INPUT_CHARS)}… [${s.length - MAX_INPUT_CHARS} more chars truncated]` : input;
}

export interface SlimRun {
  id: string;
  task: string;
  cwd: string;
  model: string;
  status: string;
  startedAt: number;
  costUsd: number;
}

export interface InboxPermissionRequest {
  id: string;
  payload: {
    tool: string;
    input: unknown;
  };
}

export interface InboxQuestion {
  id: string;
  sessionId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  createdAt: number;
}

/** A destructive slash-command parked for operator approval (it did NOT execute). */
export interface CommandApproval {
  id: string;
  command: string;   // the verb, e.g. 'reset-data'
  summary: string;   // human-readable description of what will happen on approve
  cwd: string;
  /** the full slash-command line to replay on approve, e.g. '/reset-data'. */
  line: string;
  createdAt: number;
}

export interface InboxItem {
  /** present for derived run items; omitted for parked command approvals. */
  run?: SlimRun;
  kind: 'permission' | 'input' | 'command' | 'question';
  request?: InboxPermissionRequest;
  lastText?: string;
  /** present iff kind === 'command'. */
  approval?: CommandApproval;
  /** present iff kind === 'question'. */
  question?: InboxQuestion;
  /** F-perm — true when a 'permission' item comes from the PreToolUse hook store (resolved via
   *  /api/inbox/permissions/:id/decide) rather than the dormant stdin control path. */
  viaHook?: boolean;
}

// ── command-approval queue (destructive slash commands park here, see commands.ts) ──
const pendingApprovals: CommandApproval[] = [];

/** Defensive upper bound: the queue is operator-drained, but cap it so a runaway
 *  caller (or an ignored inbox) can never grow it without limit — drop the oldest. */
const MAX_PENDING_APPROVALS = 32;

/** Park a destructive command for operator approval. Returns the approval id.
 *  The command does NOT execute here — approving it via resolveApproval() does. */
export function enqueueApproval(input: { command: string; summary: string; cwd: string; line?: string }): string {
  const approval: CommandApproval = {
    id: randomUUID(),
    command: input.command,
    summary: input.summary,
    cwd: input.cwd,
    line: input.line ?? `/${input.command}`,
    createdAt: Date.now(),
  };
  pendingApprovals.push(approval);
  // Bound the queue: drop the oldest entries beyond the cap.
  if (pendingApprovals.length > MAX_PENDING_APPROVALS) {
    pendingApprovals.splice(0, pendingApprovals.length - MAX_PENDING_APPROVALS);
  }
  return approval.id;
}

/** Drain one parked approval. On 'approve' the parked command is replayed (its stored
 *  line + cwd dispatched) and its result returned; on 'deny' it is just removed. Either
 *  way the entry leaves the queue. Resolving an unknown id is a no-op. */
export async function resolveApproval(
  id: string,
  decision: 'approve' | 'deny',
): Promise<{ ran?: ChatCommandResult }> {
  const idx = pendingApprovals.findIndex((a) => a.id === id);
  if (idx === -1) return {};
  const [approval] = pendingApprovals.splice(idx, 1);
  if (decision === 'deny') return {};
  // Dynamic import avoids a static import cycle (commands.ts imports enqueueApproval).
  // force:true bypasses the danger gate so the APPROVED command actually runs — without
  // it the danger verb would re-enqueue itself and never reach its run().
  const { dispatchCommand } = await import('./commands.js');
  const ran = await dispatchCommand(approval.line, approval.cwd, { force: true });
  return { ran };
}

/** Test-only: reset the queue between cases. */
export function __clearApprovalsForTests(): void {
  pendingApprovals.length = 0;
}

function toSlim(run: { id: string; task: string; cwd: string; model: string; status: string; startedAt: number; costUsd: number }): SlimRun {
  return {
    id: run.id,
    task: run.task,
    cwd: run.cwd,
    model: run.model,
    status: run.status,
    startedAt: run.startedAt,
    costUsd: run.costUsd,
  };
}

export function getInboxItems(): InboxItem[] {
  const runs = registry.listRuns();
  const waiting = runs.filter(
    (r) => r.status === 'awaiting-permission' || r.status === 'awaiting-input',
  );

  const items: InboxItem[] = [];

  for (const run of waiting) {
    const events: NormalizedEvent[] = repo.getEventsTail(run.id);

    if (run.status === 'awaiting-permission') {
      // Find the LATEST permission_request event
      const permEvents = events.filter((e) => e.type === 'permission_request');
      const latest = permEvents.length > 0 ? permEvents[permEvents.length - 1] : null;

      const item: InboxItem = {
        run: toSlim(run),
        kind: 'permission',
      };

      if (latest) {
        const p = latest.payload as any;
        item.request = {
          id: p.requestId ?? p.id ?? 'pending',
          payload: {
            tool: p.tool ?? 'unknown',
            input: p.input ?? null,
          },
        };
      }

      items.push(item);
    } else {
      // awaiting-input: find the last assistant_text or agent_message for preview
      const textEvents = events.filter(
        (e) => e.type === 'assistant_text' || e.type === 'agent_message',
      );
      const latest = textEvents.length > 0 ? textEvents[textEvents.length - 1] : null;
      const rawText: string = (latest?.payload as any)?.text ?? '';
      const lastText = rawText.slice(0, 400);

      items.push({
        run: toSlim(run),
        kind: 'input',
        lastText,
      });
    }
  }

  for (const approval of pendingApprovals) {
    items.push({ kind: 'command', approval });
  }

  for (const g of listGates()) {
    items.push({
      kind: 'question',
      question: { id: g.id, sessionId: g.sessionId, question: g.question, options: g.options, multiSelect: g.multiSelect, allowFreeText: g.allowFreeText, createdAt: g.createdAt },
    });
  }

  // F-perm — pending PreToolUse permission requests (sessionId === runId). Surfaced as the
  // existing 'permission' card; resolved via /api/inbox/permissions/:id/decide (viaHook).
  for (const p of listPermissions()) {
    const run = registry.getRun(p.sessionId);
    items.push({
      run: run
        ? toSlim(run)
        : { id: p.sessionId, task: '(permission request)', cwd: p.cwd, model: '', status: 'awaiting-permission', startedAt: p.createdAt, costUsd: 0 },
      kind: 'permission',
      viaHook: true,
      // Truncate the agent-controlled tool_input on the wire: a Write/Edit can carry a multi-MB
      // payload (bodyLimit 4MB) and up to MAX_PERMISSIONS of them; the inbox is polled every few
      // seconds (the Shell badge only needs the count), so shipping full inputs amplifies badly.
      request: { id: p.id, payload: { tool: p.tool, input: truncateInput(p.input) } },
    });
  }

  return items;
}

export function registerInboxRoutes(app: FastifyInstance) {
  app.get('/api/inbox', async () => {
    return { items: getInboxItems() };
  });

  // Drain a parked command approval. approve → replay the parked command; deny → drop it.
  app.post('/api/inbox/commands/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return resolveApproval(id, 'approve');
  });
  app.post('/api/inbox/commands/:id/deny', async (req) => {
    const { id } = req.params as { id: string };
    return resolveApproval(id, 'deny');
  });

  // F-perm — decide a pending PreToolUse permission request (resolves the blocked hook callback).
  app.post('/api/inbox/permissions/:id/decide', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decision } = (req.body as any) ?? {};
    if (decision !== 'approve' && decision !== 'deny') {
      reply.code(400);
      return { error: "decision must be 'approve' or 'deny'" };
    }
    // Report whether a live request was actually resolved: a stale card (already decided/expired)
    // must not be falsely acknowledged as a successful approve.
    const resolved = resolvePermission(id, { decision: decision === 'approve' ? 'allow' : 'deny', reason: `operator ${decision}` });
    return { ok: resolved };
  });

  app.post('/api/inbox/questions/:id/answer', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { selection?: string[]; text?: string };
    resolveGate(id, { selection: Array.isArray(body.selection) ? body.selection.map(String) : [], text: body.text });
    return { ok: true };
  });
}
