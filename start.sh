#!/usr/bin/env bash
# Claude Fleet Portal — production start (the "point of start" after ./install.sh).
#   ./start.sh           run against the real claude binary
#   ./start.sh --mock    run against the free deterministic mock (no tokens spent)
# Both processes shut down together on Ctrl-C / SIGTERM.
set -euo pipefail
cd "$(dirname "$0")"

# ── startup banner — the fleet octopus + a small Claude mark ─────────────────────
A=$'\033[38;5;214m'   # amber
C=$'\033[38;5;209m'   # claude coral
D=$'\033[2m'          # dim
B=$'\033[1m'          # bold
R=$'\033[0m'          # reset
cat <<EOF

${A}                с^с^ϲ
              .--------.
             /  ${R}●${A}    ${R}●${A}  \\
             |          |        ${C}✳${R} ${B}C L A U D E   F L E E T${R}
             \\   ${D}____${R}${A}   /             ${D}P O R T A L${R}
            ${A}.-'\\______/'-.
          .'   |  |  |  |   '.       ${D}one octopus,${R}
         /  /| |  |  |  | |\\  \\      ${D}many arms —${R}
        |  / | |  |  |  | | \\  |     ${D}your agents under${R}
        \\_/  ( )(  )(  )( )  \\_/     ${D}mission control${R}
        ${A}     '  ´'  ´´  '´  '
${R}             ${D}✳ powered by Claude Code${R}

EOF

WEB_PORT="${FLEET_WEB_PORT:-4318}"
API_PORT="${FLEET_SERVER_PORT:-4319}"

if [ ! -d apps/web/.next ]; then
  echo "No production build found (apps/web/.next missing) — run ./install.sh first." >&2
  exit 1
fi

if [ "${1:-}" = "--mock" ]; then
  export CLAUDE_BIN="$PWD/tools/mock-claude.mjs"
  echo "▶ mock mode — runs are free and deterministic (CLAUDE_BIN=$CLAUDE_BIN)"
elif ! command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then
  echo "claude CLI not found — install Claude Code for real runs, or use: ./start.sh --mock" >&2
  exit 1
fi

# refuse to double-start
for port in "$WEB_PORT" "$API_PORT"; do
  if lsof -ti tcp:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use — is the portal (or a dev server) already running?" >&2
    exit 1
  fi
done

echo "▶ control plane → http://127.0.0.1:$API_PORT"
echo "▶ web           → http://127.0.0.1:$WEB_PORT"

pnpm --filter @fleet/server start &
SERVER_PID=$!
pnpm --filter @fleet/web start &
WEB_PID=$!

# one Ctrl-C stops both (the server itself shuts its claude children down gracefully — H4)
trap 'kill "$SERVER_PID" "$WEB_PID" 2>/dev/null; wait "$SERVER_PID" "$WEB_PID" 2>/dev/null || true' INT TERM
wait -n "$SERVER_PID" "$WEB_PID" || true
kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
wait "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
