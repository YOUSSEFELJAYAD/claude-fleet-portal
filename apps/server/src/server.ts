/**
 * Fastify control-plane HTTP surface (PRD §9.4): REST commands + SSE live streams
 * (DC.md D-010). localhost-bound, no auth in v1 (DC.md D-011).
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, validateConfig } from './config.js';
import { registry } from './registry.js';
import { campaigns } from './campaigns.js';
import { seedTemplates } from './templates.js';
import { repo } from './db.js';
import { listSkills, listSubagents } from './catalog.js';
import { listTeams, readTeam, watchTeam, isSafeId } from './teamWatcher.js';
// Lane B additive features (self-contained modules; each owns its tables/routes).
import { registerMetricsRoutes } from './metrics.js';
import { registerInboxRoutes } from './inbox.js'; // F6 — approval inbox
import { registerGateRoutes } from './gateServer.js'; // Task 3 — ask_human MCP gate
import { registerPermissionHookRoutes } from './permissionHookServer.js'; // F-perm — PreToolUse permission gate
import { registerScheduleRoutes, startScheduler } from './scheduler.js';
import { registerMcpRoutes } from './mcp.js';
import { registerNotifierRoutes, initNotifier, subscribeNotifications } from './notifier.js';
import { registerExportRoutes } from './exporter.js';
import { registerScoreRoutes } from './scores.js';
import { registerTagsRoutes } from './tags.js';
import { registerSearchRoutes } from './search.js'; // F7 — full-text transcript search
import { registerOtelRoutes } from './otel.js'; // H6
import { registerMemoryRoutes, initMemory } from './memory.js'; // F9 — fleet memory
import { registerLearnerRoutes, initLearner } from './learner.js'; // F-LEARN — skill auto-learning loop (§29)
import { registerReleaseRoutes } from './release.js';
import { registerBenchmarkRoutes } from './benchmarks.js'; // F4+F5 — benchmark mode + best-of-N
import { registerAddonRoutes, resetAddonRuntimeForDataWipe } from './addons.js'; // §22 — add-on marketplace (compression/headroom)
import { registerResearchRoutes } from './research.js'; // §28 — web research (SearXNG)
import { registerChatRoutes, registerChatStreamRoute } from './chat.js'; // §30 — chat dashboard
import { chatLive } from './chatLive.js'; // §4 — held-process manager (subscribe onRunTerminal at boot)
import { listCommands } from './commands.js';
import { registerPackRoutes } from './packs.js'; // §23 — tool/skill packs (launch presets)
import { registerSettingsRoutes } from './settings.js'; // §31 — environment & settings panel
import { registerPortabilityRoutes } from './portability.js'; // F10 — config as code (export/import)
// Agent-PM / Kanban feature (spec docs/superpowers/specs/2026-06-09-agent-pm-kanban-design.md).
// Import order matters: projects BEFORE kanban (kanban_tasks references a project; tables created on import).
import { registerProjectsRoutes } from './projects.js';
import { registerKanbanRoutes, subscribeBoard } from './kanban.js';
import { registerControlPlaneRoutes } from './controlplane.js'; // Loops — card assessment thread (controlplane §16)
import { registerFileviewRoutes } from './fileview.js';
import { registerFileeditRoutes } from './fileedit.js'; // v2 #1 — file CRUD + commit (opt-in per project)
import { registerPlanboardRoutes, planboard } from './planboard.js'; // v2 #3 — objective → Ready cards
import { registerFleetRoutes, assertCapAboveReserve } from './fleet.js'; // v2 #7 — cross-project fleet scheduler (admission)
import { registerTriggersRoutes, startTriggerPoller } from './triggers.js'; // F1 — GitHub triggers
import { registerLoopRoutes, loops } from './loops.js'; // Loops (loop-engineering)
import { registerLoopGenRoutes } from './loopGen.js'; // Loops — AI draft-from-prompt
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

// Validated, whitelisted template fields (create + PUT). Only keys PRESENT on the body are
// emitted; bad types are a 400 instead of a stored time bomb (a non-array allowedTools used
// to crash registry.launch later, mid-campaign).
const TEMPLATE_ROLES = new Set(['orchestrator', 'worker', 'reviewer', 'synthesizer']);
export function validateTemplateFields(body: any): { fields: Partial<AgentTemplate> } | { error: string } {
  const f: Partial<AgentTemplate> = {};
  const strArray = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? (v as string[])
      : typeof v === 'string' // defensive: the UI collects these as comma-separated text
        ? v.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)
        : null;
  if (body.role !== undefined) {
    if (!TEMPLATE_ROLES.has(body.role)) return { error: `role must be one of ${[...TEMPLATE_ROLES].join(', ')}` };
    f.role = body.role;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { error: 'description must be a string' };
    f.description = body.description;
  }
  if (body.systemPrompt !== undefined) {
    if (typeof body.systemPrompt !== 'string') return { error: 'systemPrompt must be a string' };
    f.systemPrompt = body.systemPrompt;
  }
  if (body.model !== undefined) {
    if (!MODELS.some((m) => m.id === body.model)) return { error: 'unknown model id' };
    f.model = body.model;
  }
  if (body.fastMode !== undefined) f.fastMode = !!body.fastMode;
  if (body.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(body.effort)) return { error: `effort must be one of ${EFFORT_LEVELS.join(', ')}` };
    f.effort = body.effort;
  }
  if (body.allowedTools !== undefined) {
    const a = strArray(body.allowedTools);
    if (!a) return { error: 'allowedTools must be an array of strings' };
    f.allowedTools = a;
  }
  if (body.skills !== undefined) {
    const a = strArray(body.skills);
    if (!a) return { error: 'skills must be an array of strings' };
    f.skills = a;
  }
  if (body.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(body.permissionMode)) return { error: `permissionMode must be one of ${PERMISSION_MODES.join(', ')}` };
    f.permissionMode = body.permissionMode;
  }
  if (body.budgetUsd !== undefined) {
    if (body.budgetUsd !== null && !(typeof body.budgetUsd === 'number' && Number.isFinite(body.budgetUsd) && body.budgetUsd >= 0)) {
      return { error: 'budgetUsd must be a non-negative number or null' };
    }
    f.budgetUsd = body.budgetUsd;
  }
  return { fields: f };
}

export function buildServer() {
  // forceCloseConnections — hijacked SSE responses are ACTIVE connections, so the default
  // 'idle' close would let app.close() hang until every dashboard tab disconnects (H4).
  // maxParamLength — Fastify defaults to 100, which silently 404s any longer :param BEFORE the
  // handler runs (so e.g. the /api/mcp/:name handler's own length guard was unreachable). Raise it
  // to 256 so handler-level validation governs and over-long names get a clean 400, not a confusing
  // 404. 256 still bounds a single path segment well below any DoS concern.
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    forceCloseConnections: true,
    routerOptions: { maxParamLength: 256 }, // fastify@5 — top-level maxParamLength is deprecated
  });

  // The web client sets `content-type: application/json` on every call, including body-less
  // DELETEs/POSTs. Fastify's default parser rejects an EMPTY body for that content-type with
  // FST_ERR_CTP_EMPTY_JSON_BODY — which 400'd every UI delete before the route ran. Treat an
  // empty body as "no body" (routes already `?? {}`), delegating anything else to the default
  // secure parser (keeps proto-poisoning protection).
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, undefined);
    return defaultJsonParser(req as any, body as string, done);
  });

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
  registerInboxRoutes(app); // F6 — approval inbox
  registerGateRoutes(app); // Task 3 — ask_human MCP gate
  registerPermissionHookRoutes(app); // F-perm — PreToolUse permission gate callback
  registerScheduleRoutes(app); // A4
  startScheduler(); // A4 — interval tick (unref'd)
  registerMcpRoutes(app); // A5
  registerNotifierRoutes(app); // A3
  initNotifier(); // A3 — subscribe to run-terminal events
  registerExportRoutes(app); // A9
  registerScoreRoutes(app); // A7
  registerTagsRoutes(app); // A8
  registerSearchRoutes(app); // F7 — full-text transcript search
  registerOtelRoutes(app); // H6 — OTLP receiver (/v1/metrics, /v1/logs) + /api/agents/:id/otel
  registerMemoryRoutes(app); // F9 — fleet memory (compounding knowledge)
  initMemory(); // F9 — subscribe to run-terminal events
  registerLearnerRoutes(app); // F-LEARN — skill auto-learning loop (§29)
  initLearner(); // F-LEARN — autonomous skill distillation on complex run completion
  registerReleaseRoutes(app); // §15 — release page + GitHub update check / self-update
  registerBenchmarkRoutes(app); // F4+F5 — benchmark mode + best-of-N
  registerAddonRoutes(app); // §22 — add-on marketplace + headroom compression-proxy lifecycle
  registerSettingsRoutes(app); // §31 — environment & settings panel
  registerChatRoutes(app); // §30 — chat dashboard
  registerChatStreamRoute(app, sse); // §4 — chat-scoped SSE (proxies the backing run)
  chatLive.init(); // §4 — subscribe onRunTerminal: evict a held process when its run dies on its own
  app.get('/api/commands', async () => listCommands());
  registerResearchRoutes(app); // §28 — web research (SearXNG)
  registerPackRoutes(app); // §23 — tool/skill packs (launch presets)
  registerPortabilityRoutes(app); // F10 — config as code (export/import)

  // Agent-PM / Kanban — projects BEFORE kanban (FK), then the viewer; then start the PM engine.
  registerProjectsRoutes(app);
  registerKanbanRoutes(app);
  registerControlPlaneRoutes(app); // Loops — card assessment thread (controlplane §16)
  registerFileviewRoutes(app);
  registerFileeditRoutes(app); // v2 #1 — opt-in file CRUD + commit (per-project editing_enabled gate)
  registerPlanboardRoutes(app); // v2 #3 — plan-board (objective → Ready cards)
  registerFleetRoutes(app); // v2 #7 — fleet config + status (admission gate is in pm.launchBuild)
  registerTriggersRoutes(app); // F1 — GitHub triggers
  registerLoopRoutes(app); // Loops — CRUD + fire/promote/demote (spec §16)
  registerLoopGenRoutes(app); // Loops — POST /api/loops/generate (AI draft from prompt)
  startTriggerPoller(); // F1 — 120s poll interval (unref'd)
  planboard.init(); // subscribe onRunTerminal — partitioned (§3.7): acts only on its own planning runs
  pm.init(); // subscribe onRunTerminal + safety tick
  loops.init(); // Loops — boot reconcile (clears mid-fire last_error; mode/counter persist in SQLite)
  void pm.reconcile().catch(() => {}); // boot guardrail: reset cards whose run died (async: aborts mid-resolve worktrees)
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
      const next = validateConfig(req.body); // H9 — validates/clamps, throws 400 on invalid
      // Deadlock cross-check on the post-clamp cap (the fleet PUT guards the other direction);
      // done at the route layer so config.ts never has to import fleet state.
      assertCapAboveReserve(next.maxConcurrentRuns);
      registry.setConfig(next);
      return registry.getConfig();
    } catch (e: any) {
      reply.code(e.statusCode ?? 400);
      return { error: e.message };
    }
  });
  app.post('/api/config/reset-data', async (req, reply) => {
    const confirm = (req.body as any)?.confirm;
    if (confirm !== 'RESET') {
      reply.code(400);
      return { error: 'confirm must be exactly RESET' };
    }
    try {
      const campaignsKilled = campaigns.killAll();
      const result = registry.resetAllData();
      await resetAddonRuntimeForDataWipe();
      seedTemplates();
      return {
        ok: true,
        campaignsKilled,
        clearedRuns: result.clearedRuns,
        config: registry.getConfig(),
      };
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message ?? 'failed to reset data' };
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
    const normalizedBody: LaunchRequest = {
      ...body,
      model: body.model || 'claude-opus-4-8',
      effort: body.effort || 'high',
      permissionMode: body.permissionMode || 'default',
      humanGate: body.humanGate ?? true,
    };
    // Engine add-on runs require async binary detection — branch before calling launch().
    const requestedEngine = normalizedBody.engine && normalizedBody.engine !== 'claude' ? normalizedBody.engine : null;
    if (requestedEngine) {
      try {
        return await registry.launchEngine(normalizedBody);
      } catch (e: any) {
        reply.code(e.statusCode ?? 500);
        return { error: e.message, ...(e.code ? { code: e.code } : {}) };
      }
    }
    try {
      return await registry.launch(normalizedBody);
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message, ...(e.code ? { code: e.code } : {}) };
    }
  });

  app.get('/api/agents', async (req) => {
    const q = req.query as any;
    const archived = q?.archived === 'include' || q?.archived === 'only' ? q.archived : undefined;
    return registry.listRuns({ status: q?.status, effort: q?.effort, q: q?.q, archived });
  });

  app.get('/api/agents/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const run = registry.getRun(id);
    if (!run) {
      reply.code(404);
      return { error: 'not found' };
    }
    // F3 — cheap indexed lookup for the run that retried this one (null if none).
    const retriedBy = repo.getRetriedBy(id);
    return { run, nodes: registry.getNodes(id), retriedBy };
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

  // §24 — stop-all (panic button): kills every live non-terminal run; returns the count.
  // Registered BEFORE :id DELETE so Fastify's router never confuses the literal path with the param.
  // ORDER MATTERS (review): campaigns are killed FIRST (terminal-before-kill, their H2 defense) —
  // a bare registry.stopAll() fires onRunTerminal per worker, and a still-active campaign would
  // synchronously schedule() REPLACEMENT workers mid-panic, spawning new processes during the stop.
  app.post('/api/agents/stop-all', async () => {
    const campaignsKilled = campaigns.killAll();
    const stopped = registry.stopAll();
    return { stopped, campaignsKilled };
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

  app.post('/api/agents/:id/archive', async (req, reply) => {
    const id = (req.params as any).id;
    const archived = (req.body as any)?.archived;
    if (typeof archived !== 'boolean') {
      reply.code(400);
      return { error: 'archived must be boolean' };
    }
    try {
      return registry.archiveRun(id, archived);
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

  // ── notification stream (F-notify) — feeds the web browser-Notification watcher and the
  //    desktop Electron-Notification listener so a pending gate reaches the operator in real time.
  app.get('/api/notifications/stream', (req, reply) => {
    const s = sse(reply, req);
    if (!s) return;
    const { send, stop } = s;
    const unsub = subscribeNotifications((notification) => send({ kind: 'notification', notification }));
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
  app.get('/api/templates/:id', async (req, reply) => {
    const t = repo.getTemplate((req.params as any).id);
    if (!t) {
      reply.code(404);
      return { error: 'not found' };
    }
    return t;
  });
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
    const v = validateTemplateFields(body);
    if ('error' in v) {
      reply.code(400);
      return { error: v.error };
    }
    const t: AgentTemplate = {
      id: randomUUID(),
      isBuiltin: false,
      createdAt: Date.now(),
      role: 'worker',
      description: '',
      systemPrompt: '',
      model: 'claude-opus-4-8',
      fastMode: false,
      effort: 'high',
      allowedTools: [],
      skills: [],
      permissionMode: 'default',
      budgetUsd: null,
      ...v.fields,
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
    const body = (req.body as any) ?? {};
    // Whitelist + validate — a blind `{ ...existing, ...body }` persisted arbitrary types
    // (e.g. a string allowedTools), which later crashed registry.launch mid-campaign.
    const v = validateTemplateFields(body);
    if ('error' in v) {
      reply.code(400);
      return { error: v.error };
    }
    const next: AgentTemplate = { ...existing, ...v.fields, id: existing.id, isBuiltin: existing.isBuiltin, createdAt: existing.createdAt, name: existing.name };
    repo.upsertTemplate(next);
    return next;
  });
  app.delete('/api/templates/:id', async (req, reply) => {
    const existing = repo.getTemplate((req.params as any).id);
    if (!existing) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (existing.isBuiltin) {
      // campaigns/planboard resolve their orchestrator/worker/synthesizer from these.
      reply.code(409);
      return { error: 'built-in templates cannot be deleted' };
    }
    repo.deleteTemplate(existing.id);
    return { ok: true };
  });

  // ── campaigns (Orchestration Mode) ──────────────────────────────────────────
  app.post('/api/campaigns', async (req, reply) => {
    try {
      return await campaigns.create(req.body as CreateCampaignRequest);
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
