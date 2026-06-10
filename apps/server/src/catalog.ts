/**
 * Catalog: discover attachable Skills and subagent profiles from disk (PRD §7.5,
 * §9.4 /skills /subagents). Read-only — authoring is out of scope (PRD non-goals).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SkillInfo, SubagentInfo } from '@fleet/shared';
import { HOME, USER_SKILLS_DIR, USER_AGENTS_DIR, PROJECT_SKILLS_DIRNAME, PROJECT_AGENTS_DIRNAME } from './config.js';

// Plugin skills (the bulk of a real Claude Code setup — superpowers, commit-commands, …) live
// under each plugin's install dir; the MANIFEST points at the CURRENT install (the cache also
// holds stale versions, so globbing the cache would surface duplicates).
const PLUGINS_MANIFEST = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
const USER_SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');

/** Minimal YAML-frontmatter reader: returns the `name`/`description` keys. */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    val = val.replace(/^["']|["']$/g, '');
    if (key) out[key] = val;
  }
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Slash-commands (`commands/*.md`) are invocable like skills in current Claude Code
 * (`/<plugin>:<stem>`), so the catalog surfaces them alongside SKILL.md skills.
 */
function scanCommandsDir(dir: string, scope: SkillInfo['scope']): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const entry of safeList(dir)) {
    if (!entry.endsWith('.md')) continue;
    const p = path.join(dir, entry);
    let fm: Record<string, string> = {};
    try {
      fm = frontmatter(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    out.push({ name: entry.replace(/\.md$/, ''), scope, path: p, description: fm.description, kind: 'command' });
  }
  return out;
}

function scanSkillsDir(dir: string, scope: SkillInfo['scope']): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const entry of safeList(dir)) {
    const skillDir = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let fm: Record<string, string> = {};
    try {
      fm = frontmatter(readFileSync(skillMd, 'utf8'));
    } catch {
      /* ignore */
    }
    out.push({ name: fm.name || entry, scope, path: skillDir, description: fm.description, kind: 'skill' });
  }
  return out;
}

/**
 * Skills from INSTALLED PLUGINS, reported under their fully-qualified Skill-tool invoke name
 * (`<plugin>:<skill-dir>`, e.g. `superpowers:brainstorming`).
 *  - source of truth is installed_plugins.json (v2: `plugins` keyed `name@marketplace` → installs
 *    with `installPath`); skills live at `<installPath>/skills/<skill>/SKILL.md`.
 *  - a plugin explicitly disabled in settings.json `enabledPlugins` is skipped (claude won't
 *    load its skills either).
 *  - multiple cached installs of one plugin de-dupe newest-first by lastUpdated.
 * Defensive throughout — a missing/corrupt manifest yields [].
 */
export function scanPluginSkills(manifestPath: string = PLUGINS_MANIFEST, settingsPath: string = USER_SETTINGS_FILE): SkillInfo[] {
  let plugins: Record<string, unknown>;
  try {
    plugins = JSON.parse(readFileSync(manifestPath, 'utf8'))?.plugins ?? {};
  } catch {
    return [];
  }
  let enabled: Record<string, boolean> = {};
  try {
    enabled = JSON.parse(readFileSync(settingsPath, 'utf8'))?.enabledPlugins ?? {};
  } catch {
    /* no settings → treat every installed plugin as enabled */
  }
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const [key, installsRaw] of Object.entries(plugins)) {
    if (enabled[key] === false) continue;
    const pluginName = key.split('@')[0];
    const installs = (Array.isArray(installsRaw) ? [...installsRaw] : []).sort((a: any, b: any) =>
      String(b?.lastUpdated ?? '').localeCompare(String(a?.lastUpdated ?? '')),
    );
    for (const inst of installs) {
      const installPath = (inst as any)?.installPath;
      if (typeof installPath !== 'string' || !installPath) continue;
      // SKILL.md skills — the DIRECTORY name is the canonical invoke segment (frontmatter
      // `name` may drift) — plus slash-commands, whose segment is the file stem.
      const found = [
        ...scanSkillsDir(path.join(installPath, 'skills'), 'plugin').map((s) => ({ ...s, seg: path.basename(s.path) })),
        ...scanCommandsDir(path.join(installPath, 'commands'), 'plugin').map((s) => ({ ...s, seg: s.name })),
      ];
      for (const { seg, ...s } of found) {
        const qualified = `${pluginName}:${seg}`;
        if (seen.has(qualified)) continue;
        seen.add(qualified);
        out.push({ ...s, name: qualified });
      }
    }
  }
  return out;
}

/**
 * Claude Code's BUILT-IN slash-commands (task-shaped ones an agent can start on via
 * `claude -p "/<name> …"`). These ship inside the claude binary and are extracted only
 * per-invocation at runtime, so they cannot be enumerated from disk — kept as a static
 * list of the stable, documented set. A name unknown to an older/newer CLI just fails
 * loud in the run output, so this is best-effort by design.
 */
const BUILTIN_CLAUDE_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'init', description: 'Initialize a CLAUDE.md file with codebase documentation' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'code-review', description: 'Review the current diff for correctness bugs and cleanups' },
  { name: 'security-review', description: 'Security review of the pending changes on the current branch' },
  { name: 'simplify', description: 'Apply reuse / simplification / efficiency cleanups to the changed code' },
  { name: 'verify', description: 'Verify a change works by running the app and observing behavior' },
  { name: 'run', description: "Launch and drive this project's app to see a change working" },
  { name: 'deep-research', description: 'Deep multi-source, fact-checked research report with citations' },
];

export function listSkills(cwd?: string): SkillInfo[] {
  // De-dupe by path: a cwd of $HOME makes the 'project' scan resolve to the SAME
  // ~/.claude dirs as the 'user' scan, which would list every user skill twice.
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  const add = (items: SkillInfo[]) => {
    for (const s of items) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      out.push(s);
    }
  };
  add(scanSkillsDir(USER_SKILLS_DIR, 'user'));
  add(scanCommandsDir(path.join(HOME, '.claude', 'commands'), 'user'));
  if (cwd) {
    add(scanSkillsDir(path.join(cwd, PROJECT_SKILLS_DIRNAME), 'project'));
    add(scanCommandsDir(path.join(cwd, '.claude', 'commands'), 'project'));
  }
  add(scanPluginSkills());
  add(
    BUILTIN_CLAUDE_COMMANDS.map((c) => ({
      name: c.name,
      scope: 'builtin' as const,
      path: `claude-builtin:/${c.name}`,
      description: c.description,
      kind: 'command' as const,
    })),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function scanAgentsDir(dir: string, scope: SubagentInfo['scope']): SubagentInfo[] {
  const out: SubagentInfo[] = [];
  for (const entry of safeList(dir)) {
    if (!entry.endsWith('.md')) continue;
    const p = path.join(dir, entry);
    let fm: Record<string, string> = {};
    try {
      fm = frontmatter(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    out.push({ name: fm.name || entry.replace(/\.md$/, ''), scope, path: p, description: fm.description });
  }
  return out;
}

export function listSubagents(cwd?: string): SubagentInfo[] {
  const agents = scanAgentsDir(USER_AGENTS_DIR, 'user');
  if (cwd) {
    const seen = new Set(agents.map((a) => a.path));
    for (const a of scanAgentsDir(path.join(cwd, PROJECT_AGENTS_DIRNAME), 'project')) {
      if (!seen.has(a.path)) agents.push(a);
    }
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
