/**
 * cov-notifier — raises real coverage of notifier.ts uncovered logic:
 *  - getNotifConfig malformed-JSON catch + merge over defaults (68-72)
 *  - validateConfig branches: non-object throw, bool/num/str coercion, https-only
 *    webhookUrl enforcement, negative-number reject (81-115)
 *  - deleteChannel / setChannelError null-vs-error branches (256-263)
 *  - startOfToday / todayKey (273-286)
 *  - statusIcon default branch via a non-terminal status (295-296)
 *  - dispatchToChannels run-fallback text path is exercised indirectly; the
 *    awaiting-permission slack/discord payload formatters (570 area)
 *  - duration-threshold evaluate branch + legacy webhookUrl POST (424-448, 517-525)
 *  - routes: POST /read, PUT /config (ok + 400), POST /test (579-598)
 *  - channel test-send HTTP-error path returns ok:false (708-710)
 *
 * UNTESTABLE here: the actual successful HTTPS POST to a real webhook (postChannel /
 * postWebhook network success) — requires a live external endpoint. We exercise the
 * dispatch *formatting* + the error/last_error side-effects via a local HTTP fixture
 * and via failing URLs, but the happy-path TLS POST is out of scope for a unit harness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';

// Isolate DB before any src module is imported.
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-cov-notif-'));
process.env.FLEET_DATA_DIR = dataDir;

// ── local HTTP fixture (capture POST bodies) ───────────────────────────────────
const captured: Map<string, Buffer[]> = new Map();
let fixtureSrv: http.Server;
let FIXTURE_PORT: number;

async function startFixture(failPaths: Set<string>): Promise<void> {
  return new Promise((resolve) => {
    fixtureSrv = http.createServer((req, res) => {
      const path = req.url ?? '/';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const ex = captured.get(path) ?? [];
        ex.push(Buffer.concat(chunks));
        captured.set(path, ex);
        if (failPaths.has(path)) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('boom');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }
      });
    });
    fixtureSrv.listen(0, '127.0.0.1', () => {
      FIXTURE_PORT = (fixtureSrv.address() as { port: number }).port;
      resolve();
    });
  });
}
const failPaths = new Set<string>(['/fail-500']);
const lastCapture = (p: string): any => {
  const b = captured.get(p);
  return b && b.length ? JSON.parse(b[b.length - 1].toString('utf8')) : undefined;
};
const clearCaptures = () => captured.clear();

// ── app / server / helpers ─────────────────────────────────────────────────────
let app: any;
let PORT: number;
let repo: any;
let db: any;
let registry: any;

const H = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: H() });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const post = (url: string, body: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { ...H(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fireTerminal(run: any) {
  for (const cb of (registry as any).terminalSubs) {
    try { cb(run); } catch { /* ignore */ }
  }
}
function fireFleet(msg: any) {
  for (const cb of (registry as any).fleetSubs) {
    try { cb(msg); } catch { /* ignore */ }
  }
}

function mkRun(over: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id: randomUUID(), sessionId: randomUUID(), task: 'cov-task', cwd: dataDir,
    model: 'claude-haiku-4-5', fastMode: false, effort: 'low',
    workflowsEnabled: false, ultracode: false, teamId: null, campaignId: null,
    projectId: null, pid: null, status: 'completed', startedAt: now, endedAt: now,
    tokensIn: 0, tokensOut: 0, costUsd: 0, exitCode: 0, killReason: null,
    error: null, budgetUsd: null, permissionMode: 'default', allowedTools: null,
    skills: [], subagentProfile: null, resultText: null, structuredOutput: null,
    subagentCount: 0, liveSubagents: 0, maxDepth: 0, lastActivity: now, engine: undefined,
    ...over,
  };
}

beforeAll(async () => {
  await startFixture(failPaths);
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ repo } = await import('../src/db.js'));
  db = (await import('../src/db.js')).default;
  ({ registry } = await import('../src/registry.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
  // clean any channels left from boot
  await put('/api/notifier/channels', []);
});

afterAll(async () => {
  await app?.close();
  fixtureSrv?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// getNotifConfig: malformed-JSON catch path (68-72)
// ─────────────────────────────────────────────────────────────────────────────
describe('getNotifConfig — malformed stored config falls back to defaults', () => {
  it('returns defaults when the stored row is not valid JSON', async () => {
    // Write garbage directly into notif_config row 1, then read via the GET route.
    db.prepare('INSERT INTO notif_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = ?')
      .run('not-json{{', 'not-json{{');
    const res = await get('/api/notifications/config');
    expect(res.statusCode).toBe(200);
    const c = res.json();
    // Defaults restored despite the garbage row.
    expect(c.enabled).toBe(true);
    expect(c.onFailed).toBe(true);
    expect(c.costThresholdUsd).toBe(5);
    expect(c.durationThresholdMs).toBe(0);
    expect(c.webhookUrl).toBe('');
  });

  it('merges a partial stored config over the defaults', async () => {
    db.prepare('INSERT INTO notif_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = ?')
      .run(JSON.stringify({ costThresholdUsd: 42 }), JSON.stringify({ costThresholdUsd: 42 }));
    const c = (await get('/api/notifications/config')).json();
    expect(c.costThresholdUsd).toBe(42);
    expect(c.onFailed).toBe(true); // default preserved
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/notifications/config → validateConfig branches (81-115, 585-593)
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/notifications/config — validateConfig coercion + errors', () => {
  it('coerces a string number, trims a webhook url and persists', async () => {
    const res = await put('/api/notifications/config', {
      enabled: false,
      onFailed: false,
      costThresholdUsd: '12.5',
      durationThresholdMs: 60000,
      webhookUrl: '  https://example.com/hook  ',
    });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.enabled).toBe(false);
    expect(c.onFailed).toBe(false);
    expect(c.costThresholdUsd).toBe(12.5);       // Number('12.5')
    expect(c.durationThresholdMs).toBe(60000);
    expect(c.webhookUrl).toBe('https://example.com/hook'); // trimmed
    // Round-trips through GET
    expect((await get('/api/notifications/config')).json().webhookUrl).toBe('https://example.com/hook');
  });

  it('keeps current values for fields omitted (undefined fallback branch)', async () => {
    // Only flip enabled — the rest fall back to the *current* (just-saved) config.
    const res = await put('/api/notifications/config', { enabled: true });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.enabled).toBe(true);
    expect(c.costThresholdUsd).toBe(12.5);   // preserved from prior PUT
    expect(c.webhookUrl).toBe('https://example.com/hook');
  });

  it('allows an empty webhookUrl (disables) — empty/null string num branch too', async () => {
    const res = await put('/api/notifications/config', {
      webhookUrl: '',
      costThresholdUsd: '',            // '' → fallback to current
      durationThresholdMs: null,       // null → fallback to current
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhookUrl).toBe('');
  });

  it('rejects a non-object body (400)', async () => {
    const res = await put('/api/notifications/config', 123 as any);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/object/);
  });

  it('rejects a non-boolean enabled (400)', async () => {
    const res = await put('/api/notifications/config', { enabled: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/boolean/);
  });

  it('rejects a negative number (400)', async () => {
    const res = await put('/api/notifications/config', { costThresholdUsd: -1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-negative/);
  });

  it('rejects a non-numeric, non-finite string (400)', async () => {
    const res = await put('/api/notifications/config', { durationThresholdMs: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-negative number/);
  });

  it('rejects a non-string webhookUrl (400)', async () => {
    const res = await put('/api/notifications/config', { webhookUrl: 12 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/string/);
  });

  it('rejects a non-https webhookUrl (400)', async () => {
    const res = await put('/api/notifications/config', { webhookUrl: 'http://insecure.example' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/https/);
  });

  afterAll(async () => {
    // reset config back to clean defaults for later tests
    await put('/api/notifications/config', {
      enabled: true, onFailed: true, costThresholdUsd: 5, durationThresholdMs: 0, webhookUrl: '',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluate() duration branch + legacy webhookUrl POST (424-448, 517-525)
// ─────────────────────────────────────────────────────────────────────────────
describe('terminal hook — duration threshold + legacy webhook POST', () => {
  beforeAll(async () => {
    await put('/api/notifier/channels', []);
  });
  afterAll(async () => {
    await put('/api/notifications/config', {
      enabled: true, onFailed: true, costThresholdUsd: 5, durationThresholdMs: 0, webhookUrl: '',
    });
  });

  it('a long-running completed run creates a duration notification AND posts the slim legacy webhook', async () => {
    // Point the legacy webhookUrl at our HTTP fixture (write the row directly to
    // bypass the https-only validation on the config PUT).
    const target = `http://127.0.0.1:${FIXTURE_PORT}/legacy-hook`;
    const cfg = {
      enabled: true, onFailed: true, costThresholdUsd: 0,
      durationThresholdMs: 1000, // 1s threshold
      webhookUrl: target,
    };
    db.prepare('INSERT INTO notif_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = ?')
      .run(JSON.stringify(cfg), JSON.stringify(cfg));

    clearCaptures();

    const start = Date.now() - 5 * 60_000; // 5 minutes ago
    const run = mkRun({ status: 'completed', task: 'long-run', startedAt: start, endedAt: Date.now(), costUsd: 0.02 });
    fireTerminal(run);
    await sleep(300);

    // Duration notification persisted
    const notifs: any[] = (await get('/api/notifications')).json();
    const dur = notifs.find((n) => n.kind === 'duration' && n.runId === run.id);
    expect(dur).toBeDefined();
    expect(dur.message).toMatch(/over the threshold/);
    expect(dur.message).toMatch(/5\.0m/); // 5 minutes formatted

    // 'completed' notification also persisted
    expect(notifs.some((n) => n.kind === 'completed' && n.runId === run.id)).toBe(true);

    // Legacy webhook fired with the slim payload (no full run object)
    const body = lastCapture('/legacy-hook');
    expect(body).toBeDefined();
    expect(body.id).toBe(run.id);
    expect(body.task).toBe('long-run');
    expect(body.status).toBe('completed');
    expect(typeof body.costUsd).toBe('number');
    expect(body.model).toBe('claude-haiku-4-5');
    expect(typeof body.ts).toBe('number');
    // slim: no nested run / no events array
    expect(body.run).toBeUndefined();
  });

  it('endedAt null uses Date.now() so elapsed still exceeds a tiny threshold', async () => {
    const target = `http://127.0.0.1:${FIXTURE_PORT}/legacy-hook-2`;
    const cfg = {
      enabled: true, onFailed: false, costThresholdUsd: 0,
      durationThresholdMs: 1, webhookUrl: target,
    };
    db.prepare('INSERT INTO notif_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = ?')
      .run(JSON.stringify(cfg), JSON.stringify(cfg));
    clearCaptures();

    // A 'failed' run with onFailed=false → no failed notif, but duration still applies.
    const run = mkRun({ status: 'failed', task: 'no-endedAt', startedAt: Date.now() - 5000, endedAt: null, costUsd: 0 });
    fireTerminal(run);
    await sleep(200);

    const notifs: any[] = (await get('/api/notifications')).json();
    expect(notifs.some((n) => n.kind === 'duration' && n.runId === run.id)).toBe(true);
    // onFailed was false → no 'failed' notification
    expect(notifs.some((n) => n.kind === 'failed' && n.runId === run.id)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// postChannel error side-effects: HTTP non-ok (354-355) and network fail (359-361)
// ─────────────────────────────────────────────────────────────────────────────
describe('postChannel records last_error on dispatch failure', () => {
  beforeAll(async () => {
    await put('/api/notifier/channels', []);
    // disable legacy webhook so only channels fire
    await put('/api/notifications/config', {
      enabled: true, onFailed: true, costThresholdUsd: 0, durationThresholdMs: 0, webhookUrl: '',
    });
  });
  afterAll(async () => { await put('/api/notifier/channels', []); });

  it('records an HTTP-status last_error when the channel target returns 500', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/fail-500`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'slack', ?, '["run-failed"]', 1)`)
      .run(id, target);
    clearCaptures();

    const run = mkRun({ status: 'failed', task: 'will-500', costUsd: 0 });
    fireTerminal(run);
    await sleep(400);

    // fixture captured the slack payload
    const b = lastCapture('/fail-500');
    expect(b).toBeDefined();
    expect(typeof b.text).toBe('string');

    // last_error reflects the HTTP 500 (setChannelError on non-ok branch)
    const row = db.prepare('SELECT last_error, last_ok_at FROM notif_channels WHERE id = ?').get(id) as any;
    expect(row.last_error).toMatch(/HTTP 500/);
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('records a network-error last_error when the target is unreachable', async () => {
    const id = randomUUID();
    // Port 1 + immediate connection refusal → catch branch (359-361)
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'discord', 'http://127.0.0.1:1/nope', '["run-failed"]', 1)`)
      .run(id);

    const run = mkRun({ status: 'failed', task: 'unreachable', costUsd: 0 });
    fireTerminal(run);
    await sleep(400);

    const row = db.prepare('SELECT last_error FROM notif_channels WHERE id = ?').get(id) as any;
    expect(typeof row.last_error).toBe('string');
    expect(row.last_error.length).toBeGreaterThan(0);
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setChannelError success branch sets last_ok_at + clears error (260-263, 357)
// ─────────────────────────────────────────────────────────────────────────────
describe('postChannel success branch clears last_error and stamps last_ok_at', () => {
  afterAll(async () => { await put('/api/notifier/channels', []); });

  it('a 200 response clears last_error and sets last_ok_at', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/ok-channel`;
    // Seed a prior error to prove it gets cleared.
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled, last_error) VALUES (?, 'slack', ?, '["run-completed"]', 1, 'old-error')`)
      .run(id, target);
    clearCaptures();

    const run = mkRun({ status: 'completed', task: 'ok-dispatch', costUsd: 0 });
    fireTerminal(run);
    await sleep(400);

    expect(lastCapture('/ok-channel')).toBeDefined();
    const row = db.prepare('SELECT last_error, last_ok_at FROM notif_channels WHERE id = ?').get(id) as any;
    expect(row.last_error).toBeNull();              // cleared on success
    expect(typeof row.last_ok_at).toBe('number');   // stamped via CASE WHEN NULL branch
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// awaiting-permission slack/discord payload formatters (498-501) +
// statusIcon default via a non-terminal status reaching buildChannelMessage path
// ─────────────────────────────────────────────────────────────────────────────
describe('awaiting-permission formatters per channel kind', () => {
  afterAll(async () => { await put('/api/notifier/channels', []); });

  it('slack awaiting-permission payload is {text} with the ⏳ icon + portal link', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/await-slack`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'slack', ?, '["awaiting-permission"]', 1)`)
      .run(id, target);
    clearCaptures();

    const run = mkRun({ status: 'awaiting-permission', task: 'a'.repeat(120), endedAt: null });
    fireFleet({ kind: 'run', run });
    await sleep(300);

    const b = lastCapture('/await-slack');
    expect(b).toBeDefined();
    expect(typeof b.text).toBe('string');
    expect(b.text).toContain('⏳');
    expect(b.text).toContain('awaiting permission');
    expect(b.text).toContain('…');          // task > 80 chars truncated
    expect(b.text).toContain(`/runs/${run.id}`);
    expect(b.content).toBeUndefined();
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('discord awaiting-permission payload is {content}', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/await-discord`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'discord', ?, '["awaiting-permission"]', 1)`)
      .run(id, target);
    clearCaptures();

    const run = mkRun({ status: 'awaiting-permission', task: 'short-task', endedAt: null });
    fireFleet({ kind: 'run', run });
    await sleep(300);

    const b = lastCapture('/await-discord');
    expect(b).toBeDefined();
    expect(typeof b.content).toBe('string');
    expect(b.content).toContain('awaiting permission');
    expect(b.content).toContain('short-task');
    expect(b.text).toBeUndefined();
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('clears the dedupe flag when a run leaves awaiting-permission (552-554)', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/await-reenter`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'generic', ?, '["awaiting-permission"]', 1)`)
      .run(id, target);
    clearCaptures();

    const runId = randomUUID();
    const enter = mkRun({ id: runId, sessionId: runId, status: 'awaiting-permission', task: 'reenter', endedAt: null });
    const leave = mkRun({ id: runId, sessionId: runId, status: 'running', task: 'reenter', endedAt: null });

    fireFleet({ kind: 'run', run: enter }); // fires once
    await sleep(150);
    fireFleet({ kind: 'run', run: leave }); // clears the flag (non-awaiting branch)
    await sleep(100);
    fireFleet({ kind: 'run', run: enter }); // re-enter → fires again
    await sleep(300);

    const n = (captured.get('/await-reenter') ?? []).length;
    expect(n).toBe(2); // two entries → two dispatches
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('ignores non-run fleet messages (547 early return)', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/await-nonrun`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'slack', ?, '["awaiting-permission"]', 1)`)
      .run(id, target);
    clearCaptures();
    fireFleet({ kind: 'metrics', metrics: {} });
    await sleep(150);
    expect(captured.get('/await-nonrun')).toBeUndefined();
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost-threshold evaluate branch (416-421)
// ─────────────────────────────────────────────────────────────────────────────
describe('terminal hook — cost threshold', () => {
  beforeAll(async () => {
    await put('/api/notifier/channels', []);
    await put('/api/notifications/config', {
      enabled: true, onFailed: false, costThresholdUsd: 1, durationThresholdMs: 0, webhookUrl: '',
    });
  });
  afterAll(async () => {
    await put('/api/notifications/config', {
      enabled: true, onFailed: true, costThresholdUsd: 5, durationThresholdMs: 0, webhookUrl: '',
    });
  });

  it('a run at/above the cost threshold emits a "cost" notification', async () => {
    const run = mkRun({ status: 'completed', task: 'expensive', costUsd: 2.345 });
    fireTerminal(run);
    await sleep(150);
    const notifs: any[] = (await get('/api/notifications')).json();
    const cost = notifs.find((n) => n.kind === 'cost' && n.runId === run.id);
    expect(cost).toBeDefined();
    expect(cost.message).toMatch(/\$2\.35/);          // toFixed(2)
    expect(cost.message).toMatch(/\$1 threshold/);
  });

  it('a run below the threshold emits NO cost notification', async () => {
    const run = mkRun({ status: 'completed', task: 'cheap', costUsd: 0.5 });
    fireTerminal(run);
    await sleep(150);
    const notifs: any[] = (await get('/api/notifications')).json();
    expect(notifs.some((n) => n.kind === 'cost' && n.runId === run.id)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/notifier/channels — valid list round-trips through validateChannelBody +
// upsertChannel + the listChannels read (606-650)
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/notifier/channels — valid list persists and round-trips', () => {
  afterAll(async () => { await put('/api/notifier/channels', []); });

  it('accepts a valid multi-channel list, trims urls, defaults enabled=true', async () => {
    const res = await put('/api/notifier/channels', [
      { kind: 'slack', url: '  https://hooks.slack.com/services/A/B/C  ', events: ['run-failed', 'run-completed'] },
      { kind: 'discord', url: 'https://discord.com/api/webhooks/x/y', events: ['run-killed'], enabled: false },
      { kind: 'generic', url: 'https://example.com/hook', events: [] },
    ]);
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(3);
    expect(list[0].kind).toBe('slack');
    expect(list[0].url).toBe('https://hooks.slack.com/services/A/B/C'); // trimmed
    expect(list[0].enabled).toBe(true);   // default
    expect(list[0].events).toEqual(['run-failed', 'run-completed']);
    expect(list[1].enabled).toBe(false);  // explicit false
    expect(list[1].kind).toBe('discord');
    expect(list[2].events).toEqual([]);
    // GET returns the same persisted set.
    const got = (await get('/api/notifier/channels')).json();
    expect(got).toHaveLength(3);
    expect(new Set(got.map((c: any) => c.kind))).toEqual(new Set(['slack', 'discord', 'generic']));
  });

  it('PUT with an empty array clears all channels', async () => {
    const res = await put('/api/notifier/channels', []);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect((await get('/api/notifier/channels')).json()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disabled config short-circuit (511) + POST /read + POST /test (578-598)
// ─────────────────────────────────────────────────────────────────────────────
describe('routes — read / test, and disabled-config short-circuit', () => {
  it('disabled config => terminal hook inserts NO notifications', async () => {
    await put('/api/notifications/config', {
      enabled: false, onFailed: true, costThresholdUsd: 0, durationThresholdMs: 0, webhookUrl: '',
    });
    const before = (await get('/api/notifications')).json().length;
    fireTerminal(mkRun({ status: 'failed', task: 'while-disabled' }));
    await sleep(150);
    const after = (await get('/api/notifications')).json();
    expect(after.length).toBe(before);
    expect(after.some((n: any) => n.message?.includes('while-disabled'))).toBe(false);
    // re-enable for subsequent tests
    await put('/api/notifications/config', {
      enabled: true, onFailed: true, costThresholdUsd: 5, durationThresholdMs: 0, webhookUrl: '',
    });
  });

  it('POST /api/notifications/test inserts a "test" notification and returns the row', async () => {
    const res = await post('/api/notifications/test');
    expect(res.statusCode).toBe(200);
    const n = res.json();
    expect(n.kind).toBe('test');
    expect(n.read).toBe(false);
    expect(typeof n.id).toBe('string');
    expect(n.message).toMatch(/wired up correctly/);
    // it shows up at the top of the list
    const list = (await get('/api/notifications')).json();
    expect(list[0].id).toBe(n.id);
  });

  it('POST /api/notifications/read marks all unread as read and reports the count', async () => {
    // ensure at least one unread exists
    await post('/api/notifications/test');
    const res = await post('/api/notifications/read');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.marked).toBeGreaterThanOrEqual(1);
    // every notification now read
    const list = (await get('/api/notifications')).json();
    expect(list.every((n: any) => n.read === true)).toBe(true);
    // a second read marks 0
    const second = (await post('/api/notifications/read')).json();
    expect(second.marked).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// spend-threshold path: checkSpendThresholds + buildSpendThreshold*  (455-481,
// 330-339, 384-392). Fires once per threshold per day; dispatches to channels.
// ─────────────────────────────────────────────────────────────────────────────
describe('spend-threshold crossing fires in-app notif + channel payloads', () => {
  let savedCap: number | null;

  beforeAll(async () => {
    await put('/api/notifier/channels', []);
    await put('/api/notifications/config', {
      enabled: true, onFailed: false, costThresholdUsd: 0, durationThresholdMs: 0, webhookUrl: '',
    });
    savedCap = registry.getConfig().dailySpendCeilingUsd ?? null;
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: 10 });
  });

  afterAll(async () => {
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: savedCap });
    await put('/api/notifier/channels', []);
  });

  it('crossing 50% emits a spend-threshold notification and slack/generic payloads', async () => {
    // Seed a run today with $5.50 spend → 55% of the $10 cap (crosses 50% only).
    const now = Date.now();
    const seedId = randomUUID();
    repo.upsertRun(mkRun({
      id: seedId, sessionId: seedId, task: 'spend-seed', status: 'completed',
      startedAt: now, endedAt: now, costUsd: 5.5,
    }));

    // One slack + one generic channel subscribed to spend-threshold.
    const slackId = randomUUID(), genId = randomUUID();
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'slack', ?, '["spend-threshold"]', 1)`)
      .run(slackId, `http://127.0.0.1:${FIXTURE_PORT}/spend-slack`);
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'generic', ?, '["spend-threshold"]', 1)`)
      .run(genId, `http://127.0.0.1:${FIXTURE_PORT}/spend-generic`);
    clearCaptures();

    // Fire a terminal run (its own cost doesn't matter — checkSpendThresholds sums DB).
    fireTerminal(mkRun({ status: 'completed', task: 'trigger-spend', startedAt: now, endedAt: now, costUsd: 0 }));
    await sleep(400);

    // In-app spend-threshold notification with the 50% message.
    const notifs: any[] = (await get('/api/notifications')).json();
    const st = notifs.find((n) => n.kind === 'spend-threshold');
    expect(st).toBeDefined();
    expect(st.message).toMatch(/50%/);
    expect(st.message).toMatch(/cap reached/);

    // slack payload = {text} with the spend-alert text + guardrails link.
    const slack = lastCapture('/spend-slack');
    expect(slack).toBeDefined();
    expect(typeof slack.text).toBe('string');
    expect(slack.text).toMatch(/spend alert/);
    expect(slack.text).toContain('/guardrails');

    // generic payload = {event:'spend-threshold', spent, cap, ts}
    const gen = lastCapture('/spend-generic');
    expect(gen).toBeDefined();
    expect(gen.event).toBe('spend-threshold');
    expect(typeof gen.spent).toBe('number');
    expect(gen.cap).toBe(10);
    expect(typeof gen.ts).toBe('number');
  });

  it('does NOT re-fire the same 50% threshold a second time in the same day (dedupe 473)', async () => {
    const before = (await get('/api/notifications')).json().filter((n: any) => n.kind === 'spend-threshold').length;
    clearCaptures();
    const now = Date.now();
    fireTerminal(mkRun({ status: 'completed', task: 'trigger-again', startedAt: now, endedAt: now, costUsd: 0 }));
    await sleep(300);
    const after = (await get('/api/notifications')).json().filter((n: any) => n.kind === 'spend-threshold').length;
    expect(after).toBe(before); // 50% already fired; total still 55% → no new threshold
  });

  it('no cap configured => checkSpendThresholds is a no-op (458 early return)', async () => {
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: null });
    const stBefore = (await get('/api/notifications')).json().filter((n: any) => n.kind === 'spend-threshold').length;
    const now = Date.now();
    fireTerminal(mkRun({ status: 'completed', task: 'no-cap', startedAt: now, endedAt: now, costUsd: 0 }));
    await sleep(200);
    // No new spend-threshold notification: the cap is null so the function returns early.
    const stAfter = (await get('/api/notifications')).json().filter((n: any) => n.kind === 'spend-threshold').length;
    expect(stAfter).toBe(stBefore);
    registry.setConfig({ ...registry.getConfig(), dailySpendCeilingUsd: 10 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// statusIcon default '·' branch (295-296) + postWebhook catch (445-447)
// ─────────────────────────────────────────────────────────────────────────────
describe('statusIcon default branch + legacy webhook unreachable', () => {
  afterAll(async () => {
    await put('/api/notifier/channels', []);
    await put('/api/notifications/config', {
      enabled: true, onFailed: true, costThresholdUsd: 5, durationThresholdMs: 0, webhookUrl: '',
    });
  });

  it('statusIcon known icons (✓ for completed) appear in the channel message', async () => {
    // The statusIcon default '·' branch is only reachable for a status outside
    // {completed,failed,killed}, but evaluate() sets channelEvent (and thus a
    // buildChannelMessage dispatch) ONLY for those three statuses — so the default
    // is dead-defensive via the public flow. We assert the reachable ✓ icon here.
    const id = randomUUID();
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'slack', ?, '["run-completed"]', 1)`)
      .run(id, `http://127.0.0.1:${FIXTURE_PORT}/icon-known`);
    clearCaptures();

    fireTerminal(mkRun({ status: 'completed', task: 'icon-known', startedAt: Date.now(), endedAt: Date.now(), costUsd: 0.5 }));
    await sleep(300);
    const b = lastCapture('/icon-known');
    expect(b).toBeDefined();
    expect(b.text).toContain('✓'); // completed icon
    expect(b.text).toContain('$0.500'); // cost formatting in buildChannelMessage
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('legacy webhook to an unreachable host hits postWebhook catch without throwing', async () => {
    // Point the legacy webhookUrl at a refused port; notification still persists.
    const cfg = {
      enabled: true, onFailed: true, costThresholdUsd: 0, durationThresholdMs: 0,
      webhookUrl: 'http://127.0.0.1:1/dead',
    };
    db.prepare('INSERT INTO notif_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = ?')
      .run(JSON.stringify(cfg), JSON.stringify(cfg));

    const run = mkRun({ status: 'failed', task: 'webhook-unreachable', costUsd: 0 });
    fireTerminal(run);
    await sleep(300);

    // The failed notification is persisted despite the webhook being unreachable.
    const notifs: any[] = (await get('/api/notifications')).json();
    expect(notifs.some((n) => n.kind === 'failed' && n.runId === run.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// channel test-send route: 404, HTTP-error (708-710), and connection-fail catch
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/notifier/channels/:id/test', () => {
  afterAll(async () => { await put('/api/notifier/channels', []); });

  it('404 for an unknown channel', async () => {
    const res = await post('/api/notifier/channels/nope/test');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it('returns ok:false with an HTTP-status error when the channel returns 500 (708-710)', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/fail-500`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'slack', ?, '[]', 1)`)
      .run(id, target);
    clearCaptures();

    const res = await post(`/api/notifier/channels/${id}/test`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/HTTP 500/);
    // last_error persisted
    const row = db.prepare('SELECT last_error FROM notif_channels WHERE id = ?').get(id) as any;
    expect(row.last_error).toMatch(/HTTP 500/);
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('returns ok:true + clears last_error when the channel returns 200', async () => {
    const id = randomUUID();
    const target = `http://127.0.0.1:${FIXTURE_PORT}/test-ok`;
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled, last_error) VALUES (?, 'discord', ?, '[]', 1, 'old')`)
      .run(id, target);
    clearCaptures();

    const res = await post(`/api/notifier/channels/${id}/test`);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    // discord test payload shape captured
    const b = lastCapture('/test-ok');
    expect(typeof b.content).toBe('string');
    expect(b.content).toContain('test message');
    const row = db.prepare('SELECT last_error FROM notif_channels WHERE id = ?').get(id) as any;
    expect(row.last_error).toBeNull();
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });

  it('returns ok:false on a connection failure (catch branch 714-717)', async () => {
    const id = randomUUID();
    db.prepare(`INSERT INTO notif_channels (id, kind, url, events, enabled) VALUES (?, 'generic', 'http://127.0.0.1:1/x', '[]', 1)`)
      .run(id);
    const res = await post(`/api/notifier/channels/${id}/test`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    db.prepare('DELETE FROM notif_channels WHERE id = ?').run(id);
  });
});
