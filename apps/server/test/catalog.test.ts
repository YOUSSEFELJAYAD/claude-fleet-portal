import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) is imported (harness pattern).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cat-'));

let catalog: typeof import('../src/catalog.js');

beforeAll(async () => {
  catalog = await import('../src/catalog.js');
});

/** Build a fake plugin install: <root>/<plugin>/<version>/skills/<skill>/SKILL.md */
function mkPluginInstall(root: string, plugin: string, version: string, skills: Record<string, string>): string {
  const installPath = join(root, plugin, version);
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(installPath, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  }
  return installPath;
}

function mkSetup(opts: {
  plugins: Record<string, Array<{ installPath: string; lastUpdated?: string }>>;
  enabledPlugins?: Record<string, boolean>;
}): { manifestPath: string; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cat-setup-'));
  const manifestPath = join(dir, 'installed_plugins.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 2, plugins: opts.plugins }));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: opts.enabledPlugins ?? {} }));
  return { manifestPath, settingsPath };
}

describe('scanPluginSkills — collect skills from the whole Claude setup', () => {
  it('collects plugin skills under their fully-qualified <plugin>:<skill> invoke name', () => {
    const cache = mkdtempSync(join(tmpdir(), 'fleet-cat-cache-'));
    const sp = mkPluginInstall(cache, 'superpowers', '5.1.0', {
      brainstorming: 'explore intent before building',
      'systematic-debugging': 'find the root cause first',
    });
    const { manifestPath, settingsPath } = mkSetup({
      plugins: { 'superpowers@official': [{ installPath: sp }] },
    });
    const skills = catalog.scanPluginSkills(manifestPath, settingsPath);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['superpowers:brainstorming', 'superpowers:systematic-debugging']);
    expect(skills.every((s) => s.scope === 'plugin')).toBe(true);
    expect(skills.every((s) => s.kind === 'skill')).toBe(true);
    expect(skills.find((s) => s.name === 'superpowers:brainstorming')!.description).toContain('intent');
  });

  it('skips plugins explicitly disabled in settings enabledPlugins', () => {
    const cache = mkdtempSync(join(tmpdir(), 'fleet-cat-cache-'));
    const on = mkPluginInstall(cache, 'alpha', '1.0', { go: 'enabled skill' });
    const off = mkPluginInstall(cache, 'ralph-loop', '1.0', { loop: 'disabled skill' });
    const { manifestPath, settingsPath } = mkSetup({
      plugins: {
        'alpha@mkt': [{ installPath: on }],
        'ralph-loop@mkt': [{ installPath: off }],
      },
      enabledPlugins: { 'alpha@mkt': true, 'ralph-loop@mkt': false },
    });
    const names = catalog.scanPluginSkills(manifestPath, settingsPath).map((s) => s.name);
    expect(names).toEqual(['alpha:go']);
  });

  it('de-dupes multiple cached installs of one plugin, preferring the newest lastUpdated', () => {
    const cache = mkdtempSync(join(tmpdir(), 'fleet-cat-cache-'));
    const oldI = mkPluginInstall(cache, 'tool', 'old', { thing: 'OLD description' });
    const newI = mkPluginInstall(cache, 'tool', 'new', { thing: 'NEW description' });
    const { manifestPath, settingsPath } = mkSetup({
      plugins: {
        'tool@mkt': [
          { installPath: oldI, lastUpdated: '2026-01-01T00:00:00Z' },
          { installPath: newI, lastUpdated: '2026-06-01T00:00:00Z' },
        ],
      },
    });
    const skills = catalog.scanPluginSkills(manifestPath, settingsPath);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('tool:thing');
    expect(skills[0].description).toBe('NEW description');
    expect(skills[0].path).toContain('/new/');
  });

  it('collects plugin slash-COMMANDS (commands/*.md) alongside SKILL.md skills', () => {
    const cache = mkdtempSync(join(tmpdir(), 'fleet-cat-cache-'));
    const installPath = mkPluginInstall(cache, 'commit-commands', '1.0', {});
    const cmds = join(installPath, 'commands');
    mkdirSync(cmds, { recursive: true });
    writeFileSync(join(cmds, 'commit.md'), '---\ndescription: Create a git commit\n---\nDo a commit.');
    writeFileSync(join(cmds, 'commit-push-pr.md'), '---\ndescription: Commit, push, open PR\n---\n');
    writeFileSync(join(cmds, 'notes.txt'), 'not a command');
    const { manifestPath, settingsPath } = mkSetup({
      plugins: { 'commit-commands@mkt': [{ installPath }] },
    });
    const skills = catalog.scanPluginSkills(manifestPath, settingsPath);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['commit-commands:commit', 'commit-commands:commit-push-pr']);
    expect(skills.find((s) => s.name === 'commit-commands:commit')!.description).toBe('Create a git commit');
    // kind:'command' is what the LaunchModal /command picker filters on
    expect(skills.every((s) => s.kind === 'command')).toBe(true);
  });

  it('listSkills always includes Claude Code built-in /commands (static, scope builtin)', () => {
    const all = catalog.listSkills();
    const builtins = all.filter((s) => s.scope === 'builtin');
    const names = builtins.map((s) => s.name);
    for (const n of ['init', 'review', 'code-review', 'security-review', 'simplify', 'verify', 'run', 'deep-research']) {
      expect(names).toContain(n);
    }
    expect(builtins.every((s) => s.kind === 'command')).toBe(true);
    // unique paths — the picker and React keys rely on it
    expect(new Set(all.map((s) => s.path)).size).toBe(all.length);
  });

  it('returns [] for a missing or corrupt manifest (never throws)', () => {
    expect(catalog.scanPluginSkills('/nope/does-not-exist.json', '/nope/settings.json')).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cat-bad-'));
    const bad = join(dir, 'installed_plugins.json');
    writeFileSync(bad, '{not json');
    expect(catalog.scanPluginSkills(bad, '/nope/settings.json')).toEqual([]);
  });

  it('tolerates a vanished installPath and malformed install entries', () => {
    const { manifestPath, settingsPath } = mkSetup({
      plugins: {
        'gone@mkt': [{ installPath: '/tmp/definitely/not/here' }],
        'weird@mkt': [{} as any],
      },
    });
    expect(catalog.scanPluginSkills(manifestPath, settingsPath)).toEqual([]);
  });
});
