/**
 * Agent Templates (DC.md D-020): reusable agent profiles for Orchestration Mode.
 * Built-ins are seeded on boot; users can add their own via the API.
 */
import { randomUUID } from 'node:crypto';
import type { AgentTemplate } from '@fleet/shared';
import { repo } from './db.js';

type Seed = Omit<AgentTemplate, 'id' | 'createdAt'>;

export const BUILTIN_TEMPLATES: Seed[] = [
  {
    name: 'Orchestrator',
    role: 'orchestrator',
    description: 'Decomposes an objective into a dependency-ordered plan of worker subtasks.',
    systemPrompt:
      'You are an orchestration planner for a fleet of autonomous coding agents. Given a high-level objective, ' +
      'decompose it into a MINIMAL set (prefer 3–7) of concrete, independently-executable subtasks. Each task MUST have ' +
      'a fully self-contained `prompt` that a fresh worker agent can execute with no other context. Use `dependsOn` to ' +
      'order tasks whose prompt needs a prior task’s result. Assign each task a `template` name (Researcher, Implementer, ' +
      'Reviewer) appropriate to the work. Output ONLY the structured plan — no prose.',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob'],
    skills: [],
    permissionMode: 'default', // not 'plan' — avoids a headless plan-mode hang; tools are read-only anyway
    budgetUsd: 2,
    isBuiltin: true,
  },
  {
    name: 'Researcher',
    role: 'worker',
    description: 'Gathers and summarizes information from the codebase and the web.',
    systemPrompt:
      'You are a focused research agent. Investigate exactly what your task asks, cite concrete sources (file:line or URLs), ' +
      'and return a tight, factual summary. Do not modify files.',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    skills: [],
    permissionMode: 'default',
    budgetUsd: 3,
    isBuiltin: true,
  },
  {
    name: 'Implementer',
    role: 'worker',
    description: 'Writes and edits code to satisfy a concrete subtask.',
    systemPrompt:
      'You are an implementation agent. Make the smallest correct change that satisfies your task, matching the surrounding ' +
      'code style. Verify your change compiles/tests where possible. Report exactly what you changed.',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'xhigh',
    allowedTools: [],
    skills: [],
    permissionMode: 'acceptEdits',
    budgetUsd: 5,
    isBuiltin: true,
  },
  {
    name: 'Reviewer',
    role: 'worker',
    description: 'Adversarially reviews work for correctness and risk.',
    systemPrompt:
      'You are a skeptical code reviewer. Hunt for genuine correctness bugs, security issues, and missed edge cases in the ' +
      'work described by your task. Default to scrutiny; report only real, triggerable issues with the exact scenario.',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob'],
    skills: [],
    permissionMode: 'default',
    budgetUsd: 2,
    isBuiltin: true,
  },
  {
    name: 'Synthesizer',
    role: 'synthesizer',
    description: 'Merges all worker results into one coherent final answer.',
    systemPrompt:
      'You are a synthesis agent. You are given the objective and every worker’s result. Reconcile them into a single ' +
      'coherent, de-duplicated final deliverable, flag any conflicts between workers, and state what (if anything) is still open.',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob'],
    skills: [],
    permissionMode: 'default',
    budgetUsd: 2,
    isBuiltin: true,
  },
];

export function seedTemplates() {
  const now = Date.now();
  for (const s of BUILTIN_TEMPLATES) {
    if (repo.getTemplateByName(s.name)) continue;
    repo.upsertTemplate({ ...s, id: randomUUID(), createdAt: now });
  }
}
