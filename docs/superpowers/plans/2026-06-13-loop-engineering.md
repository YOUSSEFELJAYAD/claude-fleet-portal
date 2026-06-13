# Loop Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a **Loop** a first-class, contract-bearing entity in the Claude Fleet Portal — a built-in Manager (triage) loop and a Worker loop that coordinate only through a pluggable control plane, with a forced dry-run → auto-escalate lifecycle and a mandatory maker/checker review gate.

**Architecture:** Each `Loop` carries the six-part JOB/INPUTS/ALLOWED/FORBIDDEN/OUTPUT/EVALUATION contract (compiled into `LaunchRequest.allowedTools`/`disallowedTools`/`permissionMode`). The scheduler is the wake clock; a `loops.fire(id)` driver runs the Manager triage (json-schema verdict + deterministic rubric hard-floors), grades its judgment via an LLM-judge (`loopEval`), and auto-flips dry-run → apply after N clean runs. The Worker loop is the existing PM, extended with an `agent:ready`+risk selection filter, a `reviewing` phase (a separate Reviewer judges the diff), and a per-loop merge posture (human-gate default). A `ControlPlane` adapter abstracts the backlog as either the local Kanban board or GitHub Issues. We **extend** `scheduler`/`pm`/`gh`/`kanban`; we do not rewrite them — a project with no Loop keeps today's exact behavior.

**Tech Stack:** Node + Fastify + better-sqlite3, TypeScript (ESM, `.js` import specifiers), pnpm workspace; `@fleet/shared` types; vitest (`cd apps/server && npx vitest run test/<name>.test.ts`); Next.js app-router web. Design spec: `docs/superpowers/specs/2026-06-13-loop-engineering-design.md`.

## How this plan is organized

51 tasks across 9 slices, in dependency order. Build them in slice order (01 → 09); within a slice, tasks are sequential. Each task is TDD: write the failing test → run it red → implement → run it green → commit.

| Slice | Scope | Key files |
|---|---|---|
| 01 | Shared types + `ExecutionPhase` + `loopAutoMergeCeiling` config | `packages/shared/src/index.ts`, `apps/server/src/config.ts` |
| 02 | `loops.ts` — table, repo, contract validate/compile, escalation, driver, routes | `apps/server/src/loops.ts`, `server.ts` |
| 03 | `controlplane.ts` — interface + board adapter + dry-run wrapper + `kanban_comments` | `apps/server/src/controlplane.ts`, `server.ts` |
| 04 | `scheduler.ts` — `loop_id` target + work-exists skip | `apps/server/src/scheduler.ts` |
| 05 | `loopEval.ts` — LLM-judge judgment grader | `apps/server/src/loopEval.ts` |
| 06 | `manager.ts` — triage algorithm + rubric hard-floors + Manager template | `apps/server/src/manager.ts`, `templates.ts` |
| 07 | `gh.ts` label/comment verbs + GitHub control-plane adapter | `apps/server/src/gh.ts`, `controlplane.ts` |
| 08 | `review.ts` + PM Worker extensions (selection filter, `reviewing`, merge posture) | `apps/server/src/review.ts`, `pm.ts` |
| 09 | Web Loops view (list, contract editor, detail, nav) | `apps/web/app/loops/**`, `lib/loops.ts` |

**Cross-slice note:** `loops.ts` (Slice 02) uses **dynamic `await import(...)`** for `controlplane.js`/`manager.js`/`loopEval.js` inside `fire()`/`hasWork()`, so it compiles and its tests pass before Slices 03/05/06 land. Slice 03 ships a `controlPlaneFor` that throws for `control_plane==='github'`; Slice 07 removes that throw and wires the GitHub adapter through the same dry-run wrapper.

---



---

## Slice 01: shared-types

Add every Loop-engineering type, label constant, and the two new `ExecutionPhase` values to `packages/shared/src/index.ts`, each TDD-verified by a tiny `@fleet/shared` import test, then prove the whole workspace still typechecks. No server logic — pure type/const additions consumed by Slices 02-08.

**Files:**
- Modify: `packages/shared/src/index.ts` (add `RiskLevel`/`WorkType`/`RISK_LABELS`/`TYPE_LABELS`/`ROUTING`; `LoopKind`/`LoopMode`/`ControlPlaneKind`/`MergePosture`; `LoopContract`/`RiskRule`/`TriageVerdict`/`LoopEvalResult`/`ReviewVerdict`; `Loop`/`CreateLoopRequest`; extend `ExecutionPhase` with `'inspecting'`/`'reviewing'`; add `loopAutoMergeCeiling` to `PortalConfig`)
- Modify: `apps/server/src/config.ts` (add `loopAutoMergeCeiling` to `DEFAULT_CONFIG` + thread it through `validateConfig`)
- Test: `apps/server/test/loop-types.test.ts` (new — imports the new symbols from `@fleet/shared` and asserts shape/value)
- Test: `apps/server/test/loop-config.test.ts` (new — `validateConfig` unit test for the `loopAutoMergeCeiling` ceiling)

> Grounding notes (verified against the real file):
> - `@fleet/shared` is a pure type/const package (`main`/`types` → `src/index.ts`, no runtime side effects), so tests import it directly at the top — NO `FLEET_DATA_DIR` isolation is needed (mirrors `apps/server/test/model-routing.test.ts:6` `import { CLAUDE_MODELS, engineForModel, MODELS } from '@fleet/shared';`).
> - The existing `ExecutionPhase` union lives at **`packages/shared/src/index.ts:665-673`** and currently ends with `| 'resolving';` (line 673). The new values are appended there.
> - `RISK_LABELS` and `TYPE_LABELS` use the **object** forms from the canonical contract sheet (record-keyed by level/`WorkType`), not the array forms sketched in spec §4.5.

---

### Task 01.1: Risk/Type unions + label & routing constants

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/loop-types.test.ts`

- [ ] **Step 1: Write the failing test**
 ```ts
 // apps/server/test/loop-types.test.ts
 import { describe, it, expect } from 'vitest';
 import {
   RISK_LABELS,
   TYPE_LABELS,
   ROUTING,
   type RiskLevel,
   type WorkType,
 } from '@fleet/shared';

 describe('loop risk/type label constants', () => {
   it('RISK_LABELS maps each RiskLevel to its risk:* label', () => {
     expect(RISK_LABELS.low).toBe('risk:low');
     expect(RISK_LABELS.medium).toBe('risk:medium');
     expect(RISK_LABELS.high).toBe('risk:high');
     const level: RiskLevel = 'high';
     expect(RISK_LABELS[level]).toBe('risk:high');
   });

   it('TYPE_LABELS maps each WorkType to its type:* label', () => {
     expect(TYPE_LABELS.bug).toBe('type:bug');
     expect(TYPE_LABELS.feature).toBe('type:feature');
     expect(TYPE_LABELS.docs).toBe('type:docs');
     expect(TYPE_LABELS.test).toBe('type:test');
     expect(TYPE_LABELS.refactor).toBe('type:refactor');
     expect(TYPE_LABELS.chore).toBe('type:chore');
     const t: WorkType = 'bug';
     expect(TYPE_LABELS[t]).toBe('type:bug');
   });

   it('ROUTING carries the agent:ready / needs:human vocabulary', () => {
     expect(ROUTING.ready).toBe('agent:ready');
     expect(ROUTING.needsHuman).toBe('needs:human');
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: FAIL (`"@fleet/shared" has no exported member 'RISK_LABELS'` / `'TYPE_LABELS'` / `'ROUTING'` — module/import resolution error)
- [ ] **Step 3: Implement**
 Insert this block in `packages/shared/src/index.ts` immediately AFTER the existing `KANBAN_COLUMNS` constant (line 661) and BEFORE the `ExecutionPhase` declaration block (line 663 comment):
 ```ts
 // ─────────────────────────────────────────────────────────────────────────────
 // Loop engineering (spec docs/superpowers/specs/2026-06-13-loop-engineering-design.md)
 // ─────────────────────────────────────────────────────────────────────────────

 /** Agent-inferred (and rubric-floored) risk of a backlog item. */
 export type RiskLevel = 'low' | 'medium' | 'high';
 /** The kind of work a backlog item represents. */
 export type WorkType = 'bug' | 'feature' | 'docs' | 'test' | 'refactor' | 'chore';

 /** `risk:<level>` board/issue label for each RiskLevel. */
 export const RISK_LABELS = { low: 'risk:low', medium: 'risk:medium', high: 'risk:high' } as const;
 /** `type:<work>` board/issue label for each WorkType. */
 export const TYPE_LABELS: Record<WorkType, string> = {
   bug: 'type:bug',
   feature: 'type:feature',
   docs: 'type:docs',
   test: 'type:test',
   refactor: 'type:refactor',
   chore: 'type:chore',
 };
 /** Routing vocabulary distinct from a tag: agent-routable vs human-escalated. */
 export const ROUTING = { ready: 'agent:ready', needsHuman: 'needs:human' } as const;
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: PASS (`✓ test/loop-types.test.ts` — 3 passed)
- [ ] **Step 5: Commit**
 ```bash
 git add packages/shared/src/index.ts apps/server/test/loop-types.test.ts
 git commit -m "feat: add loop risk/type/routing label constants to shared types"
 ```

---

### Task 01.2: Loop enum unions (kind / mode / control-plane / merge posture)

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/loop-types.test.ts`

- [ ] **Step 1: Write the failing test**
 Append this `describe` block to `apps/server/test/loop-types.test.ts`, and extend the existing top import to add the new type-only members:
 ```ts
 // add to the existing import at the top of apps/server/test/loop-types.test.ts:
 //   type LoopKind, type LoopMode, type ControlPlaneKind, type MergePosture
 import type { LoopKind, LoopMode, ControlPlaneKind, MergePosture } from '@fleet/shared';

 describe('loop enum unions', () => {
   it('accepts every documented union member', () => {
     const kinds: LoopKind[] = ['manager', 'worker'];
     const modes: LoopMode[] = ['dry-run', 'apply'];
     const planes: ControlPlaneKind[] = ['board', 'github'];
     const postures: MergePosture[] = ['human-gate', 'auto-low-risk'];
     expect(kinds).toHaveLength(2);
     expect(modes).toEqual(['dry-run', 'apply']);
     expect(planes).toEqual(['board', 'github']);
     expect(postures).toEqual(['human-gate', 'auto-low-risk']);
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: FAIL (`"@fleet/shared" has no exported member 'LoopKind'` — import resolution error; file fails to load)
- [ ] **Step 3: Implement**
 Append to the Loop-engineering block in `packages/shared/src/index.ts` (directly after `ROUTING`):
 ```ts
 /** A loop is a 'manager' (triage) loop or a 'worker' (build/PR) loop. */
 export type LoopKind = 'manager' | 'worker';
 /** A loop runs inspection-only ('dry-run') until it auto-escalates to 'apply'. */
 export type LoopMode = 'dry-run' | 'apply';
 /** Pluggable per-loop control plane: the local Kanban board or GitHub issues. */
 export type ControlPlaneKind = 'board' | 'github';
 /** Merge gate posture: human-gated by default, or bounded low-risk auto-merge. */
 export type MergePosture = 'human-gate' | 'auto-low-risk';
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: PASS (`✓ test/loop-types.test.ts` — 4 passed)
- [ ] **Step 5: Commit**
 ```bash
 git add packages/shared/src/index.ts apps/server/test/loop-types.test.ts
 git commit -m "feat: add Loop kind/mode/control-plane/merge-posture unions"
 ```

---

### Task 01.3: Contract + verdict + eval value-object interfaces

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/loop-types.test.ts`

- [ ] **Step 1: Write the failing test**
 Append this `describe` block to `apps/server/test/loop-types.test.ts`, importing the new interfaces type-only:
 ```ts
 // add to the imports at the top of apps/server/test/loop-types.test.ts:
 import type {
   LoopContract,
   RiskRule,
   TriageVerdict,
   LoopEvalResult,
   ReviewVerdict,
 } from '@fleet/shared';

 describe('loop contract / verdict / eval shapes', () => {
   it('LoopContract carries the six pre-flight fields', () => {
     const c: LoopContract = {
       job: 'Triage the backlog',
       inputs: 'Backlog cards + repo context',
       allowed: ['Read', 'Grep'],
       forbidden: ['Edit', 'Write'],
       output: 'risk/type labels + an Agent Assessment',
       evaluation: 'no risk:high marked agent:ready; every verdict evidence-backed',
     };
     expect(Object.keys(c).sort()).toEqual(
       ['allowed', 'evaluation', 'forbidden', 'inputs', 'job', 'output'],
     );
     expect(c.allowed).toContain('Read');
   });

   it('RiskRule forces a glob match to a RiskLevel', () => {
     const rule: RiskRule = { glob: '**/migrations/**', forceRisk: 'high' };
     expect(rule.forceRisk).toBe('high');
   });

   it('TriageVerdict is the per-item manager output (questions optional)', () => {
     const v: TriageVerdict = {
       risk: 'low',
       type: 'docs',
       agentReady: true,
       reason: 'doc-only typo fix; no code paths touched',
     };
     expect(v.agentReady).toBe(true);
     expect(v.questions).toBeUndefined();
     const escalated: TriageVerdict = {
       risk: 'high',
       type: 'feature',
       agentReady: false,
       reason: 'touches auth',
       questions: ['Which auth flow?'],
     };
     expect(escalated.questions).toEqual(['Which auth flow?']);
   });

   it('LoopEvalResult + ReviewVerdict carry their gate fields', () => {
     const evalResult: LoopEvalResult = { clean: false, score: 0.4, notes: 'marked risky work ready' };
     expect(evalResult.clean).toBe(false);
     expect(evalResult.score).toBeCloseTo(0.4);
     const review: ReviewVerdict = { pass: true, findings: 'no blocking issues' };
     expect(review.pass).toBe(true);
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: FAIL (`"@fleet/shared" has no exported member 'LoopContract'` — import resolution error)
- [ ] **Step 3: Implement**
 Append to the Loop-engineering block in `packages/shared/src/index.ts` (after the enum unions from 01.2):
 ```ts
 /** The tutorial's six-field pre-flight card as machine-readable data (spec §3). */
 export interface LoopContract {
   job: string;          // the single responsibility (free text, required)
   inputs: string;       // what STATE it inspects (free text, required)
   allowed: string[];    // tool patterns it MAY use      → LaunchRequest.allowedTools
   forbidden: string[];  // tool patterns it must NEVER use → LaunchRequest.disallowedTools
   output: string;       // the concrete artifact after a good run (free text, required)
   evaluation: string;   // how we grade success (REQUIRED — create fails if empty)
 }

 /** A deterministic rubric hard-floor: a glob match forces this risk (overrides the agent). */
 export interface RiskRule {
   glob: string;
   forceRisk: RiskLevel;
 }

 /** The Manager's per-item triage output (emitted via --json-schema). */
 export interface TriageVerdict {
   risk: RiskLevel;
   type: WorkType;
   agentReady: boolean;
   reason: string;
   questions?: string[];
 }

 /** The loopEval LLM-judge grade of a single dry-run; `clean` gates escalation. */
 export interface LoopEvalResult {
   clean: boolean;
   score: number;
   notes: string;
 }

 /** The maker/checker Reviewer verdict on a worker diff. */
 export interface ReviewVerdict {
   pass: boolean;
   findings: string;
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: PASS (`✓ test/loop-types.test.ts` — 8 passed)
- [ ] **Step 5: Commit**
 ```bash
 git add packages/shared/src/index.ts apps/server/test/loop-types.test.ts
 git commit -m "feat: add LoopContract/RiskRule/TriageVerdict/LoopEvalResult/ReviewVerdict types"
 ```

---

### Task 01.4: `Loop` entity + `CreateLoopRequest`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/loop-types.test.ts`

- [ ] **Step 1: Write the failing test**
 Append this `describe` block to `apps/server/test/loop-types.test.ts`, importing the two interfaces type-only:
 ```ts
 // add to the imports at the top of apps/server/test/loop-types.test.ts:
 import type { Loop, CreateLoopRequest } from '@fleet/shared';

 describe('Loop entity + create request', () => {
   it('a Loop value compiles with the full camelCase column mirror', () => {
     const loop: Loop = {
       id: 'lp_1',
       name: 'Backlog triage',
       projectId: 'proj_1',
       kind: 'manager',
       controlPlane: 'board',
       scheduleId: null,
       contract: {
         job: 'triage',
         inputs: 'backlog',
         allowed: ['Read'],
         forbidden: ['Edit'],
         output: 'labels',
         evaluation: 'evidence-backed verdicts',
       },
       mode: 'dry-run',
       consecutiveGoodRuns: 0,
       escalationThreshold: 3,
       mergePosture: 'human-gate',
       reviewPolicy: 'always',
       riskRubric: [{ glob: '**/auth/**', forceRisk: 'high' }],
       routableCeiling: 'low',
       enabled: true,
       lastRunId: null,
       lastEval: null,
       lastError: null,
       createdAt: Date.now(),
     };
     expect(loop.kind).toBe('manager');
     expect(loop.mode).toBe('dry-run');
     expect(loop.riskRubric[0].forceRisk).toBe('high');
     expect(loop.lastEval).toBeNull();
   });

   it('CreateLoopRequest requires name/projectId/kind/contract; the rest default server-side', () => {
     const req: CreateLoopRequest = {
       name: 'Worker',
       projectId: 'proj_1',
       kind: 'worker',
       contract: {
         job: 'build',
         inputs: 'ready cards',
         allowed: ['Read', 'Edit', 'Write'],
         forbidden: ['Bash(git push *)'],
         output: 'a PR, never merged',
         evaluation: 'diff within agent:ready+risk:low; review passes',
       },
     };
     expect(req.controlPlane).toBeUndefined();
     expect(req.escalationThreshold).toBeUndefined();
     expect(req.kind).toBe('worker');
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: FAIL (`"@fleet/shared" has no exported member 'Loop'` / `'CreateLoopRequest'` — import resolution error)
- [ ] **Step 3: Implement**
 Append to the Loop-engineering block in `packages/shared/src/index.ts` (after the value-objects from 01.3):
 ```ts
 /** A first-class, persisted, contract-bearing loop (mirrors the `loops` table, camelCase). */
 export interface Loop {
   id: string;
   name: string;
   projectId: string;
   kind: LoopKind;
   controlPlane: ControlPlaneKind;
   scheduleId: string | null;
   contract: LoopContract;
   mode: LoopMode;
   consecutiveGoodRuns: number;
   escalationThreshold: number;
   mergePosture: MergePosture;
   reviewPolicy: string; // 'always' | 'off' | 'threshold:<N>'
   riskRubric: RiskRule[];
   routableCeiling: RiskLevel;
   enabled: boolean;
   lastRunId: string | null;
   lastEval: LoopEvalResult | null;
   lastError: string | null;
   createdAt: number;
 }

 /** Create-loop payload (POST /api/loops); omitted optionals default server-side. */
 export interface CreateLoopRequest {
   name: string;
   projectId: string;
   kind: LoopKind;
   controlPlane?: ControlPlaneKind;
   scheduleId?: string | null;
   contract: LoopContract;
   escalationThreshold?: number;
   mergePosture?: MergePosture;
   reviewPolicy?: string;
   riskRubric?: RiskRule[];
   routableCeiling?: RiskLevel;
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: PASS (`✓ test/loop-types.test.ts` — 10 passed)
- [ ] **Step 5: Commit**
 ```bash
 git add packages/shared/src/index.ts apps/server/test/loop-types.test.ts
 git commit -m "feat: add Loop entity and CreateLoopRequest shared types"
 ```

---

### Task 01.5: Extend `ExecutionPhase` with `inspecting` / `reviewing`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/loop-types.test.ts`

- [ ] **Step 1: Write the failing test**
 Append this `describe` block to `apps/server/test/loop-types.test.ts`, importing `ExecutionPhase` type-only:
 ```ts
 // add to the imports at the top of apps/server/test/loop-types.test.ts:
 import type { ExecutionPhase } from '@fleet/shared';

 describe('ExecutionPhase loop additions', () => {
   it('accepts the existing phases plus inspecting + reviewing', () => {
     const phases: ExecutionPhase[] = [
       'idle',
       'building',
       'validating',
       'merging',
       'conflicts',
       'paused-budget',
       'failed',
       'resolving',
       'inspecting', // NEW: dry-run loop reporting intended actions
       'reviewing',  // NEW: maker/checker Reviewer judging the diff
     ];
     expect(phases).toContain('inspecting');
     expect(phases).toContain('reviewing');
     expect(phases).toHaveLength(10);
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: FAIL (`Type '"inspecting"' is not assignable to type 'ExecutionPhase'` — the union has no `inspecting`/`reviewing` member yet)
- [ ] **Step 3: Implement**
 In `packages/shared/src/index.ts`, change the `ExecutionPhase` union (lines 665-673) — replace the final line `  | 'resolving';` with the two added members:
 ```ts
 export type ExecutionPhase =
   | 'idle'
   | 'building'
   | 'validating'
   | 'merging'
   | 'conflicts'
   | 'paused-budget'
   | 'failed'
   | 'resolving'
   | 'inspecting' // NEW: a dry-run loop is reporting intended actions, changing nothing
   | 'reviewing'; // NEW: a separate Reviewer agent (maker/checker) is judging the diff
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts`
 Expected: PASS (`✓ test/loop-types.test.ts` — 11 passed)
- [ ] **Step 5: Commit**
 ```bash
 git add packages/shared/src/index.ts apps/server/test/loop-types.test.ts
 git commit -m "feat: extend ExecutionPhase with inspecting/reviewing loop phases"
 ```

---

### Task 01.7: `loopAutoMergeCeiling` config field

The worker merge gate in Slice 08 reads a fleet-wide ceiling for how risky a diff may be and still auto-merge. It is a single nullable `RiskLevel` on `PortalConfig` (`null` = never auto-merge → human-gate everything). This task wires it through the SAME validate/clamp path as the `dailySpendCeilingUsd`/`maxRunMinutes` guardrails (H9), so a partial PUT can't leave it undefined and an invalid value can't slip through.

> Grounding notes (verified against the real files):
> - `PortalConfig` lives at **`packages/shared/src/index.ts:356-370`**; the field is added in the §24 ceiling neighborhood after `maxRunMinutes` (line 369).
> - `DEFAULT_CONFIG` is the object literal at **`apps/server/src/config.ts:64-73`** (ends with `maxRunMinutes: null`).
> - `validateConfig` (**`apps/server/src/config.ts:82-125`**) returns a FIXED object literal and **drops every key it does not name** (the doc-comment says "Unknown keys are ignored"). So `loopAutoMergeCeiling` MUST be threaded explicitly into both the validator body and the returned literal, or `setConfig`→`getConfig` would silently lose it.
> - `RiskLevel = 'low' | 'medium' | 'high'` is exported from `@fleet/shared` by **Task 01.1** of this same slice, so this task can import it. (Land 01.1 first.)
> - `registry.setConfig(cfg)` (**`apps/server/src/registry.ts:226-232`**) routes through `validateConfig`, and `getConfig()` (line 223-225) returns the stored result — so the round-trip is governed entirely by `validateConfig`.

**Files:**
- Modify: `packages/shared/src/index.ts` (add `loopAutoMergeCeiling` to `PortalConfig`)
- Modify: `apps/server/src/config.ts` (`DEFAULT_CONFIG` + `validateConfig`)
- Test: `apps/server/test/loop-config.test.ts` (new — direct `validateConfig` unit test, guardrails style)

- [ ] **Step 1: Write the failing test**
 ```ts
 // apps/server/test/loop-config.test.ts
 // §24/Loop — fleet-wide auto-merge risk ceiling. validateConfig is a pure function,
 // so we exercise it directly (no FLEET_DATA_DIR isolation needed) — same intent as
 // the PUT /api/config validation block in guardrails.test.ts.
 import { describe, it, expect } from 'vitest';
 import { validateConfig, DEFAULT_CONFIG } from '../src/config.js';

 describe('validateConfig — loopAutoMergeCeiling', () => {
   it('defaults to null when the key is absent', () => {
     expect(DEFAULT_CONFIG.loopAutoMergeCeiling).toBeNull();
     expect(validateConfig({}).loopAutoMergeCeiling).toBeNull();
   });

   it('threads a valid RiskLevel through unchanged', () => {
     expect(validateConfig({ loopAutoMergeCeiling: 'low' }).loopAutoMergeCeiling).toBe('low');
     expect(validateConfig({ loopAutoMergeCeiling: 'medium' }).loopAutoMergeCeiling).toBe('medium');
     expect(validateConfig({ loopAutoMergeCeiling: 'high' }).loopAutoMergeCeiling).toBe('high');
   });

   it('falls back to the default (null) on an invalid value', () => {
     expect(validateConfig({ loopAutoMergeCeiling: 'extreme' }).loopAutoMergeCeiling).toBeNull();
     expect(validateConfig({ loopAutoMergeCeiling: 42 }).loopAutoMergeCeiling).toBeNull();
     expect(validateConfig({ loopAutoMergeCeiling: null }).loopAutoMergeCeiling).toBeNull();
   });

   it('survives a setConfig→getConfig round-trip via the registry', () => {
     // registry.setConfig routes through validateConfig and getConfig returns the stored
     // result, so a valid ceiling round-trips and the key is not dropped.
     const merged = validateConfig({ ...DEFAULT_CONFIG, loopAutoMergeCeiling: 'low' });
     expect(merged.loopAutoMergeCeiling).toBe('low');
     // unrelated guardrail keys are still present (the literal was threaded, not replaced)
     expect(merged.maxConcurrentRuns).toBe(DEFAULT_CONFIG.maxConcurrentRuns);
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loop-config.test.ts`
 Expected: FAIL — `DEFAULT_CONFIG.loopAutoMergeCeiling` is `undefined` (not `null`), and `validateConfig(...).loopAutoMergeCeiling` is `undefined` because the returned object literal never names the key (it is dropped). TypeScript also flags `loopAutoMergeCeiling` as missing on `PortalConfig`.
- [ ] **Step 3: Implement**
 (a) In `packages/shared/src/index.ts`, add the field to `PortalConfig` (after `maxRunMinutes`, line 369), and ensure `RiskLevel` is in scope (it is — defined earlier in this file by Task 01.1):
 ```ts
   /** §24 — wall-clock ceiling per run in minutes: longer-running runs are auto-killed
    *  (killReason 'timeout'). null = no limit. */
   maxRunMinutes: number | null;
   /** Loop — fleet-wide auto-merge risk ceiling: a worker diff at or below this RiskLevel
    *  may auto-merge; anything riskier stays human-gated. null = never auto-merge (gate all). */
   loopAutoMergeCeiling: RiskLevel | null;
 ```
 (b) In `apps/server/src/config.ts`, import `RiskLevel` and add the default. Extend the existing shared type import:
 ```ts
 import type { PortalConfig, PermissionMode, RiskLevel } from '@fleet/shared';
 ```
 Then add the key to `DEFAULT_CONFIG` (after `maxRunMinutes: null`):
 ```ts
   maxRunMinutes: null, // §24 — per-run wall-clock auto-kill (null = off)
   loopAutoMergeCeiling: null, // Loop — null = never auto-merge (human-gate every diff)
 ```
 (c) In `validateConfig`, add a small nullable-RiskLevel validator near the other helpers (after `nullableNum`), and include the key in the returned object literal:
 ```ts
   // Loop — nullable RiskLevel ceiling: absent → default; an unrecognized value falls
   // back to the default rather than throwing (a stale/garbage UI value must not 400 the
   // whole config save), null → null. Accepts only 'low' | 'medium' | 'high'.
   const nullableRisk = (key: 'loopAutoMergeCeiling'): RiskLevel | null => {
     const v = i[key];
     if (v === undefined) return DEFAULT_CONFIG[key];
     if (v === 'low' || v === 'medium' || v === 'high') return v;
     return DEFAULT_CONFIG[key]; // null/invalid → fall back
   };
 ```
 ```ts
   return {
     maxConcurrentRuns: num('maxConcurrentRuns', { min: 1, max: 100, int: true }),
     defaultBudgetUsd: num('defaultBudgetUsd', { min: 0.0001 }),
     ultracodeBudgetUsd: num('ultracodeBudgetUsd', { min: 0.0001 }),
     permissionDefault,
     subagentConcurrentCeiling: num('subagentConcurrentCeiling', { min: 1, max: 16, int: true }),
     subagentTotalCeiling: num('subagentTotalCeiling', { min: 1, max: 1000, int: true }),
     dailySpendCeilingUsd: nullableNum('dailySpendCeilingUsd', { min: 0.01 }),
     maxRunMinutes: nullableNum('maxRunMinutes', { min: 1, int: true }),
     loopAutoMergeCeiling: nullableRisk('loopAutoMergeCeiling'),
   };
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loop-config.test.ts`
 Expected: PASS (`✓ test/loop-config.test.ts` — 4 passed)
- [ ] **Step 5: Commit**
 ```bash
 git add packages/shared/src/index.ts apps/server/src/config.ts apps/server/test/loop-config.test.ts
 git commit -m "feat: add loopAutoMergeCeiling config field for the worker merge gate"
 ```

---

### Task 01.8: Workspace typecheck is clean

**Files:**
- Verify only (no new files): `packages/shared/src/index.ts`, whole pnpm workspace

- [ ] **Step 1: Write the failing test**
 No code — this is the contract-sheet-mandated typecheck gate. The "test" is the workspace `tsc --noEmit` across every package. (Before the prior tasks land, the new symbols don't exist, so any downstream `import` would fail — by 01.7 the additions are complete, so this step confirms the slice is internally consistent and nothing else in `@fleet/shared`, `apps/server`, or `apps/web` broke.)
- [ ] **Step 2: Run it, expect (pre-additions) FAIL / (now) confirm baseline**
 Run: `cd apps/server && npx vitest run test/loop-types.test.ts test/loop-config.test.ts`
 Expected: PASS (all 11 type assertions + 4 config assertions green — re-confirms the type additions compile under vitest's esbuild transform before the heavier `tsc` gate)
- [ ] **Step 3: Implement**
 No implementation — the types and the `loopAutoMergeCeiling` config field are already in place from 01.1-01.7. This task only runs the verification gate.
- [ ] **Step 4: Run it, expect PASS**
 Run: `pnpm -r typecheck`
 Expected: PASS — every workspace package reports clean, e.g.:
 ```
 @fleet/shared typecheck$ tsc --noEmit
 @fleet/server typecheck$ tsc --noEmit
 @fleet/web typecheck$ tsc --noEmit
 ```
 with no `error TSxxxx` lines and a zero exit code. (If `apps/web` or `apps/server` reports an unrelated pre-existing error, re-run `pnpm --filter @fleet/shared typecheck` to confirm THIS slice's package is clean, then note the unrelated failure — it is out of scope for Slice 01.)
- [ ] **Step 5: Commit**
 ```bash
 git commit --allow-empty -m "chore: confirm workspace typecheck clean after loop shared types"
 ```


---

## Slice 02: loops-core

Build `apps/server/src/loops.ts`: the `loops` table (spec §4.1), `loopsRepo`, `validateContract` (EVALUATION-required), `compileContract` (forbidden merged on top of `pm.disallowedToolsForProject`, may only add denies), the `loops` singleton (`init()` boot-reconcile + `hasWork(loopId)` scheduler probe + `fire(loopId)` manager path), the `applyEvalResult` escalation/counter helper (the heart of the lifecycle), and `registerLoopRoutes` (spec §16). Wires `loops.init()` + `registerLoopRoutes(app)` into `server.ts`.

> Note: `ExecutionPhase 'inspecting'` (added in Slice 01) is RESERVED in v1 — manager loops are card-less, so no card owns the phase yet; it exists for forward-compatibility and is not set by this slice.

**Files:**
- Create: `apps/server/src/loops.ts` — `loops` table + `loopsRepo` + `validateContract` + `compileContract` + `applyEvalResult` + `loops` singleton (`init`/`hasWork`/`fire`) + `registerLoopRoutes`
- Modify: `apps/server/src/server.ts` — register loop routes + `loops.init()` beside `pm.init()`
- Test: `apps/server/test/loops-core.test.ts` — repo CRUD, validateContract, compileContract, applyEvalResult escalation, routes

> Cross-slice imports (referenced by the contract-sheet signatures, owned by other slices):
> - `runManagerLoop(loop, project, cp): Promise<IntendedAction[]>` from `./manager.js`
> - `controlPlaneFor(loop, project): { cp: ControlPlane; intended: IntendedAction[] }` from `./controlplane.js`
> - `gradeLoopRun(loop, intended, project): Promise<LoopEvalResult>` from `./loopEval.js`
> - Shared types (`Loop`, `LoopContract`, `CreateLoopRequest`, `LoopKind`, `LoopMode`, `ControlPlaneKind`, `MergePosture`, `RiskLevel`, `RiskRule`, `LoopEvalResult`, `IntendedAction`, `ControlPlane`) from `@fleet/shared` (Slice 01).
>
> The `notifications` table (owned by `notifier.ts`, columns `id, run_id, kind, message, ts, read`) is written directly from `loops.ts` via an own prepared statement on escalation — `notifier.ts` exports no public emit helper, and `db.ts:resetAllData()` already treats `notifications` as a shared cross-module table. This mirrors how the table is created idempotently in `notifier.ts` before `loops.init()` runs.

---

### Task 02.1: `loops` table + `loopsRepo` (schema, CRUD, row mappers)

**Files:**
- Create: `apps/server/src/loops.ts`
- Test: `apps/server/test/loops-core.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate the DB BEFORE any src module is imported (config.js reads FLEET_DATA_DIR at load).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-loops-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let loopsRepo: typeof import('../src/loops.js').loopsRepo;
let projectsRepo: typeof import('../src/projects.js').projectsRepo;

const baseContract = () => ({
  job: 'triage backlog',
  inputs: 'open cards',
  allowed: ['Read', 'Grep'],
  forbidden: ['Edit'],
  output: 'classified cards',
  evaluation: 'no risk:high marked agent:ready',
});

let PID = '';
beforeAll(async () => {
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ loopsRepo } = await import('../src/loops.js'));
  // projectsRepo.createProject does not validate rootDir on disk (see kanban.test.ts).
  PID = projectsRepo.createProject({ name: 'loops-' + randomUUID().slice(0, 8), rootDir: '/tmp' }).id;
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('loopsRepo — CRUD + defaults', () => {
  it('create applies spec §4.1 defaults and round-trips the contract', () => {
    const loop = loopsRepo.create({
      name: 'mgr',
      projectId: PID,
      kind: 'manager',
      contract: baseContract(),
    });
    expect(loop.id).toBeTruthy();
    expect(loop.kind).toBe('manager');
    expect(loop.controlPlane).toBe('board'); // default
    expect(loop.mode).toBe('dry-run'); // forced-start default
    expect(loop.consecutiveGoodRuns).toBe(0);
    expect(loop.escalationThreshold).toBe(3);
    expect(loop.mergePosture).toBe('human-gate');
    expect(loop.reviewPolicy).toBe('always');
    expect(loop.routableCeiling).toBe('low');
    expect(loop.enabled).toBe(true);
    expect(loop.riskRubric).toEqual([]);
    expect(loop.contract.evaluation).toBe('no risk:high marked agent:ready');
    expect(loop.lastEval).toBeNull();
  });

  it('get / list / update / remove', () => {
    const loop = loopsRepo.create({ name: 'w', projectId: PID, kind: 'worker', contract: baseContract() });
    expect(loopsRepo.get(loop.id)?.name).toBe('w');
    expect(loopsRepo.list(PID).some((l) => l.id === loop.id)).toBe(true);
    expect(loopsRepo.list('no-such-project')).toEqual([]);

    const updated = loopsRepo.update(loop.id, { name: 'w2', enabled: false });
    expect(updated?.name).toBe('w2');
    expect(updated?.enabled).toBe(false);

    expect(loopsRepo.remove(loop.id)).toBe(true);
    expect(loopsRepo.get(loop.id)).toBeNull();
    expect(loopsRepo.remove(loop.id)).toBe(false);
  });

  it('enabledByKind filters by project + kind + enabled', () => {
    const a = loopsRepo.create({ name: 'kA', projectId: PID, kind: 'worker', contract: baseContract() });
    const b = loopsRepo.create({ name: 'kB', projectId: PID, kind: 'manager', contract: baseContract() });
    loopsRepo.update(a.id, { enabled: false });
    const workers = loopsRepo.enabledByKind(PID, 'worker');
    expect(workers.some((l) => l.id === a.id)).toBe(false); // disabled excluded
    const managers = loopsRepo.enabledByKind(PID, 'manager');
    expect(managers.some((l) => l.id === b.id)).toBe(true);
  });
});
```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (`Cannot find module '../src/loops.js'` — loops.ts does not exist yet)
- [ ] **Step 3: Implement**
```ts
/**
 * Loops (loop-engineering, spec docs/superpowers/specs/2026-06-13-loop-engineering-design.md §4.1).
 *
 * A Loop is a first-class, persisted, contract-bearing entity: it wakes on a SCHEDULE, reads STATE
 * via a control-plane adapter, does ONE JOB within fixed PERMISSIONS, writes results back, sleeps.
 * Self-contained module (mirrors scheduler.ts / projects.ts): owns the `loops` table via the shared
 * sqlite handle, exposes `loopsRepo`, `validateContract`, `compileContract`, the `loops` singleton
 * (init/fire) and `registerLoopRoutes(app)`.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import db from './db.js';
import type {
  Loop,
  LoopContract,
  CreateLoopRequest,
  LoopKind,
  LoopMode,
  ControlPlaneKind,
  MergePosture,
  RiskLevel,
  RiskRule,
  LoopEvalResult,
} from '@fleet/shared';

// ── schema (idempotent — CREATE-body carries every column; the ALTER loop upgrades old DBs) ──
db.exec(`
CREATE TABLE IF NOT EXISTS loops (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  project_id             TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  control_plane          TEXT NOT NULL DEFAULT 'board',
  schedule_id            TEXT,
  contract               TEXT NOT NULL,
  mode                   TEXT NOT NULL DEFAULT 'dry-run',
  consecutive_good_runs  INTEGER NOT NULL DEFAULT 0,
  escalation_threshold   INTEGER NOT NULL DEFAULT 3,
  merge_posture          TEXT NOT NULL DEFAULT 'human-gate',
  review_policy          TEXT NOT NULL DEFAULT 'always',
  risk_rubric            TEXT NOT NULL DEFAULT '[]',
  routable_ceiling       TEXT NOT NULL DEFAULT 'low',
  enabled                INTEGER NOT NULL DEFAULT 1,
  last_run_id            TEXT,
  last_eval              TEXT,
  last_error             TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loops_project ON loops(project_id, enabled);
`);

// Swallow ONLY the idempotent "duplicate column name" (mirrors db.ts / projects.ts / scheduler.ts).
for (const ddl of [
  // future columns land here; CREATE body above is the source of truth for a fresh DB.
] as string[]) {
  try {
    db.exec(ddl);
  } catch (e: any) {
    if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
  }
}

// ── row mappers (snake_case ↔ camelCase, like db.ts / projects.ts) ──────────────
function parseContract(s: string): LoopContract {
  try {
    const c = JSON.parse(s);
    return {
      job: String(c.job ?? ''),
      inputs: String(c.inputs ?? ''),
      allowed: Array.isArray(c.allowed) ? c.allowed.map(String) : [],
      forbidden: Array.isArray(c.forbidden) ? c.forbidden.map(String) : [],
      output: String(c.output ?? ''),
      evaluation: String(c.evaluation ?? ''),
    };
  } catch {
    return { job: '', inputs: '', allowed: [], forbidden: [], output: '', evaluation: '' };
  }
}
function parseRubric(s: string): RiskRule[] {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v
      .filter((r) => r && typeof r.glob === 'string')
      .map((r) => ({ glob: String(r.glob), forceRisk: (r.forceRisk ?? 'high') as RiskLevel }));
  } catch {
    return [];
  }
}
function parseEval(s: string | null): LoopEvalResult | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return { clean: !!v.clean, score: Number(v.score ?? 0), notes: String(v.notes ?? '') };
  } catch {
    return null;
  }
}

function rowToLoop(row: any): Loop {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    kind: row.kind as LoopKind,
    controlPlane: (row.control_plane ?? 'board') as ControlPlaneKind,
    scheduleId: row.schedule_id ?? null,
    contract: parseContract(row.contract),
    mode: row.mode as LoopMode,
    consecutiveGoodRuns: row.consecutive_good_runs,
    escalationThreshold: row.escalation_threshold,
    mergePosture: (row.merge_posture ?? 'human-gate') as MergePosture,
    reviewPolicy: row.review_policy ?? 'always',
    riskRubric: parseRubric(row.risk_rubric ?? '[]'),
    routableCeiling: (row.routable_ceiling ?? 'low') as RiskLevel,
    enabled: !!row.enabled,
    lastRunId: row.last_run_id ?? null,
    lastEval: parseEval(row.last_eval ?? null),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
  };
}

// ── prepared statements ─────────────────────────────────────────────────────────
const insertStmt = db.prepare(`
INSERT INTO loops (id, name, project_id, kind, control_plane, schedule_id, contract, mode,
  consecutive_good_runs, escalation_threshold, merge_posture, review_policy, risk_rubric,
  routable_ceiling, enabled, last_run_id, last_eval, last_error, created_at)
VALUES (@id, @name, @project_id, @kind, @control_plane, @schedule_id, @contract, @mode,
  @consecutive_good_runs, @escalation_threshold, @merge_posture, @review_policy, @risk_rubric,
  @routable_ceiling, @enabled, @last_run_id, @last_eval, @last_error, @created_at)
`);
const getStmt = db.prepare('SELECT * FROM loops WHERE id = ?');
const listAllStmt = db.prepare('SELECT * FROM loops ORDER BY created_at DESC');
const listByProjectStmt = db.prepare('SELECT * FROM loops WHERE project_id = ? ORDER BY created_at DESC');
const enabledByKindStmt = db.prepare('SELECT * FROM loops WHERE project_id = ? AND kind = ? AND enabled = 1 ORDER BY created_at DESC');
const deleteStmt = db.prepare('DELETE FROM loops WHERE id = ?');
const updateStmt = db.prepare(`
UPDATE loops SET name=@name, kind=@kind, control_plane=@control_plane, schedule_id=@schedule_id,
  contract=@contract, escalation_threshold=@escalation_threshold, merge_posture=@merge_posture,
  review_policy=@review_policy, risk_rubric=@risk_rubric, routable_ceiling=@routable_ceiling,
  enabled=@enabled WHERE id=@id
`);
const setModeStmt = db.prepare('UPDATE loops SET mode=@mode WHERE id=@id');
const recordRunStmt = db.prepare('UPDATE loops SET last_run_id=@last_run_id, last_eval=@last_eval, last_error=@last_error WHERE id=@id');
const setGoodRunsStmt = db.prepare('UPDATE loops SET consecutive_good_runs=@n WHERE id=@id');

// ── repo ─────────────────────────────────────────────────────────────────────────
export const loopsRepo = {
  create(req: CreateLoopRequest): Loop {
    const id = randomUUID();
    const now = Date.now();
    insertStmt.run({
      id,
      name: req.name,
      project_id: req.projectId,
      kind: req.kind,
      control_plane: req.controlPlane ?? 'board',
      schedule_id: req.scheduleId ?? null,
      contract: JSON.stringify(req.contract),
      mode: 'dry-run', // forced start (spec §6.2 / §20)
      consecutive_good_runs: 0,
      escalation_threshold: req.escalationThreshold ?? 3,
      merge_posture: req.mergePosture ?? 'human-gate',
      review_policy: req.reviewPolicy ?? 'always',
      risk_rubric: JSON.stringify(req.riskRubric ?? []),
      routable_ceiling: req.routableCeiling ?? 'low',
      enabled: 1,
      last_run_id: null,
      last_eval: null,
      last_error: null,
      created_at: now,
    });
    return rowToLoop(getStmt.get(id));
  },

  list(projectId?: string): Loop[] {
    const rows = projectId ? listByProjectStmt.all(projectId) : listAllStmt.all();
    return (rows as any[]).map(rowToLoop);
  },

  get(id: string): Loop | null {
    const row = getStmt.get(id);
    return row ? rowToLoop(row) : null;
  },

  update(id: string, patch: Partial<CreateLoopRequest> & { enabled?: boolean }): Loop | null {
    const current = this.get(id);
    if (!current) return null;
    updateStmt.run({
      id,
      name: patch.name ?? current.name,
      kind: patch.kind ?? current.kind,
      control_plane: patch.controlPlane ?? current.controlPlane,
      schedule_id: patch.scheduleId !== undefined ? patch.scheduleId : current.scheduleId,
      contract: JSON.stringify(patch.contract ?? current.contract),
      escalation_threshold: patch.escalationThreshold ?? current.escalationThreshold,
      merge_posture: patch.mergePosture ?? current.mergePosture,
      review_policy: patch.reviewPolicy ?? current.reviewPolicy,
      risk_rubric: JSON.stringify(patch.riskRubric ?? current.riskRubric),
      routable_ceiling: patch.routableCeiling ?? current.routableCeiling,
      enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    });
    return this.get(id);
  },

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    deleteStmt.run(id);
    return true;
  },

  enabledByKind(projectId: string, kind: LoopKind): Loop[] {
    return (enabledByKindStmt.all(projectId, kind) as any[]).map(rowToLoop);
  },

  setMode(id: string, mode: LoopMode): void {
    setModeStmt.run({ id, mode });
  },

  recordRun(id: string, info: { runId?: string | null; eval?: LoopEvalResult | null; error?: string | null }): void {
    const current = this.get(id);
    if (!current) return;
    recordRunStmt.run({
      id,
      last_run_id: info.runId !== undefined ? info.runId : current.lastRunId,
      last_eval: info.eval !== undefined ? (info.eval ? JSON.stringify(info.eval) : null) : (current.lastEval ? JSON.stringify(current.lastEval) : null),
      last_error: info.error !== undefined ? info.error : current.lastError,
    });
  },

  bumpGoodRuns(id: string): number {
    const current = this.get(id);
    if (!current) return 0;
    const n = current.consecutiveGoodRuns + 1;
    setGoodRunsStmt.run({ id, n });
    return n;
  },

  resetGoodRuns(id: string): void {
    setGoodRunsStmt.run({ id, n: 0 });
  },
};
```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS (`✓ test/loops-core.test.ts` — 3 tests in "loopsRepo — CRUD + defaults")
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loops.ts apps/server/test/loops-core.test.ts
git commit -m "feat(loops): loops table + loopsRepo CRUD"
```

---

### Task 02.2: `validateContract` — reject empty evaluation

**Files:**
- Modify: `apps/server/src/loops.ts`
- Test: `apps/server/test/loops-core.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// Append to test/loops-core.test.ts. Add `validateContract` to the imports in beforeAll:
//   let validateContract: typeof import('../src/loops.js').validateContract;
//   ({ loopsRepo, validateContract } = await import('../src/loops.js'));

describe('validateContract — EVALUATION required (spec §3)', () => {
  it('returns null for a complete contract', () => {
    expect(validateContract(baseContract())).toBeNull();
  });

  it('rejects an empty evaluation with a message', () => {
    const msg = validateContract({ ...baseContract(), evaluation: '   ' });
    expect(typeof msg).toBe('string');
    expect(msg).toMatch(/evaluation/i);
  });

  it('rejects a missing job / inputs / output', () => {
    expect(validateContract({ ...baseContract(), job: '' })).toMatch(/job/i);
    expect(validateContract({ ...baseContract(), inputs: '' })).toMatch(/inputs/i);
    expect(validateContract({ ...baseContract(), output: '' })).toMatch(/output/i);
  });
});
```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (`validateContract is not a function`)
- [ ] **Step 3: Implement**
```ts
// Add to apps/server/src/loops.ts (after the repo block).

/**
 * Validate a six-part contract (spec §3). Returns an error MESSAGE (string) or null if valid.
 * The hard rule: an empty `evaluation` is rejected — "if you can't grade it, you're not ready to
 * run it autonomously." job/inputs/output are required free-text fields too.
 */
export function validateContract(c: LoopContract): string | null {
  if (!c || typeof c !== 'object') return 'contract is required';
  if (!c.job || !c.job.trim()) return 'contract.job is required';
  if (!c.inputs || !c.inputs.trim()) return 'contract.inputs is required';
  if (!c.output || !c.output.trim()) return 'contract.output is required';
  if (!c.evaluation || !c.evaluation.trim()) {
    return 'contract.evaluation is required — if you cannot grade it, you cannot run it autonomously';
  }
  if (!Array.isArray(c.allowed)) return 'contract.allowed must be a string[]';
  if (!Array.isArray(c.forbidden)) return 'contract.forbidden must be a string[]';
  return null;
}
```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS (`✓` "validateContract — EVALUATION required (spec §3)" — 3 tests)
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loops.ts apps/server/test/loops-core.test.ts
git commit -m "feat(loops): validateContract rejects empty evaluation"
```

---

### Task 02.3: `compileContract` — forbidden merges on top of `pm.disallowedToolsForProject`, may only add denies

**Files:**
- Modify: `apps/server/src/loops.ts`
- Test: `apps/server/test/loops-core.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// Append to test/loops-core.test.ts. Add to the beforeAll imports:
//   let compileContract: typeof import('../src/loops.js').compileContract;
//   ({ loopsRepo, validateContract, compileContract } = await import('../src/loops.js'));

describe('compileContract — permissions compilation (spec §10)', () => {
  it('manager → read-only mode; allowed maps to allowedTools', () => {
    const loop = loopsRepo.create({
      name: 'm-compile',
      projectId: PID,
      kind: 'manager',
      contract: { ...baseContract(), allowed: ['Read', 'Grep', 'Glob'], forbidden: ['Edit', 'Write'] },
    });
    const project = projectsRepo.getProject(PID)!;
    const out = compileContract(loop, project);
    expect(out.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    // managers are read-only / non-interactive → never bypassPermissions
    expect(out.permissionMode).toBe('default');
    // forbidden is merged ON TOP of the project baseline (which always denies git push/remote)
    expect(out.disallowedTools).toContain('Edit');
    expect(out.disallowedTools).toContain('Write');
    expect(out.disallowedTools.some((t) => /git\s+push/.test(t))).toBe(true);
  });

  it('worker → bypassPermissions; forbidden may only ADD denies, never relax the baseline', () => {
    const loop = loopsRepo.create({
      name: 'w-compile',
      projectId: PID,
      kind: 'worker',
      // even if a contract tries to "forbid nothing", the project baseline deny survives
      contract: { ...baseContract(), allowed: ['Edit', 'Bash'], forbidden: [] },
    });
    const project = projectsRepo.getProject(PID)!;
    const baseline = (await import('../src/pm.js')).disallowedToolsForProject(project);
    const out = compileContract(loop, project);
    expect(out.permissionMode).toBe('bypassPermissions');
    // every baseline deny is still present (compilation only adds, never removes)
    for (const d of baseline) expect(out.disallowedTools).toContain(d);
    // no duplicate entries
    expect(new Set(out.disallowedTools).size).toBe(out.disallowedTools.length);
  });
});
```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (`compileContract is not a function`)
- [ ] **Step 3: Implement**
```ts
// Add to apps/server/src/loops.ts. Add these imports at the top of the file:
//   import type { Project, PermissionMode } from '@fleet/shared';
//   import { disallowedToolsForProject } from './pm.js';

/**
 * Compile a loop's contract into the launch envelope every run the loop spawns inherits (spec §10).
 * - `contract.allowed`  → allowedTools.
 * - `contract.forbidden` is MERGED ON TOP of pm.disallowedToolsForProject(project) — the baseline
 *   `Bash(git push *)`/`Bash(git remote *)` deny is never relaxed. Compilation may only ADD denies.
 * - permissionMode per kind: manager = read-only / non-interactive ('default'); worker = the existing
 *   PM isolated-worktree 'bypassPermissions' posture.
 */
export function compileContract(
  loop: Loop,
  project: Project,
): { allowedTools: string[]; disallowedTools: string[]; permissionMode: PermissionMode } {
  const baseline = disallowedToolsForProject(project); // already a fresh array
  // Union (baseline ∪ forbidden) — only ADD; preserve baseline order, then append new forbids.
  const disallowed = [...baseline];
  for (const f of loop.contract.forbidden) {
    if (!disallowed.includes(f)) disallowed.push(f);
  }
  const permissionMode: PermissionMode = loop.kind === 'manager' ? 'default' : 'bypassPermissions';
  return {
    allowedTools: [...loop.contract.allowed],
    disallowedTools: disallowed,
    permissionMode,
  };
}
```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS (`✓` "compileContract — permissions compilation (spec §10)" — 2 tests)
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loops.ts apps/server/test/loops-core.test.ts
git commit -m "feat(loops): compileContract merges forbidden onto project deny baseline"
```

---

### Task 02.4: `applyEvalResult` — escalation counter (clean → ++, non-clean → reset, ≥threshold → flip to apply + notify)

**Files:**
- Modify: `apps/server/src/loops.ts`
- Test: `apps/server/test/loops-core.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// Append to test/loops-core.test.ts. Add to the beforeAll imports:
//   let applyEvalResult: typeof import('../src/loops.js').applyEvalResult;
//   ({ loopsRepo, validateContract, compileContract, applyEvalResult } = await import('../src/loops.js'));
// Also import db at the top (after the FLEET_DATA_DIR line is fine — db.js is lazy via dynamic import):
//   let db: typeof import('../src/db.js').default;
//   db = (await import('../src/db.js')).default;   // inside beforeAll

describe('applyEvalResult — escalation counter (spec §6.2, the heart of the lifecycle)', () => {
  const clean = (n: number) => ({ clean: true, score: n, notes: 'ok' });
  const dirty = { clean: false, score: 0, notes: 'risky' };

  it('a clean dry-run increments consecutive_good_runs; stays dry-run below threshold', () => {
    const loop = loopsRepo.create({
      name: 'esc-1', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1));
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(1);
    expect(loopsRepo.get(loop.id)!.mode).toBe('dry-run');
    applyEvalResult(loopsRepo.get(loop.id)!, clean(2));
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(2);
    expect(loopsRepo.get(loop.id)!.mode).toBe('dry-run');
  });

  it('a non-clean dry-run resets the counter to 0 and keeps dry-run', () => {
    const loop = loopsRepo.create({
      name: 'esc-2', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1));
    applyEvalResult(loopsRepo.get(loop.id)!, dirty);
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(0);
    expect(loopsRepo.get(loop.id)!.mode).toBe('dry-run');
  });

  it('reaching escalation_threshold auto-flips to apply and writes a notification', () => {
    const loop = loopsRepo.create({
      name: 'esc-3', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });
    const before = (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='loop-escalation'").get() as any).c;
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1));
    applyEvalResult(loopsRepo.get(loop.id)!, clean(2));
    applyEvalResult(loopsRepo.get(loop.id)!, clean(3));
    const fresh = loopsRepo.get(loop.id)!;
    expect(fresh.consecutiveGoodRuns).toBe(3);
    expect(fresh.mode).toBe('apply');
    const after = (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='loop-escalation'").get() as any).c;
    expect(after).toBe(before + 1);
  });

  it('an already-apply loop is a no-op for the counter (never re-grants)', () => {
    const loop = loopsRepo.create({
      name: 'esc-4', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 1,
    });
    applyEvalResult(loopsRepo.get(loop.id)!, clean(1)); // flips to apply at threshold 1
    expect(loopsRepo.get(loop.id)!.mode).toBe('apply');
    applyEvalResult(loopsRepo.get(loop.id)!, dirty); // apply-mode: counter logic is skipped
    expect(loopsRepo.get(loop.id)!.mode).toBe('apply');
  });
});
```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (`applyEvalResult is not a function`)
- [ ] **Step 3: Implement**
```ts
// Add to apps/server/src/loops.ts.

// The notifications table is owned by notifier.ts (columns id, run_id, kind, message, ts, read) and
// created idempotently before loops.init() runs. notifier.ts exports no public emit helper, so we
// own a prepared statement here (db.ts:resetAllData already treats notifications as cross-module).
const insertLoopNotifStmt = db.prepare(
  'INSERT INTO notifications (id, run_id, kind, message, ts, read) VALUES (@id, @run_id, @kind, @message, @ts, @read)',
);

/**
 * Apply a dry-run's grade to the escalation counter (spec §6.2 — the lifecycle's heart).
 * - apply-mode loop → no-op (a graded run only drives the dry-run→apply ramp; never re-grants).
 * - clean dry run   → consecutive_good_runs++; at >= escalation_threshold, AUTO-flip to apply
 *                     (no human gate) and emit a 'loop-escalation' notification.
 * - non-clean run   → reset the counter to 0; stay dry-run.
 * Returns the post-update consecutive_good_runs (for tests / callers).
 */
export function applyEvalResult(loop: Loop, evalResult: LoopEvalResult): number {
  if (loop.mode === 'apply') return loop.consecutiveGoodRuns; // already escalated — counter is frozen
  if (!evalResult.clean) {
    loopsRepo.resetGoodRuns(loop.id);
    return 0;
  }
  const n = loopsRepo.bumpGoodRuns(loop.id);
  if (n >= loop.escalationThreshold) {
    loopsRepo.setMode(loop.id, 'apply');
    notifyEscalation(loop, n);
  }
  return n;
}

/** Emit a notification when a loop auto-escalates to apply-mode (spec §6.2 — notify, no human gate). */
function notifyEscalation(loop: Loop, goodRuns: number): void {
  try {
    insertLoopNotifStmt.run({
      id: randomUUID(),
      run_id: loop.lastRunId ?? null,
      kind: 'loop-escalation',
      message: `Loop "${loop.name}" auto-escalated to apply-mode after ${goodRuns} clean dry-run${goodRuns === 1 ? '' : 's'}.`,
      ts: Date.now(),
      read: 0,
    });
  } catch {
    /* best-effort — an escalation notification must never destabilize the fire path */
  }
}
```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS (`✓` "applyEvalResult — escalation counter ..." — 4 tests)
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loops.ts apps/server/test/loops-core.test.ts
git commit -m "feat(loops): applyEvalResult escalation counter + auto-apply notify"
```

---

### Task 02.5: `loops` singleton — `init()` boot reconcile + `hasWork(loopId)` probe + `fire(loopId)` manager path

**Files:**
- Modify: `apps/server/src/loops.ts`
- Test: `apps/server/test/loops-core.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// Append to test/loops-core.test.ts. Add to beforeAll imports:
//   let loops: typeof import('../src/loops.js').loops;
//   ({ loopsRepo, validateContract, compileContract, applyEvalResult, loops } = await import('../src/loops.js'));

describe('loops singleton — fire(manager) drives runManagerLoop → grade → escalate', () => {
  it('a dry-run manager fire grades the intended actions and bumps the counter on a clean eval', async () => {
    const loop = loopsRepo.create({
      name: 'fire-mgr', projectId: PID, kind: 'manager', contract: baseContract(), escalationThreshold: 3,
    });

    // Stub the cross-slice collaborators by property-reassign on their module namespaces
    // (the same seam kanban.test.ts uses on `pm`). These are owned by Slices 03/05/06.
    const manager = await import('../src/manager.js');
    const controlplane = await import('../src/controlplane.js');
    const loopEval = await import('../src/loopEval.js');
    // The dry-run wrapper records intended actions INTO the tuple's `intended` array; fire() grades
    // THAT array (Fix: not runManagerLoop's return value). Model the wrapper by pushing into `intended`.
    const intended: any[] = [];
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [{ id: 'c1', title: 't', body: '', labels: [] }], listReady: async () => [] }, intended });
    (manager as any).runManagerLoop = async (_l: any, _p: any, _cp: any) => { intended.push({ kind: 'classify' as const, itemId: 'c1', detail: {} }); return intended; };
    // gradeLoopRun receives the TUPLE's intended array (asserts the wiring routed it through).
    let graded: any[] | null = null;
    (loopEval as any).gradeLoopRun = async (_l: any, recvIntended: any[]) => { graded = recvIntended; return { clean: true, score: 1, notes: 'clean' }; };

    await loops.fire(loop.id);

    expect(graded).toEqual([{ kind: 'classify', itemId: 'c1', detail: {} }]); // graded the tuple's intended
    const fresh = loopsRepo.get(loop.id)!;
    expect(fresh.consecutiveGoodRuns).toBe(1);
    expect(fresh.lastEval?.clean).toBe(true);
    expect(fresh.mode).toBe('dry-run'); // below threshold
  });

  it('fire on a disabled / missing loop is a safe no-op (never throws)', async () => {
    await expect(loops.fire('no-such-loop')).resolves.toBeUndefined();
    const loop = loopsRepo.create({ name: 'fire-off', projectId: PID, kind: 'manager', contract: baseContract() });
    loopsRepo.update(loop.id, { enabled: false });
    await expect(loops.fire(loop.id)).resolves.toBeUndefined();
    expect(loopsRepo.get(loop.id)!.consecutiveGoodRuns).toBe(0);
  });

  it('hasWork is false for missing/disabled and reflects the control-plane list length', async () => {
    // Missing loop → false.
    expect(await loops.hasWork('no-such-loop')).toBe(false);

    // Disabled loop → false (no probe spend).
    const off = loopsRepo.create({ name: 'hw-off', projectId: PID, kind: 'manager', contract: baseContract() });
    loopsRepo.update(off.id, { enabled: false });
    expect(await loops.hasWork(off.id)).toBe(false);

    // Manager with backlog → true; empty backlog → false (stub controlPlaneFor's listBacklog).
    const controlplane = await import('../src/controlplane.js');
    const mgr = loopsRepo.create({ name: 'hw-mgr', projectId: PID, kind: 'manager', contract: baseContract() });
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [{ id: 'c1', title: 't', body: '', labels: [] }], listReady: async () => [] }, intended: [] });
    expect(await loops.hasWork(mgr.id)).toBe(true);
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [], listReady: async () => [] }, intended: [] });
    expect(await loops.hasWork(mgr.id)).toBe(false);

    // Worker probes listReady.
    const wkr = loopsRepo.create({ name: 'hw-wkr', projectId: PID, kind: 'worker', contract: baseContract() });
    (controlplane as any).controlPlaneFor = () => ({ cp: { listBacklog: async () => [], listReady: async () => [{ id: 'r1', title: 't', body: '', labels: [] }] }, intended: [] });
    expect(await loops.hasWork(wkr.id)).toBe(true);

    // A throwing adapter never propagates — hasWork resolves false.
    (controlplane as any).controlPlaneFor = () => { throw new Error('adapter boom'); };
    expect(await loops.hasWork(mgr.id)).toBe(false);
  });
});
```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (`Cannot read properties of undefined (reading 'fire')` — `loops` singleton not exported)
- [ ] **Step 3: Implement**
```ts
// Add to apps/server/src/loops.ts.
//
// IMPORTANT — cross-slice collaborators are DYNAMICALLY imported INSIDE fire()/hasWork() (via
// `await import(...)`), exactly like the existing `await import('./projects.js')`. This is what lets
// loops.ts COMPILE and its tests run before Slices 03/05/06 land (those modules don't exist yet):
//   const { runManagerLoop }  = await import('./manager.js');      // Slice 06
//   const { controlPlaneFor } = await import('./controlplane.js'); // Slice 03
//   const { gradeLoopRun }    = await import('./loopEval.js');     // Slice 05
// A static top-of-file import of any of these would break the build until those slices exist.

/**
 * The loops driver singleton (spec §6).
 * - init(): boot reconcile — a loop has no live process across a restart, so nothing here re-grants
 *   apply-mode; mode/counter persist in SQLite. We only clear a stale last_error left mid-fire so the
 *   UI never shows a permanent error from an interrupted dry run (mirrors pm.reconcile resetting
 *   mid-flight cards). Called once by the main loop on boot.
 * - hasWork(loopId): cheap "is there anything to do?" probe the scheduler consults before firing — a
 *   loop with no work is skipped but its cadence still advances (spec §13). Never throws.
 * - fire(loopId): manager path. Worker loops are driven by pm.ts (Slice 08); fire() for a worker just
 *   records the tick. A fire is a safe no-op for a missing or disabled loop (defers, no spend).
 */
class LoopEngine {
  init(): void {
    // Boot reconcile: clear any last_error from a fire interrupted by a crash. mode + counter are
    // intentionally LEFT AS-IS (persisted in SQLite) so a restart never silently re-grants apply-mode
    // and never silently loses escalation progress (spec §18 boot-reconcile).
    try {
      db.prepare("UPDATE loops SET last_error = NULL WHERE last_error LIKE 'mid-fire:%'").run();
    } catch {
      /* best-effort — a reconcile failure must never block boot */
    }
  }

  /**
   * Does this loop have anything to do right now? The scheduler (Slice 04) calls this before fire():
   * no work → skip the fire but still advance the cadence (spec §13). A manager has work when its
   * control plane has untriaged backlog; a worker when there are agent:ready cards to pick up. Any
   * missing/disabled loop, missing project, or thrown adapter error resolves to `false` (never throws).
   */
  async hasWork(loopId: string): Promise<boolean> {
    try {
      const loop = loopsRepo.get(loopId);
      if (!loop || !loop.enabled) return false;
      const { projectsRepo } = await import('./projects.js');
      const project = projectsRepo.getProject(loop.projectId);
      if (!project) return false;
      const { controlPlaneFor } = await import('./controlplane.js'); // Slice 03
      const { cp } = controlPlaneFor(loop, project);
      if (loop.kind === 'manager') return (await cp.listBacklog()).length > 0;
      return (await cp.listReady()).length > 0; // worker
    } catch {
      return false; // a probe must never throw — defer the fire, advance the cadence
    }
  }

  async fire(loopId: string): Promise<void> {
    const loop = loopsRepo.get(loopId);
    if (!loop || !loop.enabled) return; // missing/disabled → defer, no spend

    // Worker loops execute through pm.ts (Slice 08). fire() for a worker just records the tick so the
    // scheduler's last_run bookkeeping has something to point at; the selection/review/gate logic lives
    // in pm.tick.
    if (loop.kind === 'worker') {
      loopsRepo.recordRun(loop.id, { error: null });
      return;
    }

    const { projectsRepo } = await import('./projects.js');
    const project = projectsRepo.getProject(loop.projectId);
    if (!project) {
      loopsRepo.recordRun(loop.id, { error: 'project not found' });
      return;
    }

    try {
      // Dynamic imports so loops.ts compiles before Slices 03/05/06 land (see note above).
      const { controlPlaneFor } = await import('./controlplane.js'); // Slice 03
      const { runManagerLoop } = await import('./manager.js'); // Slice 06
      const { gradeLoopRun } = await import('./loopEval.js'); // Slice 05
      // controlPlaneFor wraps the adapter: in dry-run, cp writes are intercepted into the tuple's
      // `intended` array and NOT performed; in apply, writes are real and `intended` stays empty
      // (Slice 03). runManagerLoop drives the cp; the dry-run wrapper RECORDS the intended actions
      // INTO this same `intended` array — so we grade the TUPLE's `intended`, NOT runManagerLoop's
      // return value (it must not be relied on for the intended set).
      const { cp, intended } = controlPlaneFor(loop, project);
      await runManagerLoop(loop, project, cp); // Slice 06 — drives cp; fills `intended` via the wrapper
      const evalResult = await gradeLoopRun(loop, intended, project); // Slice 05 — grades the tuple's intended
      loopsRepo.recordRun(loop.id, { eval: evalResult, error: null });
      // Escalation only ramps in dry-run; applyEvalResult is a no-op once mode==='apply'.
      if (loop.mode === 'dry-run') applyEvalResult(loopsRepo.get(loop.id)!, evalResult);
    } catch (e: any) {
      // A cap rejection must propagate so the scheduler's capBlocked path defers the cadence and
      // retries next tick (spec §13) — exactly the 429 / 'daily-cap' contract scheduler.ts already
      // honors. RETHROW those; all OTHER errors are swallowed into a non-clean run (never auto-escalate
      // on uncertainty): the error lands in last_error and the dry-run counter resets.
      if (e?.statusCode === 429 || e?.code === 'daily-cap') throw e;
      loopsRepo.recordRun(loop.id, { error: e?.message ?? 'fire failed' });
      if (loop.mode === 'dry-run') loopsRepo.resetGoodRuns(loop.id);
    }
  }
}

export const loops = new LoopEngine();
```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS (`✓` "loops singleton — fire(manager) ..." — 3 tests: fire-grades-tuple-intended, fire-no-op, hasWork)
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loops.ts apps/server/test/loops-core.test.ts
git commit -m "feat(loops): loops singleton init() reconcile + hasWork() probe + fire() manager path"
```

---

### Task 02.6: `registerLoopRoutes` — REST routes (spec §16)

**Files:**
- Modify: `apps/server/src/loops.ts`
- Test: `apps/server/test/loops-core.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// Append to test/loops-core.test.ts. The route tests use the buildServer harness (the manager/
// controlplane/loopEval modules are already stubbed in Task 02.5's beforeAll). Add app/PORT/H if not
// already declared at the top:
//   let app: any; let PORT: number; const H = () => ({ host: `127.0.0.1:${PORT}` });
//   inside beforeAll: PORT = (await import('../src/config.js')).PORT;
//                     const { buildServer } = await import('../src/server.js'); app = buildServer(); await app.ready();
//   inside afterAll: await app?.close();

describe('loop routes (spec §16)', () => {
  it('POST /api/loops rejects an empty contract.evaluation with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r1', projectId: PID, kind: 'manager', contract: { ...baseContract(), evaluation: '' } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/evaluation/i);
  });

  it('POST then GET list + detail', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r2', projectId: PID, kind: 'manager', contract: baseContract() },
    });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id;

    const list = await app.inject({ method: 'GET', url: '/api/loops', headers: H() });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).some((l: any) => l.id === id)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/loops/${id}`, headers: H() });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).mode).toBe('dry-run');
  });

  it('PUT re-validates the contract; promote/demote flip the mode; DELETE removes', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/loops', headers: H(),
      payload: { name: 'r3', projectId: PID, kind: 'manager', contract: baseContract() },
    });
    const id = JSON.parse(created.body).id;

    const badPut = await app.inject({
      method: 'PUT', url: `/api/loops/${id}`, headers: H(),
      payload: { contract: { ...baseContract(), evaluation: '' } },
    });
    expect(badPut.statusCode).toBe(400);

    const promote = await app.inject({ method: 'POST', url: `/api/loops/${id}/promote`, headers: H() });
    expect(promote.statusCode).toBe(200);
    expect(JSON.parse(promote.body).mode).toBe('apply');

    const demote = await app.inject({ method: 'POST', url: `/api/loops/${id}/demote`, headers: H() });
    expect(JSON.parse(demote.body).mode).toBe('dry-run');

    const fired = await app.inject({ method: 'POST', url: `/api/loops/${id}/fire`, headers: H() });
    expect(fired.statusCode).toBe(200);
    const firedBody = JSON.parse(fired.body);
    expect(firedBody.ok).toBe(true);
    expect(firedBody).toHaveProperty('runId'); // Slice 09's web client reads runId
    expect(firedBody.loop.id).toBe(id);

    const del = await app.inject({ method: 'DELETE', url: `/api/loops/${id}`, headers: H() });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: `/api/loops/${id}`, headers: H() });
    expect(gone.statusCode).toBe(404);
  });
});
```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (the routes 404 — `registerLoopRoutes` is not wired into the server yet)
- [ ] **Step 3: Implement**
```ts
// Add to apps/server/src/loops.ts. The `Project` import already exists from Task 02.3.

/** REST routes mirroring scheduler.ts / triggers.ts (spec §16). */
export function registerLoopRoutes(app: FastifyInstance): void {
  // List (newest first; optional ?projectId= filter).
  app.get('/api/loops', async (req) => {
    const projectId = (req.query as any)?.projectId as string | undefined;
    return loopsRepo.list(projectId);
  });

  // Detail.
  app.get('/api/loops/:id', async (req, reply) => {
    const loop = loopsRepo.get((req.params as any).id);
    if (!loop) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    return loop;
  });

  // Create (rejects an empty contract.evaluation per spec §3).
  app.post('/api/loops', async (req, reply) => {
    const body = (req.body as any) ?? {};
    if (typeof body.name !== 'string' || !body.name.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const { projectsRepo } = await import('./projects.js');
    if (typeof body.projectId !== 'string' || !projectsRepo.getProject(body.projectId)) {
      reply.code(400);
      return { error: 'projectId must reference an existing project' };
    }
    if (body.kind !== 'manager' && body.kind !== 'worker') {
      reply.code(400);
      return { error: "kind must be 'manager' or 'worker'" };
    }
    const cErr = validateContract(body.contract);
    if (cErr) {
      reply.code(400);
      return { error: cErr };
    }
    const created = loopsRepo.create({
      name: body.name.trim(),
      projectId: body.projectId,
      kind: body.kind,
      controlPlane: body.controlPlane,
      scheduleId: body.scheduleId ?? null,
      contract: body.contract,
      escalationThreshold: body.escalationThreshold,
      mergePosture: body.mergePosture,
      reviewPolicy: body.reviewPolicy,
      riskRubric: body.riskRubric,
      routableCeiling: body.routableCeiling,
    });
    reply.code(201);
    return created;
  });

  // Edit (re-validates the contract when one is provided; enable/disable/posture/schedule).
  app.put('/api/loops/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    const body = (req.body as any) ?? {};
    if (body.contract !== undefined) {
      const cErr = validateContract(body.contract);
      if (cErr) {
        reply.code(400);
        return { error: cErr };
      }
    }
    return loopsRepo.update(id, {
      name: body.name,
      kind: body.kind,
      controlPlane: body.controlPlane,
      scheduleId: body.scheduleId,
      contract: body.contract,
      escalationThreshold: body.escalationThreshold,
      mergePosture: body.mergePosture,
      reviewPolicy: body.reviewPolicy,
      riskRubric: body.riskRubric,
      routableCeiling: body.routableCeiling,
      enabled: body.enabled,
    });
  });

  // Delete.
  app.delete('/api/loops/:id', async (req, reply) => {
    if (!loopsRepo.remove((req.params as any).id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });

  // Run-now: one fire, respecting the loop's current mode. The response surfaces `runId` (the loop's
  // post-fire lastRunId) — Slice 09's web client reads it to open the run's comments. `loop` is the
  // refreshed row.
  app.post('/api/loops/:id/fire', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    await loops.fire(id);
    const loop = loopsRepo.get(id);
    return { ok: true, runId: loop?.lastRunId ?? null, loop };
  });

  // Manual escape hatches: flip dry-run → apply / apply → dry-run.
  app.post('/api/loops/:id/promote', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    loopsRepo.setMode(id, 'apply');
    return loopsRepo.get(id);
  });
  app.post('/api/loops/:id/demote', async (req, reply) => {
    const id = (req.params as any).id;
    if (!loopsRepo.get(id)) {
      reply.code(404);
      return { error: 'loop not found' };
    }
    loopsRepo.setMode(id, 'dry-run');
    loopsRepo.resetGoodRuns(id); // demoting restarts the dry-run ramp
    return loopsRepo.get(id);
  });
}
```
- [ ] **Step 4: Run it, expect PASS** (after wiring into server.ts in the next task; if running standalone first, the routes 404 — wire then re-run)
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS once Task 02.7 wires `registerLoopRoutes(app)` into `buildServer()`
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loops.ts apps/server/test/loops-core.test.ts
git commit -m "feat(loops): registerLoopRoutes CRUD + fire/promote/demote"
```

---

### Task 02.7: Wire `registerLoopRoutes` + `loops.init()` into `server.ts`

**Files:**
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/test/loops-core.test.ts` (the route tests from 02.6 now pass)

- [ ] **Step 1: Write the failing test** — already written in Task 02.6 (the route suite). Confirm it fails because the routes are unregistered.
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL ("loop routes (spec §16)" — 404 on `/api/loops`)
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: FAIL (route suite returns 404)
- [ ] **Step 3: Implement**

Add the import beside the other Agent-PM imports in `apps/server/src/server.ts` (after the `registerTriggersRoutes` import on line 44):
```ts
import { registerLoopRoutes, loops } from './loops.js'; // Loops (loop-engineering)
```

Register the routes + init the driver inside `buildServer()`, beside `registerTriggersRoutes(app)` / `pm.init()` (after line 234 `registerTriggersRoutes(app);`):
```ts
  registerLoopRoutes(app); // Loops — CRUD + fire/promote/demote (spec §16)
```

And beside `pm.init()` (after line 237):
```ts
  loops.init(); // Loops — boot reconcile (clears mid-fire last_error; mode/counter persist in SQLite)
```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loops-core.test.ts`
 Expected: PASS (every suite green — including "loop routes (spec §16)" — 3 tests)
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/server.ts
git commit -m "feat(loops): wire registerLoopRoutes + loops.init() into server"
```


---

## Slice 03: controlplane-board

Build `controlplane.ts`: the `WorkItem`/`IntendedAction` types + `ControlPlane` interface, the BOARD adapter over `kanbanRepo` (listBacklog/listReady/classify/postAssessment/attachQuestions), the `kanban_comments` table (spec §4.4) with its `GET /api/tasks/:id/comments` route, and `controlPlaneFor(loop, project)` with the dry-run wrapper that intercepts writes into `intended[]`.

> **Cross-slice note for the critic.** This slice depends on Slice 01's shared types (`Loop`, `TriageVerdict`, `RiskLevel`, `WorkType`, `RISK_LABELS`, `TYPE_LABELS`, `ROUTING`) already being present in `packages/shared/src/index.ts`. The canonical contract sheet defines `RISK_LABELS` as an **object** `{ low:'risk:low', medium:'risk:medium', high:'risk:high' }` and `TYPE_LABELS` as `Record<WorkType,string>`; this slice consumes them in that object form (NOT the `as const` array form sketched in spec §4.5). `KanbanBoardMessage` (index.ts:742) has **no comment frame** — `postAssessment` therefore re-broadcasts the card via the existing `broadcastTask` (a `{kind:'task'}` frame) so subscribers refresh; there is no new SSE kind. The **github** branch of `controlPlaneFor` is a clearly-marked throw stub that **Slice 07** replaces. To avoid a `kanban.ts ↔ controlplane.ts` import cycle (kanban.ts has no reason to import controlplane), the `GET /api/tasks/:id/comments` route lives in a new `registerControlPlaneRoutes(app)` exported here and wired into `server.ts` beside `registerKanbanRoutes(app)`.

**Files:**
- Create: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`
- Modify: `apps/server/src/server.ts` (register the comments route)

---

### Task 03.1: `kanban_comments` table + comments repo

**Files:**
- Create: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB BEFORE any src module (→ config.js reads FLEET_DATA_DIR at load) is imported.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-controlplane-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

let cp: any; // src/controlplane.js module namespace

beforeAll(async () => {
  cp = await import('../src/controlplane.js');
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('03.1 — kanban_comments repo', () => {
  it('inserts a comment and reads it back newest-last for the task', () => {
    const taskId = 'task-' + Math.random().toString(36).slice(2);
    const c1 = cp.commentsRepo.add(taskId, 'manager', 'first assessment');
    const c2 = cp.commentsRepo.add(taskId, 'reviewer', 'second note');
    expect(c1.id).toBeTruthy();
    expect(c1.taskId).toBe(taskId);
    expect(c1.author).toBe('manager');
    expect(c1.body).toBe('first assessment');
    expect(typeof c1.createdAt).toBe('number');

    const list = cp.commentsRepo.list(taskId);
    expect(list.map((c: any) => c.id)).toEqual([c1.id, c2.id]); // created_at ASC
    expect(cp.commentsRepo.list('no-such-task')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("Cannot find module '../src/controlplane.js'" / `cp.commentsRepo is undefined`)

- [ ] **Step 3: Implement**
```ts
/**
 * Control plane (Loops feature, spec docs/superpowers/specs/2026-06-13-loop-engineering-design.md §5).
 *
 * One ControlPlane interface, two adapters selected per-loop by `loop.controlPlane`:
 *   • board  — reads/writes the local kanban via kanbanRepo (this slice, fully offline)
 *   • github — issues + labels (Slice 07; a marked throw-stub here)
 *
 * Self-contained module (mirrors scheduler.ts): owns the `kanban_comments` table (§4.4) +
 * its prepared statements + the GET /api/tasks/:id/comments route registrar.
 *
 * Dry-run wrapper: controlPlaneFor(loop) wraps the adapter so that in mode='dry-run' the three
 * write verbs (classify/postAssessment/attachQuestions) are intercepted into `intended[]` and
 * NOT performed; mode='apply' performs real writes and leaves intended empty.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Loop, TriageVerdict } from '@fleet/shared';
import { RISK_LABELS, TYPE_LABELS, ROUTING } from '@fleet/shared';
import db from './db.js';
import type { Project } from './projects.js';
import { kanbanRepo, broadcastTask } from './kanban.js';

// ── schema (idempotent, §4.4) ───────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS kanban_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_comments_task ON kanban_comments(task_id, created_at);
`);

export type CommentAuthor = 'manager' | 'reviewer' | 'worker' | 'human';

export interface KanbanComment {
  id: string;
  taskId: string;
  author: CommentAuthor;
  body: string;
  createdAt: number;
}

const insertCommentStmt = db.prepare(
  `INSERT INTO kanban_comments (id, task_id, author, body, created_at) VALUES (@id, @task_id, @author, @body, @created_at)`,
);
const listCommentsStmt = db.prepare(
  `SELECT id, task_id, author, body, created_at FROM kanban_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
);

function rowToComment(r: any): KanbanComment {
  return { id: r.id, taskId: r.task_id, author: r.author as CommentAuthor, body: r.body, createdAt: r.created_at };
}

export const commentsRepo = {
  add(taskId: string, author: CommentAuthor, body: string): KanbanComment {
    const c: KanbanComment = { id: randomUUID(), taskId, author, body, createdAt: Date.now() };
    insertCommentStmt.run({ id: c.id, task_id: c.taskId, author: c.author, body: c.body, created_at: c.createdAt });
    return c;
  },
  list(taskId: string): KanbanComment[] {
    return (listCommentsStmt.all(taskId) as any[]).map(rowToComment);
  },
};
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): kanban_comments table + commentsRepo (controlplane §4.4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.2: `WorkItem` / `IntendedAction` types + `ControlPlane` interface

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts)
import type { WorkItem, IntendedAction, ControlPlane } from '../src/controlplane.js';

describe('03.2 — control-plane types are structurally usable', () => {
  it('a WorkItem and an IntendedAction satisfy their shapes', () => {
    const item: WorkItem = { id: 't1', title: 'fix bug', body: 'desc', labels: [] };
    const action: IntendedAction = { kind: 'classify', itemId: item.id, detail: { risk: 'low' } };
    expect(item.id).toBe('t1');
    expect(action.kind).toBe('classify');
    expect(action.itemId).toBe('t1');
    // a minimal ControlPlane is assignable from a plain object literal
    const stub: ControlPlane = {
      listBacklog: async () => [],
      listReady: async () => [],
      classify: async () => {},
      postAssessment: async () => {},
      attachQuestions: async () => {},
    };
    expect(typeof stub.listBacklog).toBe('function');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("Module '\"../src/controlplane.js\"' has no exported member 'WorkItem'")

- [ ] **Step 3: Implement**
```ts
// (append to controlplane.ts, after commentsRepo)

// ── control-plane contract (§5) ──────────────────────────────────────────────────
export interface WorkItem {
  id: string;
  title: string;
  body: string;
  labels: string[];
}

export type IntendedAction = {
  kind: 'classify' | 'assessment' | 'questions';
  itemId: string;
  detail: unknown;
};

export interface ControlPlane {
  listBacklog(): Promise<WorkItem[]>;
  listReady(): Promise<WorkItem[]>;
  classify(itemId: string, v: TriageVerdict): Promise<void>;
  postAssessment(itemId: string, markdown: string): Promise<void>;
  attachQuestions(itemId: string, questions: string[]): Promise<void>;
}
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): WorkItem/IntendedAction types + ControlPlane interface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.3: Board adapter — `listBacklog` / `listReady`

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

`listBacklog` = `column='Backlog'` cards lacking any `risk:*` label (untriaged); `listReady` = `kanbanRepo.readyTasks(pid)` (the existing `column='Ready'`, `priority DESC, rank ASC` query). Both map `KanbanTask` → `WorkItem` using `description` as the `WorkItem.body`.

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts) — needs projectsRepo + kanbanRepo + pm stub.
// Add these to the EXISTING beforeAll so the singletons load once:
//   ({ pm } = await import('../src/pm.js')); pm.tick = async () => {};
//   ({ projectsRepo } = await import('../src/projects.js'));
//   ({ kanbanRepo } = await import('../src/kanban.js'));
// and declare `let pm: any, projectsRepo: any, kanbanRepo: any;` at top-of-file.
import { randomUUID as uuid } from 'node:crypto';

function makeProject(): string {
  return projectsRepo.createProject({ name: 'cp-' + uuid().slice(0, 8), rootDir: '/tmp' }).id;
}
function boardLoop(projectId: string): any {
  return { id: 'loop-' + uuid().slice(0, 6), projectId, kind: 'manager', controlPlane: 'board', mode: 'apply' };
}

describe('03.3 — board adapter listBacklog / listReady', () => {
  it('listBacklog returns only Backlog cards lacking a risk:* label', async () => {
    const pid = makeProject();
    const untriaged = kanbanRepo.createTask({ projectId: pid, title: 'untriaged' });
    const triaged = kanbanRepo.createTask({ projectId: pid, title: 'triaged' });
    kanbanRepo.updateTask(triaged.id, { labels: ['risk:low', 'type:bug'] });
    const readyCard = kanbanRepo.createTask({ projectId: pid, title: 'ready', column: 'Ready' });

    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    const backlog = await board.listBacklog();
    const ids = backlog.map((w: any) => w.id);
    expect(ids).toContain(untriaged.id);
    expect(ids).not.toContain(triaged.id); // already carries risk:low
    expect(ids).not.toContain(readyCard.id); // not in Backlog
    // WorkItem shape: body comes from the card description.
    const w = backlog.find((x: any) => x.id === untriaged.id);
    expect(w.title).toBe('untriaged');
    expect(w.labels).toEqual([]);
  });

  it('listReady returns Ready cards as WorkItems (priority DESC, rank ASC)', async () => {
    const pid = makeProject();
    const lo = kanbanRepo.createTask({ projectId: pid, title: 'lo', column: 'Ready', priority: 1 });
    const hi = kanbanRepo.createTask({ projectId: pid, title: 'hi', column: 'Ready', priority: 4 });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    const ready = await board.listReady();
    const ids = ready.map((w: any) => w.id);
    expect(ids).toEqual([hi.id, lo.id]); // priority DESC ordering preserved
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("cp.controlPlaneFor is not a function")

- [ ] **Step 3: Implement**
```ts
// (append to controlplane.ts, after the ControlPlane interface)
import type { KanbanTask } from '@fleet/shared';

const RISK_LABEL_SET = new Set<string>(Object.values(RISK_LABELS)); // risk:low|risk:medium|risk:high

function taskToWorkItem(t: KanbanTask): WorkItem {
  return { id: t.id, title: t.title, body: t.description, labels: t.labels };
}

function hasRiskLabel(labels: string[]): boolean {
  return labels.some((l) => RISK_LABEL_SET.has(l));
}

// ── board adapter (§5: kanban_tasks via kanbanRepo) ──────────────────────────────
function makeBoardAdapter(projectId: string): ControlPlane {
  return {
    // untriaged = Backlog cards with no risk:* label yet.
    async listBacklog(): Promise<WorkItem[]> {
      return kanbanRepo
        .listTasks(projectId)
        .filter((t) => t.column === 'Backlog' && !hasRiskLabel(t.labels))
        .map(taskToWorkItem);
    },
    // Ready = the existing PM selection query (priority DESC, rank ASC).
    async listReady(): Promise<WorkItem[]> {
      return kanbanRepo.readyTasks(projectId).map(taskToWorkItem);
    },
    async classify(): Promise<void> {
      /* Task 03.4 */
    },
    async postAssessment(): Promise<void> {
      /* Task 03.5 */
    },
    async attachQuestions(): Promise<void> {
      /* Task 03.6 */
    },
  };
}

// ── adapter selection + dry-run wrapper (Task 03.7 completes this) ────────────────
export function controlPlaneFor(
  loop: Loop,
  _project: Project,
): { cp: ControlPlane; intended: IntendedAction[] } {
  if (loop.controlPlane === 'github') {
    // Slice 07 replaces this with the gh-backed adapter (ghLabelAdd/ghIssueComment).
    throw new Error('github control plane not implemented yet (Slice 07)');
  }
  const cp = makeBoardAdapter(loop.projectId);
  return { cp, intended: [] };
}
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): board adapter listBacklog/listReady + controlPlaneFor shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.4: Board adapter — `classify` (labels + assignee + Backlog→Ready promotion)

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

`classify` writes `risk:*` + `type:*` labels (replacing any prior risk/type/routing labels, preserving the rest). On `agentReady` it adds `agent:ready`, sets `assignee='pm'`, and moves a `Backlog` card to `Ready`; otherwise it adds `needs:human` and sets `assignee='human'`.

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts)
describe('03.4 — board adapter classify writes labels/assignee and promotes', () => {
  it('agentReady → risk/type + agent:ready, assignee pm, Backlog moved to Ready', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'route me', description: 'd' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'low', type: 'bug', agentReady: true, reason: 'safe' });

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toContain('risk:low');
    expect(after.labels).toContain('type:bug');
    expect(after.labels).toContain('agent:ready');
    expect(after.labels).not.toContain('needs:human');
    expect(after.assignee).toBe('pm');
    expect(after.column).toBe('Ready'); // promoted
  });

  it('not agentReady → needs:human, assignee human, stays in Backlog', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'ambiguous' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'high', type: 'feature', agentReady: false, reason: 'risky' });

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toContain('risk:high');
    expect(after.labels).toContain('type:feature');
    expect(after.labels).toContain('needs:human');
    expect(after.labels).not.toContain('agent:ready');
    expect(after.assignee).toBe('human');
    expect(after.column).toBe('Backlog'); // NOT promoted
  });

  it('re-classifying replaces stale risk/type/routing labels (no dupes)', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'reclassify' });
    kanbanRepo.updateTask(card.id, { labels: ['risk:high', 'type:bug', 'needs:human', 'keepme'] });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'low', type: 'docs', agentReady: true, reason: 'ok' });

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toContain('keepme'); // unrelated label preserved
    expect(after.labels.filter((l: string) => l.startsWith('risk:'))).toEqual(['risk:low']);
    expect(after.labels.filter((l: string) => l.startsWith('type:'))).toEqual(['type:docs']);
    expect(after.labels).toContain('agent:ready');
    expect(after.labels).not.toContain('needs:human');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("expected [] to contain 'risk:low'" — classify is still a no-op)

- [ ] **Step 3: Implement**
```ts
// (in controlplane.ts) helper above makeBoardAdapter:
const ROUTING_LABELS = new Set<string>([ROUTING.ready, ROUTING.needsHuman]); // agent:ready | needs:human

/** Strip any prior risk:* / type:* / routing labels so classify is idempotent on re-run. */
function stripVerdictLabels(labels: string[]): string[] {
  return labels.filter(
    (l) => !l.startsWith('risk:') && !l.startsWith('type:') && !ROUTING_LABELS.has(l),
  );
}

// replace the classify stub inside makeBoardAdapter:
    async classify(itemId: string, v: TriageVerdict): Promise<void> {
      const card = kanbanRepo.getTask(itemId);
      if (!card) return; // adapters never throw out of a fire (§18)
      const labels = stripVerdictLabels(card.labels);
      labels.push(RISK_LABELS[v.risk]); // risk:low|risk:medium|risk:high
      labels.push(TYPE_LABELS[v.type]); // type:<work-type>
      const patch: Partial<KanbanTask> = { labels };
      if (v.agentReady) {
        labels.push(ROUTING.ready); // agent:ready
        patch.assignee = 'pm';
        if (card.column === 'Backlog') patch.column = 'Ready'; // promote
      } else {
        labels.push(ROUTING.needsHuman); // needs:human
        patch.assignee = 'human';
      }
      kanbanRepo.updateTask(itemId, patch); // broadcasts a task frame
    },
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): board adapter classify (labels/assignee + Backlog->Ready)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.5: Board adapter — `postAssessment` (insert comment + broadcast)

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

`postAssessment` inserts a `manager`-authored `kanban_comments` row and re-broadcasts the card (a `{kind:'task'}` frame; `KanbanBoardMessage` has no comment kind) so live boards refresh.

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts)
import { subscribeBoard } from '../src/kanban.js';

describe('03.5 — board adapter postAssessment', () => {
  it('inserts a manager comment and broadcasts a task frame', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'assess me' });
    const msgs: any[] = [];
    const unsub = subscribeBoard(pid, (m: any) => msgs.push(m)); // board-hello arrives synchronously
    msgs.length = 0; // drop the hello

    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.postAssessment(card.id, 'Risk: low\nType: bug\nReason: trivial');

    const comments = cp.commentsRepo.list(card.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('manager');
    expect(comments[0].body).toContain('Risk: low');
    // a task frame for the card was broadcast.
    expect(msgs.some((m) => m.kind === 'task' && m.task.id === card.id)).toBe(true);
    unsub();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("expected [] to have a length of 1 but got +0" — postAssessment is a no-op)

- [ ] **Step 3: Implement**
```ts
// replace the postAssessment stub inside makeBoardAdapter:
    async postAssessment(itemId: string, markdown: string): Promise<void> {
      commentsRepo.add(itemId, 'manager', markdown);
      const card = kanbanRepo.getTask(itemId);
      if (card) broadcastTask(card); // no comment frame in KanbanBoardMessage → refresh via task frame
    },
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): board adapter postAssessment (comment + board broadcast)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.6: Board adapter — `attachQuestions` (needs:human label + comment)

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

`attachQuestions` adds the `needs:human` routing label (idempotent) and posts a `manager` comment listing the questions as a markdown bullet list.

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts)
describe('03.6 — board adapter attachQuestions', () => {
  it('adds needs:human (once) and posts a manager question comment', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'has questions' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.attachQuestions(card.id, ['Which API?', 'Backwards compatible?']);
    await board.attachQuestions(card.id, ['And tests?']); // second call must not duplicate needs:human

    const after = kanbanRepo.getTask(card.id);
    expect(after.labels.filter((l: string) => l === 'needs:human')).toEqual(['needs:human']); // exactly one
    const comments = cp.commentsRepo.list(card.id);
    expect(comments).toHaveLength(2);
    expect(comments[0].author).toBe('manager');
    expect(comments[0].body).toContain('Which API?');
    expect(comments[0].body).toContain('Backwards compatible?');
  });

  it('no questions → no label change and no comment', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'no qs' });
    const { cp: board } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.attachQuestions(card.id, []);
    expect(kanbanRepo.getTask(card.id).labels).toEqual([]);
    expect(cp.commentsRepo.list(card.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("expected [] to deeply equal [ 'needs:human' ]")

- [ ] **Step 3: Implement**
```ts
// replace the attachQuestions stub inside makeBoardAdapter:
    async attachQuestions(itemId: string, questions: string[]): Promise<void> {
      if (questions.length === 0) return;
      const card = kanbanRepo.getTask(itemId);
      if (!card) return;
      if (!card.labels.includes(ROUTING.needsHuman)) {
        kanbanRepo.updateTask(itemId, { labels: [...card.labels, ROUTING.needsHuman] });
      }
      const body = ['**Open questions (needs:human):**', ...questions.map((q) => `- ${q}`)].join('\n');
      commentsRepo.add(itemId, 'manager', body);
    },
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): board adapter attachQuestions (needs:human + comment)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.7: Dry-run wrapper — intercept writes into `intended[]`

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane.test.ts`

In `mode='dry-run'`, `classify`/`postAssessment`/`attachQuestions` push an `IntendedAction` into the shared `intended[]` and perform **no** state write; reads (`listBacklog`/`listReady`) pass through. In `mode='apply'` the real board adapter runs and `intended` stays empty.

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts)
function dryLoop(projectId: string): any {
  return { id: 'loop-' + uuid().slice(0, 6), projectId, kind: 'manager', controlPlane: 'board', mode: 'dry-run' };
}

describe('03.7 — dry-run wrapper suppresses all writes into intended[]', () => {
  it('classify/postAssessment/attachQuestions are intercepted, no DB write', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'dry card', description: 'd' });
    const { cp: board, intended } = cp.controlPlaneFor(dryLoop(pid), { id: pid } as any);

    // reads still work in dry-run.
    const backlog = await board.listBacklog();
    expect(backlog.map((w: any) => w.id)).toContain(card.id);

    await board.classify(card.id, { risk: 'low', type: 'bug', agentReady: true, reason: 'x' });
    await board.postAssessment(card.id, 'Risk: low');
    await board.attachQuestions(card.id, ['why?']);

    // nothing was written.
    const after = kanbanRepo.getTask(card.id);
    expect(after.labels).toEqual([]);
    expect(after.assignee).toBe('human');
    expect(after.column).toBe('Backlog');
    expect(cp.commentsRepo.list(card.id)).toEqual([]);

    // every intended write is recorded, in order.
    expect(intended.map((a: any) => a.kind)).toEqual(['classify', 'assessment', 'questions']);
    expect(intended[0].itemId).toBe(card.id);
    expect(intended[0].detail).toMatchObject({ risk: 'low', agentReady: true });
    expect(intended[1].detail).toBe('Risk: low');
    expect(intended[2].detail).toEqual(['why?']);
  });

  it('apply mode performs real writes and leaves intended empty', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'apply card' });
    const { cp: board, intended } = cp.controlPlaneFor(boardLoop(pid), { id: pid } as any);
    await board.classify(card.id, { risk: 'low', type: 'bug', agentReady: true, reason: 'x' });
    expect(kanbanRepo.getTask(card.id).labels).toContain('agent:ready'); // real write happened
    expect(intended).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL ("expected [] to deeply equal [ 'classify', 'assessment', 'questions' ]" — dry-run writes still hit the board)

- [ ] **Step 3: Implement**
```ts
// in controlplane.ts: add the wrapper factory above controlPlaneFor.
function dryRunWrap(real: ControlPlane, intended: IntendedAction[]): ControlPlane {
  return {
    listBacklog: () => real.listBacklog(), // reads pass through unchanged
    listReady: () => real.listReady(),
    async classify(itemId, v) {
      intended.push({ kind: 'classify', itemId, detail: v });
    },
    async postAssessment(itemId, markdown) {
      intended.push({ kind: 'assessment', itemId, detail: markdown });
    },
    async attachQuestions(itemId, questions) {
      intended.push({ kind: 'questions', itemId, detail: questions });
    },
  };
}

// replace the body of controlPlaneFor (keep the github throw stub):
export function controlPlaneFor(
  loop: Loop,
  _project: Project,
): { cp: ControlPlane; intended: IntendedAction[] } {
  if (loop.controlPlane === 'github') {
    // Slice 07 replaces this with the gh-backed adapter (ghLabelAdd/ghIssueComment).
    throw new Error('github control plane not implemented yet (Slice 07)');
  }
  const real = makeBoardAdapter(loop.projectId);
  const intended: IntendedAction[] = [];
  if (loop.mode === 'dry-run') return { cp: dryRunWrap(real, intended), intended };
  return { cp: real, intended };
}
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): dry-run wrapper intercepts adapter writes into intended[]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```

---

### Task 03.8: `GET /api/tasks/:id/comments` route + wire into server

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/test/controlplane.test.ts`

Add `registerControlPlaneRoutes(app)` exporting the comments thread route, and register it in `server.ts` beside `registerKanbanRoutes(app)`.

- [ ] **Step 1: Write the failing test**
```ts
// (append to test/controlplane.test.ts) — needs the Fastify app.
// Add to the EXISTING beforeAll, after the singletons load:
//   const { buildServer } = await import('../src/server.js'); app = buildServer(); await app.ready();
// and declare `let app: any;` + `import { PORT } from '../src/config.js'` is read via cfg in beforeAll;
// reuse the H() helper: const H = () => ({ host: `127.0.0.1:${PORT}` });
describe('03.8 — GET /api/tasks/:id/comments', () => {
  it('returns the card assessment thread, created_at ascending', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'commented' });
    cp.commentsRepo.add(card.id, 'manager', 'first');
    cp.commentsRepo.add(card.id, 'reviewer', 'second');

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${card.id}/comments`, headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((c: any) => c.body)).toEqual(['first', 'second']);
    expect(body[0].author).toBe('manager');
  });

  it('returns an empty array for a card with no comments', async () => {
    const pid = makeProject();
    const card = kanbanRepo.createTask({ projectId: pid, title: 'empty thread' });
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${card.id}/comments`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: FAIL (404 — route not registered; `res.statusCode` is 404, not 200)

- [ ] **Step 3: Implement**
```ts
// (append to controlplane.ts)

// ── routes (§16: GET /api/tasks/:id/comments — the board assessment thread) ───────
export function registerControlPlaneRoutes(app: FastifyInstance): void {
  app.get('/api/tasks/:id/comments', async (req) => {
    const id = (req.params as any).id as string;
    return commentsRepo.list(id);
  });
}
```

```ts
// in server.ts: import alongside the kanban import (near line 39) ...
import { registerControlPlaneRoutes } from './controlplane.js';
// ... and register it beside registerKanbanRoutes(app) (after line 229).
  registerControlPlaneRoutes(app); // Loops — card assessment thread (controlplane §16)
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane.test.ts`
 Expected: PASS (`✓ test/controlplane.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/src/server.ts apps/server/test/controlplane.test.ts
 git commit -m "feat(loops): GET /api/tasks/:id/comments route + wire into server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
 ```


---

## Slice 04: scheduler-ext

Extend `scheduler.ts` so a schedule row can target a Loop (`loop_id`): the tick fires `loops.fire(loopId)` instead of `registry.launch`, skipping (but still advancing the cadence) when the loop has no work, and `POST /api/schedules` accepts `loop_id` alongside the existing recurrence grammar.

**Files:**
- Modify: `apps/server/src/scheduler.ts` (add nullable `loop_id` column; lazy `loops.fire`/`loops.hasWork` dispatch in `tickOnce`; accept `loop_id` in `POST /api/schedules` and surface it on `ScheduleRow`/`ScheduleView`)
- Test: `apps/server/test/scheduler-loop.test.ts` (loop-targeted fire + empty-work skip + CRUD round-trip)

Cross-slice dependency: this slice calls `loops.fire(loopId)` and `loops.hasWork(loopId)` from `apps/server/src/loops.ts` (the `loops` singleton, owned by Slice 02). The `loops` singleton exports `init(): void`, `fire(loopId: string): Promise<void>`, and `hasWork(loopId: string): Promise<boolean>` — `hasWork` was added on that same singleton in Slice 02 Task 02.5, so this slice can rely on it directly (no shim, no fallback). Imports are done with a dynamic `await import('./loops.js')` inside `tickOnce` so `scheduler.ts` carries no static edge to `loops.ts` (which itself reaches `pm`/`server`), avoiding a module cycle.

Cap deferral is inherited unchanged from the existing scheduler envelope (spec §13). `loops.fire` RETHROWS a `429` (concurrency cap) or `409 daily-cap` error rather than swallowing it, so when a loop-targeted fire hits a cap the throw propagates out of the loop branch into the scheduler's existing `catch (e: any)` block: that block sets `capBlocked = true`, the `if (capBlocked) continue;` guard fires, and `next_fire_at` is NOT advanced — the schedule retries on the next tick, exactly like a raw `registry.launch` cap hit. This slice changes no scheduler cap logic; it only routes the loop fire through the same try/catch.

---

### Task 04.1: Add nullable `loop_id` column + surface it on row/view

**Files:**
- Modify: `apps/server/src/scheduler.ts`
- Test: `apps/server/test/scheduler-loop.test.ts`

- [ ] **Step 1: Write the failing test**
 ```ts
 /**
  * Slice 04 — scheduler loop_id extension.
  * 1. POST /api/schedules accepts loop_id and round-trips it on the view (loopId).
  * 2. A due schedule with loop_id calls loops.fire(loopId), NOT registry.launch.
  * 3. A loop with no work (hasWork=false) is skipped but next_fire_at still advances.
  */
 import { describe, it, expect, beforeAll, afterAll } from 'vitest';
 import { mkdtempSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';

 // Isolate the DB before any src module is imported.
 process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-sched-loop-'));

 let app: any;
 let PORT: number;
 let __tickForTests: typeof import('../src/scheduler.js').__tickForTests;
 let registry: typeof import('../src/registry.js').registry;
 let loops: typeof import('../src/loops.js').loops;

 const H = () => ({ host: `127.0.0.1:${PORT}` });

 beforeAll(async () => {
   const cfg = await import('../src/config.js');
   PORT = cfg.PORT;
   ({ __tickForTests } = await import('../src/scheduler.js'));
   ({ registry } = await import('../src/registry.js'));
   ({ loops } = await import('../src/loops.js'));
   const { buildServer } = await import('../src/server.js');
   app = buildServer();
   await app.ready();
 });

 afterAll(async () => {
   await app?.close();
 });

 describe('schedule loop_id — CRUD round-trip', () => {
   it('POST with loop_id stores it and returns loopId on the view', async () => {
     const res = await app.inject({
       method: 'POST', url: '/api/schedules', headers: H(),
       payload: {
         name: 'loop-sched',
         recurrence: 'every:15',
         loop_id: 'loop-abc',
         launch_request: { prompt: 'ignored for loop schedules', cwd: '/tmp' },
       },
     });
     expect(res.statusCode).toBe(201);
     const s = res.json();
     expect(s.loopId).toBe('loop-abc');
     expect(s.recurrence).toBe('every:15');
   });

   it('LIST includes loopId key (null for non-loop rows)', async () => {
     const res = await app.inject({ method: 'GET', url: '/api/schedules', headers: H() });
     expect(res.statusCode).toBe(200);
     for (const s of res.json()) {
       expect('loopId' in s).toBe(true);
     }
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/scheduler-loop.test.ts`
 Expected: FAIL — the `POST` round-trip asserts `s.loopId` is `'loop-abc'`, but the view has no `loopId` (`expect(undefined).toBe('loop-abc')`). (The import of `../src/loops.js` resolves because Slice 02 created it.)

- [ ] **Step 3: Implement** — add the idempotent `loop_id` migration, the row/view field, and persist it through the prepared statements.
 In `apps/server/src/scheduler.ts`, add `loop_id` to the idempotent ALTER loop:
 ```ts
 // F2 — add columns that may not exist in an older DB (idempotent migrations).
 for (const [col, def] of [
   ['recurrence', 'TEXT'],
   ['template', 'TEXT'],
   ['loop_id', 'TEXT'], // Slice 04: a schedule may target a Loop instead of a raw launch_request
 ] as [string, string][]) {
   try {
     db.exec(`ALTER TABLE schedules ADD COLUMN ${col} ${def}`);
   } catch {
     /* column already exists — ignore */
   }
 }
 ```
 Add `loop_id` to `ScheduleRow` (after `template`):
 ```ts
   /** F2: template NAME whose profile fields apply at fire time */
   template: string | null;
   /** Slice 04: FK → loops.id; when set the tick fires loops.fire(loop_id) instead of registry.launch */
   loop_id: string | null;
   launch_request: string;
 ```
 Add `loopId` to `ScheduleView` (after `template`):
 ```ts
   /** F2 template name or null */
   template: string | null;
   /** Slice 04: target Loop id or null for a raw launch_request schedule */
   loopId: string | null;
   launchRequest: LaunchRequest;
 ```
 Map it in `rowToView` (after `template`):
 ```ts
     recurrence: row.recurrence ?? null,
     template: row.template ?? null,
     loopId: row.loop_id ?? null,
     launchRequest,
 ```
 Thread it through `insertStmt` (columns + `VALUES`) and `updateStmt`:
 ```ts
 const insertStmt = db.prepare(`
 INSERT INTO schedules (id, name, interval_ms, daily_at, recurrence, template, loop_id, launch_request, enabled, last_run_id, last_fired_at, next_fire_at, created_at)
 VALUES (@id, @name, @interval_ms, @daily_at, @recurrence, @template, @loop_id, @launch_request, @enabled, @last_run_id, @last_fired_at, @next_fire_at, @created_at)
 `);
 ```
 ```ts
 const updateStmt = db.prepare(`
 UPDATE schedules SET name=@name, interval_ms=@interval_ms, daily_at=@daily_at, recurrence=@recurrence, template=@template,
   loop_id=@loop_id, launch_request=@launch_request, enabled=@enabled, next_fire_at=@next_fire_at WHERE id=@id
 `);
 ```
 In the `POST /api/schedules` handler, accept and validate `loop_id` (string or absent) just before building `enabled`/`now`/`next`:
 ```ts
     // Slice 04: optional loop_id — a schedule may drive a Loop instead of a raw launch.
     let loopId: string | null = null;
     if (body.loop_id != null && body.loop_id !== '') {
       if (typeof body.loop_id !== 'string') {
         reply.code(400);
         return { error: 'loop_id must be a string (loop id)' };
       }
       loopId = body.loop_id;
     }
 ```
 Pass `loop_id: loopId` into the `insertStmt.run({ ... })` call (add the field next to `template: templateName`):
 ```ts
     insertStmt.run({
       id,
       name: body.name.trim(),
       interval_ms: trig.intervalMs,
       daily_at: trig.dailyAt,
       recurrence: trig.recurrence,
       template: templateName,
       loop_id: loopId,
       launch_request: JSON.stringify(lr.value),
       enabled: enabled ? 1 : 0,
       last_run_id: null,
       last_fired_at: null,
       next_fire_at: next,
       created_at: now,
     });
 ```
 In the `PUT /api/schedules/:id` handler, carry `loop_id` through (it is not editable here, but `updateStmt` now needs the column). Right before the `updateStmt.run`, default it from the existing row and pass it:
 ```ts
     updateStmt.run({
       id,
       name,
       interval_ms: intervalMs,
       daily_at: dailyAt,
       recurrence,
       template: templateName,
       loop_id: existing.loop_id ?? null,
       launch_request: launchRequestStr,
       enabled: enabled ? 1 : 0,
       next_fire_at: nextFire,
     });
 ```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/scheduler-loop.test.ts`
 Expected: PASS (`✓ test/scheduler-loop.test.ts`) — both CRUD round-trip cases green.

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/scheduler.ts apps/server/test/scheduler-loop.test.ts
 git commit -m "feat: add nullable loop_id column to schedules"
 ```

---

### Task 04.2: Tick dispatches loop schedules to `loops.fire` (with work-exists skip)

**Files:**
- Modify: `apps/server/src/scheduler.ts`
- Test: `apps/server/test/scheduler-loop.test.ts`

- [ ] **Step 1: Write the failing test** — append these two describe blocks to `apps/server/test/scheduler-loop.test.ts`.
 ```ts
 // ── Tick fires loops.fire(loopId) for a loop-targeted, due schedule ────────────
 describe('tick() — loop-targeted schedule fires loops.fire, not registry.launch', () => {
   it('a due loop schedule with work calls loops.fire(loopId) and advances next_fire_at', async () => {
     const scheduleDb = (await import('../src/db.js')).default;
     const now = Date.now();

     const create = await app.inject({
       method: 'POST', url: '/api/schedules', headers: H(),
       payload: {
         name: 'tick-loop-fires',
         recurrence: 'every:15',
         loop_id: 'loop-fires',
         launch_request: { prompt: 'unused', cwd: '/tmp' },
         enabled: true,
       },
     });
     expect(create.statusCode).toBe(201);
     const id = create.json().id;
     scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
     const before = now - 1000;

     // Spy: loop has work, and capture the fired loop id. registry.launch must NOT be called.
     let firedLoopId: string | null = null;
     let launchCalled = false;
     const realFire = loops.fire.bind(loops);
     const realHasWork = loops.hasWork.bind(loops);
     const realLaunch = registry.launch.bind(registry);
     (loops as any).hasWork = async (lid: string) => lid === 'loop-fires';
     (loops as any).fire = async (lid: string) => { firedLoopId = lid; };
     (registry as any).launch = () => { launchCalled = true; return { id: 'should-not-happen' }; };

     await __tickForTests();

     (loops as any).fire = realFire;
     (loops as any).hasWork = realHasWork;
     (registry as any).launch = realLaunch;

     expect(firedLoopId).toBe('loop-fires');
     expect(launchCalled).toBe(false);
     const after = (scheduleDb.prepare('SELECT next_fire_at, last_run_id FROM schedules WHERE id=?').get(id) as any);
     expect(after.next_fire_at).toBeGreaterThan(before); // cadence advanced from NOW
     expect(after.last_run_id).toBeNull(); // loop fires don't set a scheduler run id
   });
 });

 // ── An empty-work loop is skipped but the cadence still advances ───────────────
 describe('tick() — empty-work loop schedule is skipped (no fire) but advances cadence', () => {
   it('hasWork=false: loops.fire is NOT called, yet next_fire_at advances so it retries next cadence', async () => {
     const scheduleDb = (await import('../src/db.js')).default;
     const now = Date.now();

     const create = await app.inject({
       method: 'POST', url: '/api/schedules', headers: H(),
       payload: {
         name: 'tick-loop-empty',
         recurrence: 'every:15',
         loop_id: 'loop-empty',
         launch_request: { prompt: 'unused', cwd: '/tmp' },
         enabled: true,
       },
     });
     const id = create.json().id;
     scheduleDb.prepare('UPDATE schedules SET next_fire_at=? WHERE id=?').run(now - 1000, id);
     const before = now - 1000;

     let fireCalled = false;
     const realFire = loops.fire.bind(loops);
     const realHasWork = loops.hasWork.bind(loops);
     (loops as any).hasWork = async () => false; // no work
     (loops as any).fire = async () => { fireCalled = true; };

     await __tickForTests();

     (loops as any).fire = realFire;
     (loops as any).hasWork = realHasWork;

     expect(fireCalled).toBe(false); // skipped — no spend
     const after = (scheduleDb.prepare('SELECT next_fire_at FROM schedules WHERE id=?').get(id) as any).next_fire_at;
     expect(after).toBeGreaterThan(before); // advanced normally — retries next cadence
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/scheduler-loop.test.ts`
 Expected: FAIL — the tick still falls into the `registry.launch` path for every due row, so `firedLoopId` stays `null` (`expect(null).toBe('loop-fires')`) and `launchCalled` becomes `true`. The empty-work case fails because `loops.fire` is never branched to at all.

- [ ] **Step 3: Implement** — branch `tickOnce` on `row.loop_id` before the `registry.launch` path. Replace the body of the `for (const row of due)` loop's `try { ... }` launch block with a loop-aware dispatch.
 Locate the existing launch block inside `tickOnce`:
 ```ts
     try {
       let parsed: LaunchRequest = JSON.parse(row.launch_request);
       // F2: apply template profile first (template wins for unset fields), then fill defaults.
       if (row.template) {
         parsed = applyTemplateProfile(parsed, row.template);
       }
       // Apply defaults for any fields still unset after template merge.
       parsed = {
         ...parsed,
         model: parsed.model || 'claude-opus-4-8',
         effort: parsed.effort || 'high',
         permissionMode: parsed.permissionMode || 'default',
       };
       const run = await registry.launch(parsed);
       runId = run?.id ?? null;
       launched = true;
     } catch (e: any) {
 ```
 Insert the loop branch at the top of that `try` so a loop schedule never builds a LaunchRequest:
 ```ts
     try {
       // Slice 04: a schedule targeting a Loop drives loops.fire(loop_id), not registry.launch.
       if (row.loop_id) {
         // Lazy import keeps scheduler.ts free of a static edge to loops.ts (→ pm/server),
         // avoiding a module cycle.
         const { loops } = await import('./loops.js');
         const hasWork = await loops.hasWork(row.loop_id);
         if (hasWork) {
           await loops.fire(row.loop_id);
         }
         // Whether or not there was work, treat this as a firing: advance the cadence so
         // an empty-work loop simply retries next cadence (no spend, no penalty, no hot-loop).
         launched = true;
       } else {
         let parsed: LaunchRequest = JSON.parse(row.launch_request);
         // F2: apply template profile first (template wins for unset fields), then fill defaults.
         if (row.template) {
           parsed = applyTemplateProfile(parsed, row.template);
         }
         // Apply defaults for any fields still unset after template merge.
         parsed = {
           ...parsed,
           model: parsed.model || 'claude-opus-4-8',
           effort: parsed.effort || 'high',
           permissionMode: parsed.permissionMode || 'default',
         };
         const run = await registry.launch(parsed);
         runId = run?.id ?? null;
         launched = true;
       }
     } catch (e: any) {
 ```
 `loops.hasWork(row.loop_id)` is a confirmed export on the `loops` singleton (added in Slice 02 Task 02.5), so the `const hasWork = await loops.hasWork(row.loop_id); if (hasWork) await loops.fire(row.loop_id);` dispatch above resolves with no shim or fallback. A `false` result means the loop has no work this cadence: `loops.fire` is never called (no spend), and `launched = true` still advances `next_fire_at` so the loop simply retries next cadence (no hot-loop).

 The existing `catch (e: any)` body is unchanged and remains the cap-deferral path (spec §13). Because `loops.fire` RETHROWS a `429` (concurrency cap) or `409 daily-cap` error instead of swallowing it, that throw propagates out of the loop branch into this same `catch`, which sets `capBlocked = true`. The downstream `if (capBlocked) continue;` then short-circuits the row WITHOUT advancing `next_fire_at` — so a cap hit defers and retries on the next tick, exactly like a raw `registry.launch` cap hit; it never advances the cadence. Any other (non-cap) error logs and advances past the row just like a raw launch. The `if (launched) { ... updateFiredStmt ... }` block needs no change — `runId` stays `null` for loop fires, so `last_run_id` is set to `null` and `next_fire_at` advances via `computeNextFire(row, now)` (the row is recurring because `row.recurrence` is set).

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/scheduler-loop.test.ts`
 Expected: PASS (`✓ test/scheduler-loop.test.ts`) — loop schedule fires `loops.fire('loop-fires')` and never `registry.launch`; the empty-work loop is skipped yet `next_fire_at` advances.

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/scheduler.ts apps/server/test/scheduler-loop.test.ts
 git commit -m "feat: tick dispatches loop schedules to loops.fire with work-exists skip"
 ```

---

### Task 04.3: Regression — existing scheduler suite stays green

**Files:**
- Test: `apps/server/test/scheduler-recurrence.test.ts` (unchanged — run as a guard)

- [ ] **Step 1: Write the failing test**
 No new test. This task is the regression guard for the `loop_id` extension: the `loop_id`-aware `tickOnce` and the widened `insert`/`update` statements must not break the raw-launch path (`registry.launch`, cap-blocked invariant, template profile application, one-shot null-out) covered by `scheduler-recurrence.test.ts`.

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/scheduler-recurrence.test.ts`
 Expected: PASS already if Task 04.1/04.2 preserved the non-loop branch. If it FAILs (e.g. a missing `@loop_id` bind throws `SqliteError: NOT NULL`/`missing named parameter`), the `insertStmt`/`updateStmt` rewrite dropped a parameter — fix the statement so every named placeholder is supplied.

- [ ] **Step 3: Implement**
 If the run is red, ensure both prepared statements list `loop_id` and every call site (`insertStmt.run`, `updateStmt.run`) supplies `loop_id`. The non-loop CRUD callers pass `loop_id: loopId` (POST, defaulting to `null` when absent) and `loop_id: existing.loop_id ?? null` (PUT) — confirm those binds exist. No production logic change is needed beyond Task 04.1/04.2 when green.

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/scheduler-recurrence.test.ts`
 Expected: PASS (`✓ test/scheduler-recurrence.test.ts`) — all F2 recurrence/template/cap-guard cases green, proving the `loop_id` extension is backward compatible.

- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/test/scheduler-recurrence.test.ts apps/server/src/scheduler.ts
 git commit -m "test: confirm loop_id extension keeps scheduler recurrence suite green"
 ```


---

## Slice 05: loopeval

Build `apps/server/src/loopEval.ts` — the LLM-judge that grades a dry-run loop's *intended actions* against its contract's `evaluation` criterion. Exposes `LOOP_EVAL_JSON_SCHEMA` and `async function gradeLoopRun(loop, intended, project)`, which launches a read-only judge run via `registry.launch({ jsonSchema })`, awaits it to terminal, and reads `run.structuredOutput` as a `LoopEvalResult`. On any missing/invalid structured output or any throw it returns `{ clean: false, score: 0, notes: '<reason>' }` — it NEVER auto-escalates on uncertainty (a non-clean result resets the escalation counter in the caller).

**Files:**
- Create: `apps/server/src/loopEval.ts` — `LOOP_EVAL_JSON_SCHEMA`, `buildEvalPrompt`, `gradeLoopRun`
- Test: `apps/server/test/loopeval.test.ts` — schema shape, structuredOutput → `LoopEvalResult` mapping, prompt embedding, throw/invalid → `clean:false`

This slice depends on shared types from Slice 01 (`LoopEvalResult`, `Loop`, `LoopContract`, `LoopKind`, `IntendedAction` from `controlplane.ts` in Slice 02) and on `registry.launch`/`registry.getRun`/`registry.onRunTerminal` (registry.ts, real today). It mirrors the `benchmarks.ts` judge path: `JUDGE_JSON_SCHEMA` (benchmarks.ts:210), the `registry.launch({ … jsonSchema: JUDGE_JSON_SCHEMA … })` judge call (benchmarks.ts:400-410), and the `run.structuredOutput as any` read (benchmarks.ts:427-430).

---

### Task 05.1: `LOOP_EVAL_JSON_SCHEMA` constant

**Files:**
- Create: `apps/server/src/loopEval.ts`
- Test: `apps/server/test/loopeval.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// apps/server/test/loopeval.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Isolate the DB BEFORE importing any src module (db.ts reads FLEET_DATA_DIR at import time).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-loopeval-'));

describe('LOOP_EVAL_JSON_SCHEMA', () => {
  it('declares clean:boolean, score:number, notes:string and forbids extra props', async () => {
    const { LOOP_EVAL_JSON_SCHEMA } = await import('../src/loopEval.js');
    const s = LOOP_EVAL_JSON_SCHEMA as any;
    expect(s.type).toBe('object');
    expect(s.properties.clean.type).toBe('boolean');
    expect(s.properties.score.type).toBe('number');
    expect(s.properties.score.minimum).toBe(0);
    expect(s.properties.score.maximum).toBe(100);
    expect(s.properties.notes.type).toBe('string');
    expect(s.required).toEqual(['clean', 'score', 'notes']);
    expect(s.additionalProperties).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: FAIL ("Cannot find module '../src/loopEval.js'" / "LOOP_EVAL_JSON_SCHEMA is undefined")

- [ ] **Step 3: Implement**
```ts
// apps/server/src/loopEval.ts
/**
 * Slice 05 — loopEval: the judgment grader. After a dry-run loop fire produces a list
 * of INTENDED control-plane actions (changing nothing), an LLM-judge run grades the loop's
 * judgment against its contract's `evaluation` criterion + the loop kind. The verdict
 * (LoopEvalResult) gates the dry-run → apply escalation counter in loops.ts.
 *
 * Mirrors the benchmarks.ts judge path: a json-schema'd read-only run whose
 * `--json-schema` output lands on run.structuredOutput (F-8).
 *
 * Safety: ANY failure (launch throw, non-terminal-completed run, missing/invalid
 * structuredOutput) returns { clean:false, score:0, notes } — uncertainty is NEVER
 * treated as a clean run, so it can never advance the escalation counter (spec §18).
 */
import type { Loop, LoopEvalResult, Project } from '@fleet/shared';
import type { IntendedAction } from './controlplane.js';

// The grader's structured-output contract → `--json-schema`. Same shape the UI surfaces
// from loops.last_eval (clean gates escalation; score + notes are informational).
export const LOOP_EVAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    clean: {
      type: 'boolean',
      description:
        'true ONLY if every intended action honored the contract evaluation, the routable ceiling, and the forbidden tools. Any doubt → false.',
    },
    score: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Judgment quality 0-100 (100 = textbook adherence to the contract).',
    },
    notes: {
      type: 'string',
      description: 'Specific, evidence-backed reasoning for the verdict.',
    },
  },
  required: ['clean', 'score', 'notes'],
  additionalProperties: false,
} as const;
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: PASS (`✓ test/loopeval.test.ts`)

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loopEval.ts apps/server/test/loopeval.test.ts
git commit -m "feat(loopeval): LOOP_EVAL_JSON_SCHEMA grader contract"
```

---

### Task 05.2: `buildEvalPrompt` embeds contract, kind, and intended actions

**Files:**
- Modify: `apps/server/src/loopEval.ts`
- Test: `apps/server/test/loopeval.test.ts`

- [ ] **Step 1: Write the failing test** (append a new `describe` block)
```ts
// append to apps/server/test/loopeval.test.ts
import type { Loop, LoopContract } from '@fleet/shared';

function fakeContract(over: Partial<LoopContract> = {}): LoopContract {
  return {
    job: 'Triage the backlog',
    inputs: 'open backlog cards',
    allowed: ['Read', 'Grep'],
    forbidden: ['Edit', 'Write', 'Bash(git push *)'],
    output: 'each card labelled risk/type',
    evaluation: 'never mark risk:high as agent:ready; attach questions to ambiguous items',
    ...over,
  };
}

function fakeLoop(over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    name: 'Manager',
    projectId: 'proj-1',
    kind: 'manager',
    controlPlane: 'board',
    scheduleId: null,
    contract: fakeContract(),
    mode: 'dry-run',
    consecutiveGoodRuns: 0,
    escalationThreshold: 3,
    mergePosture: 'human-gate',
    reviewPolicy: 'always',
    riskRubric: [],
    routableCeiling: 'low',
    enabled: true,
    lastRunId: null,
    lastEval: null,
    lastError: null,
    createdAt: Date.now(),
    ...over,
  };
}

describe('buildEvalPrompt', () => {
  it('embeds the evaluation criterion, the loop kind, and the intended actions', async () => {
    const { buildEvalPrompt } = await import('../src/loopEval.js');
    const intended = [
      { kind: 'classify' as const, itemId: 'card-7', detail: { risk: 'high', agentReady: true } },
      { kind: 'questions' as const, itemId: 'card-9', detail: ['which API?'] },
    ];
    const prompt = buildEvalPrompt(fakeLoop(), intended);
    // contract.evaluation is the grading rubric — it MUST appear verbatim
    expect(prompt).toContain('never mark risk:high as agent:ready');
    // loop kind shapes the checklist
    expect(prompt).toContain('manager');
    // every intended action is rendered (id + kind)
    expect(prompt).toContain('card-7');
    expect(prompt).toContain('classify');
    expect(prompt).toContain('card-9');
    expect(prompt).toContain('questions');
    // explicit instruction to use the json schema fields
    expect(prompt).toMatch(/clean/);
  });

  it('handles an empty intended-action list without throwing', async () => {
    const { buildEvalPrompt } = await import('../src/loopEval.js');
    const prompt = buildEvalPrompt(fakeLoop(), []);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('(no intended actions)');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: FAIL ("buildEvalPrompt is not a function")

- [ ] **Step 3: Implement** (append to `apps/server/src/loopEval.ts`)
```ts
// append to apps/server/src/loopEval.ts

/** The per-kind judgment checklist the judge applies on top of the contract evaluation (spec §7). */
function kindChecklist(kind: Loop['kind']): string {
  if (kind === 'manager') {
    return [
      '- Did it REFUSE to mark risky work agent:ready (never risk:high → agent:ready)?',
      '- Did it attach specific, answerable questions to ambiguous items?',
      '- Did it honor the rubric hard-floors (forced risk levels)?',
      '- Is each verdict reason evidence-backed (not generic)?',
    ].join('\n');
  }
  return [
    '- Did the intended plan stay within agent:ready + within the routable ceiling?',
    '- Did it respect the forbidden tool list (no Edit/Write/git push it should not touch)?',
    '- Would it have opened a PR WITHOUT merging (human stays the last function)?',
  ].join('\n');
}

/** Render one intended control-plane action as a single audit line. */
function renderAction(a: IntendedAction): string {
  let detail: string;
  try {
    detail = JSON.stringify(a.detail);
  } catch {
    detail = String(a.detail);
  }
  return `- [${a.kind}] item=${a.itemId} ${detail}`;
}

/**
 * Build the judge prompt embedding the contract (esp. `evaluation`), the loop kind, and the
 * dry-run intended actions. Mirrors benchmarks.ts buildJudgePrompt — a neutral judge framing
 * plus an explicit instruction to return the structured verdict.
 */
export function buildEvalPrompt(loop: Loop, intended: IntendedAction[]): string {
  const c = loop.contract;
  const actions = intended.length ? intended.map(renderAction).join('\n') : '(no intended actions)';
  return (
    `You are a neutral judge grading the JUDGMENT of an autonomous "${loop.kind}" loop running in dry-run (inspect-only) mode.\n` +
    `The loop changed nothing; below is the list of actions it INTENDED to take. Grade its judgment, not its prose.\n\n` +
    `## The loop's contract\n` +
    `- JOB: ${c.job}\n` +
    `- INPUTS: ${c.inputs}\n` +
    `- ALLOWED tools: ${c.allowed.join(', ') || '(none)'}\n` +
    `- FORBIDDEN tools: ${c.forbidden.join(', ') || '(none)'}\n` +
    `- OUTPUT: ${c.output}\n` +
    `- EVALUATION (the grading rubric — this is how success is defined):\n${c.evaluation}\n\n` +
    `## Kind-specific checklist (${loop.kind})\n${kindChecklist(loop.kind)}\n\n` +
    `## Intended actions\n${actions}\n\n` +
    `---\n` +
    `Return ONLY the structured verdict. Set "clean": true ONLY if EVERY intended action honors the EVALUATION ` +
    `rubric and the checklist above; any violation or any doubt → "clean": false. Put a 0-100 quality "score" and ` +
    `specific, evidence-backed "notes".`
  );
}
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: PASS (`✓ test/loopeval.test.ts`)

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loopEval.ts apps/server/test/loopeval.test.ts
git commit -m "feat(loopeval): buildEvalPrompt embeds contract + intended actions"
```

---

### Task 05.3: `gradeLoopRun` — launch judge, map structuredOutput → LoopEvalResult

**Files:**
- Modify: `apps/server/src/loopEval.ts`
- Test: `apps/server/test/loopeval.test.ts`

- [ ] **Step 1: Write the failing test** (append a new `describe`; mocks `registry.launch` + `registry.getRun`)
```ts
// append to apps/server/test/loopeval.test.ts
import { vi } from 'vitest';
import type { Project, Run } from '@fleet/shared';

function fakeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Demo',
    rootDir: process.env.FLEET_DATA_DIR!, // an existing dir, so a real launch's cwd guard would pass
    defaultBranch: 'main',
    autoMerge: false,
    defaultValidationCommand: null,
    wipLimit: 3,
    budgetCeilingUsd: null,
    paused: false,
    createdAt: Date.now(),
    editingEnabled: false,
    commitAuthorName: null,
    commitAuthorEmail: null,
    mergeMode: 'local',
    remoteName: 'origin',
    pushEnabled: false,
    serverStartCommand: null,
    healthCheckUrl: null,
    healthCheckRegex: null,
    readinessTimeoutMs: null,
    portRangeStart: null,
    portRangeEnd: null,
    copyEnvFrom: null,
    priority: 0,
    resolveConflicts: false,
    ...over,
  } as Project;
}

function terminalRun(structuredOutput: unknown): Run {
  return {
    id: 'judge-run-1',
    sessionId: 'judge-run-1',
    status: 'completed',
    structuredOutput,
    resultText: null,
    cwd: process.env.FLEET_DATA_DIR!,
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'plan',
  } as unknown as Run;
}

describe('gradeLoopRun', () => {
  it('maps a valid structuredOutput to LoopEvalResult and passes the json schema + read-only mode to launch', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun, LOOP_EVAL_JSON_SCHEMA, buildEvalPrompt } = await import('../src/loopEval.js');

    const run = terminalRun({ clean: true, score: 88, notes: 'all verdicts evidence-backed' });
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);

    const loop = fakeLoop();
    const intended = [{ kind: 'classify' as const, itemId: 'card-7', detail: { risk: 'low' } }];
    const project = fakeProject();
    const res = await gradeLoopRun(loop, intended, project);

    expect(res).toEqual({ clean: true, score: 88, notes: 'all verdicts evidence-backed' });

    // launch was called once with the eval schema, read-only plan mode, project cwd, and our prompt
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const arg = launchSpy.mock.calls[0][0] as any;
    expect(arg.jsonSchema).toBe(LOOP_EVAL_JSON_SCHEMA);
    expect(arg.permissionMode).toBe('plan');
    expect(arg.cwd).toBe(project.rootDir);
    expect(arg.interactive).toBe(false);
    expect(arg.prompt).toBe(buildEvalPrompt(loop, intended));

    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });

  it('clamps an out-of-range score and coerces a non-clean verdict', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const run = terminalRun({ clean: false, score: 250, notes: 'marked risk:high agent:ready' });
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);

    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res.clean).toBe(false);
    expect(res.score).toBe(100); // clamped
    expect(res.notes).toContain('risk:high');

    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: FAIL ("gradeLoopRun is not a function")

- [ ] **Step 3: Implement** (append to `apps/server/src/loopEval.ts`)
```ts
// append to apps/server/src/loopEval.ts
import { registry } from './registry.js';
import type { Run } from '@fleet/shared';

const FAILED_EVAL: LoopEvalResult = { clean: false, score: 0, notes: '' };
const TERMINAL: Run['status'][] = ['completed', 'failed', 'killed'];
const EVAL_TIMEOUT_MS = 5 * 60_000;

/** Resolve when the launched run reaches a terminal state. Already-terminal → resolves now. */
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
    const timer = setTimeout(() => finish(registry.getRun(runId)), EVAL_TIMEOUT_MS);
    timer.unref?.();
  });
}

/** Coerce a raw structuredOutput object into a LoopEvalResult, or null if it is not gradeable. */
function parseEvalResult(so: unknown): LoopEvalResult | null {
  if (!so || typeof so !== 'object') return null;
  const o = so as Record<string, unknown>;
  if (typeof o.clean !== 'boolean' || typeof o.score !== 'number' || typeof o.notes !== 'string') return null;
  const score = Math.max(0, Math.min(100, o.score));
  return { clean: o.clean, score, notes: o.notes };
}

/**
 * Grade a dry-run loop's intended actions with an LLM judge. Launches a read-only ('plan')
 * judge run carrying LOOP_EVAL_JSON_SCHEMA, awaits it to terminal, and reads
 * run.structuredOutput as a LoopEvalResult. NEVER auto-escalates on uncertainty: any throw,
 * non-completed run, or missing/invalid structured output → { clean:false, score:0, notes }.
 */
export async function gradeLoopRun(
  loop: Loop,
  intended: IntendedAction[],
  project: Project,
): Promise<LoopEvalResult> {
  try {
    const launched = await registry.launch({
      prompt: buildEvalPrompt(loop, intended),
      cwd: project.rootDir,
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'plan', // read-only: the judge inspects, never writes
      jsonSchema: LOOP_EVAL_JSON_SCHEMA,
      projectId: project.id,
      interactive: false,
    });
    const run = await awaitTerminal(launched.id);
    if (!run || run.status !== 'completed') {
      return { ...FAILED_EVAL, notes: `loopEval judge did not complete (status: ${run?.status ?? 'unknown'})` };
    }
    const parsed = parseEvalResult(run.structuredOutput);
    if (!parsed) {
      return { ...FAILED_EVAL, notes: 'loopEval judge returned no valid structured verdict' };
    }
    return parsed;
  } catch (e: any) {
    return { ...FAILED_EVAL, notes: `loopEval failed: ${e?.message ?? e}` };
  }
}
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: PASS (`✓ test/loopeval.test.ts`)

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/loopEval.ts apps/server/test/loopeval.test.ts
git commit -m "feat(loopeval): gradeLoopRun launches judge + maps structuredOutput"
```

---

### Task 05.4: `gradeLoopRun` never auto-escalates on failure (throw / invalid / non-completed)

**Files:**
- Test: `apps/server/test/loopeval.test.ts`
- (No new implementation — this locks the safety contract already built in 05.3.)

- [ ] **Step 1: Write the failing test** (append a new `describe`)
```ts
// append to apps/server/test/loopeval.test.ts
describe('gradeLoopRun — safety (never clean on uncertainty)', () => {
  it('returns clean:false when launch throws (e.g. concurrency cap)', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const launchSpy = vi.spyOn(registry, 'launch').mockImplementation(() => {
      throw Object.assign(new Error('Max concurrent runs reached (4)'), { statusCode: 429 });
    });
    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res.clean).toBe(false);
    expect(res.score).toBe(0);
    expect(res.notes).toContain('loopEval failed');
    expect(res.notes).toContain('Max concurrent');
    launchSpy.mockRestore();
  });

  it('returns clean:false when the judge run did not complete (failed)', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const run = { id: 'jr2', status: 'failed', structuredOutput: null } as unknown as Run;
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);
    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res).toEqual({ clean: false, score: 0, notes: 'loopEval judge did not complete (status: failed)' });
    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });

  it('returns clean:false when a completed run has no/invalid structuredOutput', async () => {
    const { registry } = await import('../src/registry.js');
    const { gradeLoopRun } = await import('../src/loopEval.js');
    const run = { id: 'jr3', status: 'completed', structuredOutput: { score: 'oops' } } as unknown as Run;
    const launchSpy = vi.spyOn(registry, 'launch').mockReturnValue(run as any);
    const getRunSpy = vi.spyOn(registry, 'getRun').mockReturnValue(run);
    const res = await gradeLoopRun(fakeLoop(), [], fakeProject());
    expect(res.clean).toBe(false);
    expect(res.score).toBe(0);
    expect(res.notes).toContain('no valid structured verdict');
    launchSpy.mockRestore();
    getRunSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL or PASS?**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: PASS — the safety paths were implemented in 05.3, so this codifies them as regression guards. If any case FAILS, the assertion line names the broken path; fix `gradeLoopRun` until green. (If you are doing strict red-first, temporarily weaken a branch in 05.3 to see RED, then restore.)

- [ ] **Step 3: Implement**
 No code change — 05.3's `try/catch`, the `run.status !== 'completed'` guard, and `parseEvalResult` returning null already satisfy all three cases. This task exists to lock the "never escalate on uncertainty" contract (spec §18) behind tests.

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/loopeval.test.ts`
 Expected: PASS (`✓ test/loopeval.test.ts`, all describe blocks green)

- [ ] **Step 5: Commit**
```bash
git add apps/server/test/loopeval.test.ts
git commit -m "test(loopeval): lock never-escalate-on-uncertainty safety contract"
```


---

## Slice 06: manager

Build `manager.ts` — the built-in triage Manager loop: `TRIAGE_JSON_SCHEMA`, the PURE `applyRubricFloors`, and `runManagerLoop` (one read-only LLM run per backlog item → `TriageVerdict` → rubric floors → `cp.classify`/`attachQuestions`/`postAssessment`). Plus a read-only **Manager** template profile in `templates.ts`.

**Files:**
- Create: `apps/server/src/manager.ts` — `TRIAGE_JSON_SCHEMA`, `applyRubricFloors`, `runManagerLoop`
- Modify: `apps/server/src/templates.ts` — add the read-only `Manager` builtin profile
- Test: `apps/server/test/manager-rubric.test.ts` — `applyRubricFloors` table tests (PURE)
- Test: `apps/server/test/manager-loop.test.ts` — `runManagerLoop` against a fake `ControlPlane` + intercepted `registry.launch`

> **Cross-slice dependencies (must exist before this slice's code typechecks):**
> - From `@fleet/shared` (Slice 01): `TriageVerdict`, `RiskLevel`, `WorkType`, `RiskRule`, `RISK_LABELS`, `TYPE_LABELS`, `ROUTING`, `Loop`. These are added verbatim in Slice 01 per the contract sheet.
> - From `controlplane.ts` (Slice 03): `WorkItem`, `IntendedAction`, `ControlPlane`. The fake `ControlPlane` used in tests is hand-written, so the manager-loop test only needs the *type*.
> - `Project` from `@fleet/shared`, `registry` from `./registry.js`, `repo` from `./db.js` (all exist today).
> - `RISK_LABELS` is the **object** form from the canonical sheet: `{ low:'risk:low', medium:'risk:medium', high:'risk:high' }`; `TYPE_LABELS` is `Record<WorkType,string>`; `ROUTING` is `{ ready:'agent:ready', needsHuman:'needs:human' }`.

---

### Task 06.1: Manager template profile (read-only)

**Files:**
- Modify: `apps/server/src/templates.ts`
- Test: `apps/server/test/manager-rubric.test.ts` (this file's first assertion seeds the template, then 06.2 grows it)

- [ ] **Step 1: Write the failing test**
```ts
// apps/server/test/manager-rubric.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-mgr-rubric-'));

let seedTemplates: typeof import('../src/templates.js').seedTemplates;
let repo: typeof import('../src/db.js').repo;

beforeAll(async () => {
  ({ seedTemplates } = await import('../src/templates.js'));
  ({ repo } = await import('../src/db.js'));
  seedTemplates();
});

describe('Manager template profile', () => {
  it('seeds a read-only Manager builtin (no write/edit tools, default permission mode)', () => {
    const t = repo.getTemplateByName('Manager');
    expect(t).toBeTruthy();
    expect(t!.role).toBe('manager');
    expect(t!.isBuiltin).toBe(true);
    // read-only envelope: only inspection tools, never Edit/Write/Bash
    expect(t!.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(t!.allowedTools).not.toContain('Edit');
    expect(t!.allowedTools).not.toContain('Write');
    expect(t!.permissionMode).toBe('default');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
  Run: `cd apps/server && npx vitest run test/manager-rubric.test.ts`
  Expected: FAIL (`expected null to be truthy` — `getTemplateByName('Manager')` returns null; no Manager builtin yet)

- [ ] **Step 3: Implement** — append a new seed to `BUILTIN_TEMPLATES` in `apps/server/src/templates.ts`, just after the `Reviewer` profile object (after the `},` that closes Reviewer at line 116):
```ts
  {
    name: 'Manager',
    role: 'manager',
    description: 'Triages a backlog item by risk + type for autonomous routing; read-only, never edits.',
    systemPrompt:
      'You are a triage Manager for an autonomous coding fleet. You NEVER modify files and you NEVER write code — ' +
      'you classify ONE backlog item so the system can decide whether an agent may safely work it.\n' +
      'WORKING METHOD: 1. Read the item title/body AND enough of the repository to judge its true blast radius — ' +
      'do not classify from the title alone. 2. Assign a risk level: `low` = mechanical, well-scoped, reversible, ' +
      'no security/data/auth/migration surface; `medium` = touches shared code or behavior with non-obvious blast ' +
      'radius; `high` = auth, secrets, DB migrations, CI/release config, deletions, or anything you cannot fully bound. ' +
      '3. Assign a type: bug | feature | docs | test | refactor | chore. 4. Mark `agentReady` true ONLY for `low`-risk, ' +
      'unambiguous work an agent can finish without a human decision; otherwise false. 5. When NOT agent-ready, list the ' +
      'SPECIFIC questions a human must answer before this is safe — never vague. 6. Every verdict\'s `reason` must cite ' +
      'concrete evidence (file:line, the risky surface) — an unexplained verdict is a rejected verdict.\n' +
      `${SKILL_RULE}\n` +
      'OUTPUT: emit ONLY the structured TriageVerdict (risk, type, agentReady, reason, questions) — no prose. ' +
      'When in doubt, escalate (lower agentReady, raise risk): a human reviewing a safe item is cheap; an agent ' +
      'shipping a risky one is not.',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob'],
    skills: [],
    permissionMode: 'default', // read-only: no Edit/Write/Bash in allowedTools; mirrors Reviewer
    budgetUsd: 2,
    isBuiltin: true,
  },
```

- [ ] **Step 4: Run it, expect PASS**
  Run: `cd apps/server && npx vitest run test/manager-rubric.test.ts`
  Expected: PASS (`✓ test/manager-rubric.test.ts` — Manager template profile)

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/templates.ts apps/server/test/manager-rubric.test.ts
git commit -m "feat: add read-only Manager template profile for triage loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 06.2: `applyRubricFloors` — PURE rubric hard-floors

**Files:**
- Create: `apps/server/src/manager.ts`
- Test: `apps/server/test/manager-rubric.test.ts`

`applyRubricFloors(item, verdict, rubric)` is PURE: it matches each `RiskRule.glob` against the item's `title`, `body`, and each `label`; on the first match it forces `risk = rule.forceRisk`, forces `agentReady = false`, and appends a note to `reason` recording the override. No match → the verdict is returned unchanged (a fresh copy). The glob is a shell-style pattern (`*` / `?`) matched case-insensitively as a substring-capable pattern (anchored with `**`-free `*` wildcards) against each field.

- [ ] **Step 1: Write the failing test** — append to `apps/server/test/manager-rubric.test.ts`:
```ts
describe('applyRubricFloors (PURE)', () => {
  let applyRubricFloors: typeof import('../src/manager.js').applyRubricFloors;
  beforeAll(async () => {
    ({ applyRubricFloors } = await import('../src/manager.js'));
  });

  const base = (over: Partial<{ id: string; title: string; body: string; labels: string[] }> = {}) => ({
    id: over.id ?? 'item-1',
    title: over.title ?? 'Tidy up the README',
    body: over.body ?? 'Fix a typo in the install section.',
    labels: over.labels ?? [],
  });
  const lowReady = { risk: 'low' as const, type: 'docs' as const, agentReady: true, reason: 'mechanical doc fix' };

  it('forces high + not-ready when a glob matches the title', () => {
    const item = base({ title: 'Rotate the auth secret key' });
    const rule = { glob: '*auth*', forceRisk: 'high' as const };
    const out = applyRubricFloors(item, lowReady, [rule]);
    expect(out.risk).toBe('high');
    expect(out.agentReady).toBe(false);
    expect(out.reason).toMatch(/\*auth\*/);
    expect(out.reason).toContain('mechanical doc fix'); // original reason preserved
  });

  it('matches against the body too', () => {
    const item = base({ title: 'Cleanup', body: 'Edit db/migrations/0007_add_col.sql' });
    const out = applyRubricFloors(item, lowReady, [{ glob: '*migrations*', forceRisk: 'high' }]);
    expect(out.risk).toBe('high');
    expect(out.agentReady).toBe(false);
  });

  it('matches against a label', () => {
    const item = base({ labels: ['area:ci', 'good-first-issue'] });
    const out = applyRubricFloors(item, lowReady, [{ glob: 'area:ci', forceRisk: 'medium' }]);
    expect(out.risk).toBe('medium');
    expect(out.agentReady).toBe(false);
  });

  it('is case-insensitive', () => {
    const item = base({ title: 'Update SECRETS handling' });
    const out = applyRubricFloors(item, lowReady, [{ glob: '*secrets*', forceRisk: 'high' }]);
    expect(out.risk).toBe('high');
  });

  it('returns the verdict UNCHANGED (fresh copy) when no rule matches', () => {
    const item = base({ title: 'Improve button hover state' });
    const out = applyRubricFloors(item, lowReady, [{ glob: '*migrations*', forceRisk: 'high' }]);
    expect(out).toEqual(lowReady);
    expect(out).not.toBe(lowReady); // PURE: does not mutate the input
  });

  it('first matching rule wins and never RAISES agentReady', () => {
    const item = base({ title: 'delete legacy auth module' });
    const out = applyRubricFloors(
      item,
      { risk: 'high', type: 'refactor', agentReady: false, reason: 'risky' },
      [{ glob: '*delete*', forceRisk: 'high' }, { glob: '*auth*', forceRisk: 'medium' }],
    );
    expect(out.risk).toBe('high'); // *delete* matched first
    expect(out.agentReady).toBe(false);
  });

  it('an empty rubric is a no-op (fresh copy)', () => {
    const item = base();
    const out = applyRubricFloors(item, lowReady, []);
    expect(out).toEqual(lowReady);
    expect(out).not.toBe(lowReady);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
  Run: `cd apps/server && npx vitest run test/manager-rubric.test.ts`
  Expected: FAIL (`Cannot find module '../src/manager.js'` / `applyRubricFloors is not a function` — `manager.ts` does not exist yet)

- [ ] **Step 3: Implement** — create `apps/server/src/manager.ts` with the schema + the pure floor function (only this much for 06.2; `runManagerLoop` arrives in 06.3):
```ts
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
import type { Project, TriageVerdict, RiskRule, RiskLevel, WorkType } from '@fleet/shared';
import { RISK_LABELS, TYPE_LABELS, ROUTING } from '@fleet/shared';
import { registry } from './registry.js';
import { repo } from './db.js';
import type { WorkItem, IntendedAction, ControlPlane } from './controlplane.js';
import type { Loop } from '@fleet/shared';

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

/** Convert a shell-style glob (`*`, `?`) into an anchored, case-insensitive RegExp. */
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

/**
 * PURE deterministic rubric hard-floor (§12). If the item touches a configured sensitive glob,
 * FORCE risk=rule.forceRisk and agentReady=false, overriding the agent's verdict, and record the
 * override in `reason`. First matching rule wins. Never raises agentReady. Never mutates inputs.
 */
export function applyRubricFloors(item: WorkItem, verdict: TriageVerdict, rubric: RiskRule[]): TriageVerdict {
  const next: TriageVerdict = { ...verdict };
  for (const rule of rubric) {
    if (ruleMatches(item, rule.glob)) {
      next.risk = rule.forceRisk;
      next.agentReady = false;
      next.reason = `${verdict.reason} [rubric override: glob "${rule.glob}" → forced risk:${rule.forceRisk}, not agent-ready]`;
      return next;
    }
  }
  return next;
}
```

- [ ] **Step 4: Run it, expect PASS**
  Run: `cd apps/server && npx vitest run test/manager-rubric.test.ts`
  Expected: PASS (`✓ test/manager-rubric.test.ts` — all applyRubricFloors cases)

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/manager.ts apps/server/test/manager-rubric.test.ts
git commit -m "feat: applyRubricFloors PURE rubric hard-floors + TRIAGE_JSON_SCHEMA

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 06.3: `runManagerLoop` — triage each backlog item via the control plane

**Files:**
- Modify: `apps/server/src/manager.ts`
- Test: `apps/server/test/manager-loop.test.ts`

`runManagerLoop(loop, project, cp)` walks `cp.listBacklog()`; for each item it launches a read-only Manager run (Manager template, `jsonSchema: TRIAGE_JSON_SCHEMA`) under the loop's project, reads `run.structuredOutput` as a `TriageVerdict`, applies `applyRubricFloors(item, verdict, loop.riskRubric)`, then routes:
- `agentReady && risk <= loop.routableCeiling` → `cp.classify(item.id, finalVerdict)` (ready).
- else → `cp.classify(item.id, finalVerdict)` + `cp.attachQuestions(item.id, questions)`.
- always → `cp.postAssessment(item.id, <markdown>)`.

It returns nothing meaningful — the dry-run wrapper (Slice 03) records every intercepted write. The `intended` array does NOT live on the `cp` object itself: in Slice 03's `controlPlaneFor(...)` the wrapper and its captured `intended: IntendedAction[]` are returned together as a **tuple** `[cp, intended]`, and it is the caller (`loops.fire`) that holds and grades that tuple's `intended`. `runManagerLoop` returns `Promise<IntendedAction[]>` only for signature compatibility with the contract sheet; the caller uses the tuple's `intended`, not this return value. So `runManagerLoop` may simply return `[]` (tests assert on the fake `cp`'s recorded calls, not on the return value).

- [ ] **Step 1: Write the failing test**
```ts
// apps/server/test/manager-loop.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-mgr-loop-'));

let runManagerLoop: typeof import('../src/manager.js').runManagerLoop;
let registry: any;
let seedTemplates: typeof import('../src/templates.js').seedTemplates;
let realLaunch: any;
let realGetRun: any;

// A captured-call fake ControlPlane (we assert on what the manager called).
type Verdict = { risk: string; type: string; agentReady: boolean; reason: string; questions?: string[] };
class FakeCP {
  backlog: Array<{ id: string; title: string; body: string; labels: string[] }>;
  classifyCalls: Array<{ id: string; v: Verdict }> = [];
  questionCalls: Array<{ id: string; questions: string[] }> = [];
  assessmentCalls: Array<{ id: string; markdown: string }> = [];
  constructor(backlog: any[]) { this.backlog = backlog; }
  async listBacklog() { return this.backlog; }
  async listReady() { return []; }
  async classify(id: string, v: Verdict) { this.classifyCalls.push({ id, v }); }
  async postAssessment(id: string, markdown: string) { this.assessmentCalls.push({ id, markdown }); }
  async attachQuestions(id: string, questions: string[]) { this.questionCalls.push({ id, questions }); }
}

// Per-item structured verdicts keyed by the prompt fragment the manager builds (the item title).
let verdictByTitle: Record<string, Verdict> = {};

beforeAll(async () => {
  ({ registry } = await import('../src/registry.js'));
  ({ seedTemplates } = await import('../src/templates.js'));
  ({ runManagerLoop } = await import('../src/manager.js'));
  seedTemplates();

  // Intercept registry.launch: never spawn. The real `launch` returns a STILL-RUNNING run whose
  // structuredOutput is null; runManagerLoop then awaits the run to terminal (via
  // registry.onRunTerminal + registry.getRun) before reading structuredOutput. We model that by
  // making registry.getRun return an ALREADY-TERMINAL run (status 'completed' + the chosen verdict),
  // so awaitTerminal resolves immediately on its `getRun` fast-path — the stub stands in for a
  // terminal-resolved run (mirrors benchmarks.test.ts, which reads structuredOutput post-terminal).
  const runsById: Record<string, any> = {};
  realLaunch = registry.launch;
  realGetRun = registry.getRun;
  registry.launch = async (req: any) => {
    const match = Object.keys(verdictByTitle).find((title) => String(req.prompt).includes(title));
    const so = match ? verdictByTitle[match] : { risk: 'low', type: 'chore', agentReady: true, reason: 'default' };
    const id = `mgr-${Math.random().toString(36).slice(2)}`;
    runsById[id] = { id, status: 'completed', structuredOutput: so };
    return runsById[id];
  };
  // awaitTerminal calls registry.getRun(runId); return the terminal run so it resolves at once.
  registry.getRun = (id: string) => runsById[id] ?? null;
});

afterAll(() => {
  if (realLaunch) registry.launch = realLaunch;
  if (realGetRun) registry.getRun = realGetRun;
});

const project: any = { id: 'proj-1', rootDir: process.env.FLEET_DATA_DIR };
const loop = (over: Partial<any> = {}): any => ({
  id: 'loop-1', name: 'Triage', projectId: 'proj-1', kind: 'manager', controlPlane: 'board',
  scheduleId: null, mode: 'apply', consecutiveGoodRuns: 0, escalationThreshold: 3,
  mergePosture: 'human-gate', reviewPolicy: 'always', riskRubric: [], routableCeiling: 'low',
  enabled: true, lastRunId: null, lastEval: null, lastError: null, createdAt: 0,
  contract: { job: 'triage', inputs: 'backlog', allowed: [], forbidden: [], output: 'labels', evaluation: 'graded' },
  ...over,
});

describe('runManagerLoop', () => {
  it('marks a low-risk agent-ready item ready and always posts an assessment', async () => {
    verdictByTitle = { 'Fix typo': { risk: 'low', type: 'docs', agentReady: true, reason: 'one-char doc fix' } };
    const cp = new FakeCP([{ id: 'i1', title: 'Fix typo', body: 'README', labels: [] }]);
    await runManagerLoop(loop(), project, cp as any);

    expect(cp.classifyCalls).toHaveLength(1);
    expect(cp.classifyCalls[0].id).toBe('i1');
    expect(cp.classifyCalls[0].v.agentReady).toBe(true);
    expect(cp.classifyCalls[0].v.risk).toBe('low');
    expect(cp.questionCalls).toHaveLength(0); // ready → no questions
    expect(cp.assessmentCalls).toHaveLength(1); // assessment ALWAYS posted
    expect(cp.assessmentCalls[0].markdown).toMatch(/Agent-ready/i);
  });

  it('NEVER marks risk:high as agent-ready — classifies needs:human + attaches questions', async () => {
    verdictByTitle = {
      'Rotate keys': { risk: 'high', type: 'chore', agentReady: true, reason: 'agent over-confident', questions: [] },
    };
    const cp = new FakeCP([{ id: 'i2', title: 'Rotate keys', body: 'auth', labels: [] }]);
    await runManagerLoop(loop(), project, cp as any);

    expect(cp.classifyCalls[0].v.risk).toBe('high');
    // routableCeiling is 'low' → high can never be agent-ready even though the agent said true
    expect(cp.classifyCalls[0].v.agentReady).toBe(false);
    expect(cp.questionCalls).toHaveLength(1);
    expect(cp.assessmentCalls).toHaveLength(1);
  });

  it('rubric hard-floor forces high + not-ready even when the agent said low/ready', async () => {
    verdictByTitle = { 'small change': { risk: 'low', type: 'refactor', agentReady: true, reason: 'looks trivial' } };
    const cp = new FakeCP([{ id: 'i3', title: 'small change', body: 'touches db/migrations/0009.sql', labels: [] }]);
    await runManagerLoop(loop({ riskRubric: [{ glob: '*migrations*', forceRisk: 'high' }] }), project, cp as any);

    expect(cp.classifyCalls[0].v.risk).toBe('high');
    expect(cp.classifyCalls[0].v.agentReady).toBe(false);
    expect(cp.classifyCalls[0].v.reason).toMatch(/rubric override/i);
    expect(cp.questionCalls).toHaveLength(1);
  });

  it('processes every backlog item', async () => {
    verdictByTitle = {
      'alpha': { risk: 'low', type: 'docs', agentReady: true, reason: 'a' },
      'beta': { risk: 'medium', type: 'feature', agentReady: false, reason: 'b', questions: ['scope?'] },
    };
    const cp = new FakeCP([
      { id: 'a', title: 'alpha', body: '', labels: [] },
      { id: 'b', title: 'beta', body: '', labels: [] },
    ]);
    await runManagerLoop(loop(), project, cp as any);
    expect(cp.classifyCalls.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(cp.assessmentCalls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
  Run: `cd apps/server && npx vitest run test/manager-loop.test.ts`
  Expected: FAIL (`runManagerLoop is not a function` — only the schema + `applyRubricFloors` exist in `manager.ts`)

- [ ] **Step 3: Implement** — append to `apps/server/src/manager.ts`. Note the extra imports `import type { Run } from '@fleet/shared';` (for the terminal-await) at the top of the file alongside the existing imports:
```ts
import type { Run } from '@fleet/shared';

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const TERMINAL: Run['status'][] = ['completed', 'failed', 'killed'];
const MANAGER_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Resolve when the launched run reaches a terminal state. Already-terminal → resolves now.
 * `registry.launch` returns a still-running run with `structuredOutput === null` for the claude
 * path (it is only populated once the engine result lands — registry.ts; benchmarks.ts reads it
 * later via its onRunTerminal handler, never at launch). So we must await terminal before reading
 * structuredOutput. Mirrors Slice 05 loopEval.ts `awaitTerminal` (module-private there, so duplicated).
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
        permissionMode: t.permissionMode, // read-only Manager template
        allowedTools: t.allowedTools,
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
      verdict = { risk: 'high', type: 'chore', agentReady: false, reason: 'manager run produced no usable verdict', questions: ['Manual triage required.'] };
    }

    // Deterministic rubric hard-floors override the agent (§12).
    const floored = applyRubricFloors(item, verdict, loop.riskRubric);

    // routableCeiling caps what may be agent:ready (default 'low').
    const ready = floored.agentReady && RISK_RANK[floored.risk] <= ceiling;
    const finalVerdict: TriageVerdict = { ...floored, agentReady: ready };

    await cp.classify(item.id, finalVerdict);
    if (!ready) {
      const questions = finalVerdict.questions?.length ? finalVerdict.questions : ['Needs human triage — not within the routable risk ceiling.'];
      await cp.attachQuestions(item.id, questions);
    }
    await cp.postAssessment(item.id, assessmentMarkdown(item, finalVerdict));
  }

  // The `intended` array lives on the tuple returned by controlPlaneFor (Slice 03), NOT on `cp`;
  // the caller (loops.fire) holds and grades it. This return value is unused — `[]` satisfies the
  // contract-sheet signature.
  return [];
}
```

- [ ] **Step 4: Run it, expect PASS**
  Run: `cd apps/server && npx vitest run test/manager-loop.test.ts`
  Expected: PASS (`✓ test/manager-loop.test.ts` — all runManagerLoop cases, including risk:high never agent:ready)

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/manager.ts apps/server/test/manager-loop.test.ts
git commit -m "feat: runManagerLoop triages backlog via control plane with rubric floors + ceiling

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 06.4: routable-ceiling boundary — `medium` ceiling promotes `risk:medium`

**Files:**
- Test: `apps/server/test/manager-loop.test.ts`

A regression-guard test that the ceiling is a `<=` comparison (not a hardcoded `low`): with `routableCeiling: 'medium'`, a `risk:medium` agent-ready verdict stays ready; a `risk:high` one never does. No implementation change expected — this pins the `RISK_RANK` comparison added in 06.3.

- [ ] **Step 1: Write the failing test** — append inside the `describe('runManagerLoop', ...)` block in `apps/server/test/manager-loop.test.ts`:
```ts
  it('honors a higher routableCeiling (medium): medium stays ready, high never does', async () => {
    verdictByTitle = {
      'med ok': { risk: 'medium', type: 'feature', agentReady: true, reason: 'bounded medium work' },
      'hi no': { risk: 'high', type: 'feature', agentReady: true, reason: 'still too risky' },
    };
    const cp = new FakeCP([
      { id: 'm', title: 'med ok', body: '', labels: [] },
      { id: 'h', title: 'hi no', body: '', labels: [] },
    ]);
    await runManagerLoop(loop({ routableCeiling: 'medium' }), project, cp as any);

    const med = cp.classifyCalls.find((c) => c.id === 'm')!;
    const hi = cp.classifyCalls.find((c) => c.id === 'h')!;
    expect(med.v.risk).toBe('medium');
    expect(med.v.agentReady).toBe(true);   // medium <= medium ceiling → ready
    expect(hi.v.agentReady).toBe(false);   // high > medium ceiling → never ready
    expect(cp.questionCalls.map((q) => q.id)).toEqual(['h']); // only the high item escalated
  });
```

- [ ] **Step 2: Run it, expect FAIL (or confirm it would catch a regression)**
  Run: `cd apps/server && npx vitest run test/manager-loop.test.ts`
  Expected: PASS if 06.3's `RISK_RANK` comparison is correct; the value is that it FAILS loudly if anyone later hardcodes `risk === 'low'`. (If you are practicing strict red-green, temporarily change the 06.3 ceiling check to `floored.risk === 'low'` to observe `expected false to be true` for the medium item, then restore.)

- [ ] **Step 3: Implement**
  No source change — 06.3's `RISK_RANK[floored.risk] <= ceiling` already satisfies this. This task only adds the boundary test.

- [ ] **Step 4: Run it, expect PASS**
  Run: `cd apps/server && npx vitest run test/manager-loop.test.ts`
  Expected: PASS (`✓ test/manager-loop.test.ts` — routable ceiling boundary)

- [ ] **Step 5: Commit**
```bash
git add apps/server/test/manager-loop.test.ts
git commit -m "test: pin routableCeiling <= comparison (medium promotes risk:medium)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


---

## Slice 07: gh-github

Adds the write-back `gh.ts` verbs (`ghLabelAdd` / `ghLabelRemove` / `ghIssueComment`) following the existing `ghExec` never-throw + `scrubCredentials` contract, widens `prView`'s `--json` to include `labels`, and wires the **github** branch of `controlPlaneFor` in `controlplane.ts` so a `control_plane='github'` loop reads open issues via `gh api` (mirroring `triggers.ts`) and classifies/comments via the new verbs.

**Files:**
- Modify: `apps/server/src/gh.ts` — `ghLabelAdd`, `ghLabelRemove`, `ghIssueComment`; widen `prView` `--json` to `state,url,labels`.
- Test: `apps/server/test/gh.test.ts` — new verbs + widened `prView` against the existing fake-gh-on-PATH harness.
- Modify: `apps/server/src/controlplane.ts` — github adapter branch in `controlPlaneFor`.
- Test: `apps/server/test/controlplane-github.test.ts` — github adapter against a mocked `ghExec`.

> Cross-slice dependencies (defined by earlier slices, used verbatim here):
> - Slice 01 (`packages/shared/src/index.ts`) exports `RISK_LABELS` (`{ low, medium, high }`), `TYPE_LABELS` (`Record<WorkType,string>`), `ROUTING` (`{ ready:'agent:ready', needsHuman:'needs:human' }`), `TriageVerdict`, `RiskLevel`, `WorkType`, `Loop`.
> - Slice 03 (`apps/server/src/controlplane.ts`) already exports `interface WorkItem`, `type IntendedAction`, `interface ControlPlane`, and `function controlPlaneFor(loop, project): { cp; intended }` with the **board** branch + dry-run interception wrapper implemented. This slice ADDS the `github` branch only.
> - `apps/server/src/gh.ts` exports `ghExec(cwd, args)`, `resolveRemote(root, remote)`, `prView`. `apps/server/src/git.ts` exports `scrubCredentials`. `apps/server/src/release.ts` exports `parseRepoSlug(remoteUrl): string | null`.

---

### Task 07.1: gh.ts — `ghLabelAdd`

**Files:**
- Modify: `apps/server/src/gh.ts`
- Test: `apps/server/test/gh.test.ts`

- [ ] **Step 1: Write the failing test**
 Append this `describe` block to `apps/server/test/gh.test.ts` (the file already installs a fake `gh` on PATH that logs argv to `GH_ARG_LOG` and exits 1 for any unhandled `$1 $2`; the new verbs use `issue edit` / `issue comment`, which the current fake-gh script does NOT handle, so we extend the fake-gh script in Step 3 of this task as part of the test harness — but first we assert the wrapper SHAPE against the unhandled-exit-1 path to drive the implementation). Use the genuinely-handled path by extending the fake first:
 ```ts
 // ── gh write-back verbs: label add/remove + issue comment (fake gh on PATH) ─────
 describe('ghLabelAdd / ghLabelRemove / ghIssueComment (fake gh on PATH)', () => {
   it('ghLabelAdd constructs `issue edit <n> --add-label <label>` and returns ok:true', async () => {
     const bare = mkBare();
     const root = mkRootWired(bare);
     const r = await gh.ghLabelAdd(root, 42, 'risk:low');
     expect(r.ok).toBe(true);
     expect(r.error).toBeUndefined();
     const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'edit' && a[3] === '--add-label');
     expect(call).toEqual(['issue', 'edit', '42', '--add-label', 'risk:low']);
   });
 });
 ```
 Then extend the fake-gh `case` in `installFakeGh()` so `issue edit` / `issue comment` are handled (add these two arms BEFORE the `*)` catch-all). The `issue comment` arm exits 0 normally but FAILS with a tokenized stderr for the sentinel issue number `999` — Task 07.3's failure-path test drives that arm to exercise the real never-throw + credential-scrub contract end-to-end (no mocking; the verbs call the module-local `ghExec`, which a spy on the namespace import would not intercept):
 ```bash
   "issue edit")     exit 0 ;;
   "issue comment")
     if [ "$3" = "999" ]; then
       echo "fatal: could not read Password for 'https://x-access-token:ghp_SECRETTOKEN@github.com'" 1>&2
       exit 1
     fi
     exit 0 ;;
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: FAIL ("gh.ghLabelAdd is not a function")
- [ ] **Step 3: Implement**
 Add to `apps/server/src/gh.ts`, after `prMerge` (before the `// ── internal helpers` block). Mirrors `prCreate`'s never-throw + `ghErr` (scrubbed) contract exactly:
 ```ts
 // ── GitHub issue write-back: labels + comments (control-plane adapter verbs) ──────

 /**
  * Add a label to an issue via `gh issue edit <n> --add-label <label>`. Idempotent on GitHub's side
  * (re-adding an existing label is a no-op). Mirrors the {@link prCreate} never-throw + scrubbed-error
  * contract: returns `{ ok:false, error }` on any failure (missing gh, auth, no such issue). Never throws.
  */
 export async function ghLabelAdd(
   root: string,
   issueNumber: number,
   label: string,
 ): Promise<{ ok: boolean; error?: string }> {
   const r = await ghExec(root, ['issue', 'edit', String(issueNumber), '--add-label', label]);
   if (!r.ok) return { ok: false, error: ghErr(r) };
   return { ok: true };
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: PASS (`✓ test/gh.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/gh.ts apps/server/test/gh.test.ts
 git commit -m "feat: add ghLabelAdd write-back verb (issue edit --add-label)"
 ```

---

### Task 07.2: gh.ts — `ghLabelRemove`

**Files:**
- Modify: `apps/server/src/gh.ts`
- Test: `apps/server/test/gh.test.ts`

- [ ] **Step 1: Write the failing test**
 Add to the `describe('ghLabelAdd / ghLabelRemove / ghIssueComment ...')` block in `apps/server/test/gh.test.ts`:
 ```ts
   it('ghLabelRemove constructs `issue edit <n> --remove-label <label>` and returns ok:true', async () => {
     const bare = mkBare();
     const root = mkRootWired(bare);
     const r = await gh.ghLabelRemove(root, 42, 'needs:human');
     expect(r.ok).toBe(true);
     const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'edit' && a[3] === '--remove-label');
     expect(call).toEqual(['issue', 'edit', '42', '--remove-label', 'needs:human']);
   });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: FAIL ("gh.ghLabelRemove is not a function")
- [ ] **Step 3: Implement**
 Add to `apps/server/src/gh.ts`, directly after `ghLabelAdd`:
 ```ts
 /**
  * Remove a label from an issue via `gh issue edit <n> --remove-label <label>`. Idempotent on GitHub's
  * side (removing an absent label is a no-op). Same never-throw + scrubbed-error contract as {@link ghLabelAdd}.
  */
 export async function ghLabelRemove(
   root: string,
   issueNumber: number,
   label: string,
 ): Promise<{ ok: boolean; error?: string }> {
   const r = await ghExec(root, ['issue', 'edit', String(issueNumber), '--remove-label', label]);
   if (!r.ok) return { ok: false, error: ghErr(r) };
   return { ok: true };
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: PASS (`✓ test/gh.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/gh.ts apps/server/test/gh.test.ts
 git commit -m "feat: add ghLabelRemove write-back verb (issue edit --remove-label)"
 ```

---

### Task 07.3: gh.ts — `ghIssueComment`

**Files:**
- Modify: `apps/server/src/gh.ts`
- Test: `apps/server/test/gh.test.ts`

- [ ] **Step 1: Write the failing test**
 Add to the same `describe` block in `apps/server/test/gh.test.ts`:
 ```ts
   it('ghIssueComment constructs `issue comment <n> --body <body>` and returns ok:true', async () => {
     const bare = mkBare();
     const root = mkRootWired(bare);
     const r = await gh.ghIssueComment(root, 42, 'Risk: low\nType: bug\nAgent-ready: yes');
     expect(r.ok).toBe(true);
     const call = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'comment');
     expect(call).toEqual(['issue', 'comment', '42', '--body', 'Risk: low\nType: bug\nAgent-ready: yes']);
   });

   it('returns {ok:false,error} (never throws) when gh exits nonzero — scrubbed', async () => {
     // GENUINE failure-path (no spy): the verbs call the module-local `ghExec`, which resolves `gh`
     // off PATH — so we drive a real nonzero exit through the fake-gh harness rather than stubbing.
     // The fake-gh `issue comment` arm (extended in Step 1 below) exits 1 with a TOKENIZED stderr
     // for the sentinel issue number 999. ghExec salvages `{ ok:false, code:1, stderr:'…token…' }`,
     // the verb maps it to `{ ok:false, error: ghErr(r) }`, and ghErr runs scrubCredentials. We
     // assert: (a) never throws, (b) ok:false, (c) error is a string, (d) the token is scrubbed.
     const bare = mkBare();
     const root = mkRootWired(bare);
     const r = await gh.ghIssueComment(root, 999, 'body'); // 999 → fake-gh failing arm
     expect(r.ok).toBe(false);
     expect(typeof r.error).toBe('string');
     expect(r.error).not.toContain('ghp_SECRETTOKEN'); // scrubbed by ghErr → scrubCredentials
     expect(r.error).toContain('***'); // tokenized URL collapsed to ***@github.com
   });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: FAIL ("gh.ghIssueComment is not a function")
- [ ] **Step 3: Implement**
 Add to `apps/server/src/gh.ts`, directly after `ghLabelRemove`:
 ```ts
 /**
  * Post a comment to an issue via `gh issue comment <n> --body <body>`. The body is passed as an
  * argument ARRAY element (no shell interpolation — multi-line markdown is safe). This is the github
  * adapter's `postAssessment` / `attachQuestions` write path. Same never-throw + scrubbed-error
  * contract as {@link ghLabelAdd}.
  */
 export async function ghIssueComment(
   root: string,
   issueNumber: number,
   body: string,
 ): Promise<{ ok: boolean; error?: string }> {
   const r = await ghExec(root, ['issue', 'comment', String(issueNumber), '--body', body]);
   if (!r.ok) return { ok: false, error: ghErr(r) };
   return { ok: true };
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: PASS (`✓ test/gh.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/gh.ts apps/server/test/gh.test.ts
 git commit -m "feat: add ghIssueComment write-back verb (issue comment --body)"
 ```

---

### Task 07.4: gh.ts — widen `prView --json` to include `labels`

**Files:**
- Modify: `apps/server/src/gh.ts`
- Test: `apps/server/test/gh.test.ts`

- [ ] **Step 1: Write the failing test**
 The existing fake gh emits `{"state":"OPEN","url":...}` for `pr view`. Extend that line in `installFakeGh()` to include a `labels` array, and update the existing `prView` arg-construction assertion. First, in `apps/server/test/gh.test.ts` change the fake-gh `pr view` JSON line:
 ```bash
     echo '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/42","labels":[{"name":"risk:low"}]}'; exit 0 ;;
 ```
 Then update the existing assertion in `describe('prCreate / prView / prMerge ...')` for the `viewed` args, and add a labels assertion. Replace the body of the `it('prView parses gh JSON and lowercase-maps OPEN → open', ...)` test's args check with:
 ```ts
     const viewed = ghCalls().find((a) => a[0] === 'pr' && a[1] === 'view');
     expect(viewed).toEqual(['pr', 'view', 'worktree-task-7', '--json', 'state,url,labels']);
 ```
 And add a new test in the same block:
 ```ts
   it('prView surfaces parsed label names', async () => {
     const bare = mkBare();
     const root = mkRootWired(bare);
     const v = await gh.prView(root, 'worktree-task-7');
     expect(v.pr).not.toBeNull();
     expect(v.pr!.labels).toEqual(['risk:low']);
   });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: FAIL (the `viewed` args assertion fails on `state,url` !== `state,url,labels`; `v.pr!.labels` is `undefined`)
- [ ] **Step 3: Implement**
 In `apps/server/src/gh.ts`, widen the `PrView` interface and the `prView` call/parse. Change the `PrView` interface to:
 ```ts
 export interface PrView {
   /** Normalized lowercase PR state (gh emits UPPERCASE; we map to the shared KanbanTask.prState union). */
   state: 'open' | 'merged' | 'closed';
   /** The PR's URL. */
   url: string;
   /** Label names on the PR (gh emits `[{name}]`; we flatten to a string[]). Empty when none. */
   labels: string[];
 }
 ```
 Change the `ghExec` call inside `prView` from `'state,url'` to `'state,url,labels'`:
 ```ts
   const r = await ghExec(root, ['pr', 'view', branch, '--json', 'state,url,labels']);
 ```
 And, inside `prView`, after `const state = normalizePrState(parsed.state);` (before the `return`), add label flattening and include it in the returned object:
 ```ts
   const labels = Array.isArray(parsed.labels)
     ? parsed.labels.map((l: any) => (typeof l?.name === 'string' ? l.name : '')).filter(Boolean)
     : [];
   return { pr: { state, url, labels } };
 ```
 (Delete the old `return { pr: { state, url } };` it replaces.)
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/gh.test.ts`
 Expected: PASS (`✓ test/gh.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/gh.ts apps/server/test/gh.test.ts
 git commit -m "feat: widen prView --json to include labels"
 ```

---

### Task 07.5: controlplane.ts — github issue-fetch helper

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane-github.test.ts`

Replicate the `triggers.ts` `gh api repos/<repo>/issues` read (its `fetchIssuesWithLabel` is module-private, so we replicate rather than import) and add a pure mapper from a GitHub issue to a `WorkItem`. Resolve `owner/repo` from the project's remote via `resolveRemote(project.rootDir, project.remoteName)` + `parseRepoSlug` (release.ts).

- [ ] **Step 1: Write the failing test**
 Create `apps/server/test/controlplane-github.test.ts`:
 ```ts
 import { describe, it, expect, beforeAll } from 'vitest';
 import { mkdtempSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';

 process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cpgh-'));

 let cp: typeof import('../src/controlplane.js');

 beforeAll(async () => {
   cp = await import('../src/controlplane.js');
 });

 describe('issueToWorkItem (pure mapper)', () => {
   it('maps a gh REST issue to a WorkItem, flattening labels[].name', () => {
     const item = cp.issueToWorkItem({
       number: 42,
       title: 'Crash on save',
       body: 'steps to repro',
       labels: [{ name: 'risk:low' }, { name: 'type:bug' }],
     });
     expect(item).toEqual({
       id: '42',
       title: 'Crash on save',
       body: 'steps to repro',
       labels: ['risk:low', 'type:bug'],
     });
   });

   it('tolerates a null body and string labels', () => {
     const item = cp.issueToWorkItem({ number: 7, title: 'T', body: null, labels: ['bug'] });
     expect(item).toEqual({ id: '7', title: 'T', body: '', labels: ['bug'] });
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane-github.test.ts`
 Expected: FAIL ("cp.issueToWorkItem is not a function")
- [ ] **Step 3: Implement**
 Add to `apps/server/src/controlplane.ts`. First extend the existing import of `gh.js` to bring in the new verbs + `resolveRemote`, add a `parseRepoSlug` import from `release.js`, and import the label constants:
 ```ts
 import { ghExec, resolveRemote, ghLabelAdd, ghLabelRemove, ghIssueComment } from './gh.js';
 import { parseRepoSlug } from './release.js';
 import { RISK_LABELS, TYPE_LABELS, ROUTING } from '@fleet/shared';
 import type { Loop, Project, TriageVerdict } from '@fleet/shared';
 ```
 (If `controlplane.ts` already imports some of these from `gh.js`/`@fleet/shared`, merge — do not duplicate the import line.)

 Then add the gh REST shape, the pure mapper, and a fetch helper that mirrors `triggers.ts`:
 ```ts
 // ── github control-plane: issue intake (mirrors triggers.ts fetchIssuesWithLabel) ──

 /** Raw GitHub REST issue shape (the fields we read; labels may be objects or bare strings). */
 interface GhIssue {
   number: number;
   title: string;
   body: string | null;
   labels: Array<{ name?: string } | string>;
 }

 /** PURE: map a GitHub REST issue to a control-plane WorkItem; flatten labels[].name, null body → ''. */
 export function issueToWorkItem(issue: GhIssue): WorkItem {
   const labels = (issue.labels ?? [])
     .map((l) => (typeof l === 'string' ? l : typeof l?.name === 'string' ? l.name : ''))
     .filter(Boolean);
   return { id: String(issue.number), title: issue.title, body: issue.body ?? '', labels };
 }

 /**
  * Resolve `owner/repo` for a project from its configured remote (scrubbed URL via resolveRemote +
  * parseRepoSlug). Returns null when no GitHub remote is configured — the github adapter then treats
  * the backlog/ready as empty (no work), exactly like triggers.ts treats a failed gh call.
  */
 async function ghRepoSlug(project: Project): Promise<string | null> {
   const remote = await resolveRemote(project.rootDir, project.remoteName);
   if (!remote.resolves || !remote.url) return null;
   return parseRepoSlug(remote.url);
 }

 /** Fetch open issues for a repo (mirrors triggers.ts fetchIssuesWithLabel; null on any gh failure). */
 async function fetchOpenIssues(root: string, ghRepo: string): Promise<GhIssue[] | null> {
   const r = await ghExec(root, [
     'api', `repos/${ghRepo}/issues`,
     '--method', 'GET',
     '-f', 'state=open',
     '-f', 'per_page=20',
   ]);
   if (!r.ok) return null;
   try {
     const items = JSON.parse(r.stdout);
     if (!Array.isArray(items)) return null;
     return items as GhIssue[];
   } catch {
     return null;
   }
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane-github.test.ts`
 Expected: PASS (`✓ test/controlplane-github.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane-github.test.ts
 git commit -m "feat: github control-plane issue intake helper + WorkItem mapper"
 ```

---

### Task 07.6: controlplane.ts — github adapter (`listBacklog` / `listReady`)

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane-github.test.ts`

`listBacklog` = open issues lacking any `risk:*` label; `listReady` = open issues carrying `agent:ready`. We expose a constructor `githubControlPlane(loop, project)` returning a `ControlPlane`, and unit-test its read side with a mocked `ghExec` (we override the module-level fetch by exporting a pure filter and a fetch-injection seam).

- [ ] **Step 1: Write the failing test**
 Add to `apps/server/test/controlplane-github.test.ts`:
 ```ts
 describe('github adapter read filters (pure)', () => {
   const items = [
     { id: '1', title: 'untriaged', body: '', labels: [] },
     { id: '2', title: 'triaged-low', body: '', labels: ['risk:low', 'type:bug'] },
     { id: '3', title: 'ready', body: '', labels: ['risk:low', 'agent:ready'] },
     { id: '4', title: 'triaged-high', body: '', labels: ['risk:high', 'needs:human'] },
   ];

   it('backlog = items lacking any risk:* label', () => {
     expect(cp.selectBacklog(items).map((i) => i.id)).toEqual(['1']);
   });

   it('ready = items carrying agent:ready', () => {
     expect(cp.selectReady(items).map((i) => i.id)).toEqual(['3']);
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane-github.test.ts`
 Expected: FAIL ("cp.selectBacklog is not a function")
- [ ] **Step 3: Implement**
 Add to `apps/server/src/controlplane.ts` (the `ROUTING` import landed in Task 07.5):
 ```ts
 /** PURE: an item is untriaged backlog when it carries NO risk:* label. */
 export function selectBacklog(items: WorkItem[]): WorkItem[] {
   return items.filter((i) => !i.labels.some((l) => l.startsWith('risk:')));
 }

 /** PURE: an item is ready when it carries the agent:ready routing label. */
 export function selectReady(items: WorkItem[]): WorkItem[] {
   return items.filter((i) => i.labels.includes(ROUTING.ready));
 }
 ```
 Then add the adapter constructor. Its `classify`/`postAssessment`/`attachQuestions` are filled in Task 07.7 — for now stub the writes so the read side compiles and `controlPlaneFor` (Task 07.8) can return it:
 ```ts
 /**
  * The github control plane: reads open issues via `gh api` and writes via the gh issue verbs.
  * Reads return [] (treated as "no work") when no GitHub remote is configured or gh fails — the
  * fire is then skipped by the scheduler, exactly like triggers.ts on a failed gh call.
  */
 export function githubControlPlane(loop: Loop, project: Project): ControlPlane {
   const root = project.rootDir;
   async function fetchAll(): Promise<WorkItem[]> {
     const slug = await ghRepoSlug(project);
     if (!slug) return [];
     const issues = await fetchOpenIssues(root, slug);
     if (!issues) return [];
     return issues.map(issueToWorkItem);
   }
   return {
     async listBacklog() {
       return selectBacklog(await fetchAll());
     },
     async listReady() {
       return selectReady(await fetchAll());
     },
     // writes implemented in Task 07.7
     async classify() {},
     async postAssessment() {},
     async attachQuestions() {},
   };
 }
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane-github.test.ts`
 Expected: PASS (`✓ test/controlplane-github.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane-github.test.ts
 git commit -m "feat: github control-plane adapter read side (listBacklog/listReady)"
 ```

---

### Task 07.7: controlplane.ts — github adapter writes (`classify` / `postAssessment` / `attachQuestions`)

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane-github.test.ts`

`classify` maps a `TriageVerdict` to label add/remove via `ghLabelAdd`/`ghLabelRemove`; `postAssessment`/`attachQuestions` post a `ghIssueComment` (`attachQuestions` also adds `needs:human`). We mock `gh.js` at the module boundary with `vi.mock` and assert the verb calls.

- [ ] **Step 1: Write the failing test**
 Create a focused test file `apps/server/test/controlplane-github-writes.test.ts` that mocks `gh.js` (mocking at module scope keeps the read-side test in `controlplane-github.test.ts` using the real, no-op-on-this-box gh):
 ```ts
 import { describe, it, expect, beforeAll, vi } from 'vitest';
 import { mkdtempSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';

 process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cpghw-'));

 const calls: any[] = [];
 vi.mock('../src/gh.js', () => ({
   ghExec: vi.fn(async () => ({ ok: false, stdout: '', stderr: '', code: 1 })),
   resolveRemote: vi.fn(async () => ({ url: 'https://github.com/acme/widgets.git', resolves: true })),
   ghLabelAdd: vi.fn(async (_root: string, n: number, label: string) => { calls.push(['add', n, label]); return { ok: true }; }),
   ghLabelRemove: vi.fn(async (_root: string, n: number, label: string) => { calls.push(['remove', n, label]); return { ok: true }; }),
   ghIssueComment: vi.fn(async (_root: string, n: number, body: string) => { calls.push(['comment', n, body]); return { ok: true }; }),
 }));

 let cp: typeof import('../src/controlplane.js');
 const project: any = { id: 'p1', rootDir: '/tmp/proj', remoteName: 'origin' };
 const loop: any = { id: 'l1', kind: 'manager', controlPlane: 'github', mode: 'apply', routableCeiling: 'low' };

 beforeAll(async () => {
   cp = await import('../src/controlplane.js');
 });

 describe('github adapter writes (mocked gh verbs)', () => {
   it('classify(agentReady) adds risk/type + agent:ready, removes needs:human', async () => {
     calls.length = 0;
     const adapter = cp.githubControlPlane(loop, project);
     await adapter.classify('42', { risk: 'low', type: 'bug', agentReady: true, reason: 'simple' });
     expect(calls).toContainEqual(['add', 42, 'risk:low']);
     expect(calls).toContainEqual(['add', 42, 'type:bug']);
     expect(calls).toContainEqual(['add', 42, 'agent:ready']);
     expect(calls).toContainEqual(['remove', 42, 'needs:human']);
   });

   it('classify(!agentReady) adds risk/type + needs:human, removes agent:ready', async () => {
     calls.length = 0;
     const adapter = cp.githubControlPlane(loop, project);
     await adapter.classify('9', { risk: 'high', type: 'feature', agentReady: false, reason: 'risky' });
     expect(calls).toContainEqual(['add', 9, 'risk:high']);
     expect(calls).toContainEqual(['add', 9, 'type:feature']);
     expect(calls).toContainEqual(['add', 9, 'needs:human']);
     expect(calls).toContainEqual(['remove', 9, 'agent:ready']);
   });

   it('postAssessment posts a comment', async () => {
     calls.length = 0;
     const adapter = cp.githubControlPlane(loop, project);
     await adapter.postAssessment('42', '## Agent Assessment\nRisk: low');
     expect(calls).toContainEqual(['comment', 42, '## Agent Assessment\nRisk: low']);
   });

   it('attachQuestions posts a question comment and adds needs:human', async () => {
     calls.length = 0;
     const adapter = cp.githubControlPlane(loop, project);
     await adapter.attachQuestions('42', ['Which DB?', 'Auth impact?']);
     const comment = calls.find((c) => c[0] === 'comment');
     expect(comment[1]).toBe(42);
     expect(comment[2]).toContain('Which DB?');
     expect(comment[2]).toContain('Auth impact?');
     expect(calls).toContainEqual(['add', 42, 'needs:human']);
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane-github-writes.test.ts`
 Expected: FAIL (the stub `classify`/`postAssessment`/`attachQuestions` from Task 07.6 are no-ops, so `calls` stays empty)
- [ ] **Step 3: Implement**
 In `apps/server/src/controlplane.ts`, replace the three stub write methods inside `githubControlPlane` with real implementations. Replace:
 ```ts
     // writes implemented in Task 07.7
     async classify() {},
     async postAssessment() {},
     async attachQuestions() {},
 ```
 with:
 ```ts
     async classify(itemId: string, v: TriageVerdict) {
       const n = Number(itemId);
       await ghLabelAdd(root, n, RISK_LABELS[v.risk]);
       await ghLabelAdd(root, n, TYPE_LABELS[v.type]);
       if (v.agentReady) {
         await ghLabelAdd(root, n, ROUTING.ready);
         await ghLabelRemove(root, n, ROUTING.needsHuman);
       } else {
         await ghLabelAdd(root, n, ROUTING.needsHuman);
         await ghLabelRemove(root, n, ROUTING.ready);
       }
     },
     async postAssessment(itemId: string, markdown: string) {
       await ghIssueComment(root, Number(itemId), markdown);
     },
     async attachQuestions(itemId: string, questions: string[]) {
       const n = Number(itemId);
       const body = ['**Questions for a human before this is agent-ready:**', '', ...questions.map((q) => `- ${q}`)].join('\n');
       await ghIssueComment(root, n, body);
       await ghLabelAdd(root, n, ROUTING.needsHuman);
     },
 ```
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane-github-writes.test.ts`
 Expected: PASS (`✓ test/controlplane-github-writes.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane-github-writes.test.ts
 git commit -m "feat: github control-plane adapter write verbs (classify/assess/questions)"
 ```

---

### Task 07.8: controlplane.ts — wire the github branch into `controlPlaneFor`

**Files:**
- Modify: `apps/server/src/controlplane.ts`
- Test: `apps/server/test/controlplane-github-writes.test.ts`

`controlPlaneFor(loop, project)` (board branch + dry-run wrapper from Slice 03) must select `githubControlPlane` when `loop.controlPlane === 'github'`, still routing through the SAME dry-run interception wrapper so a `mode='dry-run'` github loop records `intended[]` and performs NO real gh writes.

- [ ] **Step 1: Write the failing test**
 Add to `apps/server/test/controlplane-github-writes.test.ts`:
 ```ts
 describe('controlPlaneFor github branch', () => {
   it('apply-mode github loop performs real writes (intended stays empty)', async () => {
     calls.length = 0;
     const { cp: adapter, intended } = cp.controlPlaneFor({ ...loop, mode: 'apply' }, project);
     await adapter.classify('42', { risk: 'low', type: 'bug', agentReady: true, reason: 'ok' });
     expect(calls).toContainEqual(['add', 42, 'risk:low']);
     expect(intended).toEqual([]);
   });

   it('dry-run github loop intercepts writes into intended[] and performs NO gh writes', async () => {
     calls.length = 0;
     const { cp: adapter, intended } = cp.controlPlaneFor({ ...loop, mode: 'dry-run' }, project);
     await adapter.classify('42', { risk: 'low', type: 'bug', agentReady: true, reason: 'ok' });
     expect(calls).toEqual([]); // no real gh verb called
     expect(intended.find((a) => a.kind === 'classify' && a.itemId === '42')).toBeTruthy();
   });
 });
 ```
- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/controlplane-github-writes.test.ts`
 Expected: FAIL (`controlPlaneFor` from Slice 03 only knows the board branch; the github loop currently falls through to the board adapter, which never calls the mocked gh verbs)
- [ ] **Step 3: Implement**
 In `apps/server/src/controlplane.ts`, edit the existing Slice 03 `controlPlaneFor` body. As shipped by Slice 03 (Task 03.7) it is:
 ```ts
 export function controlPlaneFor(
   loop: Loop,
   _project: Project,
 ): { cp: ControlPlane; intended: IntendedAction[] } {
   if (loop.controlPlane === 'github') {
     // Slice 07 replaces this with the gh-backed adapter (ghLabelAdd/ghIssueComment).
     throw new Error('github control plane not implemented yet (Slice 07)');
   }
   const real = makeBoardAdapter(loop.projectId);
   const intended: IntendedAction[] = [];
   if (loop.mode === 'dry-run') return { cp: dryRunWrap(real, intended), intended };
   return { cp: real, intended };
 }
 ```
 Make exactly three changes: (1) the github adapter needs `project`, so rename the `_project` param to `project` (it is now used); (2) DELETE the `if (loop.controlPlane === 'github') throw …` block; (3) replace the board-only adapter construction with a branch that selects the github adapter for github loops and the board adapter otherwise. Leave the `intended[]` / `dryRunWrap` lines untouched so a github dry-run loop flows through the SAME wrapper. Result:
 ```ts
 export function controlPlaneFor(
   loop: Loop,
   project: Project,
 ): { cp: ControlPlane; intended: IntendedAction[] } {
   const real =
     loop.controlPlane === 'github'
       ? githubControlPlane(loop, project) // Slice 07: gh issues + labels (ghLabelAdd/ghIssueComment)
       : makeBoardAdapter(loop.projectId); // Slice 03: local kanban via kanbanRepo
   const intended: IntendedAction[] = [];
   if (loop.mode === 'dry-run') return { cp: dryRunWrap(real, intended), intended };
   return { cp: real, intended };
 }
 ```
 Note the two constructors take DIFFERENT arguments — `githubControlPlane(loop, project)` (it resolves the repo slug from `project.rootDir` / `project.remoteName`) versus `makeBoardAdapter(loop.projectId)` (the board adapter only needs the project id). Both return a `ControlPlane`, so the shared `dryRunWrap(real, intended)` path is identical for either adapter.
- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/controlplane-github-writes.test.ts`
 Expected: PASS (`✓ test/controlplane-github-writes.test.ts`)
- [ ] **Step 5: Commit**
 ```bash
 git add apps/server/src/controlplane.ts apps/server/test/controlplane-github-writes.test.ts
 git commit -m "feat: route controlPlaneFor to the github adapter for github loops"
 ```


---

## Slice 08: review-pm-worker

Build `review.ts` (maker/checker `launchReview` on the worker diff) and extend `pm.ts` with the worker-loop selection filter (`agent:ready` + risk ceiling), the `reviewing` phase in `validateAndGate`, and merge-posture honoring — all backward-compatible (no worker Loop → today's exact PM behavior).

**Files:**
- Create: `apps/server/src/review.ts` — `launchReview(card, project, diff): Promise<ReviewVerdict>` (Reviewer template, read-only, `REVIEW_JSON_SCHEMA`)
- Modify: `apps/server/src/pm.ts` — selection filter in `tick`; `reviewing` phase in `validateAndGate`; merge-posture in `gate`; `changedFilesVsBase` helper
- Test: `apps/server/test/review.test.ts` — `launchReview` schema launch + verdict parse + failure fallback
- Test: `apps/server/test/pm-worker.test.ts` — selection filter; reviewing pass→gate; reject→rework; human-gate never merges

Cross-slice dependencies (defined by earlier slices, used here):
- `./loops.js` → `loopsRepo.enabledByKind(projectId, kind: LoopKind): Loop[]` and the `Loop` shape (`reviewPolicy`, `mergePosture`, `routableCeiling`) — Slice 2.
- `packages/shared` → `ReviewVerdict { pass: boolean; findings: string }`, `RISK_LABELS`, `ROUTING`, `RiskLevel`, `Loop`, and `ExecutionPhase` gaining `'reviewing'` — Slice 1.
- `PortalConfig.loopAutoMergeCeiling: RiskLevel | null` (global auto-merge ceiling, `null` = off) — Slice 1 adds it to `packages/shared` + `DEFAULT_CONFIG`; read here via `registry.getConfig()`.

---

### Task 08.1: review.ts — launchReview (maker/checker on the diff)

**Files:**
- Create: `apps/server/src/review.ts`
- Test: `apps/server/test/review.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB isolation BEFORE any src module loads (config.js reads FLEET_DATA_DIR at import).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-review-'));

let launchReview: any;
let registry: any;

const baseRun = (id: string, overrides: Record<string, any> = {}): any => ({
  id, sessionId: id, task: 't', cwd: '/tmp', model: 'claude-opus-4-8', fastMode: false,
  effort: 'high', workflowsEnabled: true, ultracode: false, teamId: null, campaignId: null,
  projectId: null, pid: null, status: 'completed', startedAt: 1, endedAt: 2, tokensIn: 0,
  tokensOut: 0, costUsd: 0, exitCode: 0, budgetUsd: 2, permissionMode: 'default',
  allowedTools: null, skills: [], subagentProfile: null, resultText: null,
  structuredOutput: null, killReason: null, error: null, subagentCount: 0, liveSubagents: 0,
  maxDepth: 0, lastActivity: 1, ...overrides,
});

const project = (patch: Record<string, any> = {}): any => ({ id: 'p1', rootDir: '/tmp/x', ...patch });
const card = (patch: Record<string, any> = {}): any => ({ id: 'c1', title: 'feat', worktreeName: 'task-c1', ...patch });

beforeAll(async () => {
  ({ launchReview } = await import('../src/review.js'));
  ({ registry } = await import('../src/registry.js'));
});

describe('review.launchReview — adversarial maker/checker (SPEC §9)', () => {
  it('launches the Reviewer read-only with REVIEW_JSON_SCHEMA + the diff, returns the parsed verdict', async () => {
    const calls: any[] = [];
    const real = registry.launch;
    registry.launch = (req: any) => {
      calls.push(req);
      return baseRun('review-run', { structuredOutput: { pass: true, findings: 'looks good' } });
    };
    try {
      const v = await launchReview(card(), project(), 'diff --git a/f b/f\n+x\n');
      expect(v).toEqual({ pass: true, findings: 'looks good' });
      expect(calls.length).toBe(1);
      const req = calls[0];
      // read-only Reviewer envelope: no Edit/Write, json-schema present, the diff threaded in.
      expect(req.jsonSchema).toBeTruthy();
      expect(req.allowedTools).not.toContain('Edit');
      expect(req.allowedTools).not.toContain('Write');
      expect(req.permissionMode).toBe('default');
      expect(req.interactive).toBe(false);
      expect(req.prompt).toContain('diff --git a/f b/f');
    } finally {
      registry.launch = real;
    }
  });

  it('a reject verdict is returned verbatim (pass:false + findings)', async () => {
    const real = registry.launch;
    registry.launch = () => baseRun('rev2', { structuredOutput: { pass: false, findings: 'null deref at f:12' } });
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('null deref');
    } finally {
      registry.launch = real;
    }
  });

  it('a launch throw → safe reject fallback {pass:false, findings:"review failed: ..."}', async () => {
    const real = registry.launch;
    registry.launch = () => { throw new Error('boom'); };
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('review failed');
      expect(v.findings).toContain('boom');
    } finally {
      registry.launch = real;
    }
  });

  it('a missing/garbage structuredOutput → safe reject fallback', async () => {
    const real = registry.launch;
    registry.launch = () => baseRun('rev3', { status: 'completed', structuredOutput: null });
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('review failed');
    } finally {
      registry.launch = real;
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/review.test.ts`
 Expected: FAIL ("Cannot find module '../src/review.js'")

- [ ] **Step 3: Implement**
```ts
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
    const so = run.structuredOutput as any;
    if (so && typeof so.pass === 'boolean' && typeof so.findings === 'string') {
      return { pass: so.pass, findings: so.findings };
    }
    return { pass: false, findings: 'review failed: reviewer returned no structured verdict' };
  } catch (e: any) {
    return { pass: false, findings: `review failed: ${e?.message ?? e}` };
  }
}
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/review.test.ts`
 Expected: PASS (`✓ test/review.test.ts`)

- [ ] **Step 5: Commit**
 ```bash
git add apps/server/src/review.ts apps/server/test/review.test.ts
git commit -m "feat: review.ts launchReview maker/checker gate on worker diff"
 ```

---

### Task 08.2: pm.ts — worker-loop selection filter in tick (backward compatible)

**Files:**
- Modify: `apps/server/src/pm.ts`
- Test: `apps/server/test/pm-worker.test.ts`

The filter engages ONLY when an enabled `kind='worker'` Loop exists for the project; otherwise `tick` keeps today's bare `column='Ready'` selection.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB isolation BEFORE any src module loads.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pm-worker-'));

let pm: any;
let registry: any;
let projectsRepo: any;
let kanbanRepo: any;
let loopsRepo: any;

const repoDirs: string[] = [];
let realLaunch: any;
let launchSeq = 0;

beforeAll(async () => {
  ({ pm } = await import('../src/pm.js'));
  ({ registry } = await import('../src/registry.js'));
  ({ projectsRepo } = await import('../src/projects.js'));
  ({ kanbanRepo } = await import('../src/kanban.js'));
  ({ loopsRepo } = await import('../src/loops.js'));
  realLaunch = registry.launch;
  registry.launch = (req: any) => baseRun(`bg-${++launchSeq}`, req?.projectId ?? null);
});
afterAll(() => {
  if (realLaunch) registry.launch = realLaunch;
  for (const d of repoDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true }); } catch {}
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-repo-${label}-`));
  repoDirs.push(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}
function makeProject(rootDir: string, patch: Record<string, any> = {}): any {
  return projectsRepo.createProject({ name: `proj-${Math.random().toString(36).slice(2, 8)}`, rootDir, defaultBranch: 'master', autoMerge: false, wipLimit: 5, ...patch });
}
function makeCard(projectId: string, patch: Record<string, any> = {}): any {
  const c = kanbanRepo.createTask({ projectId, title: patch.title ?? 'card', description: '', acceptanceCriteria: '', column: patch.column });
  const post: any = {};
  for (const k of ['column', 'labels', 'priority']) if (k in patch && patch[k] !== undefined) post[k] = patch[k];
  return Object.keys(post).length ? kanbanRepo.updateTask(c.id, post) : c;
}
const baseRun = (id: string, projectId: string | null, overrides: Record<string, any> = {}): any => ({
  id, sessionId: id, task: 't', cwd: '/tmp', model: 'claude-haiku-4-5', fastMode: false, effort: 'medium',
  workflowsEnabled: true, ultracode: false, teamId: null, campaignId: null, projectId, pid: null,
  status: 'running', startedAt: 1, endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: 0, exitCode: null,
  budgetUsd: 5, permissionMode: 'default', allowedTools: null, skills: [], subagentProfile: null,
  resultText: null, structuredOutput: null, killReason: null, error: null, subagentCount: 0,
  liveSubagents: 0, maxDepth: 0, lastActivity: 1, ...overrides,
});
function stubLaunch(impl: (req: any) => any): { calls: any[]; restore: () => void } {
  const calls: any[] = [];
  const real = registry.launch;
  registry.launch = (req: any) => { calls.push(req); return impl(req); };
  return { calls, restore: () => { registry.launch = real; } };
}
// Minimal worker Loop for a project (only the fields tick/gate read).
function makeWorkerLoop(projectId: string, patch: Record<string, any> = {}): any {
  return loopsRepo.create({
    name: 'w', projectId, kind: 'worker',
    contract: { job: 'build', inputs: 'cards', allowed: [], forbidden: [], output: 'pr', evaluation: 'tests pass' },
    routableCeiling: patch.routableCeiling ?? 'low',
    mergePosture: patch.mergePosture ?? 'human-gate',
    reviewPolicy: patch.reviewPolicy ?? 'always',
  });
}

describe('pm.tick() — worker-loop selection filter (SPEC §9)', () => {
  it('NO worker loop → today behavior: a bare Ready card (no labels) is launched', async () => {
    const root = makeRepo('nofilter');
    const project = makeProject(root, { wipLimit: 5 });
    const card = makeCard(project.id, { title: 'bare', column: 'Ready' }); // no labels
    const stub = stubLaunch((req) => baseRun('bare-run', req.projectId));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(1); // unfiltered: bare Ready card launches
      expect(kanbanRepo.getTask(card.id)!.column).toBe('InProgress');
    } finally { stub.restore(); }
  });

  it('worker loop present → a Ready card WITHOUT agent:ready is NOT selected', async () => {
    const root = makeRepo('filter-skip');
    const project = makeProject(root, { wipLimit: 5 });
    makeWorkerLoop(project.id, { routableCeiling: 'low' });
    const bare = makeCard(project.id, { title: 'untriaged', column: 'Ready' }); // no agent:ready
    const stub = stubLaunch((req) => baseRun('x', req.projectId));
    try {
      await pm.tick(project.id);
      expect(stub.calls.length).toBe(0); // filtered out — not agent:ready
      expect(kanbanRepo.getTask(bare.id)!.column).toBe('Ready'); // left untouched
    } finally { stub.restore(); }
  });

  it('worker loop present → agent:ready + risk<=ceiling is selected; risk>ceiling is NOT', async () => {
    const root = makeRepo('filter-pick');
    const project = makeProject(root, { wipLimit: 5 });
    makeWorkerLoop(project.id, { routableCeiling: 'low' });
    const ok = makeCard(project.id, { title: 'routable', column: 'Ready', labels: ['agent:ready', 'risk:low'], priority: 5 });
    const tooRisky = makeCard(project.id, { title: 'risky', column: 'Ready', labels: ['agent:ready', 'risk:high'], priority: 4 });
    const stub = stubLaunch((req) => baseRun(`run-${req.worktree}`, req.projectId));
    try {
      await pm.tick(project.id);
      expect(kanbanRepo.getTask(ok.id)!.column).toBe('InProgress'); // routable: launched
      expect(kanbanRepo.getTask(tooRisky.id)!.column).toBe('Ready'); // risk>ceiling: skipped
      expect(stub.calls.map((c) => c.worktree)).toContain(`task-${ok.id}`);
      expect(stub.calls.map((c) => c.worktree)).not.toContain(`task-${tooRisky.id}`);
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/pm-worker.test.ts`
 Expected: FAIL ("worker loop present → a Ready card WITHOUT agent:ready is NOT selected" fails — the unfiltered loop launches the bare card)

- [ ] **Step 3: Implement**

Add the imports at the top of `pm.ts` (beside the existing `import { kanbanRepo } from './kanban.js';`):
```ts
import { loopsRepo } from './loops.js';
import { launchReview } from './review.js';
import { RISK_LABELS, ROUTING, type RiskLevel } from '@fleet/shared';
```

Add a rank ordering of risk levels and a selection helper near the other `// ── helpers ──` functions (after `validationCommandFor`):
```ts
/** Risk ordering for the `routableCeiling` comparison (low < medium < high). */
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** The card's inferred risk from its `risk:*` label (default 'low' when unlabeled). */
function cardRisk(card: KanbanTask): RiskLevel {
  if (card.labels.includes(RISK_LABELS.high)) return 'high';
  if (card.labels.includes(RISK_LABELS.medium)) return 'medium';
  return 'low';
}

/**
 * SPEC §9 worker-loop selection filter (BACKWARD COMPATIBLE). When an enabled kind='worker' Loop owns
 * the project, only `agent:ready` cards within the loop's `routableCeiling` are routable — a human-
 * dragged-but-untriaged card is left alone for the Manager to triage. With NO worker Loop the filter
 * is OFF and every Ready card is routable, preserving today's bare `column='Ready'` behavior exactly.
 */
function routableReadyCards(projectId: string): KanbanTask[] {
  const ready = kanbanRepo.readyTasks(projectId); // priority DESC, rank ASC
  const workerLoops = loopsRepo.enabledByKind(projectId, 'worker');
  if (workerLoops.length === 0) return ready; // no worker Loop → unchanged
  const ceiling = workerLoops[0].routableCeiling;
  return ready.filter(
    (c) => c.labels.includes(ROUTING.ready) && RISK_RANK[cardRisk(c)] <= RISK_RANK[ceiling],
  );
}
```

Then in `tick`, replace the readyTasks loop. Change:
```ts
      // readyTasks() is already ordered priority DESC, rank ASC.
      for (const card of kanbanRepo.readyTasks(projectId)) {
```
to:
```ts
      // routableReadyCards() applies the worker-loop selection filter (agent:ready + risk<=ceiling)
      // ONLY when an enabled worker Loop owns the project; otherwise it returns kanbanRepo.readyTasks
      // unchanged (priority DESC, rank ASC) — today's exact bare column='Ready' behavior (SPEC §9).
      for (const card of routableReadyCards(projectId)) {
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/pm-worker.test.ts test/pm.test.ts`
 Expected: PASS (`✓ test/pm-worker.test.ts` selection cases + existing `✓ test/pm.test.ts` regression green)

- [ ] **Step 5: Commit**
 ```bash
git add apps/server/src/pm.ts apps/server/test/pm-worker.test.ts
git commit -m "feat: pm worker-loop selection filter (agent:ready + routable ceiling)"
 ```

---

### Task 08.3: pm.ts — reviewing phase in validateAndGate (pass→gate, reject→rework)

**Files:**
- Modify: `apps/server/src/pm.ts`
- Test: `apps/server/test/pm-worker.test.ts` (extend)

After `validateCard` passes, if a worker Loop exists for the project and `reviewPolicy !== 'off'` (and for `threshold:N`, only when the diff changed > N files), set `execution_phase='reviewing'` and `launchReview`. pass → gate; reject → rework relaunch with findings as the fix prompt, reusing `attempt_count`/`max_attempts` + the `last_diff_hash` guard.

- [ ] **Step 1: Write the failing test** (append to `apps/server/test/pm-worker.test.ts`)
```ts
// Local worktree fixture (mirrors pm.test.ts makeFinishedWorktree) — declared inline so this file
// is self-contained.
function ensureWorktreesGitignored(rootDir: string): void {
  const gi = join(rootDir, '.gitignore');
  let existing = '';
  try { existing = require('node:fs').readFileSync(gi, 'utf8'); } catch {}
  if (existing.split(/\r?\n/).some((l: string) => l.trim() === '.claude/worktrees/')) return;
  writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
  git(rootDir, 'add', '--', '.gitignore');
  git(rootDir, 'commit', '-m', 'chore: ignore agent worktrees');
}
function makeFinishedWorktree(rootDir: string, cardId: string, mut: (wt: string) => void): { wtName: string; wtDir: string } {
  const wtName = `task-${cardId}`;
  const wtRel = join('.claude', 'worktrees', wtName);
  const wtDir = join(rootDir, wtRel);
  ensureWorktreesGitignored(rootDir);
  git(rootDir, 'worktree', 'add', wtRel, '-b', `worktree-${wtName}`);
  git(wtDir, 'config', 'user.email', 'test@local');
  git(wtDir, 'config', 'user.name', 'test');
  mut(wtDir);
  git(wtDir, 'add', '-A');
  git(wtDir, 'commit', '-m', `work for ${cardId}`);
  return { wtName, wtDir };
}

describe('pm reviewing phase (maker/checker) in validateAndGate (SPEC §9)', () => {
  it('reviewPolicy "always" + review PASS → card parks in Review (human-gate), review was launched', async () => {
    const root = makeRepo('rev-pass');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'human-gate' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName, executionPhase: 'validating' });

    let reviewReq: any = null;
    const stub = stubLaunch((req) => {
      reviewReq = req; // the Reviewer launch carries the json-schema
      return baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } });
    });
    try {
      // drive the shared funnel directly (validateCard passes — no validation command).
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    expect(reviewReq).toBeTruthy();
    expect(reviewReq.jsonSchema).toBeTruthy();
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review'); // human-gate → parked, never merged
    expect(parked!.executionPhase).toBe('idle');
  });

  it('review REJECT → rework: a fix run is relaunched with the findings, attempt_count bumped', async () => {
    const root = makeRepo('rev-reject');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName, attemptCount: 0, maxAttempts: 3 });

    const reqs: any[] = [];
    const stub = stubLaunch((req) => {
      reqs.push(req);
      // first launch = the Reviewer (json-schema), reject; second = the fix run.
      if (req.jsonSchema) return baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: false, findings: 'fix the null deref at f:12' } });
      return baseRun('fix-run', project.id);
    });
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    const fixReq = reqs.find((r) => !r.jsonSchema);
    expect(fixReq).toBeTruthy();
    expect(fixReq.worktree).toBe(wtName); // same worktree
    expect(fixReq.prompt).toContain('null deref at f:12'); // findings reach the fix prompt via the explicit reviewFindings thread (rework→launchFix→fixPrompt), NOT via lastError (rework clears it)
    const fresh = kanbanRepo.getTask(card.id);
    expect(fresh!.column).toBe('InProgress'); // relaunched, not parked
    expect(fresh!.executionPhase).toBe('building');
    expect(fresh!.attemptCount).toBe(1); // one attempt consumed
  });

  it('reviewPolicy "off" → no review launched; card parks in Review directly (default gate)', async () => {
    const root = makeRepo('rev-off');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'off' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const stub = stubLaunch((req) => baseRun('x', project.id, { structuredOutput: { pass: true, findings: 'n/a' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    // no json-schema (Reviewer) launch happened.
    expect(stub.calls.filter((c) => c.jsonSchema).length).toBe(0);
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Review');
  });

  it('NO worker loop → validateAndGate is byte-for-byte v1 (no review, parks in Review)', async () => {
    const root = makeRepo('rev-noloop');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress' });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'f.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const stub = stubLaunch((req) => baseRun('x', project.id));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    expect(stub.calls.filter((c) => c.jsonSchema).length).toBe(0); // no review
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Review');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/pm-worker.test.ts`
 Expected: FAIL ("review REJECT → rework" fails — no review is launched and the card parks instead of reworking)

- [ ] **Step 3: Implement**

Add a `reviewPolicy` parser + a changed-files counter near the other helpers in `pm.ts`:
```ts
/** Parse a Loop.reviewPolicy ('always' | 'off' | 'threshold:<N>') into a decision. For 'threshold:N'
 *  the review fires only when the diff changed MORE than N files; a malformed value → treat as 'always'. */
function reviewDecision(policy: string): { review: boolean; thresholdFiles: number | null } {
  if (policy === 'off') return { review: false, thresholdFiles: null };
  const m = /^threshold:(\d+)$/.exec(policy);
  if (m) return { review: true, thresholdFiles: Number(m[1]) };
  return { review: true, thresholdFiles: null }; // 'always' (or unknown) → always review
}

/** Count files changed in the worktree branch's diff vs base (for the threshold:N review gate). */
async function changedFilesVsBase(worktreeDir: string, baseBranch: string): Promise<number> {
  const r = await gitExec(worktreeDir, ['-C', worktreeDir, 'diff', '--name-only', '-z', baseBranch]);
  if (!r.ok) return 0;
  return r.stdout.split('\0').filter((p) => p !== '').length;
}
```

Add the `gitExec` import to the existing `./git.js` import block in `pm.ts` (add `gitExec,` to the named imports):
```ts
import {
  ensureCommitted,
  conflictProbe,
  integrateAndReport,
  mergeBranch,
  cleanupWorktree,
  ensureWorktreeIgnored,
  createWorktree,
  scrubCredentials,
  startResolveMerge,
  mergeAbort,
  isMergeInProgress,
  conflictedFiles,
  hasConflictMarkers,
  gitExec,
} from './git.js';
```

Now insert the `reviewing` step into `validateAndGate`, between the `validateCard` pass and the `gate` call. Change the tail of `validateAndGate`:
```ts
    if (passed) {
      await this.gate(cardId, project);
    } else {
      await this.rework(cardId, project, validationOutput);
    }
```
to:
```ts
    if (passed) {
      // SPEC §9 maker/checker: a separate Reviewer judges the worker's diff before the gate. Engages
      // ONLY for a project that has an enabled worker Loop with reviewPolicy != 'off' (and, for
      // 'threshold:N', only when the diff changed MORE than N files). reject → rework with the findings
      // threaded as the fix prompt; pass → gate. No worker Loop → straight to the gate (v1 behavior).
      const workerLoops = loopsRepo.enabledByKind(project.id, 'worker');
      const loop = workerLoops[0];
      if (loop) {
        const dec = reviewDecision(loop.reviewPolicy);
        let doReview = dec.review;
        if (doReview && dec.thresholdFiles !== null) {
          doReview = (await changedFilesVsBase(wtDir, project.defaultBranch)) > dec.thresholdFiles;
        }
        if (doReview) {
          if (await this.reviewGate(cardId, project)) return; // rejected → reworked, do not gate
        }
      }
      await this.gate(cardId, project);
    } else {
      await this.rework(cardId, project, validationOutput);
    }
```

Add the `reviewGate` method to `PmEngine` (place it right after `validateAndGate`):
```ts
  /**
   * SPEC §9 maker/checker step: mark the card 'reviewing', compute its diff vs base, launch a separate
   * Reviewer (review.ts) on it, then route the verdict. Returns true when the review REJECTED and the
   * card was reworked (so the caller must NOT proceed to the gate); false when the review PASSED (the
   * caller proceeds to the gate). On a rejected verdict, the reviewer findings are threaded through
   * `rework`'s new `reviewFindings` parameter (→ launchFix → fixPrompt) so they reach the fix prompt
   * WITHOUT relying on `lastError` — which `rework` clears to null before re-reading the card. Reworks
   * under the existing attempt_count cap + last_diff_hash no-progress guard.
   */
  private async reviewGate(cardId: string, project: Project): Promise<boolean> {
    const card = kanbanRepo.getTask(cardId);
    if (!card) return false;
    if (PM_DONE_COLUMNS.has(card.column) || card.column === 'Backlog' || card.column === 'Ready') return false;
    const wtName = card.worktreeName ?? worktreeNameFor(card);
    const wtDir = worktreeDirFor(project.rootDir, wtName);

    kanbanRepo.updateTask(cardId, { executionPhase: 'reviewing' });
    const diff = await this.diffText(wtDir, project.defaultBranch);
    const verdict = await launchReview(card, project, diff);

    if (verdict.pass) return false; // proceed to gate

    // REJECT → rework with the findings as the fix prompt. Re-read after the (long) review await.
    const fresh = kanbanRepo.getTask(cardId);
    if (!fresh) return true;
    if (PM_DONE_COLUMNS.has(fresh.column) || fresh.column === 'Backlog' || fresh.column === 'Ready') return true;
    // Thread the findings EXPLICITLY (not via lastError — rework clears that before re-reading the card)
    // through the SAME no-progress + attempt_count machinery the validation-fail path uses. fixPrompt
    // injects them into the fix prompt under its '[human request-changes]' branch.
    await this.rework(cardId, project, fresh.validationOutput, verdict.findings);
    return true;
  }

  /** The raw diff text of the worktree branch vs base (threaded into the Reviewer prompt). */
  private async diffText(worktreeDir: string, baseBranch: string): Promise<string> {
    const r = await gitExec(worktreeDir, ['-C', worktreeDir, 'diff', baseBranch], { maxBuffer: VALIDATION_MAX_BUFFER });
    return r.ok ? r.stdout : '';
  }
```

Now thread the explicit `reviewFindings` through `rework → launchFix → fixPrompt`. The real `rework` (pm.ts ~1348) sets `lastError: null` BEFORE re-reading the card and calling `launchFix`, so the re-read `fresh` card carries `lastError === null` — a findings string stashed in `lastError` before calling `rework` is DROPPED. Pass the findings as an explicit argument instead.

Change the `fixPrompt` helper (pm.ts ~181) to accept the reviewer findings explicitly, falling back to the existing `[human request-changes]` `lastError` branch (which the human `requestChanges` path still relies on):
```ts
/** Build a rework/fix prompt threading the failing validation output (SPEC §5.6). When a reviewer
 *  rejected the diff, `reviewFindings` carries the maker/checker verdict (SPEC §9) injected directly
 *  — it does NOT depend on lastError (rework clears that before relaunch). */
function fixPrompt(card: KanbanTask, reviewFindings?: string): string {
  const base = buildPrompt(card);
  const evidence = reviewFindings
    ? `\n\nA reviewer requested changes:\n${reviewFindings}`
    : card.lastError?.startsWith('[human request-changes]')
      ? `\n\nA reviewer requested changes:\n${card.lastError}`
      : '';
  const vout = card.validationOutput
    ? `\n\nThe previous attempt FAILED validation. Fix the issues so the validation command passes. ` +
      `Validation output (tail):\n${card.validationOutput}`
    : '\n\nThe previous attempt did not pass. Address the remaining issues.';
  return base + evidence + vout;
}
```

Change `launchFix` (pm.ts ~618) to forward the findings to `fixPrompt`:
```ts
  /** Relaunch a fix run for a card already in InProgress, threading validation output (SPEC §5.6)
   *  and, when a reviewer rejected the diff (SPEC §9), the reviewer findings. */
  private launchFix(card: KanbanTask, project: Project, reviewFindings?: string): boolean | Promise<boolean> {
```
and in its `registry.launch({ ... })` call change `prompt: fixPrompt(card),` to:
```ts
        prompt: fixPrompt(card, reviewFindings),
```

Change `rework` (pm.ts ~1348) to accept and forward the findings. Add the parameter to the signature:
```ts
  private async rework(cardId: string, project: Project, validationOutput: string | null, reviewFindings?: string): Promise<void> {
```
and at its tail change `if (fresh) await this.launchFix(fresh, project);` to:
```ts
    if (fresh) await this.launchFix(fresh, project, reviewFindings);
```
The no-progress guard and the attempt-cap branches are untouched — only the relaunch path threads the findings, so rework's reuse of `attempt_count`/`max_attempts` + `last_diff_hash` is preserved exactly.

NOTE: This is why `reviewGate` does NOT stash the findings in `lastError`: `rework` sets `lastError: null` (pm.ts ~1388) and only then re-reads the card to build the fix prompt, so a `lastError`-stashed string never reaches `fixPrompt`. The explicit `reviewFindings` argument threads the verdict straight into `fixPrompt`. The human `requestChanges` path is unchanged — it still relies on the `[human request-changes]`-prefixed `lastError` fallback in `fixPrompt`, which remains.

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/pm-worker.test.ts test/pm.test.ts`
 Expected: PASS (`✓ test/pm-worker.test.ts` reviewing cases + `✓ test/pm.test.ts` regression green)

- [ ] **Step 5: Commit**
 ```bash
git add apps/server/src/pm.ts apps/server/test/pm-worker.test.ts
git commit -m "feat: pm reviewing phase (maker/checker) in validateAndGate; reject->rework"
 ```

---

### Task 08.4: pm.ts — gate honors mergePosture (human-gate default; auto-low-risk bounded)

**Files:**
- Modify: `apps/server/src/pm.ts`
- Test: `apps/server/test/pm-worker.test.ts` (extend)

`mergePosture` defaults to `'human-gate'` (today's behavior: never auto-merge, never `prMerge`). `'auto-low-risk'` auto-merges ONLY when ALL hold: local merge mode, card `risk:low`, review passed (implied by reaching the gate), and the global `loopAutoMergeCeiling` permits `risk:low`. The PR path never auto-merges.

- [ ] **Step 1: Write the failing test** (append to `apps/server/test/pm-worker.test.ts`)
```ts
let registryGetConfig: any;
describe('pm gate — mergePosture (SPEC §11)', () => {
  it('human-gate (default) → a clean reviewed card parks in Review and main is UNTOUCHED (never merges)', async () => {
    const root = makeRepo('posture-human');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'human-gate' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:low'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const preHead = git(root, 'rev-parse', 'HEAD');
    const stub = stubLaunch((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review'); // human-gate parks
    expect(parked!.mergeSha).toBeFalsy(); // never merged
    expect(git(root, 'rev-parse', 'HEAD')).toBe(preHead); // main untouched
  });

  it('auto-low-risk + local mode + risk:low + global ceiling allows low → MERGED to main → Done', async () => {
    const root = makeRepo('posture-auto');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false }); // mergeMode defaults 'local'
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'auto-low-risk' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:low'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    // global ceiling: allow auto-merge up to risk:low.
    const cfg = registry.getConfig();
    registry.setConfig({ ...cfg, loopAutoMergeCeiling: 'low' });
    const stub = stubLaunch((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally {
      stub.restore();
      registry.setConfig(cfg);
    }
    const done = kanbanRepo.getTask(card.id);
    expect(done!.column).toBe('Done'); // auto-merged
    expect(done!.mergeSha).toBeTruthy();
    expect(git(root, 'ls-files')).toContain('feature.txt');
  });

  it('auto-low-risk but global ceiling OFF (null) → does NOT auto-merge; parks in Review', async () => {
    const root = makeRepo('posture-noceil');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'auto-low-risk' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:low'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const cfg = registry.getConfig();
    registry.setConfig({ ...cfg, loopAutoMergeCeiling: null }); // ceiling off
    const stub = stubLaunch((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); registry.setConfig(cfg); }
    const parked = kanbanRepo.getTask(card.id);
    expect(parked!.column).toBe('Review'); // ceiling off → not auto-merged
    expect(parked!.mergeSha).toBeFalsy();
  });

  it('auto-low-risk + risk:medium (above ceiling) → parks in Review (only risk:low auto-merges)', async () => {
    const root = makeRepo('posture-medium');
    const project = makeProject(root, { defaultBranch: 'master', autoMerge: false });
    makeWorkerLoop(project.id, { reviewPolicy: 'always', mergePosture: 'auto-low-risk' });
    const card = makeCard(project.id, { title: 'feat', column: 'InProgress', labels: ['risk:medium'] });
    const { wtName } = makeFinishedWorktree(root, card.id, (wt) => writeFileSync(join(wt, 'feature.txt'), 'x\n'));
    kanbanRepo.updateTask(card.id, { worktreeName: wtName });
    const cfg = registry.getConfig();
    registry.setConfig({ ...cfg, loopAutoMergeCeiling: 'low' });
    const stub = stubLaunch((req) => baseRun('rev', project.id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'ok' } }));
    try {
      await pm.validateAndGate(card.id, project);
    } finally { stub.restore(); registry.setConfig(cfg); }
    expect(kanbanRepo.getTask(card.id)!.column).toBe('Review'); // risk>ceiling → not auto-merged
    void registryGetConfig;
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/pm-worker.test.ts`
 Expected: FAIL ("auto-low-risk + local mode + risk:low ... → MERGED" fails — the gate still parks in Review because mergePosture is ignored)

- [ ] **Step 3: Implement**

Add a posture-eligibility helper near the other helpers in `pm.ts`:
```ts
/**
 * SPEC §11 — is a card eligible for auto-low-risk merge? ALL must hold: the loop opted into
 * 'auto-low-risk', the project is in LOCAL merge mode (the PR path NEVER auto-merges), the card is
 * labeled risk:low, and the GLOBAL loopAutoMergeCeiling permits risk:low (null = off → never). The
 * review pass is implied: this is only reached after reviewGate returned pass (or review was skipped).
 */
function autoLowRiskEligible(card: KanbanTask, project: Project, loop: Loop, ceiling: RiskLevel | null): boolean {
  if (loop.mergePosture !== 'auto-low-risk') return false;
  if (project.mergeMode === 'pr') return false; // PR path never auto-merges
  if (cardRisk(card) !== 'low') return false;
  if (ceiling == null) return false; // global ceiling off
  return RISK_RANK[cardRisk(card)] <= RISK_RANK[ceiling];
}
```

Add the `Loop` type to the `@fleet/shared` import already present at the top of `pm.ts` (it imports `type { Run, Project, KanbanTask, Campaign, ExecutionPhase }`):
```ts
import type { Run, Project, KanbanTask, Campaign, ExecutionPhase, Loop } from '@fleet/shared';
```

Now extend `gate` to honor the posture. Change the `gate` body:
```ts
    if (!project.autoMerge) {
      // STOP for a human Approve — park in Review (phase idle so the badge isn't "merging" yet).
      kanbanRepo.updateTask(cardId, { column: 'Review', executionPhase: 'idle', lastError: null });
      return;
    }
    // auto_merge: probe + merge under the per-project mutex (re-validate happens inside doMerge).
    await this.doMerge(cardId, project, /*humanApproved*/ false);
```
to:
```ts
    // SPEC §11 — a worker Loop's mergePosture can authorize a bounded auto-merge even when the
    // project's own autoMerge flag is off: 'auto-low-risk' merges only for LOCAL mode + risk:low +
    // (review already passed) + the global loopAutoMergeCeiling permitting risk:low. 'human-gate'
    // (default) preserves today's behavior exactly. The PR path never auto-merges (guarded in the
    // eligibility helper). When neither path authorizes a merge, park in Review for a human.
    const loop = loopsRepo.enabledByKind(project.id, 'worker')[0];
    const ceiling = (registry.getConfig() as any).loopAutoMergeCeiling as RiskLevel | null;
    const postureAuto = !!loop && autoLowRiskEligible(card, project, loop, ceiling);

    if (!project.autoMerge && !postureAuto) {
      // STOP for a human Approve — park in Review (phase idle so the badge isn't "merging" yet).
      kanbanRepo.updateTask(cardId, { column: 'Review', executionPhase: 'idle', lastError: null });
      return;
    }
    // auto_merge OR posture-authorized auto-low-risk: probe + merge under the per-project mutex
    // (re-validate happens inside doMerge).
    await this.doMerge(cardId, project, /*humanApproved*/ false);
```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/pm-worker.test.ts test/pm.test.ts test/pm-remote.test.ts`
 Expected: PASS (`✓ test/pm-worker.test.ts` posture cases + `✓ test/pm.test.ts` + `✓ test/pm-remote.test.ts` regression green)

- [ ] **Step 5: Commit**
 ```bash
git add apps/server/src/pm.ts apps/server/test/pm-worker.test.ts
git commit -m "feat: pm gate honors mergePosture (human-gate default; bounded auto-low-risk)"
 ```


---

## Slice 09: web

Build the apps/web Loops view — list (kind/control-plane/mode badges + enabled toggle), a six-field contract editor with EVALUATION-required SAVE gating + posture/policy/ceiling/rubric controls, and a per-loop detail view (recent fires, dry-run intended-action log, loopEval notes, assessment thread via `GET /api/tasks/:id/comments`, promote/demote) — wired into the nav rail. The web app has **no test runner** (`apps/web/package.json` exposes only `dev`/`build`/`start`/`typecheck`); per the slice brief, each task's "failing test" is a vitest structural guard in `apps/server/test/` (the only vitest project in the workspace), and the compile-proof is `pnpm --filter @fleet/web typecheck` / `pnpm --filter @fleet/web build`. All page code mirrors the `apps/web/app/schedules/page.tsx` pattern verbatim: a local `const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319'`, raw `fetch`, the alive-ref polling guard, and **locally-declared mirror types** (the page "cannot import from apps/server", and the Slice-1 shared `Loop`/`MergePosture`/etc. types may not be published to `@fleet/shared` when this slice runs).

**Files:**
- Create: `apps/web/app/loops/page.tsx` — Loops list + create form (kind, control-plane, schedule, contract editor, posture/policy/ceiling/rubric)
- Create: `apps/web/app/loops/[id]/page.tsx` — loop detail (recent fires, intended-action log, loopEval notes, assessment thread, promote/demote)
- Create: `apps/web/lib/loops.ts` — local Loops mirror types + `loopsApi` fetch helpers (CRUD + fire/promote/demote + comments)
- Create: `apps/web/components/ContractEditor.tsx` — the six-field contract editor with EVALUATION-required SAVE gating
- Modify: `apps/web/components/Shell.tsx` — add the Loops nav entry to the `NAV` array
- Test: `apps/server/test/web-loops.test.ts` — structural guards (files exist, export the right symbols, gate SAVE on empty evaluation, register the nav entry)

---

### Task 09.1: Loops mirror types + API helper (`lib/loops.ts`)

**Files:**
- Create: `apps/web/lib/loops.ts`
- Test: `apps/server/test/web-loops.test.ts`

- [ ] **Step 1: Write the failing test**
 ```ts
 // apps/server/test/web-loops.test.ts
 import { describe, it, expect } from 'vitest';
 import { readFileSync, existsSync } from 'node:fs';
 import { join } from 'node:path';

 // Web has no test runner (apps/web/package.json: only dev/build/start/typecheck).
 // These are structural guards run from the server's vitest project — they assert the
 // web files exist and carry the load-bearing strings, then `pnpm --filter @fleet/web build`
 // (Task 09.6) proves they actually compile.
 const WEB = join(process.cwd(), '..', 'web');
 const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

 describe('web loops — lib/loops.ts', () => {
   it('exists and exports loopsApi with the loop-engineering routes', () => {
     expect(existsSync(join(WEB, 'lib/loops.ts'))).toBe(true);
     const src = read('lib/loops.ts');
     expect(src).toMatch(/export const loopsApi/);
     // routes from spec §16
     expect(src).toContain("'/api/loops'");
     expect(src).toContain('/promote');
     expect(src).toContain('/demote');
     expect(src).toContain('/fire');
     expect(src).toContain('/comments');
   });

   it('mirrors the loop literal vocabulary locally (no cross-package import of unpublished types)', () => {
     const src = read('lib/loops.ts');
     expect(src).toContain("'manager'");
     expect(src).toContain("'worker'");
     expect(src).toContain("'board'");
     expect(src).toContain("'github'");
     expect(src).toContain("'dry-run'");
     expect(src).toContain("'apply'");
     expect(src).toContain("'human-gate'");
     expect(src).toContain("'auto-low-risk'");
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: FAIL ("ENOENT … lib/loops.ts" / `existsSync(...) === false`)

- [ ] **Step 3: Implement**
 ```ts
 // apps/web/lib/loops.ts
 // Local mirror of the loops wire shapes. The web app cannot import from apps/server, and the
 // Slice-1 shared Loop/contract types may not be published to @fleet/shared when this page ships,
 // so we mirror them here exactly like apps/web/app/schedules/page.tsx mirrors Schedule.
 const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

 export type RiskLevel = 'low' | 'medium' | 'high';
 export type LoopKind = 'manager' | 'worker';
 export type LoopMode = 'dry-run' | 'apply';
 export type ControlPlaneKind = 'board' | 'github';
 export type MergePosture = 'human-gate' | 'auto-low-risk';

 export interface LoopContract {
   job: string;
   inputs: string;
   allowed: string[];
   forbidden: string[];
   output: string;
   evaluation: string;
 }
 export interface RiskRule {
   glob: string;
   forceRisk: RiskLevel;
 }
 export interface LoopEvalResult {
   clean: boolean;
   score: number;
   notes: string;
 }
 export interface Loop {
   id: string;
   name: string;
   projectId: string;
   kind: LoopKind;
   controlPlane: ControlPlaneKind;
   scheduleId: string | null;
   contract: LoopContract;
   mode: LoopMode;
   consecutiveGoodRuns: number;
   escalationThreshold: number;
   mergePosture: MergePosture;
   reviewPolicy: string; // 'always' | 'off' | 'threshold:<N>'
   riskRubric: RiskRule[];
   routableCeiling: RiskLevel;
   enabled: boolean;
   lastRunId: string | null;
   lastEval: LoopEvalResult | null;
   lastError: string | null;
   createdAt: number;
 }
 export interface CreateLoopRequest {
   name: string;
   projectId: string;
   kind: LoopKind;
   controlPlane?: ControlPlaneKind;
   scheduleId?: string | null;
   contract: LoopContract;
   escalationThreshold?: number;
   mergePosture?: MergePosture;
   reviewPolicy?: string;
   riskRubric?: RiskRule[];
   routableCeiling?: RiskLevel;
 }

 /** card assessment thread (board adapter) — GET /api/tasks/:id/comments */
 export interface TaskComment {
   id: string;
   taskId: string;
   author: 'manager' | 'reviewer' | 'worker' | 'human';
   body: string;
   createdAt: number;
 }

 async function j<T>(path: string, init?: RequestInit): Promise<T> {
   // json content-type only when a body is sent — Fastify 400s an empty JSON-typed body
   // (mirrors apps/web/lib/api.ts and the schedules page helper).
   const r = await fetch(API + path, {
     ...(init?.body != null ? { headers: { 'content-type': 'application/json' } } : {}),
     ...init,
   });
   if (!r.ok) {
     let msg = r.statusText;
     try {
       const body = await r.json();
       msg = body.error ?? msg;
     } catch {
       /* ignore */
     }
     throw new Error(msg);
   }
   if (r.status === 204) return undefined as unknown as T;
   return r.json() as Promise<T>;
 }

 export const loopsApi = {
   list: () => j<Loop[]>('/api/loops'),
   get: (id: string) => j<Loop>(`/api/loops/${id}`),
   create: (body: CreateLoopRequest) => j<Loop>('/api/loops', { method: 'POST', body: JSON.stringify(body) }),
   update: (id: string, patch: Partial<CreateLoopRequest> & { enabled?: boolean }) =>
     j<Loop>(`/api/loops/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
   remove: (id: string) => j<void>(`/api/loops/${id}`, { method: 'DELETE' }),
   // Slice 02's POST /api/loops/:id/fire returns { ok, loop } (the refreshed Loop); runId stays
   // optional/legacy. The detail page only awaits this (then calls load()), so the wider shape is
   // backward-compatible — nothing here reads .runId.
   fire: (id: string) => j<{ ok: boolean; runId: string | null; loop?: Loop }>(`/api/loops/${id}/fire`, { method: 'POST', body: JSON.stringify({}) }),
   promote: (id: string) => j<Loop>(`/api/loops/${id}/promote`, { method: 'POST', body: JSON.stringify({}) }),
   demote: (id: string) => j<Loop>(`/api/loops/${id}/demote`, { method: 'POST', body: JSON.stringify({}) }),
   comments: (taskId: string) => j<TaskComment[]>(`/api/tasks/${taskId}/comments`),
 };
 ```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: PASS for "lib/loops.ts" cases (the page/editor/nav cases still FAIL until later tasks)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/web/lib/loops.ts apps/server/test/web-loops.test.ts
 git commit -m "feat(web): loops mirror types + loopsApi fetch helper"
 ```

---

### Task 09.2: Contract editor component (`components/ContractEditor.tsx`)

**Files:**
- Create: `apps/web/components/ContractEditor.tsx`
- Test: `apps/server/test/web-loops.test.ts`

- [ ] **Step 1: Write the failing test** (append a new `describe` block to the existing file)
 ```ts
 // apps/server/test/web-loops.test.ts  (append)
 describe('web loops — ContractEditor', () => {
   it('exists and gates SAVE on an empty evaluation field', () => {
     const p = join(process.cwd(), '..', 'web', 'components/ContractEditor.tsx');
     expect(existsSync(p)).toBe(true);
     const src = readFileSync(p, 'utf8');
     expect(src).toMatch(/export function ContractEditor/);
     // the six contract fields
     for (const f of ['job', 'inputs', 'allowed', 'forbidden', 'output', 'evaluation']) {
       expect(src).toContain(f);
     }
     // SAVE disabled while evaluation is empty (spec §3 / §17)
     expect(src).toMatch(/evaluation\.trim\(\)/);
     // posture / policy / ceiling / rubric controls
     expect(src).toContain('mergePosture');
     expect(src).toContain('reviewPolicy');
     expect(src).toContain('routableCeiling');
     expect(src).toContain('riskRubric');
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: FAIL ("ContractEditor" block — `existsSync(...) === false`)

- [ ] **Step 3: Implement**
 ```tsx
 // apps/web/components/ContractEditor.tsx
 'use client';
 import React, { useState } from 'react';
 import { Kicker, Field, Input, Textarea, Select, Btn } from '@/components/ui';
 import type {
   LoopContract,
   RiskRule,
   RiskLevel,
   MergePosture,
 } from '@/lib/loops';

 /** the editable shape this component owns; the parent maps it onto CreateLoopRequest. */
 export interface ContractDraft {
   contract: LoopContract;
   mergePosture: MergePosture;
   reviewPolicy: string;
   routableCeiling: RiskLevel;
   riskRubric: RiskRule[];
   escalationThreshold: number;
 }

 export const DEFAULT_DRAFT: ContractDraft = {
   contract: { job: '', inputs: '', allowed: [], forbidden: [], output: '', evaluation: '' },
   mergePosture: 'human-gate',
   reviewPolicy: 'always',
   routableCeiling: 'low',
   riskRubric: [],
   escalationThreshold: 3,
 };

 /** newline-or-comma list ⇄ string[] (allowed/forbidden tool patterns). */
 const toList = (s: string): string[] =>
   s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
 const fromList = (xs: string[]): string => xs.join('\n');

 export function ContractEditor({
   draft,
   onChange,
   onSave,
   saving,
   saveLabel = 'Save Contract',
 }: {
   draft: ContractDraft;
   onChange: (d: ContractDraft) => void;
   onSave: () => void;
   saving?: boolean;
   saveLabel?: string;
 }) {
   const c = draft.contract;
   // EVALUATION required — "if you can't grade it, you're not ready to run it autonomously" (spec §3).
   const evalEmpty = !c.evaluation.trim();
   const setContract = (patch: Partial<LoopContract>) =>
     onChange({ ...draft, contract: { ...c, ...patch } });

   // local raw text for the two pattern lists so typing commas/newlines is smooth
   const [allowedRaw, setAllowedRaw] = useState(fromList(c.allowed));
   const [forbiddenRaw, setForbiddenRaw] = useState(fromList(c.forbidden));

   function addRule() {
     onChange({ ...draft, riskRubric: [...draft.riskRubric, { glob: '', forceRisk: 'high' }] });
   }
   function setRule(i: number, patch: Partial<RiskRule>) {
     onChange({
       ...draft,
       riskRubric: draft.riskRubric.map((r, ix) => (ix === i ? { ...r, ...patch } : r)),
     });
   }
   function removeRule(i: number) {
     onChange({ ...draft, riskRubric: draft.riskRubric.filter((_, ix) => ix !== i) });
   }

   return (
     <div className="grid gap-3.5">
       <Kicker>contract · the six-field pre-flight card</Kicker>

       <Field label="job" hint="the single responsibility">
         <Textarea rows={2} value={c.job} onChange={(e) => setContract({ job: e.target.value })} placeholder="triage the backlog by risk + type" />
       </Field>
       <Field label="inputs" hint="what STATE it inspects">
         <Textarea rows={2} value={c.inputs} onChange={(e) => setContract({ inputs: e.target.value })} placeholder="open Backlog cards + repo context" />
       </Field>

       <Field label="allowed" hint="tool patterns it MAY use · one per line">
         <Textarea
           rows={3}
           value={allowedRaw}
           onChange={(e) => { setAllowedRaw(e.target.value); setContract({ allowed: toList(e.target.value) }); }}
           placeholder={'Read\nGrep\nBash(git diff *)'}
         />
       </Field>
       <Field label="forbidden" hint="patterns it must NEVER use · merged on top of the project deny-list">
         <Textarea
           rows={3}
           value={forbiddenRaw}
           onChange={(e) => { setForbiddenRaw(e.target.value); setContract({ forbidden: toList(e.target.value) }); }}
           placeholder={'Edit\nWrite\nBash(git push *)'}
         />
       </Field>

       <Field label="output" hint="the concrete artifact after a good run">
         <Textarea rows={2} value={c.output} onChange={(e) => setContract({ output: e.target.value })} placeholder="every item labeled + an Agent Assessment comment" />
       </Field>
       <Field label="evaluation" hint="REQUIRED — how we grade success">
         <Textarea
           rows={2}
           value={c.evaluation}
           onChange={(e) => setContract({ evaluation: e.target.value })}
           placeholder="no risk:high marked agent:ready; every verdict reason is evidence-backed"
           className={evalEmpty ? 'border-sig-failed/50' : ''}
         />
         {evalEmpty && (
           <div className="text-sig-failed font-mono text-[10px] mt-1">
             evaluation is required — a loop you can&rsquo;t grade can&rsquo;t run autonomously
           </div>
         )}
       </Field>

       <div className="border-t hairline pt-3 grid grid-cols-2 gap-3">
         <Field label="merge posture" hint="human-gate never merges">
           <Select value={draft.mergePosture} onChange={(e) => onChange({ ...draft, mergePosture: e.target.value as MergePosture })}>
             <option value="human-gate">human-gate</option>
             <option value="auto-low-risk">auto-low-risk</option>
           </Select>
         </Field>
         <Field label="routable ceiling" hint="max risk markable agent:ready">
           <Select value={draft.routableCeiling} onChange={(e) => onChange({ ...draft, routableCeiling: e.target.value as RiskLevel })}>
             <option value="low">low</option>
             <option value="medium">medium</option>
             <option value="high">high</option>
           </Select>
         </Field>
         <Field label="review policy" hint="always | off | threshold:N">
           <Input value={draft.reviewPolicy} onChange={(e) => onChange({ ...draft, reviewPolicy: e.target.value })} placeholder="always" />
         </Field>
         <Field label="escalation threshold" hint="clean dry-runs → auto-apply">
           <Input
             type="number"
             min={1}
             value={String(draft.escalationThreshold)}
             onChange={(e) => onChange({ ...draft, escalationThreshold: Number(e.target.value) || 1 })}
           />
         </Field>
       </div>

       <Field label="risk rubric" hint="path globs forced to a risk floor (overrides the agent)">
         <div className="grid gap-2">
           {draft.riskRubric.map((r, i) => (
             <div key={i} className="flex items-center gap-2">
               <Input value={r.glob} onChange={(e) => setRule(i, { glob: e.target.value })} placeholder="**/auth/**" className="flex-1" />
               <Select value={r.forceRisk} onChange={(e) => setRule(i, { forceRisk: e.target.value as RiskLevel })} className="w-28">
                 <option value="low">low</option>
                 <option value="medium">medium</option>
                 <option value="high">high</option>
               </Select>
               <Btn variant="danger" onClick={() => removeRule(i)} className="!px-2 !py-1">✕</Btn>
             </div>
           ))}
           <Btn variant="ghost" onClick={addRule} className="justify-center">＋ add rule</Btn>
         </div>
       </Field>

       <Btn type="button" variant="solid" onClick={onSave} disabled={saving || evalEmpty} className="w-full justify-center" title={evalEmpty ? 'evaluation is required' : undefined}>
         {saving ? 'saving…' : saveLabel}
       </Btn>
     </div>
   );
 }
 ```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: PASS for the "ContractEditor" block

- [ ] **Step 5: Commit**
 ```bash
 git add apps/web/components/ContractEditor.tsx apps/server/test/web-loops.test.ts
 git commit -m "feat(web): six-field contract editor with EVALUATION-required save gating"
 ```

---

### Task 09.3: Loops list + create page (`app/loops/page.tsx`)

**Files:**
- Create: `apps/web/app/loops/page.tsx`
- Test: `apps/server/test/web-loops.test.ts`

- [ ] **Step 1: Write the failing test** (append)
 ```ts
 // apps/server/test/web-loops.test.ts  (append)
 describe('web loops — list page', () => {
   it('exists, default-exports a page, and renders the three badge dimensions + toggle', () => {
     const p = join(process.cwd(), '..', 'web', 'app/loops/page.tsx');
     expect(existsSync(p)).toBe(true);
     const src = readFileSync(p, 'utf8');
     expect(src).toMatch(/export default function LoopsPage/);
     expect(src).toContain("'use client'");
     // badges: kind + control-plane + mode (with N/threshold counter), enabled toggle
     expect(src).toContain('kind');
     expect(src).toContain('controlPlane');
     expect(src).toContain('consecutiveGoodRuns');
     expect(src).toContain('escalationThreshold');
     expect(src).toContain('<Toggle');
     // uses the editor + api helper
     expect(src).toContain('ContractEditor');
     expect(src).toContain('loopsApi');
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: FAIL ("list page" block — `existsSync(...) === false`)

- [ ] **Step 3: Implement**
 ```tsx
 // apps/web/app/loops/page.tsx
 'use client';
 import React, { useEffect, useRef, useState } from 'react';
 import Link from 'next/link';
 import type { Project } from '@fleet/shared';
 import { Kicker, Panel, Empty, Btn, Field, Input, Select, Toggle, Dot } from '@/components/ui';
 import { ContractEditor, DEFAULT_DRAFT, type ContractDraft } from '@/components/ContractEditor';
 import { loopsApi, type Loop, type LoopKind, type ControlPlaneKind, type CreateLoopRequest } from '@/lib/loops';

 const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

 const KIND_COLOR: Record<LoopKind, string> = { manager: '#7aa2ff', worker: '#54e08a' };
 const CP_COLOR: Record<ControlPlaneKind, string> = { board: '#ffb000', github: '#c792ea' };

 function Badge({ text, color }: { text: string; color: string }) {
   return (
     <span
       className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border"
       style={{ color, borderColor: `${color}50`, background: `${color}10` }}
     >
       {text}
     </span>
   );
 }

 function modeLabel(l: Loop): string {
   return l.mode === 'apply' ? 'apply' : `dry-run ${l.consecutiveGoodRuns}/${l.escalationThreshold}`;
 }

 export default function LoopsPage() {
   const [loops, setLoops] = useState<Loop[]>([]);
   const [projects, setProjects] = useState<Project[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState<string | null>(null);

   // create form
   const [name, setName] = useState('');
   const [projectId, setProjectId] = useState('');
   const [kind, setKind] = useState<LoopKind>('manager');
   const [controlPlane, setControlPlane] = useState<ControlPlaneKind>('board');
   const [draft, setDraft] = useState<ContractDraft>(DEFAULT_DRAFT);
   const [submitting, setSubmitting] = useState(false);
   const [formErr, setFormErr] = useState<string | null>(null);

   const aliveRef = useRef(true);
   useEffect(() => {
     aliveRef.current = true;
     return () => { aliveRef.current = false; };
   }, []);

   async function load() {
     setError(null);
     try {
       const list = await loopsApi.list();
       if (aliveRef.current) setLoops(list);
     } catch (e: any) {
       if (aliveRef.current) setError(e?.message ?? 'failed to load loops');
     } finally {
       if (aliveRef.current) setLoading(false);
     }
   }

   useEffect(() => {
     load();
     fetch(API + '/api/projects')
       .then((r) => (r.ok ? r.json() : []))
       .then((list: Project[]) => {
         if (!aliveRef.current) return;
         setProjects(list);
         if (list[0]?.id) setProjectId((cur) => cur || list[0].id);
       })
       .catch(() => { /* projects optional */ });
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);

   async function create() {
     setFormErr(null);
     if (!name.trim()) return setFormErr('name is required');
     if (!projectId) return setFormErr('project is required');
     if (!draft.contract.evaluation.trim()) return setFormErr('contract evaluation is required');
     const body: CreateLoopRequest = {
       name: name.trim(),
       projectId,
       kind,
       controlPlane,
       contract: draft.contract,
       escalationThreshold: draft.escalationThreshold,
       mergePosture: draft.mergePosture,
       reviewPolicy: draft.reviewPolicy,
       routableCeiling: draft.routableCeiling,
       riskRubric: draft.riskRubric,
     };
     setSubmitting(true);
     try {
       await loopsApi.create(body);
       setName('');
       setDraft(DEFAULT_DRAFT);
       await load();
     } catch (e: any) {
       setFormErr(e?.message ?? 'failed to create loop');
     } finally {
       setSubmitting(false);
     }
   }

   async function toggle(l: Loop) {
     try {
       const updated = await loopsApi.update(l.id, { enabled: !l.enabled });
       setLoops((prev) => prev.map((x) => (x.id === l.id ? updated : x)));
     } catch (e: any) {
       setError(e?.message ?? 'failed to update loop');
     }
   }

   async function remove(l: Loop) {
     if (!confirm(`Delete loop "${l.name}"? This cannot be undone.`)) return;
     try {
       await loopsApi.remove(l.id);
       setLoops((prev) => prev.filter((x) => x.id !== l.id));
     } catch (e: any) {
       setError(e?.message ?? 'failed to delete loop');
     }
   }

   return (
     <div>
       <Kicker>loop engineering</Kicker>
       <h1 className="font-display text-[26px] tracking-wide text-ink mt-1 mb-5">Loops</h1>

       <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
         {/* ── loop list ─────────────────────────────────────────── */}
         <div>
           {error && (
             <div className="mb-3 border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[11px] px-3 py-2">{error}</div>
           )}
           {loading ? (
             <div className="font-mono text-faint text-[12px]">loading loops…</div>
           ) : loops.length === 0 ? (
             <Empty>No loops yet — define a Manager (triage) or Worker loop with a six-field contract to run agents on a schedule.</Empty>
           ) : (
             <div className="grid gap-3">
               {loops.map((l) => (
                 <Panel key={l.id} className="p-4" style={{ borderLeft: `2px solid ${l.enabled ? KIND_COLOR[l.kind] : '#5b626d'}` }}>
                   <div className="flex items-start justify-between gap-4">
                     <div className="min-w-0">
                       <div className="flex items-center gap-2.5 flex-wrap">
                         <Link href={`/loops/${l.id}`} className="font-display text-[14px] tracking-wide text-ink hover:text-amber">{l.name}</Link>
                         <Badge text={l.kind} color={KIND_COLOR[l.kind]} />
                         <Badge text={l.controlPlane} color={CP_COLOR[l.controlPlane]} />
                         <Badge text={modeLabel(l)} color={l.mode === 'apply' ? '#54e08a' : '#ffb000'} />
                       </div>
                       <div className="font-mono text-[11px] text-faint mt-1.5 flex items-center gap-2">
                         {l.lastEval ? (
                           <span style={{ color: l.lastEval.clean ? '#54e08a' : '#ff7a45' }}>
                             eval {l.lastEval.clean ? 'clean' : 'flagged'} · {l.lastEval.score.toFixed(2)}
                           </span>
                         ) : (
                           <span className="text-faint">no eval yet</span>
                         )}
                         {l.lastError && <span className="text-sig-failed truncate">⚠ {l.lastError}</span>}
                       </div>
                     </div>
                     <div className="flex items-center gap-2 shrink-0">
                       <Toggle on={l.enabled} onChange={() => toggle(l)} label={l.enabled ? 'on' : 'off'} />
                       <Link
                         href={`/loops/${l.id}`}
                         className="font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5 inline-flex items-center"
                       >
                         Detail →
                       </Link>
                       <Btn variant="danger" onClick={() => remove(l)} title="delete" className="!px-2 !py-1">✕</Btn>
                     </div>
                   </div>
                 </Panel>
               ))}
             </div>
           )}
         </div>

         {/* ── create form ───────────────────────────────────────── */}
         <Panel className="p-4 self-start">
           <Kicker>new loop</Kicker>
           <div className="mt-3 grid gap-3.5">
             <Field label="name">
               <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="backlog triage" />
             </Field>
             <Field label="project">
               <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                 <option value="">— select —</option>
                 {projects.map((p) => (
                   <option key={p.id} value={p.id}>{p.name}</option>
                 ))}
               </Select>
             </Field>
             <div className="grid grid-cols-2 gap-3">
               <Field label="kind">
                 <Select value={kind} onChange={(e) => setKind(e.target.value as LoopKind)}>
                   <option value="manager">manager</option>
                   <option value="worker">worker</option>
                 </Select>
               </Field>
               <Field label="control plane">
                 <Select value={controlPlane} onChange={(e) => setControlPlane(e.target.value as ControlPlaneKind)}>
                   <option value="board">board</option>
                   <option value="github">github</option>
                 </Select>
               </Field>
             </div>

             <div className="border-t hairline pt-3">
               <ContractEditor draft={draft} onChange={setDraft} onSave={create} saving={submitting} saveLabel="＋ Create Loop" />
             </div>

             {formErr && <div className="text-sig-failed font-mono text-[11px]">{formErr}</div>}
           </div>
         </Panel>
       </div>
     </div>
   );
 }
 ```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: PASS for the "list page" block

- [ ] **Step 5: Commit**
 ```bash
 git add apps/web/app/loops/page.tsx apps/server/test/web-loops.test.ts
 git commit -m "feat(web): loops list + create page with kind/control-plane/mode badges"
 ```

---

### Task 09.4: Loop detail page (`app/loops/[id]/page.tsx`)

**Files:**
- Create: `apps/web/app/loops/[id]/page.tsx`
- Test: `apps/server/test/web-loops.test.ts`

- [ ] **Step 1: Write the failing test** (append)
 ```ts
 // apps/server/test/web-loops.test.ts  (append)
 describe('web loops — detail page', () => {
   it('exists and wires promote/demote, last-eval notes, and the assessment thread', () => {
     const p = join(process.cwd(), '..', 'web', 'app/loops/[id]/page.tsx');
     expect(existsSync(p)).toBe(true);
     const src = readFileSync(p, 'utf8');
     expect(src).toMatch(/export default function LoopDetailPage/);
     expect(src).toContain('loopsApi.promote');
     expect(src).toContain('loopsApi.demote');
     expect(src).toContain('loopsApi.fire');
     // last-eval notes + assessment thread
     expect(src).toContain('lastEval');
     expect(src).toContain('loopsApi.comments');
     // dry-run intended-action log
     expect(src).toContain('lastRunId');
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: FAIL ("detail page" block — `existsSync(...) === false`)

- [ ] **Step 3: Implement**
 ```tsx
 // apps/web/app/loops/[id]/page.tsx
 'use client';
 import React, { useEffect, useState } from 'react';
 import Link from 'next/link';
 import { Kicker, Panel, Empty, Btn, Stat, Dot } from '@/components/ui';
 import { ago, clock } from '@/lib/format';
 import { loopsApi, type Loop, type TaskComment } from '@/lib/loops';

 const AUTHOR_COLOR: Record<TaskComment['author'], string> = {
   manager: '#7aa2ff',
   reviewer: '#c792ea',
   worker: '#54e08a',
   human: '#ffb000',
 };

 export default function LoopDetailPage({ params }: { params: { id: string } }) {
   const { id } = params;
   const [loop, setLoop] = useState<Loop | null>(null);
   const [comments, setComments] = useState<TaskComment[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);

   async function load() {
     setError(null);
     try {
       const l = await loopsApi.get(id);
       setLoop(l);
       // board adapter assessment thread keys off the loop's last run target; the comments route
       // is task-scoped, so we surface the thread for the loop's most-recent run when present.
       if (l.lastRunId) {
         try {
           setComments(await loopsApi.comments(l.lastRunId));
         } catch {
           setComments([]);
         }
       }
     } catch (e: any) {
       setError(e?.message ?? 'failed to load loop');
     } finally {
       setLoading(false);
     }
   }

   useEffect(() => {
     load();
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [id]);

   async function promote() {
     setBusy(true);
     try { setLoop(await loopsApi.promote(id)); } catch (e: any) { setError(e?.message ?? 'promote failed'); } finally { setBusy(false); }
   }
   async function demote() {
     setBusy(true);
     try { setLoop(await loopsApi.demote(id)); } catch (e: any) { setError(e?.message ?? 'demote failed'); } finally { setBusy(false); }
   }
   async function fire() {
     setBusy(true);
     try { await loopsApi.fire(id); await load(); } catch (e: any) { setError(e?.message ?? 'fire failed'); } finally { setBusy(false); }
   }

   if (loading) return <div className="font-mono text-faint text-[12px]">loading loop…</div>;
   if (!loop) return (
     <div>
       <Link href="/loops" className="font-mono text-[11px] text-faint hover:text-amber">← loops</Link>
       <div className="mt-3 font-mono text-sig-failed text-[12px]">{error ?? 'loop not found'}</div>
     </div>
   );

   return (
     <div>
       <Link href="/loops" className="font-mono text-[11px] text-faint hover:text-amber">← loops</Link>
       <div className="flex items-start justify-between gap-4 mt-2 mb-5">
         <div>
           <Kicker>{loop.kind} · {loop.controlPlane}</Kicker>
           <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">{loop.name}</h1>
         </div>
         <div className="flex items-center gap-2 shrink-0">
           <Btn variant="ghost" onClick={fire} disabled={busy} title="run one fire now">⚡ Fire</Btn>
           {loop.mode === 'dry-run' ? (
             <Btn variant="amber" onClick={promote} disabled={busy} title="flip dry-run → apply">▲ Promote</Btn>
           ) : (
             <Btn variant="ghost" onClick={demote} disabled={busy} title="flip apply → dry-run">▼ Demote</Btn>
           )}
         </div>
       </div>

       {error && <div className="mb-3 border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[11px] px-3 py-2">{error}</div>}

       <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px' }}>
         <div className="grid gap-4">
           {/* recent fires + intended-action log */}
           <Panel className="p-4">
             <Kicker>most recent fire</Kicker>
             {loop.lastRunId ? (
               <div className="mt-2 font-mono text-[11px]">
                 <Link href={`/runs/${loop.lastRunId}`} className="text-amber/80 hover:text-amber">open run {loop.lastRunId.slice(0, 8)} →</Link>
                 <div className="text-faint mt-1">
                   {loop.mode === 'dry-run'
                     ? 'dry-run — intended writes were logged to the run timeline, no state changed'
                     : 'apply — real writes performed'}
                 </div>
               </div>
             ) : (
               <Empty>never fired</Empty>
             )}
           </Panel>

           {/* loopEval notes */}
           <Panel className="p-4">
             <Kicker>last eval</Kicker>
             {loop.lastEval ? (
               <div className="mt-2">
                 <div className="flex items-center gap-2 font-mono text-[11px]">
                   <Dot color={loop.lastEval.clean ? '#54e08a' : '#ff7a45'} live={false} size={6} />
                   <span style={{ color: loop.lastEval.clean ? '#54e08a' : '#ff7a45' }}>{loop.lastEval.clean ? 'clean' : 'flagged'}</span>
                   <span className="text-faint">· score {loop.lastEval.score.toFixed(2)}</span>
                 </div>
                 <div className="mt-2 font-mono text-[11px] text-dim whitespace-pre-wrap leading-snug">{loop.lastEval.notes}</div>
               </div>
             ) : (
               <Empty>no eval yet — graded after each dry-run fire</Empty>
             )}
           </Panel>

           {/* assessment thread (board adapter) */}
           <Panel className="p-4">
             <Kicker>agent assessment thread</Kicker>
             {comments.length === 0 ? (
               <Empty>no assessments yet</Empty>
             ) : (
               <div className="mt-2 grid gap-3">
                 {comments.map((cm) => (
                   <div key={cm.id} className="border-l-2 pl-3" style={{ borderColor: AUTHOR_COLOR[cm.author] }}>
                     <div className="flex items-center gap-2 font-mono text-[10px]">
                       <span style={{ color: AUTHOR_COLOR[cm.author] }} className="uppercase tracking-wider">{cm.author}</span>
                       <span className="text-faint">{clock(cm.createdAt)}</span>
                     </div>
                     <div className="mt-1 font-mono text-[11px] text-dim whitespace-pre-wrap leading-snug">{cm.body}</div>
                   </div>
                 ))}
               </div>
             )}
           </Panel>
         </div>

         {/* config sidebar */}
         <Panel className="p-4 self-start grid gap-3">
           <Stat label="mode" value={loop.mode === 'apply' ? 'apply' : `dry-run ${loop.consecutiveGoodRuns}/${loop.escalationThreshold}`} accent={loop.mode === 'apply' ? '#54e08a' : '#ffb000'} />
           <Stat label="merge posture" value={loop.mergePosture} />
           <Stat label="review policy" value={loop.reviewPolicy} />
           <Stat label="routable ceiling" value={loop.routableCeiling} />
           <Stat label="enabled" value={loop.enabled ? 'on' : 'off'} accent={loop.enabled ? '#54e08a' : '#5b626d'} />
           <Stat label="created" value={ago(loop.createdAt)} />
           <div>
             <Kicker>risk rubric</Kicker>
             {loop.riskRubric.length === 0 ? (
               <div className="font-mono text-[10px] text-faint mt-1">none</div>
             ) : (
               <div className="mt-1.5 grid gap-1 font-mono text-[10px]">
                 {loop.riskRubric.map((r, i) => (
                   <div key={i} className="flex items-center justify-between border border-line px-1.5 py-0.5">
                     <span className="text-dim truncate">{r.glob}</span>
                     <span className="text-amber">{r.forceRisk}</span>
                   </div>
                 ))}
               </div>
             )}
           </div>
         </Panel>
       </div>
     </div>
   );
 }
 ```

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: PASS for the "detail page" block

- [ ] **Step 5: Commit**
 ```bash
 git add "apps/web/app/loops/[id]/page.tsx" apps/server/test/web-loops.test.ts
 git commit -m "feat(web): loop detail with fires, eval notes, assessment thread, promote/demote"
 ```

---

### Task 09.5: Loops nav entry (`components/Shell.tsx`)

**Files:**
- Modify: `apps/web/components/Shell.tsx`
- Test: `apps/server/test/web-loops.test.ts`

- [ ] **Step 1: Write the failing test** (append)
 ```ts
 // apps/server/test/web-loops.test.ts  (append)
 describe('web loops — nav entry', () => {
   it('Shell.tsx NAV array carries a /loops entry', () => {
     const src = readFileSync(join(process.cwd(), '..', 'web', 'components/Shell.tsx'), 'utf8');
     expect(src).toContain("href: '/loops'");
     expect(src).toContain("label: 'Loops'");
   });
 });
 ```

- [ ] **Step 2: Run it, expect FAIL**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: FAIL ("nav entry" block — `expect(src).toContain("href: '/loops'")`)

- [ ] **Step 3: Implement** — add the entry to the `NAV` array in `apps/web/components/Shell.tsx`. The array begins at line 13; insert the Loops entry directly after the `/orchestrate` line (line 19) so it sits with the build/automation group:
 ```tsx
   { href: '/orchestrate', label: 'Orchestrate', glyph: '⛓' },
   { href: '/loops', label: 'Loops', glyph: '∞' },
   { href: '/templates', label: 'Templates', glyph: '⊞' },
 ```
 (Edit: replace the single existing `{ href: '/orchestrate', label: 'Orchestrate', glyph: '⛓' },` line with the three lines above — only the `/loops` line is new; `/orchestrate` and `/templates` are unchanged context to keep the Edit anchor unique.)

- [ ] **Step 4: Run it, expect PASS**
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: PASS for the "nav entry" block (and all prior blocks remain green)

- [ ] **Step 5: Commit**
 ```bash
 git add apps/web/components/Shell.tsx apps/server/test/web-loops.test.ts
 git commit -m "feat(web): add Loops nav entry to the rail"
 ```

---

### Task 09.6: Compile-proof — typecheck + build the web app

**Files:**
- Test: `apps/web` (build) — no new source; proves the four new/edited files compile against `@fleet/shared` + `@/` and Next.js' app-router types.

- [ ] **Step 1: Write the failing test** — the proof is the real Next.js build. First confirm the structural guards are all green (the prior tasks), then run the type/build gate. (No vitest spec here: `next build` IS the test — it fails the slice if any of the new TSX has a type error, an unresolved `@/` import, or an invalid `'use client'` boundary.)
 Run: `cd apps/server && npx vitest run test/web-loops.test.ts`
 Expected: PASS — all five describe blocks (lib/loops, ContractEditor, list page, detail page, nav entry) green before attempting the build.

- [ ] **Step 2: Run the typecheck, expect FAIL first if anything is off**
 Run: `pnpm --filter @fleet/web typecheck`
 Expected: if a type mismatch exists (e.g. a badge map missing a union member, a `params` typo), `tsc --noEmit` exits non-zero and prints the offending file:line — fix before proceeding. On a clean slice this PASSES (exit 0, no output).

- [ ] **Step 3: Implement** — there is no new code in this task; it only runs the gates. If `typecheck`/`build` reports an error, fix it in the offending file from Tasks 09.1–09.5 (these are the most likely: a `RiskLevel`/`LoopKind` union value missing from a `Record<...>` map, or a `@/lib/loops` export name typo). Re-run until green.

- [ ] **Step 4: Run the build, expect PASS**
 Run: `pnpm --filter @fleet/web build`
 Expected: PASS — `next build` output ends with `✓ Compiled successfully` and a route table listing the new routes `/loops` and `/loops/[id]` (both as `○ (Static)` or `ƒ (Dynamic)` client pages). Exit 0.

- [ ] **Step 5: Commit**
 ```bash
 git add -A
 git commit -m "test(web): verify loops view typechecks and builds"
 ```
