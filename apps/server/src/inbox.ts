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
  kind: 'permission' | 'input' | 'command';
  request?: InboxPermissionRequest;
  lastText?: string;
  /** present iff kind === 'command'. */
  approval?: CommandApproval;
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
}
