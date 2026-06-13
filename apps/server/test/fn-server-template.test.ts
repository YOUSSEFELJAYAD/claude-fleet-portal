/**
 * Real tests for server.ts validateTemplateFields — the whitelist/type gate that turns
 * a raw template-edit body into stored AgentTemplate fields (or a 400-shaped error).
 * Returns {fields} | {error}; never throws. Importing server builds the app graph,
 * so the DB is isolated first.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS } from '@fleet/shared';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-template-'));

let server: typeof import('../src/server.js');
beforeAll(async () => { server = await import('../src/server.js'); });

const ok = (r: any) => { expect(r.error).toBeUndefined(); return r.fields; };

describe('validateTemplateFields', () => {
  it('returns an empty field set for an empty body (only present keys emitted)', () => {
    expect(server.validateTemplateFields({})).toEqual({ fields: {} });
  });

  it('validates the role enum', () => {
    expect(ok(server.validateTemplateFields({ role: 'worker' })).role).toBe('worker');
    expect(server.validateTemplateFields({ role: 'wizard' })).toHaveProperty('error');
  });

  it('type-checks description and systemPrompt', () => {
    expect(ok(server.validateTemplateFields({ description: 'hi' })).description).toBe('hi');
    expect(server.validateTemplateFields({ description: 5 })).toHaveProperty('error');
    expect(server.validateTemplateFields({ systemPrompt: {} })).toHaveProperty('error');
  });

  it('accepts a known model id and rejects an unknown one', () => {
    const valid = MODELS[0].id;
    expect(ok(server.validateTemplateFields({ model: valid })).model).toBe(valid);
    expect(server.validateTemplateFields({ model: 'gpt-imaginary' })).toHaveProperty('error');
  });

  it('coerces comma/newline strings into arrays for allowedTools/skills', () => {
    expect(ok(server.validateTemplateFields({ allowedTools: 'Read, Write\nBash' })).allowedTools)
      .toEqual(['Read', 'Write', 'Bash']);
    expect(ok(server.validateTemplateFields({ skills: ['a', 'b'] })).skills).toEqual(['a', 'b']);
    expect(server.validateTemplateFields({ allowedTools: 42 })).toHaveProperty('error');
  });

  it('validates effort and permissionMode enums', () => {
    expect(ok(server.validateTemplateFields({ effort: 'high' })).effort).toBe('high');
    expect(server.validateTemplateFields({ effort: 'ultra' })).toHaveProperty('error');
    expect(ok(server.validateTemplateFields({ permissionMode: 'plan' })).permissionMode).toBe('plan');
    expect(server.validateTemplateFields({ permissionMode: 'yolo' })).toHaveProperty('error');
  });

  it('validates budgetUsd (non-negative number or null) and coerces fastMode to boolean', () => {
    expect(ok(server.validateTemplateFields({ budgetUsd: 0 })).budgetUsd).toBe(0);
    expect(ok(server.validateTemplateFields({ budgetUsd: null })).budgetUsd).toBeNull();
    expect(server.validateTemplateFields({ budgetUsd: -1 })).toHaveProperty('error');
    expect(ok(server.validateTemplateFields({ fastMode: 1 })).fastMode).toBe(true);
  });
});
