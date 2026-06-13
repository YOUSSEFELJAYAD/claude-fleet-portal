/**
 * Real tests for packs.ts validatePack — the H9-spirit input gate that sanitizes a
 * tool/skill pack before its entries are fed verbatim to `--allowedTools`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-packs-'));

let packs: typeof import('../src/packs.js');
beforeAll(async () => { packs = await import('../src/packs.js'); });

const code = (fn: () => unknown): number | undefined => {
  try { fn(); return undefined; } catch (e: any) { return e?.statusCode; }
};

describe('validatePack', () => {
  it('rejects non-objects with a 400', () => {
    expect(code(() => packs.validatePack(null))).toBe(400);
    expect(code(() => packs.validatePack('x'))).toBe(400);
    expect(code(() => packs.validatePack(42))).toBe(400);
  });

  it('requires a non-empty name', () => {
    expect(code(() => packs.validatePack({}))).toBe(400);
    expect(code(() => packs.validatePack({ name: '   ' }))).toBe(400);
  });

  it('trims the name and rejects > 60 chars', () => {
    expect(packs.validatePack({ name: '  Web Dev  ' }).name).toBe('Web Dev');
    expect(code(() => packs.validatePack({ name: 'x'.repeat(61) }))).toBe(400);
  });

  it('defaults description to empty and truncates to 300 chars', () => {
    expect(packs.validatePack({ name: 'p' }).description).toBe('');
    const long = packs.validatePack({ name: 'p', description: 'd'.repeat(400) });
    expect(long.description.length).toBe(300);
  });

  it('trims, dedupes, and drops empty tool/skill entries', () => {
    const out = packs.validatePack({
      name: 'p',
      tools: ['  Read  ', 'Read', '', '   ', 'Write'],
      skills: ['a', 'a', 'b'],
    });
    expect(out.tools).toEqual(['Read', 'Write']);
    expect(out.skills).toEqual(['a', 'b']);
  });

  it('rejects a non-array tools/skills field', () => {
    expect(code(() => packs.validatePack({ name: 'p', tools: 'Read' }))).toBe(400);
    expect(code(() => packs.validatePack({ name: 'p', skills: { a: 1 } }))).toBe(400);
  });

  it('rejects non-string entries', () => {
    expect(code(() => packs.validatePack({ name: 'p', tools: ['ok', 123] }))).toBe(400);
  });

  it('rejects an over-long entry (> 120 chars) and too many entries (> 100)', () => {
    expect(code(() => packs.validatePack({ name: 'p', tools: ['x'.repeat(121)] }))).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `tool${i}`);
    expect(code(() => packs.validatePack({ name: 'p', tools: many }))).toBe(400);
  });

  it('returns a fully-normalized pack for valid input', () => {
    expect(packs.validatePack({ name: 'Auditor', description: 'ro', tools: ['Read'], skills: ['x'] }))
      .toEqual({ name: 'Auditor', description: 'ro', tools: ['Read'], skills: ['x'] });
  });
});
