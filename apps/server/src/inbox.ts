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
import type { FastifyInstance } from 'fastify';
import type { NormalizedEvent } from '@fleet/shared';
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

export interface InboxItem {
  run: SlimRun;
  kind: 'permission' | 'input';
  request?: InboxPermissionRequest;
  lastText?: string;
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

  return items;
}

export function registerInboxRoutes(app: FastifyInstance) {
  app.get('/api/inbox', async () => {
    return { items: getInboxItems() };
  });
}
