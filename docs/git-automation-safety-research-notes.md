# Git Automation Safety — research notes (LENS: per-task agent worktree → validate → merge)

## Codebase reuse anchors (verified)
- H10 worktree: `buildArgs` (processManager.ts:116) emits `--worktree <name>`; DC.md:293 real-claude-verified the worktree lands at `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`. DETERMINISTIC path + branch name → the merge engine can compute both without parsing.
- Reactive engine: campaigns.ts `handleRunTerminal` via `registry.onRunTerminal` (no polling). PM/merge gate mirrors this.
- registry.launch(LaunchRequest) tracks cost/budget/result; structuredOutput lands on run.structuredOutput.
- SQLite repo with idempotent ALTER TABLE migrations (db.ts:164+). New tables: projects, kanban_cards.
- git 2.52 → merge-tree --write-tree, --quiet early-exit, merge --abort all available.

## Safe local merge flow (CORRECTED per advisor — order is load-bearing)
1. Agent works in worktree `<repo>/.claude/worktrees/task-<cardId>` branch `worktree-task-<cardId>`.
2. ENSURE COMMITTED (advisor #2): merge-tree/merge see only commits. If the agent left work uncommitted, the gate sees an empty diff → silent no-op merge. Fallback: `git -C <wt> add -A && git -C <wt> commit -m "task <id>"` if `git -C <wt> status --porcelain` is dirty. Guard: `.claude/worktrees/` MUST be gitignored (VERIFIED NOT gitignored in THIS repo) or `add -A` stages sibling worktree internals (advisor #4).
3. CHEAP pre-merge conflict probe (in-memory, zero side effects): `git merge-tree --write-tree --quiet <main> <branch>`; exit 0 clean / 1 conflict / other error. Conflict → park in Review w/ conflict info, stop.
4. INTEGRATE-THEN-REVALIDATE (advisor #1 — biggest gap): if main advanced, integrate main INTO the branch inside the worktree (rebase or merge) → RE-RUN validation there → only then merge. Validate the tree you actually ship; isolated-branch-green + clean merge-tree do NOT catch semantic conflicts. (Worktrunk + "require branch up to date before merge" both do this.)
5. GATE: default human-approve (Review column). Per-project `autoMerge` toggle → skip human if validation+conflict-gate green.
6. MERGE per-project SERIALIZED (advisor #3 — TOCTOU): hold a per-project mutex across gate→merge (or re-gate under lock immediately before merge). Concurrent onRunTerminal completions otherwise both gate same main, race, and hit index.lock on the single main worktree. Capture main tip; save `refs/fleet-backup/<branch>` first; `git merge --no-ff worktree-task-<cardId>` (revertable unit). If integrated in step 4, this fast-forwards.
7. ROLLBACK: post-merge failure → `git reset --hard ORIG_HEAD` (local, unshared) or `git revert -m 1 <mergeSha>` if shared.
8. CLEANUP on success: `git worktree remove <path>` (--force if unclean), `git branch -d worktree-task-<cardId>`, `git worktree prune`.

## Key facts
- git merge-tree --write-tree <b1> <b2>: auto-finds merge base, in-memory, exit 0/1/other. --quiet for early-exit + exit-status-only.
- merge --abort / reset --merge: restore pre-merge state; REQUIRES clean working tree before merge starts (commit/stash first) — main worktree must be clean.
- --no-ff: always a merge commit → revert the merge as a unit (-m 1).
- Worktrunk (closest analog): rebase onto target → pre-merge hooks (test/lint) → FF merge → remove worktree+branch; "conflicts abort immediately"; backup ref refs/wt-backup/<branch>.
- Auto-merge gating (Renovate/GitHub): only as safe as CI; required checks must be green; "branch up to date" before merge. Default-block is the safe posture → maps to default human-approve.
- Worktree env: copy .env per worktree (don't symlink); submodules need explicit init per worktree.
