#!/usr/bin/env bash
# Claude Fleet Portal — one-shot installer for a fresh clone.
# Checks prerequisites, installs dependencies, builds the production web bundle,
# and tells you how to start. Safe to re-run any time.
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✕\033[0m %s\n' "$*"; exit 1; }

cd "$(dirname "$0")"

bold "Claude Fleet Portal — install"
echo

# ── 1. prerequisites ─────────────────────────────────────────────────────────────
bold "1/4 · checking prerequisites"

command -v node >/dev/null 2>&1 || fail "Node.js not found — install Node ≥ 20 (https://nodejs.org or nvm)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $(node -v) is too old — Node ≥ 20 required (built on 22)"
fi
ok "node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    warn "pnpm not found — enabling via corepack"
    corepack enable
    corepack prepare pnpm@10.19.0 --activate
  else
    fail "pnpm not found — install it: npm install -g pnpm"
  fi
fi
ok "pnpm $(pnpm --version)"

command -v git >/dev/null 2>&1 || fail "git not found — required for projects/worktrees/self-update"
ok "git $(git --version | awk '{print $3}')"

# claude is only needed for REAL runs — the free deterministic mock works without it.
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1 || echo '(installed)')"
else
  warn "claude CLI not found — real agent runs need Claude Code ≥ 2.1.154 (https://claude.com/claude-code)."
  warn "you can still explore everything with the free mock: pnpm dev:mock"
fi

# gh is optional — used for PR-mode merges and release checks against PRIVATE repos.
if command -v gh >/dev/null 2>&1; then
  ok "gh $(gh --version | head -1 | awk '{print $3}') (PR mode + private-repo update checks available)"
else
  warn "gh CLI not found (optional) — PR-mode merges and private-repo update checks need it"
fi

# ── 2. dependencies ──────────────────────────────────────────────────────────────
echo
bold "2/4 · installing dependencies (first run builds the better-sqlite3 native binding)"
pnpm install

# ── 3. production build ──────────────────────────────────────────────────────────
echo
bold "3/4 · building the web app"
pnpm build
# stamp the built sha — start.sh rebuilds automatically when the code moves past it (self-update)
git rev-parse --short HEAD > apps/web/.next/fleet-build-sha 2>/dev/null || true

# ── 4. finishing touches ─────────────────────────────────────────────────────────
echo
bold "4/4 · finishing up"
chmod +x tools/mock-claude.mjs start.sh 2>/dev/null || true
mkdir -p data
ok "data directory ready (SQLite lives in ./data — no database server needed)"

echo
bold "Done. Start it:"
cat <<'EOT'

  ./start.sh              production mode  →  web http://127.0.0.1:4318 · API :4319
  ./start.sh --mock       production mode against the FREE deterministic mock (no tokens)

  pnpm dev                development mode (hot reload, real claude)
  pnpm dev:mock           development mode against the mock

Env knobs: FLEET_WEB_PORT (4318) · FLEET_SERVER_PORT (4319) · FLEET_DATA_DIR (./data)
           CLAUDE_BIN (path to claude; the mock sets this for you)
EOT
