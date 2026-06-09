/**
 * Fastify control-plane HTTP surface (PRD §9.4): REST commands + SSE live streams
 * (DC.md D-010). localhost-bound, no auth in v1 (DC.md D-011).
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { ALLOWED_HOSTS, ALLOWED_ORIGINS } from './config.js';
import { registry } from './registry.js';
import { campaigns } from './campaigns.js';
import { seedTemplates } from './templates.js';
import { repo } from './db.js';
import { listSkills, listSubagents } from './catalog.js';
import { listTeams, readTeam, watchTeam, isSafeId } from './teamWatcher.js';
// Lane B additive features (self-contained modules; each owns its tables/routes).
import { registerMetricsRoutes } from './metrics.js';
import { registerScheduleRoutes, startScheduler } from './scheduler.js';
import { registerMcpRoutes } from './mcp.js';
import { registerNotifierRoutes, initNotifier } from './notifier.js';
import { registerExportRoutes } from './exporter.js';
import { registerScoreRoutes } from './scores.js';
import { registerTagsRoutes } from './tags.js';
import { registerOtelRoutes } from './otel.js'; // H6
// Agent-PM / Kanban feature (spec docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md).
// Import order matters: projects BEFORE kanban (kanban_tasks references a project; tables created on import).
import { registerProjectsRoutes } from './projects.js';
import { registerKanbanRoutes, subscribeBoard } from './kanban.js';
import { registerFileviewRoutes } from './fileview.js';
import { pm } from './pm.js';

/** H21 — a cwd query must be an absolute path with no traversal/null byte (or absent). */
function isSafeCwd(cwd: unknown): cwd is string | undefined {
  if (cwd === undefined) return true;
  return typeof cwd === 'string' && cwd.startsWith('/') && !cwd.includes('..') && !cwd.includes('\0');
}
import { MODELS, EFFORT_LEVELS, PERMISSION_MODES, RUN_STATUSES } from '@fleet/shared';
import type { LaunchRequest, CreateCampaignRequest, AgentTemplate, CreateTemplateRequest } from '@fleet/shared';

// H18 — bound concurrent SSE connections so unbounded tabs/clients can't exhaust the
// control plane. Over the cap → 503 (no hijack); returns null so the route bails cleanly.
let sseOpen = 0;
const MAX_SSE = Number(process.env.FLEET_MAX_SSE || 64);

function sse(reply: FastifyReply, req: FastifyRequest): { send: (obj: unknown) => void; stop: () => void } | null {
  if (sseOpen >= MAX_SSE) {
    reply.code(503).send({ error: 'too many live connections' });
    return null;
  }
  reply.hijack();
  // reply.hijack() bypasses the CORS plugin, so echo the validated origin here too (H3).
  // EventSource sends no credentials, so omitting ACAO for a disallowed origin just blocks reads.
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  reply.raw.writeHead(200, headers);
  reply.raw.write(': connected\n\n');
  sseOpen++;
  const send = (obj: unknown) => {
    try {
      // H18 — emit id:<seq> for event frames so EventSource carries Last-Event-ID on reconnect.
      const seq = (obj as any)?.event?.seq;
      const idLine = typeof seq === 'number' ? `id: ${seq}\n` : '';
      reply.raw.write(`${idLine}data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* socket gone */
    }
  };
  const ping = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);
  ping.unref();
  let closed = false;
  return {
    send,
    stop: () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      sseOpen--;
    },
  };
}

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  // H3 — reject any request whose Host header isn't an allowlisted localhost:PORT.
  // This is the real DNS-rebinding guard (an attacker page rebound to 127.0.0.1 still
  // carries its own domain as Host). Runs before every route, including hijacked SSE.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!host || !ALLOWED_HOSTS.has(host)) {
      return reply.code(403).send({ error: 'forbidden host' });
    }
  });

  // CORS scoped to the local web app only (defense-in-depth). A request with no Origin
  // (curl, same-origin, EventSource) is allowed — the Host allowlist above is the guard.
  app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin)),
  });

  // Orchestration Mode bootstrap (DC.md D-018..D-020)
  seedTemplates();
  campaigns.init();

  // Lane B additive features — register routes + start background workers.
  registerMetricsRoutes(app); // A2
  registerScheduleRoutes(app); // A4
  startScheduler(); // A4 — interval tick (unref'd)
  registerMcpRoutes(app); // A5
  registerNotifierRoutes(app); // A3
  initNotifier(); // A3 — subscribe to run-terminal events
  registerExportRoutes(app); // A9
  registerScoreRoutes(app); // A7
  registerTagsRoutes(app); // A8
  registerOtelRoutes(app); // H6 — OTLP receiver (/v1/metrics, /v1/logs) + /api/agents/:id/otel

  // Agent-PM / Kanban — projects BEFORE kanban (FK), then the viewer; then start the PM engine.
  registerProjectsRoutes(app);
  registerKanbanRoutes(app);
  registerFileviewRoutes(app);
  pm.init(); // subscribe onRunTerminal + safety tick
  pm.reconcile(); // boot guardrail: reset cards whose run died
  // Kanban board live stream (sse() is module-private here; subscribeBoard never returns null).
  app.get('/api/projects/:pid/board/stream', (req, reply) => {
    const s = sse(reply, req);
    if (!s) return; // 503 already sent (connection cap, H18)
    const { send, stop } = s;
    const unsub = subscribeBoard((req.params as any).pid, send);
    reply.raw.on('close', () => {
      unsub();
      stop();
    });
  });

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  // ── reference data ──────────────────────────────────────────────────────────
  app.get('/api/models', async () => MODELS);
  app.get('/api/meta', async () => ({
    models: MODELS,
    efforts: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    statuses: RUN_STATUSES,
  }));
  app.get('/api/skills', async (req, reply) => {
    const cwd = (req.query as any)?.cwd as string | undefined;
    if (!isSafeCwd(cwd)) {
      reply.code(400);
      return { error: 'cwd must be an absolute path' };
    }
    return listSkills(cwd);
  });
  app.get('/api/subagents', async (req, reply) => {
    const cwd = (req.query as any)?.cwd as string | undefined;
    if (!isSafeCwd(cwd)) {
      reply.code(400);
      return { error: 'cwd must be an absolute path' };
    }
    return listSubagents(cwd);
  });

  // ── config / spend ────────────────────────────────────────────────────────────
  app.get('/api/config', async () => registry.getConfig());
  app.put('/api/config', async (req, reply) => {
    try {
      registry.setConfig(req.body); // H9 — validates/clamps, throws 400 on invalid
      return registry.getConfig();
    } catch (e: any) {
      reply.code(e.statusCode ?? 400);
      return { error: e.message };
    }
  });
  app.get('/api/spend', async () => registry.spend());

  // ── agents (runs) ─────────────────────────────────────────────────────────────
  app.post('/api/agents', async (req, reply) => {
    const body = req.body as LaunchRequest;
    if (!body?.prompt || !body?.cwd) {
      reply.code(400);
      return { error: 'prompt and cwd are required' };
    }
    try {
      return registry.launch({
        ...body,
        model: body.model || 'claude-opus-4-8',
        effort: body.effort || 'high',
        permissionMode: body.permissionMode || 'default',
      });
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  app.get('/api/agents', async (req) => {
    const q = req.query as any;
    return registry.listRuns({ status: q?.status, effort: q?.effort, q: q?.q });
  });

  app.get('/api/agents/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const run = registry.getRun(id);
    if (!run) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { run, nodes: registry.getNodes(id) };
  });

  app.get('/api/agents/:id/tree', async (req, reply) => {
    const id = (req.params as any).id;
    const tree = registry.getTree(id);
    if (!tree) {
      reply.code(404);
      return { error: 'not found' };
    }
    return tree;
  });

  app.get('/api/agents/:id/stream', (req, reply) => {
    const id = (req.params as any).id;
    const s = sse(reply, req);
    if (!s) return; // 503 already sent (connection cap, H18)
    const { send, stop } = s;
    const unsub = registry.subscribeRun(id, send);
    if (!unsub) {
      send({ error: 'not found' });
      stop();
      reply.raw.end();
      return;
    }
    reply.raw.on('close', () => {
      unsub();
      stop();
    });
  });

  app.post('/api/agents/:id/input', async (req, reply) => {
    const id = (req.params as any).id;
    const text = (req.body as any)?.text;
    if (typeof text !== 'string' || text.length === 0) {
      reply.code(400); // H9 — validate before forwarding to claude stdin
      return { error: 'text must be a non-empty string' };
    }
    try {
      registry.sendInput(id, text);
      return { ok: true };
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  app.post('/api/agents/:id/resume', async (req, reply) => {
    const id = (req.params as any).id;
    const body = (req.body as any) ?? {};
    try {
      return registry.resume(id, body.prompt, body.interactive);
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  app.delete('/api/agents/:id', async (req) => {
    const id = (req.params as any).id;
    registry.stop(id);
    return { ok: true };
  });

  // delete a finished run from history (PRD §7.8). Distinct from stop (which signals a live run).
  app.delete('/api/agents/:id/record', async (req, reply) => {
    const id = (req.params as any).id;
    try {
      registry.deleteRun(id);
      return { ok: true };
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  app.post('/api/agents/:id/permission', async (req, reply) => {
    const id = (req.params as any).id;
    const { requestId, decision } = (req.body as any) ?? {};
    if (typeof requestId !== 'string' || !requestId || (decision !== 'approve' && decision !== 'deny')) {
      reply.code(400); // H9 — validate before forwarding into the control_response
      return { error: 'requestId (non-empty string) and decision (approve|deny) are required' };
    }
    try {
      registry.decidePermission(id, requestId, decision);
      return { ok: true };
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  // ── fleet-wide live stream ────────────────────────────────────────────────────
  app.get('/api/fleet/stream', (req, reply) => {
    const s = sse(reply, req);
    if (!s) return; // 503 already sent (connection cap, H18)
    const { send, stop } = s;
    const unsub = registry.subscribeFleet(send);
    reply.raw.on('close', () => {
      unsub();
      stop();
    });
  });

  // ── teams (PRD §7.4) ──────────────────────────────────────────────────────────
  app.get('/api/teams', async () => listTeams());
  app.get('/api/teams/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!isSafeId(id)) {
      reply.code(400);
      return { error: 'invalid team id' };
    }
    const view = readTeam(id);
    if (!view) {
      reply.code(404);
      return { error: 'not found' };
    }
    return view;
  });
  app.get('/api/teams/:id/stream', (req, reply) => {
    const id = (req.params as any).id;
    if (!isSafeId(id)) {
      reply.code(400).send({ error: 'invalid team id' });
      return;
    }
    const s = sse(reply, req);
    if (!s) return; // 503 already sent (connection cap, H18)
    const { send, stop } = s;
    const initial = readTeam(id);
    if (initial) send({ kind: 'team', view: initial });
    const unwatch = watchTeam(id, (view) => send({ kind: 'team', view }));
    reply.raw.on('close', () => {
      unwatch();
      stop();
    });
  });

  // ── agent templates (Orchestration Mode, PRD-extension) ─────────────────────
  app.get('/api/templates', async () => repo.listTemplates());
  app.post('/api/templates', async (req, reply) => {
    const body = req.body as CreateTemplateRequest;
    if (!body?.name?.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    if (repo.getTemplateByName(body.name)) {
      reply.code(409);
      return { error: 'a template with that name already exists' };
    }
    const t: AgentTemplate = {
      id: randomUUID(),
      isBuiltin: false,
      createdAt: Date.now(),
      role: body.role || 'worker',
      description: body.description || '',
      systemPrompt: body.systemPrompt || '',
      model: body.model || 'claude-opus-4-8',
      fastMode: !!body.fastMode,
      effort: body.effort || 'high',
      allowedTools: body.allowedTools || [],
      skills: body.skills || [],
      permissionMode: body.permissionMode || 'default',
      budgetUsd: body.budgetUsd ?? null,
      name: body.name,
    };
    repo.upsertTemplate(t);
    return t;
  });
  app.put('/api/templates/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const existing = repo.getTemplate(id);
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = req.body as Partial<AgentTemplate>;
    const next: AgentTemplate = { ...existing, ...body, id: existing.id, isBuiltin: existing.isBuiltin, createdAt: existing.createdAt, name: existing.name };
    repo.upsertTemplate(next);
    return next;
  });
  app.delete('/api/templates/:id', async (req) => {
    repo.deleteTemplate((req.params as any).id);
    return { ok: true };
  });

  // ── campaigns (Orchestration Mode) ──────────────────────────────────────────
  app.post('/api/campaigns', async (req, reply) => {
    try {
      return campaigns.create(req.body as CreateCampaignRequest);
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });
  app.get('/api/campaigns', async () => campaigns.list());
  app.get('/api/campaigns/:id', async (req, reply) => {
    const view = campaigns.view((req.params as any).id);
    if (!view) {
      reply.code(404);
      return { error: 'not found' };
    }
    return view;
  });
  app.delete('/api/campaigns/:id', async (req, reply) => {
    try {
      campaigns.kill((req.params as any).id);
      return { ok: true };
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });
  app.get('/api/campaigns/:id/stream', (req, reply) => {
    const id = (req.params as any).id;
    const s = sse(reply, req);
    if (!s) return; // 503 already sent (connection cap, H18)
    const { send, stop } = s;
    const unsub = campaigns.subscribe(id, send);
    if (!unsub) {
      send({ error: 'not found' });
      stop();
      reply.raw.end();
      return;
    }
    reply.raw.on('close', () => {
      unsub();
      stop();
    });
  });

  return app;
}
