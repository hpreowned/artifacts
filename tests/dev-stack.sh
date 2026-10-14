#!/usr/bin/env bash
# One-command local stack: intake-api + scanner worker (8080), static-gateway (8081), viewer-shell (8082).
# Memory backends, DEV_AUTH=1, dev keys generated once into .local/dev.env. Usage: tests/dev-stack.sh start|stop|status|env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; L="$ROOT/.local"; mkdir -p "$L/serving" "$L/logs"
ENV="$L/dev.env"
if [ ! -f "$ENV" ]; then
  {
    echo "VIEW_TOKEN_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
    echo "INTERNAL_SHARED_KEY=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
    echo "PIPELINE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  } > "$ENV"
fi
set -a; . "$ENV"; set +a
export DEV_AUTH=1 SERVE_ROOT="$L/serving" PUBLIC_BASE_URL=http://localhost:8080 SHELL_ORIGIN=http://localhost:8082
export ARTIFACT_DOMAIN=localhost:8081 ARTIFACT_SCHEME=http INTAKE_INTERNAL_URL=http://localhost:8080 DEV_INSECURE_COOKIES=1
export RUNTIME_MANIFEST="$ROOT/tests/runtime-manifest.python-1.json"
pidfile="$L/pids"
case "${1:-start}" in
  env) cat "$ENV" ;;
  start)
    [ -f "$pidfile" ] && { echo "already running (pids in $pidfile); run stop first"; exit 1; }
    for d in intake-api static-gateway viewer-shell; do [ -d "$ROOT/$d/node_modules" ] || npm --prefix "$ROOT/$d" ci --silent; done
    ( cd "$ROOT/intake-api"     && PORT=8080 exec npm run -s dev ) > "$L/logs/intake.log"  2>&1 & echo $! >  "$pidfile"
    ( cd "$ROOT/static-gateway" && PORT=8081 exec npm run -s dev ) > "$L/logs/gateway.log" 2>&1 & echo $! >> "$pidfile"
    ( cd "$ROOT/viewer-shell"   && PORT=8082 exec npm run -s dev ) > "$L/logs/shell.log"   2>&1 & echo $! >> "$pidfile"
    for p in 8080 8081 8082; do curl -s -o /dev/null --retry 30 --retry-connrefused --retry-delay 1 "http://localhost:$p/" || true; done
    echo "started: intake 8080, gateway 8081, shell 8082; logs in $L/logs; env in $ENV"
    ;;
  stop)
    [ -f "$pidfile" ] || { echo "not running"; exit 0; }
    while read -r pid; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done < "$pidfile"
    rm -f "$pidfile"; echo "stopped"
    ;;
  status)
    for p in 8080 8081 8082; do printf "%s: " "$p"; curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:$p/" || echo down; done
    ;;
  *) echo "usage: $0 start|stop|status|env"; exit 1 ;;
esac
