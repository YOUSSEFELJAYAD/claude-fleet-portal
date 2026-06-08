# Research-Augmented Planning (Discovery phase) — findings

## Integration point (verified in code)
- campaigns.ts `create()` lines 132-146: orchestrator launched immediately with bare prompt + `orchT.systemPrompt` as appendSystemPrompt + PLAN_JSON_SCHEMA.
- handleRunTerminal lines 154-169 special-cases orchestratorRunId / synthesizerRunId. Discovery = new branch here, mirroring synthesizer (311-338).
- registry.launch passes req.skills, appendSystemPrompt, jsonSchema, budgetUsd, campaignId.

## Mechanism
1. Add Campaign.researchRunId + 'researching' status (shared types + db migration like structured_output ALTER, db.ts 157-166).
2. create(): if config.autoLearnResearch, launch DISCOVERY run FIRST (Researcher-like template + deep-research skill, context7 MCP, Grep/Glob, WebSearch/WebFetch), with its own discovery json-schema (mirror PLAN_JSON_SCHEMA) and small budget. status='researching'.
3. handleRunTerminal: special-case researchRunId BEFORE planning branch; on completion read run.structuredOutput (the brief), then launch orchestrator with brief prepended to prompt AND injected via appendSystemPrompt (orchT.systemPrompt + "\n\n## RESEARCH BRIEF\n" + brief). status='planning'.
4. Cache brief in personal-rag (save_text keyed by objective hash) + search before launching discovery; skip discovery on cache hit.

## Verified flag semantics (context7 /websites/code_claude)
- `claude -p --json-schema '{...}' --output-format json` validates structured output. (cli-reference, headless)
- `--append-system-prompt` and `--append-system-prompt-file ./file.txt` both real — use the file variant for large briefs to avoid shell escaping.
- `--agents '{...}'` defines ephemeral subagents inline (sub-agents, cli-reference).
- Skills auto-trigger in non-interactive mode BUT require setting_sources=["user","project"] + skills="all" loaded from filesystem (agent-sdk/skills). RISK: portal passes specific skill NAMES via LaunchRequest.skills.

## Skill availability (verified on disk)
- ~/.claude/skills/ has only graphify + merging-through-branch-protection.
- deep-research is a PLUGIN skill (in available-skills list, not in ~/.claude/skills/). RISK: must verify a headless run spawned in campaign cwd can resolve a plugin-namespaced skill; fallback = inline the deep-research steps (fan-out search/verify/synthesize) directly in the discovery prompt.

## Prior art (verified URLs)
- Anthropic, Building effective agents: https://www.anthropic.com/news/building-effective-agents — augmented LLM (retrieval+tools+memory) + orchestrator-workers.
- Anthropic, How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system — lead agent thinks/plans + saves plan to Memory BEFORE spawning subagents; scales effort by complexity.
- Microsoft Magentic-One: https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ + arxiv 2411.04468 — Orchestrator builds a Task Ledger (verified facts, facts-to-look-up, guesses) BEFORE deriving the plan. Closest production analog to a discovery step.
- RAP: Retrieval-Augmented Planning, arxiv 2402.03610 — retrieve past experiences to inform current plan (academic anchor; ties to learn-from-past).
- Plan*RAG / Plan×RAG, arxiv 2410.20753 — plan-then-retrieve over a DAG of sub-queries; matches research-then-plan over a task DAG.

## Risks
- Cost/latency: +1 agent run per campaign. Mitigate: budget cap, personal-rag cache, config toggle.
- Brief bloat: inject distilled synthesis (deep-research verifies+synthesizes), schema-bounded, not raw dumps.
- Headless skill triggering unreliable for plugin skills → inline fallback.
- Stale/wrong brief poisons the plan: keep brief advisory ("consider"), orchestrator still owns the DAG.
