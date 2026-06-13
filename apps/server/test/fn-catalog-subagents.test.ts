/**
 * Real tests for catalog.ts listSubagents — scans USER_AGENTS_DIR + a project's
 * .claude/agents for *.md subagent definitions, parsing YAML-ish frontmatter.
 * Builds a REAL project agents dir on disk (no mocks) and asserts the project
 * agents surface, deduped and name-sorted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-catalog-'));

let catalog: typeof import('../src/catalog.js');
let cwd: string;

beforeAll(async () => {
  catalog = await import('../src/catalog.js');
  cwd = mkdtempSync(join(tmpdir(), 'fleet-catalog-proj-'));
  const agentsDir = join(cwd, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'zeta.md'), '---\nname: zeta-agent\ndescription: last alphabetically\n---\nbody');
  writeFileSync(join(agentsDir, 'alpha.md'), '---\nname: alpha-agent\ndescription: first\n---\nbody');
  writeFileSync(join(agentsDir, 'notes.txt'), 'not a subagent'); // ignored (not .md)
});

afterAll(() => {
  for (const d of [cwd, process.env.FLEET_DATA_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('listSubagents', () => {
  it('returns an array even with no project cwd', () => {
    expect(Array.isArray(catalog.listSubagents())).toBe(true);
  });

  it('discovers project .md subagents and parses their frontmatter name/description', () => {
    const project = catalog.listSubagents(cwd).filter((a) => a.scope === 'project');
    const byName = Object.fromEntries(project.map((a) => [a.name, a]));
    expect(byName['alpha-agent']).toBeDefined();
    expect(byName['alpha-agent'].description).toBe('first');
    expect(byName['zeta-agent']).toBeDefined();
    // the non-.md file is ignored
    expect(project.some((a) => a.path.endsWith('notes.txt'))).toBe(false);
  });

  it('returns results sorted by name (A→Z)', () => {
    const names = catalog.listSubagents(cwd).map((a) => a.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
