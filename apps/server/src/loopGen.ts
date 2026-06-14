/**
 * AI loop generation — draft a Loop config from a natural-language prompt, tailored to the
 * selected project's board + repo. Mirrors loopEval.ts: a read-only ('plan'), json-schema'd
 * claude run whose `--json-schema` output lands on run.structuredOutput. Nothing is created —
 * the normalized draft prefills the create form for human review (POST /api/loops/generate).
 *
 * The model gets server-gathered context (no repo tools), so generation is a fast, deterministic
 * text→JSON transform. parseLoopGen + buildProjectContext are PURE (unit-tested in loopgen.test.ts).
 */
import type { FastifyInstance } from 'fastify';
import type {
  ControlPlaneKind, GenerateLoopResponse, LoopContract, LoopKind,
  MergePosture, Project, RiskLevel, RiskRule, Run,
} from '@fleet/shared';
import { registry } from './registry.js';
import { projectsRepo } from './projects.js';
import { kanbanRepo } from './kanban.js';
import { validateContract } from './loops.js';
import { gitExec } from './git.js';

// ── structured-output schema → `--json-schema` ─────────────────────────────────────
export const LOOP_GEN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['manager', 'worker'], description: "manager = triage/label backlog (needs a schedule); worker = execute agent:ready cards (PM-driven)" },
    controlPlane: { type: 'string', enum: ['board', 'github'] },
    suggestedName: { type: 'string', description: 'a short kebab-or-spaced loop name' },
    contract: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'the single responsibility' },
        inputs: { type: 'string', description: 'what STATE it inspects' },
        allowed: { type: 'array', items: { type: 'string' }, description: 'tool patterns it MAY use (e.g. Read, Grep, Bash(git diff *), or * for a worker)' },
        forbidden: { type: 'array', items: { type: 'string' }, description: 'tool patterns it must NEVER use (e.g. Bash(git push *))' },
        output: { type: 'string', description: 'the concrete artifact after a good run' },
        evaluation: { type: 'string', description: 'REQUIRED, non-empty — how success is graded' },
      },
      required: ['job', 'inputs', 'allowed', 'forbidden', 'output', 'evaluation'],
      additionalProperties: false,
    },
    mergePosture: { type: 'string', enum: ['human-gate', 'auto-low-risk'] },
    reviewPolicy: { type: 'string', description: "'always', 'off', or 'threshold:<N>'" },
    routableCeiling: { type: 'string', enum: ['low', 'medium', 'high'], description: 'max risk an agent may self-route' },
    escalationThreshold: { type: 'integer', minimum: 1, description: 'clean dry-runs before auto-apply' },
    riskRubric: {
      type: 'array',
      items: {
        type: 'object',
        properties: { glob: { type: 'string' }, forceRisk: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['glob', 'forceRisk'],
        additionalProperties: false,
      },
      description: 'path globs forced to a risk floor (use real repo paths)',
    },
  },
  required: ['kind', 'controlPlane', 'suggestedName', 'contract', 'mergePosture', 'reviewPolicy', 'routableCeiling', 'escalationThreshold'],
  additionalProperties: false,
} as const;

// ── pure normalization ─────────────────────────────────────────────────────────────

const RISK: RiskLevel[] = ['low', 'medium', 'high'];
const s = (x: unknown): string => (x == null ? '' : String(x));
const strArr = (x: unknown): string[] => (Array.isArray(x) ? x.map(s).map((v) => v.trim()).filter(Boolean) : []);
const REVIEW_RE = /^(always|off|threshold:\d+)$/;

export type NormalizedDraft = Omit<GenerateLoopResponse, 'warning'>;

/** Clamp/coerce a raw model structuredOutput into a valid loop draft, or null if unusable. */
export function parseLoopGen(so: unknown): NormalizedDraft | null {
  if (!so || typeof so !== 'object') return null;
  const o = so as Record<string, any>;
  const c = (o.contract && typeof o.contract === 'object' ? o.contract : {}) as Record<string, any>;
  const rubric: RiskRule[] = (Array.isArray(o.riskRubric) ? o.riskRubric : [])
    .filter((r: any) => r && typeof r === 'object' && s(r.glob).trim() && RISK.includes(r.forceRisk))
    .map((r: any) => ({ glob: s(r.glob).trim(), forceRisk: r.forceRisk as RiskLevel }));
  const threshold = Number.isInteger(o.escalationThreshold) && o.escalationThreshold >= 1 ? o.escalationThreshold : 3;
  const contract: LoopContract = {
    job: s(c.job), inputs: s(c.inputs), output: s(c.output), evaluation: s(c.evaluation),
    allowed: strArr(c.allowed), forbidden: strArr(c.forbidden),
  };
  return {
    kind: (o.kind === 'worker' ? 'worker' : 'manager') as LoopKind,
    controlPlane: (o.controlPlane === 'github' ? 'github' : 'board') as ControlPlaneKind,
    suggestedName: s(o.suggestedName).trim(),
    contract,
    mergePosture: (o.mergePosture === 'auto-low-risk' ? 'auto-low-risk' : 'human-gate') as MergePosture,
    reviewPolicy: REVIEW_RE.test(s(o.reviewPolicy)) ? s(o.reviewPolicy) : 'always',
    routableCeiling: (RISK.includes(o.routableCeiling) ? o.routableCeiling : 'low') as RiskLevel,
    escalationThreshold: threshold,
    riskRubric: rubric,
  };
}

// ── pure context assembly ────────────────────────────────────────────────────────────

const CARD_CAP = 40;
const PATH_CAP = 80;
/** Stack-signalling files: their presence hints the tech stack → tool patterns + risk globs. */
const STACK_FILES = ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'Dockerfile'];

type CtxProject = Pick<Project, 'name' | 'defaultBranch' | 'mergeMode' | 'autoMerge' | 'pushEnabled' | 'wipLimit'>;
type CtxCard = { title: string; column: string; labels: string[] };

/** Build a compact, BOUNDED context block from the project, its board, and its tracked paths. */
export function buildProjectContext(project: CtxProject, cards: CtxCard[], repoPaths: string[]): string {
  const lines: string[] = [];
  lines.push('## Project');
  lines.push(`name: ${project.name} · defaultBranch: ${project.defaultBranch} · mergeMode: ${project.mergeMode} · autoMerge: ${project.autoMerge} · pushEnabled: ${project.pushEnabled} · wipLimit: ${project.wipLimit}`);

  lines.push('\n## Board');
  const byCol = cards.reduce<Record<string, number>>((m, c) => ((m[c.column] = (m[c.column] || 0) + 1), m), {});
  lines.push(`cards by column: ${Object.entries(byCol).map(([k, v]) => `${k}=${v}`).join(', ') || '(empty)'}`);
  for (const c of cards.slice(0, CARD_CAP)) {
    lines.push(`- [${c.column}] ${c.title}${c.labels.length ? ` — ${c.labels.join(', ')}` : ''}`);
  }
  if (cards.length > CARD_CAP) lines.push(`(+${cards.length - CARD_CAP} more cards)`);

  lines.push('\n## Repo');
  const stack = STACK_FILES.filter((f) => repoPaths.some((p) => p === f || p.endsWith('/' + f)));
  lines.push(`stack signals: ${stack.join(', ') || '(none detected)'}`);
  const sensitive = repoPaths.filter((p) => /(^|\/)(auth|migrations|\.github)(\/|$)/i.test(p)).slice(0, 20);
  if (sensitive.length) lines.push(`sensitive paths (good risk-rubric globs): ${sensitive.join(', ')}`);
  const sample = repoPaths.slice(0, PATH_CAP);
  if (sample.length) lines.push(`tracked paths (sample): ${sample.join(', ')}${repoPaths.length > PATH_CAP ? ` (+${repoPaths.length - PATH_CAP} more)` : ''}`);
  return lines.join('\n');
}

// ── prompt ────────────────────────────────────────────────────────────────────────────

function buildGenPrompt(userPrompt: string, context: string): string {
  return [
    'You design autonomous "Loops" for a Kanban/PM control plane. Convert the user request below into ONE loop config, returned via the structured schema. Tailor it to the PROJECT CONTEXT.',
    '',
    'Loop model:',
    '- kind "manager": triages the Backlog — classifies type+risk and routes agent:ready/needs:human. Read-only tools (Read, Grep, Glob, git diff/log, gh issue view); forbid Edit/Write/git push. Needs a schedule to fire.',
    '- kind "worker": implements agent:ready cards in an isolated worktree until validation passes. allowed ["*"]; forbid Bash(git push *) and Bash(git remote *). PM-driven (no schedule).',
    'Rules: evaluation MUST be specific and non-empty. mergePosture "auto-low-risk" REQUIRES reviewPolicy "always" or "threshold:<N>" (never "off"). reviewPolicy is "always" | "off" | "threshold:<N>". routableCeiling is the max risk an agent may self-route. Use REAL repo paths from the context for riskRubric globs (e.g. security/auth and DB migration dirs → forceRisk "high").',
    '',
    '## Project context',
    context,
    '',
    '## User request',
    userPrompt.trim(),
    '',
    'Return ONLY the structured loop config.',
  ].join('\n');
}

// ── launch + await (copied from loopEval.ts — same trusted plumbing) ─────────────────────

const TERMINAL: Run['status'][] = ['completed', 'failed', 'killed'];
const GEN_TIMEOUT_MS = 3 * 60_000;

function awaitTerminal(runId: string): Promise<Run | null> {
  return new Promise((resolve) => {
    const current = registry.getRun(runId);
    if (current && TERMINAL.includes(current.status)) { resolve(current); return; }
    let done = false;
    const finish = (r: Run | null) => { if (done) return; done = true; unsub(); clearTimeout(timer); resolve(r); };
    const unsub = registry.onRunTerminal((run) => { if (run.id === runId) finish(registry.getRun(runId) ?? run); });
    const timer = setTimeout(() => finish(registry.getRun(runId)), GEN_TIMEOUT_MS);
    timer.unref?.();
  });
}

const httpErr = (code: number, message: string) => Object.assign(new Error(message), { statusCode: code });

/** Generate + normalize + validate a loop draft for a project. Throws {statusCode} on failure. */
export async function generateLoopDraft(opts: { prompt: string; projectId: string }): Promise<GenerateLoopResponse> {
  const project = projectsRepo.getProject(opts.projectId);
  if (!project) throw httpErr(400, 'projectId must reference an existing project');

  const cards: CtxCard[] = kanbanRepo.listTasks(project.id).map((t) => ({ title: t.title, column: t.column, labels: t.labels }));
  let repoPaths: string[] = [];
  try {
    const ls = await gitExec(project.rootDir, ['ls-files']);
    if (ls.ok) repoPaths = ls.stdout.split('\n').filter(Boolean);
  } catch { /* non-git project → no repo signal, still generate */ }

  const context = buildProjectContext(project, cards, repoPaths);

  const launched = await registry.launch({
    prompt: buildGenPrompt(opts.prompt, context),
    cwd: project.rootDir,
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'plan', // read-only: context is provided; the model only emits JSON
    jsonSchema: LOOP_GEN_JSON_SCHEMA,
    projectId: project.id,
    interactive: false,
  });
  const run = await awaitTerminal(launched.id);
  if (!run || run.status !== 'completed') {
    throw httpErr(502, `AI did not return a config (status: ${run?.status ?? 'unknown'}) — retry or use a template`);
  }
  const draft = parseLoopGen(run.structuredOutput);
  if (!draft) throw httpErr(502, 'AI returned no usable config — retry or use a template');

  // Non-fatal: surface a contract problem as a warning so the form can guide the fix.
  const warning = validateContract(draft.contract, { mergePosture: draft.mergePosture, reviewPolicy: draft.reviewPolicy });
  return { ...draft, warning };
}

// ── route ────────────────────────────────────────────────────────────────────────────

export function registerLoopGenRoutes(app: FastifyInstance): void {
  app.post('/api/loops/generate', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{ prompt: string; projectId: string }>;
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return reply.code(400).send({ error: 'prompt is required' });
    }
    if (typeof body.projectId !== 'string' || !body.projectId) {
      return reply.code(400).send({ error: 'projectId is required' });
    }
    try {
      return await generateLoopDraft({ prompt: body.prompt, projectId: body.projectId });
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 502).send({ error: e?.message ?? 'generation failed' });
    }
  });
}
