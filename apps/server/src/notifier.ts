/**
 * Feature A3 — Notifications on terminal run state + threshold alerts.
 *
 * Subscribes to registry.onRunTerminal and evaluates a small ruleset against each
 * run that reaches a terminal state (completed / failed / killed). When a rule
 * matches, a notification row is persisted and (best-effort) POSTed to a webhook.
 *
 * Self-owned tables (idempotent DDL), no edits to db.ts. Reuses the raw sqlite
 * handle (default export) for storage and the registry for the terminal hook.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Run } from '@fleet/shared';
import db from './db.js';
import { registry } from './registry.js';

// ── schema (idempotent) ───────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);

CREATE TABLE IF NOT EXISTS notif_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT NOT NULL
);
`);

// ── config ─────────────────────────────────────────────────────────────────────
interface NotifConfig {
  enabled: boolean;
  onFailed: boolean;
  costThresholdUsd: number;
  durationThresholdMs: number;
  webhookUrl: string;
}

const DEFAULT_NOTIF_CONFIG: NotifConfig = {
  enabled: true,
  onFailed: true,
  costThresholdUsd: 5,
  durationThresholdMs: 0,
  webhookUrl: '',
};

function getNotifConfig(): NotifConfig {
  const row = db.prepare('SELECT config FROM notif_config WHERE id = 1').get() as any;
  if (!row) return { ...DEFAULT_NOTIF_CONFIG };
  try {
    return { ...DEFAULT_NOTIF_CONFIG, ...JSON.parse(row.config) };
  } catch {
    return { ...DEFAULT_NOTIF_CONFIG };
  }
}

function setNotifConfig(cfg: NotifConfig) {
  db.prepare('INSERT INTO notif_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = ?')
    .run(JSON.stringify(cfg), JSON.stringify(cfg));
}

/** Coerce/clamp a raw config body into a valid NotifConfig (throws on bad types). */
function validateConfig(body: any): NotifConfig {
  if (!body || typeof body !== 'object') throw new Error('config body must be an object');
  const cur = getNotifConfig();

  const bool = (v: unknown, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') throw new Error('expected a boolean');
    return v;
  };
  const num = (v: unknown, fallback: number): number => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error('expected a non-negative number');
    return n;
  };
  const str = (v: unknown, fallback: string): string => {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string') throw new Error('expected a string');
    return v.trim();
  };

  return {
    enabled: bool(body.enabled, cur.enabled),
    onFailed: bool(body.onFailed, cur.onFailed),
    costThresholdUsd: num(body.costThresholdUsd, cur.costThresholdUsd),
    durationThresholdMs: num(body.durationThresholdMs, cur.durationThresholdMs),
    webhookUrl: str(body.webhookUrl, cur.webhookUrl),
  };
}

// ── persistence ─────────────────────────────────────────────────────────────────
interface NotificationRow {
  id: string;
  runId: string | null;
  kind: string;
  message: string;
  ts: number;
  read: boolean;
}

const insertNotifStmt = db.prepare(
  'INSERT INTO notifications (id, run_id, kind, message, ts, read) VALUES (@id, @run_id, @kind, @message, @ts, @read)',
);

function insertNotification(kind: string, message: string, runId: string | null): NotificationRow {
  const row = {
    id: randomUUID(),
    run_id: runId,
    kind,
    message,
    ts: Date.now(),
    read: 0,
  };
  insertNotifStmt.run(row);
  return { id: row.id, runId, kind, message, ts: row.ts, read: false };
}

function listNotifications(limit = 50): NotificationRow[] {
  const rows = db
    .prepare('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?')
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id ?? null,
    kind: r.kind,
    message: r.message,
    ts: r.ts,
    read: !!r.read,
  }));
}

// ── rule evaluation ──────────────────────────────────────────────────────────────
type Match = { kind: string; message: string };

function evaluate(run: Run, cfg: NotifConfig): Match[] {
  const matches: Match[] = [];

  if (cfg.onFailed && (run.status === 'failed' || run.status === 'killed')) {
    matches.push({
      kind: run.status === 'killed' ? 'killed' : 'failed',
      message: `Run ${run.status}: ${run.task}`,
    });
  }

  if (cfg.costThresholdUsd > 0 && run.costUsd >= cfg.costThresholdUsd) {
    matches.push({
      kind: 'cost',
      message: `Cost $${run.costUsd.toFixed(2)} reached the $${cfg.costThresholdUsd} threshold: ${run.task}`,
    });
  }

  if (cfg.durationThresholdMs > 0) {
    const elapsed = (run.endedAt ?? Date.now()) - run.startedAt;
    if (elapsed >= cfg.durationThresholdMs) {
      const mins = (elapsed / 60000).toFixed(1);
      matches.push({
        kind: 'duration',
        message: `Run took ${mins}m, over the threshold: ${run.task}`,
      });
    }
  }

  return matches;
}

/** Best-effort webhook POST — never throws into the terminal hook. */
async function postWebhook(url: string, payload: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* webhook unreachable — notifications are still persisted locally */
  }
}

/** Subscribe to terminal runs. Call once from the main loop. */
export function initNotifier(): void {
  registry.onRunTerminal((run) => {
    // onRunTerminal fires a shared subscriber loop (campaigns also listens) — never
    // let a notification error propagate into that loop and break other features.
    try {
      const cfg = getNotifConfig();
      if (!cfg.enabled) return;
      const matches = evaluate(run, cfg);
      for (const m of matches) {
        insertNotification(m.kind, m.message, run.id);
        if (cfg.webhookUrl) {
          // fire-and-forget; postWebhook swallows its own errors
          void postWebhook(cfg.webhookUrl, { run, kind: m.kind, message: m.message });
        }
      }
    } catch {
      /* best-effort — notifications must not destabilize the terminal hook */
    }
  });
}

// ── routes ───────────────────────────────────────────────────────────────────────
export function registerNotifierRoutes(app: FastifyInstance): void {
  app.get('/api/notifications', async () => listNotifications(50));

  app.post('/api/notifications/read', async () => {
    const r = db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
    return { ok: true, marked: r.changes };
  });

  app.get('/api/notifications/config', async () => getNotifConfig());

  app.put('/api/notifications/config', async (req, reply) => {
    try {
      const next = validateConfig(req.body);
      setNotifConfig(next);
      return next;
    } catch (e: any) {
      reply.code(400);
      return { error: e.message };
    }
  });

  app.post('/api/notifications/test', async () => {
    const n = insertNotification('test', 'Test notification — alerts are wired up correctly.', null);
    return n;
  });
}
