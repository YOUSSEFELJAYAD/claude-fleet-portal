/**
 * Fastify control-plane HTTP surface (PRD §9.4): REST commands + SSE live streams
 * (DC.md D-010). localhost-bound, no auth in v1 (DC.md D-011).
 */
import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { registry } from './registry.js';
import { campaigns } from './campaigns.js';
import { seedTemplates } from './templates.js';
import { repo } from './db.js';
import { listSkills, listSubagents } from './catalog.js';
import { listTeams, readTeam, watchTeam } from './teamWatcher.js';
import { MODELS, EFFORT_LEVELS, PERMISSION_MODES, RUN_STATUSES } from '@fleet/shared';
import type { LaunchRequest, PortalConfig, CreateCampaignRequest, AgentTemplate, CreateTemplateRequest } from '@fleet/shared';

function sse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  reply.raw.write(': connected\n\n');
  const send = (obj: unknown) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
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
  return { send, stop: () => clearInterval(ping) };
}

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  app.register(cors, { origin: true });

  // Orchestration Mode bootstrap (DC.md D-018..D-020)
  seedTemplates();
  campaigns.init();

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  // ── reference data ──────────────────────────────────────────────────────────
  app.get('/api/models', async () => MODELS);
  app.get('/api/meta', async () => ({
    models: MODELS,
    efforts: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    statuses: RUN_STATUSES,
  }));
  app.get('/api/skills', async (req) => {
    const cwd = (req.query as any)?.cwd as string | undefined;
    return listSkills(cwd);
  });
  app.get('/api/subagents', async (req) => {
    const cwd = (req.query as any)?.cwd as string | undefined;
    return listSubagents(cwd);
  });

  // ── config / spend ────────────────────────────────────────────────────────────
  app.get('/api/config', async () => registry.getConfig());
  app.put('/api/config', async (req) => {
    const cfg = req.body as PortalConfig;
    registry.setConfig(cfg);
    return registry.getConfig();
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
    const { send, stop } = sse(reply);
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
    try {
      registry.decidePermission(id, requestId, decision);
      return { ok: true };
    } catch (e: any) {
      reply.code(e.statusCode ?? 500);
      return { error: e.message };
    }
  });

  // ── fleet-wide live stream ────────────────────────────────────────────────────
  app.get('/api/fleet/stream', (_req, reply) => {
    const { send, stop } = sse(reply);
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
    const view = readTeam(id);
    if (!view) {
      reply.code(404);
      return { error: 'not found' };
    }
    return view;
  });
  app.get('/api/teams/:id/stream', (req, reply) => {
    const id = (req.params as any).id;
    const { send, stop } = sse(reply);
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
    const { send, stop } = sse(reply);
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
