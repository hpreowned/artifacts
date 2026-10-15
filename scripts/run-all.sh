#!/usr/bin/env bash
# Foreground consolidated runner: all three components in one terminal with prefixed logs. Ctrl+C stops all.
# (For a detached stack use tests/dev-stack.sh start|stop|status instead.)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/dev-env.sh"
for port in 8080 8081 8082; do
  [ -z "$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)" ] || { echo "port $port already bound; stop it first (tests/dev-stack.sh stop)"; exit 1; }
done
pids=()
cleanup() {
  trap - INT TERM EXIT
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; pkill -P "$p" 2>/dev/null || true; done
  for port in 8080 8081 8082; do for lp in $(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do kill "$lp" 2>/dev/null || true; done; done
  echo; echo "stopped"
}
trap cleanup INT TERM EXIT
( cd "$ROOT/intake-api"     && PORT=8080 npm run -s dev 2>&1 | sed -u 's/^/[intake ] /' ) & pids+=($!)
( cd "$ROOT/static-gateway" && PORT=8081 npm run -s dev 2>&1 | sed -u 's/^/[gateway] /' ) & pids+=($!)
( cd "$ROOT/viewer-shell"   && PORT=8082 npm run -s dev 2>&1 | sed -u 's/^/[shell  ] /' ) & pids+=($!)
echo "intake :8080  gateway :8081  shell :8082 — Ctrl+C stops everything"
wait
