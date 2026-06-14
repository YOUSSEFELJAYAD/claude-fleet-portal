---
name: spec-plan-implement-feature
description: Workflow command scaffold for spec-plan-implement-feature in claude-fleet-portal.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /spec-plan-implement-feature

Use this workflow when working on **spec-plan-implement-feature** in `claude-fleet-portal`.

## Goal

A workflow for designing and implementing a new major feature or redesign, starting with a specification, followed by an implementation plan, and then iterative implementation and refinement in the main site file.

## Common Files

- `docs/superpowers/specs/*.md`
- `docs/superpowers/plans/*.md`
- `site/index.html`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Write a specification document describing the feature or redesign in docs/superpowers/specs/
- Write an implementation plan in docs/superpowers/plans/
- Iteratively implement the feature in site/index.html, making multiple commits for feature additions and bug fixes

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.