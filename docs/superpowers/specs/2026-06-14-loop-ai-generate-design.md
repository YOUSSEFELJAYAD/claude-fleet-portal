# Generate a Loop from a prompt (AI, context-aware)

**Date:** 2026-06-14
**Status:** approved (brainstorming) → implementation
**Builds on:** the loop-templates feature (same create form). Lands as commits on PR #4 (`feat/loops-templates`).

## Problem

Even with presets, writing a loop's six-field contract + posture/policy/ceiling/rubric from scratch is work. Users want to describe what they want in plain language and have the form filled for them — tailored to the project they picked.

## Goal

A "✨ Generate with AI" affordance on `/loops`: the user types a description, the server asks Claude (context-aware, using the selected project's board + repo signals) to produce a complete, valid loop config, and the **form is prefilled for review** (never auto-created).

## Mechanism (constraint-driven)

The portal has **no direct Anthropic API** — every model call spawns a `claude` run via `registry.launch({ jsonSchema })`, awaited to terminal, reading `run.structuredOutput`. We reuse that exact pattern (as `loopEval.ts` / `manager.ts` do). The run is **read-only**: `permissionMode: 'plan'`, **no tools** — the model only transforms server-gathered context + the prompt into JSON. Context comes from the server (option A), not from giving the model repo tools, so generation is fast (~10–40s) and deterministic.

## Design

### Server — new `apps/server/src/loopGen.ts`

- **`LOOP_GEN_JSON_SCHEMA`** (`as const`) — structured output: `kind` (enum), `controlPlane` (enum), `contract` { job, inputs, allowed[], forbidden[], output, evaluation }, `mergePosture` (enum), `reviewPolicy` (string), `routableCeiling` (enum), `escalationThreshold` (int), `riskRubric` (array of {glob, forceRisk}), `suggestedName` (string).
- **`buildProjectContext(project, cards, repoPaths)` → string** — PURE, bounded:
  - project meta: name, defaultBranch, mergeMode (local/pr), autoMerge, pushEnabled, wipLimit.
  - board: counts by column + up to 40 card titles with their labels.
  - repo signal: detected stack files (package.json, tsconfig, Cargo.toml, go.mod, pyproject, requirements.txt, Gemfile) + up to ~80 sampled tracked paths, emphasizing `auth`/`migrations`/`.github` dirs so risk-rubric globs match reality.
  - Caps enforced so the prompt stays small.
- **`parseLoopGen(structuredOutput) → NormalizedDraft | null`** — PURE: validates/clamps the model output to valid enums, coerces arrays, trims strings, defaults `escalationThreshold` (≥1, default 3), `mergePosture` (`human-gate`), `reviewPolicy` (`always`), `routableCeiling` (`low`). Returns null only when unusable (not an object).
- **`generateLoopDraft({ prompt, projectId }) → { draft, suggestedName, warning? }`**:
  1. load project (required) → gather cards (`kanbanRepo.listTasks`) + repo paths (`git ls-files`, bounded).
  2. `registry.launch({ prompt: buildGenPrompt(userPrompt, context), cwd: project.rootDir, model: 'claude-opus-4-8', effort: 'high', permissionMode: 'plan', jsonSchema, projectId, interactive: false })`.
  3. `awaitTerminal(runId, GEN_TIMEOUT_MS = 3 * 60_000)` (module-private, copied from loopEval).
  4. run not `completed` or `parseLoopGen` null → throw 502 "AI did not return a usable config — retry or use a template".
  5. `validateContract(draft.contract, {mergePosture, reviewPolicy})` → on error, attach as a non-fatal `warning` (the form's own evaluation guard handles the fix) rather than hard-failing.
- **Route** `POST /api/loops/generate` (registered via `registerLoopGenRoutes(app)`, wired in `server.ts` next to `registerResearchRoutes`). Body `{ prompt, projectId }`; 400 if either missing / project unknown; 502 on no-completion. No module-level import of loopGen by loops.ts (loopGen imports `validateContract` from loops.ts — one-directional, no cycle).

### Shared types (`packages/shared/src/index.ts`)

```ts
interface GenerateLoopRequest { prompt: string; projectId: string; }
interface GenerateLoopResponse {
  kind: LoopKind; controlPlane: ControlPlaneKind; suggestedName: string;
  contract: LoopContract; mergePosture: MergePosture; reviewPolicy: string;
  routableCeiling: RiskLevel; escalationThreshold: number; riskRubric: RiskRule[];
  warning: string | null;
}
```

### Web — `apps/web/app/loops/page.tsx` + `lib/loops.ts`

- `loopsApi.generate(body: GenerateLoopRequest) => Promise<GenerateLoopResponse>`.
- `mapGenerateResponseToForm(resp)` — PURE (in `lib/loops.ts`): returns `{ kind, controlPlane, name, draft }` (draft = ContractDraft-shaped). Tested.
- A "✨ Generate with AI" block next to the template dropdown: a textarea ("Describe the loop you want…") + button + busy state ("Generating… spawns an Opus run, ~10–40s") + error/warning line. Requires a selected project (inline error otherwise). On success: apply the mapped form state (like `applyTemplate`), flip the template select to Custom, surface any `warning`.

## Testing

- **Server (`test/loopgen.test.ts`):** `buildProjectContext` respects caps (cards ≤40, paths bounded) and includes project meta; `parseLoopGen` clamps bad enums / fills defaults / returns a valid draft from a canned `structuredOutput`, and rejects a non-object. (The launch+await is a copy of trusted loopEval plumbing — not re-tested.)
- **Web (`test/fn-loop-gen.test.ts`):** `mapGenerateResponseToForm` maps every field and produces a server-valid draft (reuse the contract-validity asserts).

## Error handling

No project → 400. Run didn't complete / unusable output → 502 with a retry-or-template message. Contract invalid post-generation → returned with a `warning`, form guides the fix. Each click = one real Opus run (read-only); nothing is created until the user clicks Create.

## Non-goals (YAGNI)

No giving the model repo tools (server-gathered context only). No streaming/progress UI (simple spinner). No auto-create. No persistence of prompts.
