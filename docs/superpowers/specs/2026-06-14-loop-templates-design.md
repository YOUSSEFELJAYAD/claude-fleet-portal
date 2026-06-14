# Loop Templates — preconfigured create-loop presets

**Date:** 2026-06-14
**Status:** approved (brainstorming) → implementation
**Scope:** frontend-only. One new data file + ~15 lines of wiring in the Loops page. No backend, schema, or API changes.

## Problem

The "new loop" form (`apps/web/app/loops/page.tsx` + `components/ContractEditor.tsx`) is fully manual: the user hand-writes the six-field contract, picks `kind`/`controlPlane`, and sets merge posture, review policy, routable ceiling, escalation threshold, and risk rubric. This is the proximate cause of misconfigured / "stuck" loops (e.g. a worker loop with no routable `agent:ready` work, or a manager with no schedule). Users have no starting point that is known-good.

## Goal

A **template dropdown** at the top of the create form. Selecting a template **prefills every field** (the user can still edit anything, then clicks Create). Pure client-side; nothing is created until the user submits the existing form.

## Non-goals (YAGNI)

- No schedule auto-creation, no card seeding (prefill only — confirmed with user).
- No server-served or DB-persisted templates. Static frontend catalog, matching the existing `DEFAULT_DRAFT` constant pattern.
- `ContractEditor.tsx` is not modified.

## Design

### Data: `apps/web/components/loopTemplates.ts`

```ts
export interface LoopTemplate {
  id: string;            // stable key, e.g. 'manager-triage-board'
  label: string;        // shown in the dropdown
  group: 'Manager' | 'Worker' | 'Custom';
  hint: string;         // "what makes it run" one-liner shown under the dropdown
  kind: LoopKind;
  controlPlane: ControlPlaneKind;
  nameSuggestion: string; // used only if the name field is still empty
  draft: ContractDraft;   // full ContractEditor draft (contract + posture/policy/ceiling/threshold/rubric)
}
export const LOOP_TEMPLATES: LoopTemplate[];
export const CUSTOM_TEMPLATE_ID = 'custom';
export function applyTemplate(
  t: LoopTemplate,
  currentName: string,
): { kind: LoopKind; controlPlane: ControlPlaneKind; name?: string; draft: ContractDraft };
```

`applyTemplate` returns the new `kind`/`controlPlane`/`draft`, and `name` **only when `currentName` is empty** (never clobbers typed input). The `'custom'` entry's `draft` is `DEFAULT_DRAFT`.

### Catalog (the "all possible cases")

Spans both kinds × both control planes × all three postures. Each carries a complete, server-valid contract.

| id | label | kind · CP | posture / review / ceiling |
|----|-------|-----------|----------------------------|
| custom | — Custom (blank) — | Custom | DEFAULT_DRAFT |
| manager-triage-board | Backlog Triage Manager | manager · board | human-gate / always / medium |
| manager-triage-conservative | Conservative Triage Manager | manager · board | human-gate / always / low |
| manager-research-board | Research & Label Manager | manager · board | human-gate / always / medium |
| manager-triage-github | GitHub Issue Triage Manager | manager · github | human-gate / always / medium |
| worker-exec-board | Worker Executor — Human Gate | worker · board | human-gate / always / medium |
| worker-automerge-board | Auto-Merge Low-Risk Worker | worker · board | auto-low-risk / always / low |
| worker-reviewed-board | Reviewed Worker (big-diff) | worker · board | human-gate / threshold:5 / medium |
| worker-pr-github | GitHub PR Worker | worker · github | human-gate / always / medium |

Manager templates use read-only `allowed` (Read/Grep/Glob, diff/log, WebSearch for research) and forbid Edit/Write/push. Worker templates allow `*` and forbid `Bash(git push *)` / `Bash(git remote *)`. Risk-floor rubrics (`**/auth/**`→high, `**/migrations/**`→high) on the triage templates.

### UI wiring: `apps/web/app/loops/page.tsx`

- Add `const [templateId, setTemplateId] = useState(CUSTOM_TEMPLATE_ID)`.
- Render a `<Field label="template">` `<Select>` as the first control (full-width row above the existing `name/project/kind/control plane` grid), listing templates grouped via `<optgroup>`.
- `onChange`: look up the template, call `applyTemplate`, and `setKind/setControlPlane/setName?/setDraft`.
- Show `template.hint` under the select when a non-custom template is selected.
- After a successful `create()`, reset `templateId` to custom (the draft already resets to `DEFAULT_DRAFT`).

### Testing: `apps/web/test/fn-loop-templates.test.ts`

A `validateTemplateDraft` mirror of the server's `validateContract` invariants, asserted over **every** template:

- `contract.job/inputs/output/evaluation` all non-empty.
- `allowed`/`forbidden` are arrays.
- not (`mergePosture === 'auto-low-risk'` && `reviewPolicy === 'off'`).
- `escalationThreshold` is an integer ≥ 1.
- `routableCeiling`/`mergePosture`/risk `forceRisk` are valid enum values.
- `reviewPolicy` matches `always|off|threshold:<N>`.
- template `id`s are unique; `applyTemplate` preserves a non-empty current name and overrides an empty one.

This guarantees no preset can be shipped that the create API would reject.

## Risks

- Selecting a template overwrites the current contract draft. Mitigation: name is preserved if typed; a `— Custom (blank) —` reset is always available. Acceptable for a prefill affordance.
