/**
 * Built-in Manager (triage) loop (design §8). Per fire it asks a read-only LLM run to
 * classify ONE backlog item into a TriageVerdict, applies deterministic rubric hard-floors
 * (§12), then writes risk/type labels + agent:ready|needs:human + an Agent Assessment via
 * the control plane. In dry-run mode the control plane (controlplane.ts) intercepts every
 * write into IntendedAction[]; this module performs no conditional dry-run logic of its own.
 *
 * The Manager NEVER writes code — it runs under the read-only `Manager` template (templates.ts)
 * with allowedTools Read/Grep/Glob and no Edit/Write/Bash.
 */
import type { Project, TriageVerdict, RiskRule, RiskLevel, WorkType, Run, Loop } from '@fleet/shared';
import { RISK_LABELS, TYPE_LABELS, ROUTING } from '@fleet/shared';
import { registry } from './registry.js';
import { repo } from './db.js';
import { compileContract } from './loops.js';
import type { WorkItem, IntendedAction, ControlPlane } from './controlplane.js';

/** `--json-schema` shape the Manager run emits; lands on run.structuredOutput (F-8). Mirrors
 *  benchmarks.ts JUDGE_JSON_SCHEMA / campaigns PLAN_JSON_SCHEMA usage. */
export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Blast-radius risk of working this item autonomously' },
    type: { type: 'string', enum: ['bug', 'feature', 'docs', 'test', 'refactor', 'chore'], description: 'Work category' },
    agentReady: { type: 'boolean', description: 'true ONLY for low-risk, unambiguous work an agent can finish with no human decision' },
    reason: { type: 'string', description: 'Evidence-backed justification (cite file:line / the risky surface)' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Specific questions a human must answer when not agent-ready' },
  },
  required: ['risk', 'type', 'agentReady', 'reason'],
  additionalProperties: false,
} as const;

/** Convert a shell-style glob (`*`, `?`) into a case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when `glob` matches any of the item's title, body, or labels. */
function ruleMatches(item: WorkItem, glob: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(item.title) || re.test(item.body)) return true;
  return item.labels.some((l) => re.test(l));
}

/** Numeric rank for risk comparison: higher number = higher risk. */
const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * PURE deterministic rubric hard-floor (§12). If the item touches a configured sensitive glob,
 * FORCE risk to at least rule.forceRisk (hard-floor: only raises, never lowers) and set
 * agentReady=false, overriding the agent's verdict, and record the override in `reason`. First
 * matching rule wins. Never raises agentReady. Never mutates inputs.
 */
export function applyRubricFloors(item: WorkItem, verdict: TriageVerdict, rubric: RiskRule[]): TriageVerdict {
  const next: TriageVerdict = { ...verdict };
  for (const rule of rubric) {
    if (ruleMatches(item, rule.glob)) {
      // Hard-floor: the rule can only RAISE risk, never lower it.
      next.risk = RANK[rule.forceRisk] >= RANK[next.risk] ? rule.forceRisk : next.risk;
      next.agentReady = false;
      next.reason = `${verdict.reason} [rubric override: glob "${rule.glob}" → forced risk:${rule.forceRisk}, not agent-ready]`;
      return next;
    }
  }
  return next;
}

// ── runManagerLoop internals ─────────────────────────────────────────────────

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const TERMINAL: Run['status'][] = ['completed', 'failed', 'killed'];
const MANAGER_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Resolve when the launched run reaches a terminal state. Already-terminal → resolves now.
 * `registry.launch` returns a still-running run with `structuredOutput === null` for the claude
 * path (it is only populated once the engine result lands — registry.ts; benchmarks.ts reads it
 * later via its onRunTerminal handler, never at launch). So we must await terminal before reading
 * structuredOutput. Mirrors loopEval.ts `awaitTerminal` (module-private there, so duplicated).
 */
function awaitTerminal(runId: string): Promise<Run | null> {
  return new Promise((resolve) => {
    const current = registry.getRun(runId);
    if (current && TERMINAL.includes(current.status)) {
      resolve(current);
      return;
    }
    let done = false;
    const finish = (r: Run | null) => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      resolve(r);
    };
    const unsub = registry.onRunTerminal((run) => {
      if (run.id === runId) finish(registry.getRun(runId) ?? run);
    });
    const timer = setTimeout(() => finish(registry.getRun(runId)), MANAGER_RUN_TIMEOUT_MS);
    timer.unref?.(); // never keep the process alive on the fallback timer
  });
}

/** Resolve the read-only Manager template (falls back to a minimal read-only envelope). */
function managerTemplate() {
  return (
    repo.getTemplateByName('Manager') ?? {
      model: 'claude-opus-4-8',
      effort: 'high' as const,
      permissionMode: 'default' as const,
      allowedTools: ['Read', 'Grep', 'Glob'],
      skills: [] as string[],
      budgetUsd: 2,
      systemPrompt: '',
    }
  );
}

/** Human-readable Agent Assessment for a verdict (board comment / GitHub issue comment). */
function assessmentMarkdown(item: WorkItem, v: TriageVerdict): string {
  const lines = [
    `**Agent Assessment** — ${item.title}`,
    `- Risk: \`${RISK_LABELS[v.risk]}\``,
    `- Type: \`${TYPE_LABELS[v.type]}\``,
    `- Agent-ready: ${v.agentReady ? `\`${ROUTING.ready}\`` : `\`${ROUTING.needsHuman}\``}`,
    `- Reason: ${v.reason}`,
  ];
  if (!v.agentReady && v.questions?.length) {
    lines.push('- Open questions:');
    for (const q of v.questions) lines.push(`  - ${q}`);
  }
  return lines.join('\n');
}

/**
 * Triage every backlog item (design §8). For each item: launch a read-only Manager run that emits
 * a TriageVerdict (TRIAGE_JSON_SCHEMA) — AWAIT the run to terminal before reading
 * run.structuredOutput (launch returns a still-running run; structuredOutput is null until the
 * engine result lands) — apply rubric hard-floors, then classify + (when escalating) attach
 * questions, and ALWAYS post an assessment. risk above routableCeiling can never stay agent-ready.
 * Writes flow through `cp`; in dry-run mode the Slice 03 wrapper intercepts them into the
 * `intended` array that `controlPlaneFor` returns ALONGSIDE `cp` (the tuple `{ cp, intended }`),
 * not onto `cp` itself. The caller (loops.fire) grades that tuple's `intended`. This function's
 * `Promise<IntendedAction[]>` return type exists only for contract-sheet signature compatibility;
 * the value is unused by the caller, so it simply returns `[]`.
 */
export async function runManagerLoop(loop: Loop, project: Project, cp: ControlPlane): Promise<IntendedAction[]> {
  const t = managerTemplate();
  const ceiling = RISK_RANK[loop.routableCeiling];
  const backlog = await cp.listBacklog();

  // SPEC §10: the loop contract compiles into the launch envelope for EVERY run the loop spawns.
  // For the read-only Manager triage run we KEEP the template's read-only allowedTools/permissionMode
  // (never broadened) and UNION the compiled deny-list (project baseline ∪ contract.forbidden — only
  // ADDS denies) with whatever denies the template already carries.
  const compiled = compileContract(loop, project);
  const templateDenies = (t as any).disallowedTools as string[] | undefined;
  const triageDisallowed = [...(templateDenies ?? [])];
  for (const d of compiled.disallowedTools) {
    if (!triageDisallowed.includes(d)) triageDisallowed.push(d);
  }

  for (const item of backlog) {
    const prompt =
      `Triage this backlog item for autonomous routing. Return ONLY the structured TriageVerdict.\n\n` +
      `# ${item.title}\n\n${item.body}\n\n` +
      (item.labels.length ? `Existing labels: ${item.labels.join(', ')}\n` : '');

    let verdict: TriageVerdict | null = null;
    try {
      const launched = await registry.launch({
        prompt,
        cwd: project.rootDir,
        model: t.model,
        effort: t.effort,
        permissionMode: t.permissionMode, // read-only Manager template (kept; never broadened)
        allowedTools: t.allowedTools, // read-only template allowedTools — NOT widened to contract.allowed
        disallowedTools: triageDisallowed, // SPEC §10 — compiled contract denies UNIONed in
        skills: t.skills,
        budgetUsd: t.budgetUsd ?? undefined,
        appendSystemPrompt: t.systemPrompt,
        jsonSchema: TRIAGE_JSON_SCHEMA,
        projectId: loop.projectId,
        interactive: false,
      });
      // launch returns a STILL-RUNNING run (structuredOutput === null on the claude path);
      // await terminal first, then read the structured verdict off the resolved run.
      const run = await awaitTerminal(launched.id);
      const so = run?.status === 'completed' ? (run.structuredOutput as Partial<TriageVerdict> | null) : null;
      if (so && so.risk && so.type && typeof so.agentReady === 'boolean' && typeof so.reason === 'string') {
        verdict = {
          risk: so.risk as RiskLevel,
          type: so.type as WorkType,
          agentReady: so.agentReady,
          reason: so.reason,
          questions: Array.isArray(so.questions) ? so.questions.map(String) : undefined,
        };
      }
    } catch {
      verdict = null; // a failed manager run → escalate the item to a human (below)
    }

    // No usable verdict → safest default: needs:human with a generic question.
    if (!verdict) {
      verdict = {
        risk: 'high',
        type: 'chore',
        agentReady: false,
        reason: 'manager run produced no usable verdict',
        questions: ['Manual triage required.'],
      };
    }

    // Deterministic rubric hard-floors override the agent (§12).
    const floored = applyRubricFloors(item, verdict, loop.riskRubric);

    // routableCeiling caps what may be agent:ready (default 'low').
    const ready = floored.agentReady && RISK_RANK[floored.risk] <= ceiling;
    const finalVerdict: TriageVerdict = { ...floored, agentReady: ready };

    await cp.classify(item.id, finalVerdict);
    if (!ready) {
      const questions =
        finalVerdict.questions?.length
          ? finalVerdict.questions
          : ['Needs human triage — not within the routable risk ceiling.'];
      await cp.attachQuestions(item.id, questions);
    }
    await cp.postAssessment(item.id, assessmentMarkdown(item, finalVerdict));
  }

  // The `intended` array lives on the tuple returned by controlPlaneFor (Slice 03), NOT on `cp`;
  // the caller (loops.fire) holds and grades it. This return value is unused — `[]` satisfies the
  // contract-sheet signature.
  return [];
}
