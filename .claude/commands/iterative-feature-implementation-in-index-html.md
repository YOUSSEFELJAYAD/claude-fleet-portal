---
name: iterative-feature-implementation-in-index-html
description: Workflow command scaffold for iterative-feature-implementation-in-index-html in claude-fleet-portal.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /iterative-feature-implementation-in-index-html

Use this workflow when working on **iterative-feature-implementation-in-index-html** in `claude-fleet-portal`.

## Goal

A workflow for incrementally building and refining a complex feature directly in the main site/index.html file, with multiple small commits for each sub-feature or fix.

## Common Files

- `site/index.html`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Implement a sub-feature or design token in site/index.html
- Commit the change with a descriptive message
- Repeat for each additional sub-feature, animation, or bug fix

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.