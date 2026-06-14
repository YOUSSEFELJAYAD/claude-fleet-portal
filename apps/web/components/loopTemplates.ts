// Preconfigured create-loop presets (frontend-only). The dropdown in app/loops/page.tsx applies
// one of these to the form via applyTemplate(); nothing is created until the user submits the
// existing form. Every non-custom preset is a known-good, server-valid loop config — see
// test/fn-loop-templates.test.ts, which asserts each one against the server's contract rules.
//
// Type-only imports (erased at runtime) so this module loads in vitest without the `@/` alias.
import type { LoopKind, ControlPlaneKind } from '@/lib/loops';
import type { ContractDraft } from '@/components/ContractEditor';

export const CUSTOM_TEMPLATE_ID = 'custom';

export interface LoopTemplate {
  id: string;
  label: string;
  group: 'Custom' | 'Manager' | 'Worker';
  /** One-line "what makes it run" note shown under the dropdown. */
  hint: string;
  kind: LoopKind;
  controlPlane: ControlPlaneKind;
  /** Applied to the name field only when it is still empty (never clobbers typed input). */
  nameSuggestion: string;
  draft: ContractDraft;
}

const MANAGER_HINT = 'Manager — fires on a schedule. Attach one in Schedules so it actually runs.';
const WORKER_HINT = 'Worker — runs agent:ready Ready cards from the board (PM-driven, no schedule needed).';

/** Risk floors common to triage/build presets: never let an agent self-route security or schema work. */
const SAFETY_RUBRIC = [
  { glob: '**/auth/**', forceRisk: 'high' as const },
  { glob: '**/migrations/**', forceRisk: 'high' as const },
];

const BLANK_DRAFT: ContractDraft = {
  contract: { job: '', inputs: '', allowed: [], forbidden: [], output: '', evaluation: '' },
  mergePosture: 'human-gate',
  reviewPolicy: 'always',
  routableCeiling: 'low',
  riskRubric: [],
  escalationThreshold: 3,
};

export const LOOP_TEMPLATES: LoopTemplate[] = [
  {
    id: CUSTOM_TEMPLATE_ID,
    label: '— Custom (blank) —',
    group: 'Custom',
    hint: '',
    kind: 'manager',
    controlPlane: 'board',
    nameSuggestion: '',
    draft: BLANK_DRAFT,
  },

  // ── Managers (triage backlog → classify + label; need a schedule to fire) ──────────────────
  {
    id: 'manager-triage-board',
    label: 'Backlog Triage Manager',
    group: 'Manager',
    hint: MANAGER_HINT,
    kind: 'manager',
    controlPlane: 'board',
    nameSuggestion: 'backlog triage',
    draft: {
      contract: {
        job: 'Triage every open Backlog card: classify its type and risk, then mark it agent:ready when an agent can safely execute it, or needs:human when it cannot.',
        inputs: 'Open Backlog cards (title, description, acceptance criteria) plus repository context.',
        allowed: ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)'],
        forbidden: ['Edit', 'Write', 'Bash(git push *)'],
        output: 'Every Backlog card labeled type:* and risk:*, routed agent:ready or needs:human, with an Agent Assessment comment explaining the verdict.',
        evaluation: 'No risk:high card is marked agent:ready; every verdict cites concrete evidence from the card or repository.',
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      routableCeiling: 'medium',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },
  {
    id: 'manager-triage-conservative',
    label: 'Conservative Triage Manager',
    group: 'Manager',
    hint: MANAGER_HINT,
    kind: 'manager',
    controlPlane: 'board',
    nameSuggestion: 'conservative triage',
    draft: {
      contract: {
        job: 'Cautiously triage open Backlog cards: only mark the smallest, clearly-safe cards agent:ready; route anything ambiguous or risky as needs:human.',
        inputs: 'Open Backlog cards plus repository context.',
        allowed: ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)'],
        forbidden: ['Edit', 'Write', 'Bash(git push *)'],
        output: 'Every Backlog card labeled type:* and risk:*, with conservative agent:ready routing and an evidence-backed assessment comment.',
        evaluation: 'Only low-risk, well-specified cards are agent:ready; every borderline card is needs:human with a stated reason.',
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      routableCeiling: 'low',
      riskRubric: [
        ...SAFETY_RUBRIC,
        { glob: '**/*secret*', forceRisk: 'high' },
        { glob: '**/.github/**', forceRisk: 'high' },
      ],
      escalationThreshold: 5,
    },
  },
  {
    id: 'manager-research-board',
    label: 'Research & Label Manager',
    group: 'Manager',
    hint: MANAGER_HINT,
    kind: 'manager',
    controlPlane: 'board',
    nameSuggestion: 'research & label',
    draft: {
      contract: {
        job: "Research each open Backlog card's topic, post a concise sourced summary as a comment, then label the card by type and risk.",
        inputs: 'Open Backlog cards plus web search.',
        allowed: ['Read', 'Grep', 'Glob', 'WebSearch'],
        forbidden: ['Edit', 'Write', 'Bash(git push *)'],
        output: 'Each card carries a cited research summary comment plus type:* and risk:* labels.',
        evaluation: "Each summary is supported by cited sources and the labels match the card's actual scope; no unsupported claims.",
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      routableCeiling: 'medium',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },
  {
    id: 'manager-triage-github',
    label: 'GitHub Issue Triage Manager',
    group: 'Manager',
    hint: MANAGER_HINT,
    kind: 'manager',
    controlPlane: 'github',
    nameSuggestion: 'gh issue triage',
    draft: {
      contract: {
        job: 'Triage open GitHub issues: apply type and risk labels, then route each issue as agent:ready or needs:human.',
        inputs: 'Open GitHub issues lacking triage labels, plus repository context.',
        allowed: ['Read', 'Grep', 'Glob', 'Bash(gh issue view *)', 'Bash(gh issue list *)', 'Bash(git diff *)'],
        forbidden: ['Edit', 'Write', 'Bash(git push *)'],
        output: 'Every open issue labeled type:* and risk:*, routed agent:ready/needs:human, with a triage comment.',
        evaluation: "No risk:high issue is marked agent:ready; labels and routing match the issue's scope.",
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      routableCeiling: 'medium',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },

  // ── Workers (execute agent:ready cards; PM-driven) ─────────────────────────────────────────
  {
    id: 'worker-exec-board',
    label: 'Worker Executor — Human Gate',
    group: 'Worker',
    hint: WORKER_HINT,
    kind: 'worker',
    controlPlane: 'board',
    nameSuggestion: 'worker executor',
    draft: {
      contract: {
        job: 'Implement each agent:ready card in an isolated worktree until its acceptance criteria are met and validation passes.',
        inputs: 'Ready cards labeled agent:ready within the routable risk ceiling, each with its description and acceptance criteria.',
        allowed: ['*'],
        forbidden: ['Bash(git push *)', 'Bash(git remote *)'],
        output: 'A committed, validation-passing diff parked in Review for human approval.',
        evaluation: "Validation passes and the diff satisfies the card's acceptance criteria without unrelated changes.",
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      routableCeiling: 'medium',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },
  {
    id: 'worker-automerge-board',
    label: 'Auto-Merge Low-Risk Worker',
    group: 'Worker',
    hint: WORKER_HINT + ' Auto-merges reviewed risk:low diffs (needs local merge mode + a loop auto-merge ceiling).',
    kind: 'worker',
    controlPlane: 'board',
    nameSuggestion: 'auto-merge worker',
    draft: {
      contract: {
        job: 'Implement each agent:ready card in an isolated worktree, then auto-merge it when it is low-risk and passes both validation and review.',
        inputs: 'Ready cards labeled agent:ready and risk:low, each with its acceptance criteria.',
        allowed: ['*'],
        forbidden: ['Bash(git push *)', 'Bash(git remote *)'],
        output: 'A reviewed, validation-passing risk:low diff merged to the default branch; anything higher-risk parks in Review.',
        evaluation: 'Only risk:low diffs that pass validation and maker/checker review are merged; nothing higher-risk is auto-merged.',
      },
      mergePosture: 'auto-low-risk',
      reviewPolicy: 'always',
      routableCeiling: 'low',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },
  {
    id: 'worker-reviewed-board',
    label: 'Reviewed Worker (big-diff)',
    group: 'Worker',
    hint: WORKER_HINT + ' Runs a maker/checker review only on diffs larger than 5 files.',
    kind: 'worker',
    controlPlane: 'board',
    nameSuggestion: 'reviewed worker',
    draft: {
      contract: {
        job: 'Implement each agent:ready card in an isolated worktree until acceptance criteria are met and validation passes; large diffs get a maker/checker review.',
        inputs: 'Ready cards labeled agent:ready within the routable risk ceiling.',
        allowed: ['*'],
        forbidden: ['Bash(git push *)', 'Bash(git remote *)'],
        output: 'A committed, validation-passing diff parked in Review; diffs over 5 files are maker/checker reviewed first.',
        evaluation: "Validation passes, large diffs pass review, and the result satisfies the card's acceptance criteria.",
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'threshold:5',
      routableCeiling: 'medium',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },
  {
    id: 'worker-pr-github',
    label: 'GitHub PR Worker',
    group: 'Worker',
    hint: WORKER_HINT + ' Opens a pull request instead of merging (needs push enabled + PR merge mode).',
    kind: 'worker',
    controlPlane: 'github',
    nameSuggestion: 'gh pr worker',
    draft: {
      contract: {
        job: 'Implement each agent:ready issue in an isolated worktree and open a pull request; never auto-merge.',
        inputs: 'Issues labeled agent:ready within the risk ceiling, each with its acceptance criteria.',
        allowed: ['*'],
        forbidden: ['Bash(git push *)', 'Bash(git remote *)'],
        output: 'An opened pull request whose diff passes validation and satisfies the issue.',
        evaluation: "Validation passes, the PR satisfies the issue's acceptance criteria, and no unrelated changes are included.",
      },
      mergePosture: 'human-gate',
      reviewPolicy: 'always',
      routableCeiling: 'medium',
      riskRubric: SAFETY_RUBRIC,
      escalationThreshold: 3,
    },
  },
];

/** Apply a template to the create form. Returns the new kind/controlPlane/draft, and a name ONLY
 *  when the user has not typed one (so picking a template never clobbers a typed name). */
export function applyTemplate(
  t: LoopTemplate,
  currentName: string,
): { kind: LoopKind; controlPlane: ControlPlaneKind; name?: string; draft: ContractDraft } {
  const out: { kind: LoopKind; controlPlane: ControlPlaneKind; name?: string; draft: ContractDraft } = {
    kind: t.kind,
    controlPlane: t.controlPlane,
    draft: t.draft,
  };
  if (!currentName.trim() && t.nameSuggestion.trim()) out.name = t.nameSuggestion;
  return out;
}
