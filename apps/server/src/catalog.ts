/**
 * Catalog: discover attachable Skills and subagent profiles from disk (PRD §7.5,
 * §9.4 /skills /subagents). Read-only — authoring is out of scope (PRD non-goals).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SkillInfo, SubagentInfo } from '@fleet/shared';
import { USER_SKILLS_DIR, USER_AGENTS_DIR, PROJECT_SKILLS_DIRNAME, PROJECT_AGENTS_DIRNAME } from './config.js';

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
    out.push({ name: fm.name || entry, scope, path: skillDir, description: fm.description });
  }
  return out;
}

export function listSkills(cwd?: string): SkillInfo[] {
  const skills = scanSkillsDir(USER_SKILLS_DIR, 'user');
  if (cwd) skills.push(...scanSkillsDir(path.join(cwd, PROJECT_SKILLS_DIRNAME), 'project'));
  return skills.sort((a, b) => a.name.localeCompare(b.name));
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
  if (cwd) agents.push(...scanAgentsDir(path.join(cwd, PROJECT_AGENTS_DIRNAME), 'project'));
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
