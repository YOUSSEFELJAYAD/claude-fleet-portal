/**
 * F10 — Config as code (export/import) tests.
 * Covers: export/import round-trip, idempotence, validation, error handling.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-portability-'));

let app: any;
let PORT: number;

const H = () => ({ headers: { host: `127.0.0.1:${PORT}` } });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

// Import type after buildServer is available
import type { ExportedSetup, ImportResult } from '../src/portability.js';

describe('F10 — Portability (export/import)', () => {

  describe('GET /api/portability/export', () => {
    it('exports all templates (incl. builtins), packs, guardrails, fleet', async () => {
      // Create a test pack.
      const res1 = await app.inject({
        ...H(),
        method: 'POST',
        url: '/api/packs',
        payload: {
          name: 'test-pack',
          description: 'Test pack for export',
          tools: ['Read', 'Edit'],
          skills: [],
        },
        ...H(),
      });
      expect(res1.statusCode).toBe(200);

      // Export.
      const res = await app.inject({
        method: 'GET',
        url: '/api/portability/export',
        ...H(),
      });
      expect(res.statusCode).toBe(200);
      const setup: ExportedSetup = JSON.parse(res.payload);

      // Check structure.
      expect(setup.version).toBe(1);
      expect(typeof setup.exportedAt).toBe('number');
      expect(Array.isArray(setup.templates)).toBe(true);
      expect(Array.isArray(setup.packs)).toBe(true);
      expect(typeof setup.guardrails).toBe('object');
      expect(typeof setup.fleet).toBe('object');

      // Builtins should be present (at least Orchestrator).
      const orchestrator = setup.templates.find((t) => t.name === 'Orchestrator');
      expect(orchestrator).toBeDefined();
      expect(orchestrator!.role).toBe('orchestrator');

      // Test pack should be in the export (id/createdAt stripped).
      const testPack = setup.packs.find((p) => p.name === 'test-pack');
      expect(testPack).toBeDefined();
      expect(testPack!.tools).toEqual(['Read', 'Edit']);
      expect((testPack as any).id).toBeUndefined();
      expect((testPack as any).createdAt).toBeUndefined();

      // Guardrails and fleet should be objects.
      expect(setup.guardrails.maxConcurrentRuns).toBeGreaterThan(0);
      expect(typeof setup.fleet.reserveSlotsForNonPm).toBe('number');
    });
  });

  describe('POST /api/portability/import', () => {
    it('imports templates by name, creating new and updating existing', async () => {
      // Export first to get a valid structure.
      const exportRes = await app.inject({
        method: 'GET',
        url: '/api/portability/export',
        ...H(),
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);

      // Modify a builtin (Orchestrator) and add a new one.
      const orchestrator = setup.templates.find((t) => t.name === 'Orchestrator')!;
      orchestrator.description = 'Updated Orchestrator description';
      setup.templates.push({
        name: 'Import Test Template',
        role: 'worker',
        description: 'A template imported in a test',
        systemPrompt: 'You are a test worker.',
        model: 'claude-opus-4-8',
        fastMode: false,
        effort: 'high',
        allowedTools: [],
        skills: [],
        permissionMode: 'default',
        budgetUsd: 2,
        isBuiltin: false,
      });

      // Import.
      const res = await app.inject({
        method: 'POST',
        url: '/api/portability/import',
        payload: setup,
        ...H(),
      });
      expect(res.statusCode).toBe(200);
      const result: ImportResult = JSON.parse(res.payload);

      expect(result.templates.created).toBe(1); // new template
      expect(result.templates.updated).toBeGreaterThan(0); // Orchestrator + others

      // Verify the new template exists.
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/templates',
        ...H(),
      });
      const templates = JSON.parse(listRes.payload);
      const imported = templates.find((t: any) => t.name === 'Import Test Template');
      expect(imported).toBeDefined();
      expect(imported.description).toBe('A template imported in a test');

      // Verify Orchestrator was updated.
      const orch = templates.find((t: any) => t.name === 'Orchestrator');
      expect(orch.description).toBe('Updated Orchestrator description');
    });

    it('imports packs by name, creating new and updating existing', async () => {
      // Create an initial pack.
      await app.inject({
        ...H(),
        method: 'POST',
        url: '/api/packs',
        payload: { name: 'pack-a', description: 'First pack', tools: ['Read'], skills: [] },
      });

      // Export to get valid structure, modify pack.
      const exportRes = await app.inject({
        ...H(),
        method: 'GET',
        url: '/api/portability/export',
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);
      const packA = setup.packs.find((p) => p.name === 'pack-a')!;
      packA.description = 'Updated first pack';
      packA.tools.push('Edit');

      setup.packs.push({
        name: 'pack-b',
        description: 'New pack from import',
        tools: ['Grep'],
        skills: [],
      });

      // Import.
      const res = await app.inject({
        ...H(),
        method: 'POST',
        url: '/api/portability/import',
        payload: setup,
      });
      const result: ImportResult = JSON.parse(res.payload);
      expect(result.packs.created).toBe(1);
      expect(result.packs.updated).toBeGreaterThan(0);

      // Verify.
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/packs',
        ...H(),
      });
      const packs = JSON.parse(listRes.payload);
      const pkgA = packs.find((p: any) => p.name === 'pack-a');
      expect(pkgA.description).toBe('Updated first pack');
      expect(pkgA.tools).toContain('Edit');

      const pkgB = packs.find((p: any) => p.name === 'pack-b');
      expect(pkgB).toBeDefined();
      expect(pkgB.tools).toEqual(['Grep']);
    });

    it('imports guardrails (portal config) when provided', async () => {
      const exportRes = await app.inject({
        ...H(),
        method: 'GET',
        url: '/api/portability/export',
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);
      setup.guardrails.defaultBudgetUsd = 7.5;

      const res = await app.inject({
        ...H(),
        method: 'POST',
        url: '/api/portability/import',
        payload: setup,
      });
      const result: ImportResult = JSON.parse(res.payload);
      expect(result.guardrails).toBe('applied');

      // Verify the config was set.
      const cfgRes = await app.inject({
        method: 'GET',
        url: '/api/config',
        ...H(),
      });
      const cfg = JSON.parse(cfgRes.payload);
      expect(cfg.defaultBudgetUsd).toBe(7.5);
    });

    it('imports fleet config when provided', async () => {
      const exportRes = await app.inject({
        method: 'GET',
        url: '/api/portability/export',
        ...H(),
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);
      setup.fleet.reserveSlotsForNonPm = 3;

      const res = await app.inject({
        method: 'POST',
        url: '/api/portability/import',
        payload: setup,
        ...H(),
      });
      const result: ImportResult = JSON.parse(res.payload);
      expect(result.fleet).toBe('applied');

      // Verify.
      const fleetRes = await app.inject({
        method: 'GET',
        url: '/api/fleet/config',
        ...H(),
      });
      const fleet = JSON.parse(fleetRes.payload);
      expect(fleet.reserveSlotsForNonPm).toBe(3);
    });

    it('skips invalid items and reports them, continuing with valid ones', async () => {
      const exportRes = await app.inject({
        method: 'GET',
        url: '/api/portability/export',
        ...H(),
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);

      // Add a template with an invalid field.
      setup.templates.push({
        name: 'Bad Template',
        role: 'invalid-role' as any,
        description: 'This template has a bad role',
        systemPrompt: 'x',
        model: 'claude-opus-4-8',
        fastMode: false,
        effort: 'high',
        allowedTools: [],
        skills: [],
        permissionMode: 'default',
        budgetUsd: 1,
        isBuiltin: false,
      });

      // Add a valid one.
      setup.templates.push({
        name: 'Good Template',
        role: 'worker',
        description: 'This one should import',
        systemPrompt: 'x',
        model: 'claude-opus-4-8',
        fastMode: false,
        effort: 'high',
        allowedTools: [],
        skills: [],
        permissionMode: 'default',
        budgetUsd: 1,
        isBuiltin: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/portability/import',
        payload: setup,
        ...H(),
      });
      expect(res.statusCode).toBe(200);
      const result: ImportResult = JSON.parse(res.payload);

      // Bad template is in errors, good one is created.
      expect(result.errors.length).toBeGreaterThan(0);
      const badError = result.errors.find((e) => e.includes('Bad Template'));
      expect(badError).toBeDefined();
      expect(result.templates.created).toBeGreaterThan(0);

      // Good template exists.
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/templates',
        ...H(),
      });
      const templates = JSON.parse(listRes.payload);
      const good = templates.find((t: any) => t.name === 'Good Template');
      expect(good).toBeDefined();
    });

    it('rejects non-version-1 imports with a 400', async () => {
      const res = await app.inject({
        ...H(),
        method: 'POST',
        url: '/api/portability/import',
        payload: {
          version: 2,
          exportedAt: Date.now(),
          templates: [],
          packs: [],
          guardrails: {},
          fleet: {},
        },
        ...H(),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('version must be 1');
    });

    it('round-trips idempotently: second import updates, not creates', async () => {
      // Export initial state.
      const exportRes1 = await app.inject({
        method: 'GET',
        url: '/api/portability/export',
        ...H(),
      });
      const setup1: ExportedSetup = JSON.parse(exportRes1.payload);

      // First import (creates builtins + any user items).
      const importRes1 = await app.inject({
        method: 'POST',
        url: '/api/portability/import',
        payload: setup1,
        ...H(),
      });
      const result1: ImportResult = JSON.parse(importRes1.payload);

      // Export again (should have the same items).
      const exportRes2 = await app.inject({
        method: 'GET',
        url: '/api/portability/export',
        ...H(),
      });
      const setup2: ExportedSetup = JSON.parse(exportRes2.payload);

      // Second import (all items already exist, so all are updates).
      const importRes2 = await app.inject({
        method: 'POST',
        url: '/api/portability/import',
        payload: setup2,
        ...H(),
      });
      const result2: ImportResult = JSON.parse(importRes2.payload);

      // On second import, nothing new is created; everything reimports as updates.
      expect(result2.templates.created).toBe(0);
      expect(result2.packs.created).toBe(0);
      expect(result2.templates.updated + result2.packs.updated).toBeGreaterThanOrEqual(
        result1.templates.created + result1.packs.created,
      );
    });

    it('null entry in templates[] is skipped with an error, valid entry still applied', async () => {
      const exportRes = await app.inject({
        method: 'GET', url: '/api/portability/export', ...H(),
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);

      // Inject a null entry followed by a valid new template.
      (setup.templates as any[]).push(null);
      setup.templates.push({
        name: 'NullEntryGood',
        role: 'worker',
        description: 'valid after null',
        systemPrompt: '',
        model: 'claude-opus-4-8',
        fastMode: false,
        effort: 'high',
        allowedTools: [],
        skills: [],
        permissionMode: 'default',
        budgetUsd: null,
        isBuiltin: false,
      });

      const res = await app.inject({
        method: 'POST', url: '/api/portability/import', payload: setup, ...H(),
      });
      // Must not 500 — partial result returned.
      expect(res.statusCode).toBe(200);
      const result: ImportResult = JSON.parse(res.payload);
      // Null entry reported as an error.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('null') || e.includes('skipped'))).toBe(true);
      // Valid entry was created.
      const listRes = await app.inject({ method: 'GET', url: '/api/templates', ...H() });
      const templates = JSON.parse(listRes.payload);
      expect(templates.find((t: any) => t.name === 'NullEntryGood')).toBeDefined();
    });

    it('fleet config with reserveSlotsForNonPm >= maxConcurrentRuns → fleet: skipped + error mentioning guard', async () => {
      const exportRes = await app.inject({
        method: 'GET', url: '/api/portability/export', ...H(),
      });
      const setup: ExportedSetup = JSON.parse(exportRes.payload);

      // Use current guardrails cap as-is; set fleet reserve to >= cap to trigger the deadlock guard.
      const currentCap = setup.guardrails.maxConcurrentRuns;
      setup.fleet = { ...setup.fleet, reserveSlotsForNonPm: currentCap }; // >= cap → guard fires

      const res = await app.inject({
        method: 'POST', url: '/api/portability/import', payload: setup, ...H(),
      });
      expect(res.statusCode).toBe(200);
      const result: ImportResult = JSON.parse(res.payload);
      // Fleet section must be skipped with a guard error.
      expect(result.fleet).toBe('skipped');
      const fleetError = result.errors.find((e) => e.startsWith('fleet:'));
      expect(fleetError).toBeDefined();
      expect(fleetError).toMatch(/reserve|pool|PM/i);
      // Guardrails should still be applied (fleet error must not abort everything).
      expect(result.guardrails).toBe('applied');
    });

    it('imports with missing optional fields (guardrails/fleet omitted)', async () => {
      // intentionally omits guardrails/fleet — the import must treat them as optional
      const partial: Omit<ExportedSetup, 'guardrails' | 'fleet'> = {
        version: 1,
        exportedAt: Date.now(),
        templates: [
          {
            name: 'Minimal Template',
            role: 'worker',
            description: 'Minimal import',
            systemPrompt: 'x',
            model: 'claude-opus-4-8',
            fastMode: false,
            effort: 'high',
            allowedTools: [],
            skills: [],
            permissionMode: 'default',
            budgetUsd: 1,
            isBuiltin: false,
          },
        ],
        packs: [],
        // guardrails and fleet omitted
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/portability/import',
        payload: partial,
        ...H(),
      });
      expect(res.statusCode).toBe(200);
      const result: ImportResult = JSON.parse(res.payload);
      expect(result.templates.created).toBe(1);
      expect(result.guardrails).toBe('skipped'); // omitted = skipped
      expect(result.fleet).toBe('skipped');
    });
  });
});
