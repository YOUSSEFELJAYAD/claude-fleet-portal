/**
 * Config as code — export / import the whole setup (F10).
 *
 * Allows operators to snapshot the entire portal configuration (templates, packs, guardrails, fleet)
 * as JSON and re-import it elsewhere, enabling setup portability across instances and version control.
 */
import type { FastifyInstance } from 'fastify';
import type { AgentTemplate, PortalConfig, FleetConfig, ToolPack } from '@fleet/shared';
import { randomUUID } from 'node:crypto';
import db, { repo } from './db.js';
import { registry } from './registry.js';
import { validateConfig } from './config.js';
import { validateFleetConfig, fleetRepo, assertCapAboveReserve } from './fleet.js';
import { validatePack, rowToPack } from './packs.js';
import { validateTemplateFields } from './server.js';

/**
 * Export shape: version 1, with all templates (builtins + user), packs, guardrails, and fleet config.
 * Template/pack ids and createdAt are omitted so imports are idempotent (match by name).
 */
export interface ExportedSetup {
  version: 1;
  exportedAt: number;
  templates: Array<Omit<AgentTemplate, 'id' | 'createdAt'>>;
  packs: Array<Omit<ToolPack, 'id' | 'createdAt'>>;
  guardrails: PortalConfig;
  fleet: FleetConfig;
}

/**
 * Result of an import: counts of created/updated items plus any skipped items with their errors.
 */
export interface ImportResult {
  templates: { created: number; updated: number };
  packs: { created: number; updated: number };
  guardrails: 'applied' | 'skipped';
  fleet: 'applied' | 'skipped';
  errors: string[];
}

// Query to list all packs (mirrors packs.ts route).
function listPacks(): ToolPack[] {
  return (db.prepare('SELECT * FROM tool_packs ORDER BY name COLLATE NOCASE').all() as any[]).map(rowToPack);
}

// Query to find a pack by name.
function getPackByName(name: string): ToolPack | null {
  const row = db.prepare('SELECT * FROM tool_packs WHERE name = ?').get(name) as any;
  return row ? rowToPack(row) : null;
}

// Upsert a pack (insert or update by id).
function upsertPack(pack: ToolPack): void {
  db.prepare(
    'INSERT INTO tool_packs (id, name, description, tools, skills, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = ?, description = ?, tools = ?, skills = ?',
  ).run(
    pack.id,
    pack.name,
    pack.description,
    JSON.stringify(pack.tools),
    JSON.stringify(pack.skills),
    pack.createdAt,
    pack.name,
    pack.description,
    JSON.stringify(pack.tools),
    JSON.stringify(pack.skills),
  );
}

export function registerPortabilityRoutes(app: FastifyInstance) {
  /**
   * GET /api/portability/export → JSON download with all setup.
   * Content-Disposition triggers browser download as fleet-setup.json.
   */
  app.get('/api/portability/export', async (_req, reply) => {
    try {
      // Fetch all templates (including builtins) and strip id/createdAt for idempotence.
      const templates = repo.listTemplates().map(
        ({ id: _, createdAt: __, ...rest }) => rest,
      );

      // Fetch all packs and strip id/createdAt.
      const packs = listPacks().map(
        ({ id: _, createdAt: __, ...rest }) => rest,
      );

      const guardrails = registry.getConfig();
      const fleet = fleetRepo.get();

      const setup: ExportedSetup = {
        version: 1,
        exportedAt: Date.now(),
        templates,
        packs,
        guardrails,
        fleet,
      };

      reply.header('content-disposition', 'attachment; filename=fleet-setup.json');
      return setup;
    } catch (e: any) {
      // surface the cause — a blind 500 made a missing-Host test failure look like serialization magic
      reply.code(500);
      return { error: `failed to export setup: ${e?.message ?? e}` };
    }
  });

  /**
   * POST /api/portability/import (body = ExportedSetup shape)
   * Upserts templates/packs by name; applies guardrails/fleet via their validators.
   * Items failing validation are skipped with an error message; the import continues.
   */
  app.post('/api/portability/import', async (req, reply) => {
    const body = req.body as any;
    const result: ImportResult = {
      templates: { created: 0, updated: 0 },
      packs: { created: 0, updated: 0 },
      guardrails: 'skipped',
      fleet: 'skipped',
      errors: [],
    };

    // Check version.
    if (body?.version !== 1) {
      reply.code(400);
      return { error: 'version must be 1' };
    }

    // Import templates.
    if (Array.isArray(body.templates)) {
      for (const tmpl of body.templates) {
        // Skip null/non-object entries gracefully instead of throwing a 500.
        if (!tmpl || typeof tmpl !== 'object' || typeof tmpl.name !== 'string' || !tmpl.name) {
          result.errors.push(`template entry skipped: null or missing name`);
          continue;
        }
        try {
          const existing = repo.getTemplateByName(tmpl.name);
          if (existing) {
            // Upsert: merge incoming tmpl over existing, then validate.
            const validated = validateTemplateFields({ ...existing, ...(tmpl as object ?? {}) });
            if ('error' in validated) {
              result.errors.push(`template "${tmpl.name}": ${validated.error}`);
              continue;
            }
            repo.upsertTemplate({ ...existing, ...validated.fields });
            result.templates.updated++;
          } else {
            // New template: validate, then create with full fields.
            const validated = validateTemplateFields(tmpl);
            if ('error' in validated) {
              result.errors.push(`template "${tmpl.name}": ${validated.error}`);
              continue;
            }
            const id = randomUUID();
            repo.upsertTemplate({
              id,
              name: tmpl.name,
              role: (tmpl as any).role || 'worker',
              description: (tmpl as any).description || '',
              systemPrompt: (tmpl as any).systemPrompt || '',
              model: (tmpl as any).model || 'claude-opus-4-8',
              fastMode: (tmpl as any).fastMode ?? false,
              effort: (tmpl as any).effort || 'high',
              allowedTools: validated.fields.allowedTools || [],
              skills: validated.fields.skills || [],
              permissionMode: (tmpl as any).permissionMode || 'default',
              budgetUsd: (tmpl as any).budgetUsd ?? null,
              isBuiltin: false,
              createdAt: Date.now(),
            });
            result.templates.created++;
          }
        } catch (e: any) {
          result.errors.push(`template "${tmpl.name}": ${e.message}`);
        }
      }
    }

    // Import packs.
    if (Array.isArray(body.packs)) {
      for (const pack of body.packs) {
        // Skip null/non-object entries gracefully instead of throwing a 500.
        if (!pack || typeof pack !== 'object' || typeof pack.name !== 'string' || !pack.name) {
          result.errors.push(`pack entry skipped: null or missing name`);
          continue;
        }
        try {
          const existing = getPackByName(pack.name);
          if (existing) {
            // Upsert: validate and merge.
            const validated = validatePack(pack);
            upsertPack({
              ...existing,
              ...validated,
            });
            result.packs.updated++;
          } else {
            // New pack: validate and create.
            const validated = validatePack(pack);
            const id = randomUUID();
            upsertPack({
              id,
              ...validated,
              createdAt: Date.now(),
            });
            result.packs.created++;
          }
        } catch (e: any) {
          result.errors.push(`pack "${pack.name}": ${e.message}`);
        }
      }
    }

    // Import guardrails (portal config).
    if (body.guardrails && typeof body.guardrails === 'object') {
      try {
        const validated = validateConfig(body.guardrails);
        // Run the same deadlock guard as PUT /api/config: lowering the cap at/below the existing
        // fleet reserve zeroes the PM pool. Report a per-section error rather than applying it.
        assertCapAboveReserve(validated.maxConcurrentRuns);
        registry.setConfig(validated);
        result.guardrails = 'applied';
      } catch (e: any) {
        result.errors.push(`guardrails: ${e.message}`);
      }
    }

    // Import fleet config.
    // validateFleetConfig already checks reserveSlotsForNonPm < registry.config.maxConcurrentRuns,
    // covering the sealed cap<=reserve guard (DC §10) for the fleet side of the import.
    if (body.fleet && typeof body.fleet === 'object') {
      try {
        const validated = validateFleetConfig(body.fleet);
        fleetRepo.set(validated);
        result.fleet = 'applied';
      } catch (e: any) {
        result.errors.push(`fleet: ${e.message}`);
      }
    }

    return result;
  });
}
