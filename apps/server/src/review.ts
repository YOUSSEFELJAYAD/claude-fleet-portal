/**
 * Maker/checker gate (SPEC §9): launch the existing adversarial, READ-ONLY Reviewer template on a
 * worker's diff and parse a structured pass/findings verdict. The maker is never the only judge of
 * its own diff. NEVER throws — any launch/parse failure returns a safe reject so the worker path
 * reworks rather than silently shipping an unreviewed diff.
 *
 * Mirrors benchmarks.ts JUDGE_JSON_SCHEMA usage: registry.launch({ jsonSchema }) → run.structuredOutput.
 * The Reviewer profile (templates.ts: name 'Reviewer', role 'reviewer') is read-only — allowedTools
 * ['Read','Grep','Glob'], permissionMode 'default' — so we resolve it via repo.getTemplateByName and
 * carry its envelope; if it is somehow absent we fall back to the same read-only envelope inline.
 */
import type { KanbanTask, Project, ReviewVerdict } from '@fleet/shared';
import { registry } from './registry.js';
import { repo } from './db.js';

/** Await-terminal fallback timeout (mirrors loopEval.ts / manager.ts). */
const REVIEW_TIMEOUT_MS = 5 * 60_000;

/** Structured verdict schema → `--json-schema` (parsed off run.structuredOutput). */
export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'true to ship, false to reject and request changes' },
    findings: { type: 'string', description: 'verdict rationale; on reject, the specific issues to fix' },
  },
  required: ['pass', 'findings'],
  additionalProperties: false,
} as const;

/** The read-only Reviewer tool envelope (matches templates.ts Reviewer; never includes Edit/Write). */
const REVIEWER_FALLBACK_TOOLS = ['Read', 'Grep', 'Glob'];

function buildReviewPrompt(card: KanbanTask, diff: string): string {
  const ac = card.acceptanceCriteria?.trim()
    ? `\n\nACCEPTANCE CRITERIA / DEFINITION OF DONE:\n${card.acceptanceCriteria.trim()}`
    : '';
  return (
    `Adversarially review the following diff for the task "${card.title}". You may read the surrounding ` +
    `code (Read/Grep/Glob) for context but you NEVER modify files. Hunt for genuine correctness bugs, ` +
    `security issues, and missed edge cases.${ac}\n\n` +
    `Return a structured verdict: set "pass" true only if the change is safe to ship; otherwise set ` +
    `"pass" false and put the specific issues to fix in "findings".\n\n` +
    `--- DIFF ---\n${diff}`
  );
}

export async function launchReview(card: KanbanTask, project: Project, diff: string): Promise<ReviewVerdict> {
  try {
    const t = repo.getTemplateByName('Reviewer');
    const run = await registry.launch({
      prompt: buildReviewPrompt(card, diff),
      cwd: project.rootDir,
      projectId: project.id,
      campaignId: null,
      model: t?.model ?? 'claude-opus-4-8',
      effort: (t?.effort as any) ?? 'high',
      // read-only checker: the Reviewer envelope has no Edit/Write; default permission mode.
      permissionMode: (t?.permissionMode as any) ?? 'default',
      allowedTools: t?.allowedTools ?? REVIEWER_FALLBACK_TOOLS,
      appendSystemPrompt: t?.systemPrompt,
      budgetUsd: t?.budgetUsd ?? undefined,
      jsonSchema: REVIEW_JSON_SCHEMA,
      interactive: false,
    });
    // launch returns a STILL-RUNNING run (structuredOutput === null on the claude path); await
    // terminal first, THEN read the verdict off the resolved run. Reading run.structuredOutput here
    // would always be null in production → reviews would fail closed on every card.
    const terminal = await registry.awaitRunTerminal(run.id, REVIEW_TIMEOUT_MS);
    if (!terminal) {
      return { pass: false, findings: 'review failed: reviewer run never reached terminal' };
    }
    if (terminal.status !== 'completed') {
      return { pass: false, findings: `review failed: reviewer run ${terminal.status}` };
    }
    const so = terminal.structuredOutput as any;
    if (so && typeof so.pass === 'boolean' && typeof so.findings === 'string') {
      return { pass: so.pass, findings: so.findings };
    }
    return { pass: false, findings: 'review failed: reviewer returned no structured verdict' };
  } catch (e: any) {
    return { pass: false, findings: `review failed: ${e?.message ?? e}` };
  }
}
