/**
 * Feature A3 — Notifications on terminal run state + threshold alerts.
 * Feature F8 — Notification channels + spend alerts (PRD v0.4 §F8).
 *
 * Subscribes to registry.onRunTerminal and evaluates a small ruleset against each
 * run that reaches a terminal state (completed / failed / killed). When a rule
 * matches, a notification row is persisted and (best-effort) dispatched to all
 * matching channels (Slack / Discord / generic webhook) in addition to the
 * pre-existing single-webhook path.
 *
 * Self-owned tables (idempotent DDL), no edits to db.ts. Reuses the raw sqlite
 * handle (default export) for storage and the registry for the terminal hook.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Run } from '@fleet/shared';
import db from './db.js';
import { registry } from './registry.js';
import { subscribePermissionEnqueued } from './permissionGate.js';
import { subscribeGateEnqueued } from './gate.js';

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

CREATE TABLE IF NOT EXISTS notif_channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  last_ok_at INTEGER
);
`);

// ── config ─────────────────────────────────────────────────────────────────────
interface NotifConfig {
  enabled: boolean;
  onFailed: boolean;
  costThresholdUsd: number;
  durationThresholdMs: number;
  webhookUrl: string;
  /** F-notify — alert when a run pauses for an operator permission decision (PreToolUse gate). */
  onAwaitingPermission: boolean;
  /** F-notify — alert when an agent asks the operator a question (ask_human gate). */
  onAwaitingQuestion: boolean;
}

const DEFAULT_NOTIF_CONFIG: NotifConfig = {
  enabled: true,
  onFailed: true,
  costThresholdUsd: 5,
  durationThresholdMs: 0,
  webhookUrl: '',
  onAwaitingPermission: true,
  onAwaitingQuestion: true,
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

  const webhookUrl = str(body.webhookUrl, cur.webhookUrl);
  // Enforce https-only on write (same constraint as channels) — empty string is allowed (disables).
  if (webhookUrl && !webhookUrl.startsWith('https://')) {
    throw new Error('webhookUrl must start with https:// (or be empty to disable)');
  }

  return {
    enabled: bool(body.enabled, cur.enabled),
    onFailed: bool(body.onFailed, cur.onFailed),
    costThresholdUsd: num(body.costThresholdUsd, cur.costThresholdUsd),
    durationThresholdMs: num(body.durationThresholdMs, cur.durationThresholdMs),
    webhookUrl,
    onAwaitingPermission: bool(body.onAwaitingPermission, cur.onAwaitingPermission),
    onAwaitingQuestion: bool(body.onAwaitingQuestion, cur.onAwaitingQuestion),
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

// F-notify — in-memory pub/sub so the web (browser Notification) and desktop (Electron
// Notification) can react in real time via GET /api/notifications/stream, without polling.
type NotifSub = (row: NotificationRow) => void;
const notifSubs = new Set<NotifSub>();
export function subscribeNotifications(cb: NotifSub): () => void {
  notifSubs.add(cb);
  return () => notifSubs.delete(cb);
}

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
  const pub: NotificationRow = { id: row.id, runId, kind, message, ts: row.ts, read: false };
  for (const cb of notifSubs) {
    try {
      cb(pub);
    } catch {
      /* a bad subscriber must not break notification writes */
    }
  }
  return pub;
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

// ── F8: channels ──────────────────────────────────────────────────────────────

/** Event kinds that channels can subscribe to. */
const VALID_CHANNEL_EVENTS = [
  'run-failed',
  'run-completed',
  'run-killed',
  'awaiting-permission',
  'awaiting-question',
  'awaiting-input',
  'spend-threshold',
] as const;
type ChannelEvent = (typeof VALID_CHANNEL_EVENTS)[number];

/** Channel kinds. */
const VALID_CHANNEL_KINDS = ['slack', 'discord', 'generic'] as const;
type ChannelKind = (typeof VALID_CHANNEL_KINDS)[number];

interface Channel {
  id: string;
  kind: ChannelKind;
  url: string;
  events: ChannelEvent[];
  enabled: boolean;
  lastError: string | null;
  lastOkAt: number | null;
}

function rowToChannel(r: any): Channel {
  return {
    id: r.id,
    kind: r.kind as ChannelKind,
    url: r.url,
    events: JSON.parse(r.events ?? '[]') as ChannelEvent[],
    enabled: !!r.enabled,
    lastError: r.last_error ?? null,
    lastOkAt: r.last_ok_at ?? null,
  };
}

function listChannels(): Channel[] {
  return (db.prepare('SELECT * FROM notif_channels ORDER BY rowid').all() as any[]).map(rowToChannel);
}

function getChannel(id: string): Channel | null {
  const r = db.prepare('SELECT * FROM notif_channels WHERE id = ?').get(id) as any;
  return r ? rowToChannel(r) : null;
}

/** Validate a channel body for create or update. Throws on validation errors. */
function validateChannelBody(body: any): { kind: ChannelKind; url: string; events: ChannelEvent[]; enabled: boolean } {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');

  const kind = body.kind;
  if (!VALID_CHANNEL_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${VALID_CHANNEL_KINDS.join(', ')}`);
  }

  const url = body.url;
  if (typeof url !== 'string' || !url.trim()) throw new Error('url is required');
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith('https://')) throw new Error('url must start with https://');
  if (trimmedUrl.length > 512) throw new Error('url must be ≤ 512 characters');

  const eventsRaw: unknown[] = Array.isArray(body.events) ? body.events : [];
  const events: ChannelEvent[] = [];
  for (const e of eventsRaw) {
    if (!VALID_CHANNEL_EVENTS.includes(e as ChannelEvent)) {
      throw new Error(`unknown event kind "${e}"; valid: ${VALID_CHANNEL_EVENTS.join(', ')}`);
    }
    events.push(e as ChannelEvent);
  }

  const enabled = body.enabled === undefined ? true : !!body.enabled;

  return { kind, url: trimmedUrl, events, enabled };
}

function upsertChannel(ch: Channel) {
  db.prepare(`
    INSERT INTO notif_channels (id, kind, url, events, enabled, last_error, last_ok_at)
    VALUES (@id, @kind, @url, @events, @enabled, @last_error, @last_ok_at)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      url = excluded.url,
      events = excluded.events,
      enabled = excluded.enabled,
      last_error = excluded.last_error,
      last_ok_at = excluded.last_ok_at
  `).run({
    id: ch.id,
    kind: ch.kind,
    url: ch.url,
    events: JSON.stringify(ch.events),
    enabled: ch.enabled ? 1 : 0,
    last_error: ch.lastError,
    last_ok_at: ch.lastOkAt,
  });
}

function deleteChannel(id: string) {
  db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
}

function setChannelError(id: string, err: string | null) {
  db.prepare('UPDATE notif_channels SET last_error = ?, last_ok_at = CASE WHEN ? IS NULL THEN strftime(\'%s\',\'now\')*1000 ELSE last_ok_at END WHERE id = ?')
    .run(err, err, id);
}

// ── F8: spend-threshold state ─────────────────────────────────────────────────
/**
 * Track which threshold percentages (50/80/100) have already fired today so we
 * never double-fire within the same calendar day. Keyed by 'YYYY-MM-DD:PCT'.
 * This is in-process memory — server restart resets it (acceptable per PRD).
 */
const firedThresholds = new Set<string>();

/** Local-midnight timestamp for "today" — mirrors registry's startOfToday. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayKey(pct: number): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}:${pct}`;
}

// ── F8: channel dispatch ──────────────────────────────────────────────────────

/** Status icon for a run terminal state. */
function statusIcon(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'killed') return '⊘';
  return '·';
}

/** Build the human-readable message text for a run-terminal channel post. */
function buildChannelMessage(run: Run): string {
  const icon = statusIcon(run.status);
  const task = run.task.length > 80 ? run.task.slice(0, 79) + '…' : run.task;
  const cost = `$${run.costUsd.toFixed(3)}`;
  const portal = `http://127.0.0.1:4318/runs/${run.id}`;
  return `[fleet] ${icon} ${task} · ${cost} · ${run.model}  ${portal}`;
}

/** Build the payload for a given channel kind. */
function buildChannelPayload(kind: ChannelKind, text: string, eventKind: string, run: Run): unknown {
  if (kind === 'slack') {
    return { text };
  }
  if (kind === 'discord') {
    return { content: text };
  }
  // generic
  return {
    event: eventKind,
    run: {
      id: run.id,
      task: run.task,
      status: run.status,
      costUsd: run.costUsd,
      model: run.model,
    },
    ts: Date.now(),
  };
}

/** Build spend-threshold message text. */
function buildSpendThresholdMessage(pct: number, spent: number, cap: number): string {
  return `[fleet] spend alert — ${pct}% of daily cap reached ($${spent.toFixed(2)} / $${cap.toFixed(2)})  http://127.0.0.1:4318/guardrails`;
}

/** Build spend-threshold channel payload. */
function buildSpendThresholdPayload(kind: ChannelKind, text: string, spent: number, cap: number): unknown {
  if (kind === 'slack') return { text };
  if (kind === 'discord') return { content: text };
  return { event: 'spend-threshold', spent, cap, ts: Date.now() };
}

/**
 * Best-effort POST to a channel URL — fire-and-forget, records last_error/last_ok_at.
 * Never throws into the caller.
 */
async function postChannel(ch: Channel, payload: unknown): Promise<void> {
  try {
    const res = await fetch(ch.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const errText = `HTTP ${res.status} ${res.statusText}`;
      setChannelError(ch.id, errText);
    } else {
      setChannelError(ch.id, null);
    }
  } catch (e: any) {
    setChannelError(ch.id, e?.message ?? 'network error');
  }
}

/**
 * Fan out an event to all enabled matching channels.
 * Fire-and-forget — never blocks or throws into the terminal hook.
 */
function dispatchToChannels(eventKind: ChannelEvent, run: Run): void {
  const channels = listChannels().filter((ch) => ch.enabled && ch.events.includes(eventKind));
  if (channels.length === 0) return;
  const text = run
    ? buildChannelMessage(run)
    : `[fleet] ${eventKind}`;
  for (const ch of channels) {
    const payload = buildChannelPayload(ch.kind, text, eventKind, run);
    void postChannel(ch, payload);
  }
}

/**
 * Fan out a spend-threshold event to all enabled channels subscribed to
 * 'spend-threshold'. Fire-and-forget.
 */
function dispatchSpendThresholdToChannels(pct: number, spent: number, cap: number): void {
  const channels = listChannels().filter((ch) => ch.enabled && ch.events.includes('spend-threshold'));
  if (channels.length === 0) return;
  const text = buildSpendThresholdMessage(pct, spent, cap);
  for (const ch of channels) {
    const payload = buildSpendThresholdPayload(ch.kind, text, spent, cap);
    void postChannel(ch, payload);
  }
}

// ── rule evaluation ──────────────────────────────────────────────────────────────
type Match = { kind: string; message: string; channelEvent?: ChannelEvent };

function evaluate(run: Run, cfg: NotifConfig): Match[] {
  const matches: Match[] = [];

  if (cfg.onFailed && (run.status === 'failed' || run.status === 'killed')) {
    matches.push({
      kind: run.status === 'killed' ? 'killed' : 'failed',
      message: `Run ${run.status}: ${run.task}`,
      channelEvent: run.status === 'killed' ? 'run-killed' : 'run-failed',
    });
  }

  if (run.status === 'completed') {
    matches.push({
      kind: 'completed',
      message: `Run completed: ${run.task}`,
      channelEvent: 'run-completed',
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

/**
 * Check today's spend against daily cap thresholds (50/80/100%) and fire alerts
 * for any newly-crossed thresholds. Inserts in-app notifications + dispatches to
 * channels. Called after each run terminal event.
 */
function checkSpendThresholds(): void {
  const cfg = registry.getConfig();
  const cap = cfg.dailySpendCeilingUsd;
  if (!cap) return;

  const spent = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    // Import repo lazily to avoid circular module issues — db.ts is already imported
    // at module top via `import db from './db.js'`. Use the raw db handle.
    const row = db.prepare('SELECT COALESCE(SUM(cost_usd),0) as total FROM runs WHERE started_at >= ?').get(d.getTime()) as any;
    return row?.total ?? 0;
  })();

  const pct = (spent / cap) * 100;
  for (const threshold of [50, 80, 100] as const) {
    if (pct >= threshold) {
      const key = todayKey(threshold);
      if (!firedThresholds.has(key)) {
        firedThresholds.add(key);
        const msg = `Daily spend alert: ${threshold}% of $${cap.toFixed(2)} cap reached ($${spent.toFixed(2)} spent)`;
        insertNotification('spend-threshold', msg, null);
        dispatchSpendThresholdToChannels(threshold, spent, cap);
      }
    }
  }
}

// ── F8: awaiting-permission tracking (in-process, reset on server restart) ───
/**
 * Track runs that have already triggered an awaiting-permission dispatch so we
 * fire at most once per entry (i.e. each time a run enters the state, not every
 * fleet-broadcast tick while it stays in that state).
 *
 * Key: runId.  Cleared when the run leaves awaiting-permission or goes terminal.
 */
const awaitingPermissionFired = new Set<string>();

/**
 * Build the awaiting-permission dispatch payload for a run.
 */
function buildAwaitingPermissionPayload(kind: ChannelKind, runId: string, task: string): unknown {
  const portal = `http://127.0.0.1:4318/runs/${runId}`;
  const text = `[fleet] ⏳ awaiting permission: ${task.length > 80 ? task.slice(0, 79) + '…' : task}  ${portal}`;
  if (kind === 'slack') return { text };
  if (kind === 'discord') return { content: text };
  return { event: 'awaiting-permission', run: { id: runId, task }, ts: Date.now(), portal };
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
          // F8 #4: slim legacy payload — no full run object
          void postWebhook(cfg.webhookUrl, {
            id: run.id,
            task: run.task,
            status: run.status,
            costUsd: run.costUsd,
            model: run.model,
            ts: Date.now(),
          });
        }
        // F8: fan out to matching channels
        if (m.channelEvent) {
          dispatchToChannels(m.channelEvent, run);
        }
      }
      // F8: check spend thresholds after every terminal run
      checkSpendThresholds();
    } catch {
      /* best-effort — notifications must not destabilize the terminal hook */
    }
    // Clear the awaiting-permission tracking for this run on terminal so the next
    // time the same run id is reused it fires fresh (unlikely but defensive).
    awaitingPermissionFired.delete(run.id);
  });

  // F8 #1: subscribe to the fleet stream to detect runs entering awaiting-permission.
  // subscribeFleet broadcasts { kind: 'run', run } every time any run's status changes.
  // We fire 'awaiting-permission' channels exactly once per entry (dedupe by runId;
  // cleared when the run leaves the state or reaches terminal above).
  registry.subscribeFleet((msg) => {
    try {
      if (msg.kind !== 'run') return;
      // Honor the operator's notification preferences here too — this legacy status-flip path must
      // obey cfg.enabled / cfg.onAwaitingPermission exactly like the hook-gate subscriber below, or
      // it leaks external Slack/Discord/webhook posts after notifications were disabled.
      const cfg = getNotifConfig();
      if (!cfg.enabled || !cfg.onAwaitingPermission) return;
      const run = msg.run;
      if (run.status !== 'awaiting-permission') {
        // If the run left awaiting-permission (e.g. resumed running), clear the flag
        // so a future re-entry fires again.
        if (awaitingPermissionFired.has(run.id)) {
          awaitingPermissionFired.delete(run.id);
        }
        return;
      }
      // Already fired for this entry — skip (dedupe per run id per entry).
      if (awaitingPermissionFired.has(run.id)) return;
      awaitingPermissionFired.add(run.id);

      // Dispatch to all enabled channels subscribed to 'awaiting-permission'.
      const channels = listChannels().filter((ch) => ch.enabled && ch.events.includes('awaiting-permission'));
      if (channels.length === 0) return;
      for (const ch of channels) {
        const payload = buildAwaitingPermissionPayload(ch.kind, run.id, run.task);
        void postChannel(ch, payload);
      }
    } catch {
      /* best-effort — fleet subscriber must not throw */
    }
  });

  // F-notify — the PreToolUse permission gate stores requests without flipping run status, so the
  // fleet path above can't see them. Fire once per enqueue: an in-app row + channel fan-out.
  subscribePermissionEnqueued((p) => {
    try {
      const cfg = getNotifConfig();
      if (!cfg.enabled || !cfg.onAwaitingPermission) return;
      const run = registry.getRun(p.sessionId);
      const task = run?.task ?? p.sessionId;
      insertNotification('awaiting-permission', `Permission requested: ${p.tool} — ${task.slice(0, 80)}`, p.sessionId);
      if (run) dispatchToChannels('awaiting-permission', run);
    } catch {
      /* best-effort */
    }
  });

  // F-notify — ask_human questions never touch run status either; alert on enqueue.
  subscribeGateEnqueued((g) => {
    try {
      const cfg = getNotifConfig();
      if (!cfg.enabled || !cfg.onAwaitingQuestion) return;
      const run = registry.getRun(g.sessionId);
      insertNotification('awaiting-question', `Agent question: ${g.question.slice(0, 80)}`, g.sessionId);
      if (run) dispatchToChannels('awaiting-question', run);
    } catch {
      /* best-effort */
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

  // ── F8: channel routes ──────────────────────────────────────────────────────

  /** GET /api/notifier/channels — list all channels */
  app.get('/api/notifier/channels', async () => listChannels());

  /** PUT /api/notifier/channels — replace the full channel list */
  app.put('/api/notifier/channels', async (req, reply) => {
    const body = req.body as any;
    const incoming: unknown[] = Array.isArray(body) ? body : [];

    if (incoming.length > 10) {
      reply.code(400);
      return { error: 'maximum 10 channels allowed' };
    }

    const validated: { kind: ChannelKind; url: string; events: ChannelEvent[]; enabled: boolean; id?: string }[] = [];
    for (let i = 0; i < incoming.length; i++) {
      try {
        const v = validateChannelBody(incoming[i]);
        const existingId = (incoming[i] as any)?.id;
        validated.push({ ...v, id: typeof existingId === 'string' ? existingId : undefined });
      } catch (e: any) {
        reply.code(400);
        return { error: `channel[${i}]: ${e.message}` };
      }
    }

    // Replace: snapshot existing diagnostics keyed by id, then delete-all and
    // re-insert — incoming fields win but runtime diagnostic fields (lastError /
    // lastOkAt) are preserved for channels that already exist (merge by id).
    const existingById = new Map<string, Channel>();
    for (const ch of listChannels()) existingById.set(ch.id, ch);

    db.prepare('DELETE FROM notif_channels').run();
    for (const v of validated) {
      const existing = v.id ? existingById.get(v.id) : undefined;
      const ch: Channel = {
        id: v.id ?? randomUUID(),
        kind: v.kind,
        url: v.url,
        events: v.events,
        enabled: v.enabled,
        // Preserve runtime diagnostic fields from the existing row; null only for new channels.
        lastError: existing?.lastError ?? null,
        lastOkAt: existing?.lastOkAt ?? null,
      };
      upsertChannel(ch);
    }
    return listChannels();
  });

  /** POST /api/notifier/channels/:id/test — send a test message to one channel */
  app.post('/api/notifier/channels/:id/test', async (req, reply) => {
    const id = (req.params as any).id;
    const ch = getChannel(id);
    if (!ch) {
      reply.code(404);
      return { error: 'channel not found' };
    }
    const text = '[fleet] test message — channel is wired up correctly';
    const fakeRun: Run = {
      id: 'test',
      sessionId: 'test',
      task: 'test',
      cwd: '/tmp',
      model: 'claude-opus-4-8',
      fastMode: false,
      effort: 'high',
      workflowsEnabled: true,
      ultracode: false,
      teamId: null,
      campaignId: null,
      projectId: null,
      pid: null,
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      exitCode: 0,
      killReason: null,
      error: null,
      budgetUsd: null,
      permissionMode: 'default',
      allowedTools: null,
      skills: [],
      subagentProfile: null,
      resultText: null,
      structuredOutput: null,
      subagentCount: 0,
      liveSubagents: 0,
      maxDepth: 0,
      lastActivity: Date.now(),
      engine: undefined,
    };
    const payload = buildChannelPayload(ch.kind, text, 'test', fakeRun);
    let ok = true;
    let errorMsg: string | null = null;
    try {
      const res = await fetch(ch.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        ok = false;
        errorMsg = `HTTP ${res.status} ${res.statusText}`;
        setChannelError(id, errorMsg);
      } else {
        setChannelError(id, null);
      }
    } catch (e: any) {
      ok = false;
      errorMsg = (e?.message as string) ?? 'network error';
      setChannelError(id, errorMsg);
    }
    if (!ok) {
      // Return 200 with ok:false so api.ts's j() helper (which throws on non-2xx) can
      // return the typed { ok: false, error } shape to callers rather than an exception.
      return { ok: false, error: errorMsg };
    }
    return { ok: true };
  });
}
