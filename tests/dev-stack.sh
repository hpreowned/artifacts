#!/usr/bin/env bash
# One-command local stack: intake-api + scanner worker (8080), static-gateway (8081), viewer-shell (8082).
# Memory backends, DEV_AUTH=1, dev keys generated once into .local/dev.env. Usage: tests/dev-stack.sh start|stop|status|env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/dev-env.sh"
L="$ROOT/.local"
ENV="$L/dev.env"
pidfile="$L/pids"
PORTS="8080 8081 8082"
listeners() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
case "${1:-start}" in
  env) cat "$ENV" ;;
  start)
    for port in $PORTS; do [ -z "$(listeners "$port")" ] || { echo "port $port already bound; run stop first"; exit 1; }; done
    [ -f "$pidfile" ] && { echo "stale pid file $pidfile; run stop first"; exit 1; }
    for d in intake-api static-gateway viewer-shell; do [ -d "$ROOT/$d/node_modules" ] || npm --prefix "$ROOT/$d" ci --silent; done
    ( cd "$ROOT/intake-api"     && PORT=8080 exec nohup npm run -s dev ) > "$L/logs/intake.log"  2>&1 & echo $! >  "$pidfile"; disown
    ( cd "$ROOT/static-gateway" && PORT=8081 exec nohup npm run -s dev ) > "$L/logs/gateway.log" 2>&1 & echo $! >> "$pidfile"; disown
    ( cd "$ROOT/viewer-shell"   && PORT=8082 exec nohup npm run -s dev ) > "$L/logs/shell.log"   2>&1 & echo $! >> "$pidfile"; disown
    for p in $PORTS; do curl -s -o /dev/null --retry 30 --retry-connrefused --retry-delay 1 "http://localhost:$p/" || true; done
    echo "started: intake 8080, gateway 8081, shell 8082; logs in $L/logs; env in $ENV"
    ;;
  stop)
    # npm wraps node; killing the wrapper leaves the listener alive. Kill listeners by port, then the wrappers.
    for port in $PORTS; do for pid in $(listeners "$port"); do kill "$pid" 2>/dev/null || true; done; done
    if [ -f "$pidfile" ]; then while read -r pid; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done < "$pidfile"; fi
    rm -f "$pidfile"
    for port in $PORTS; do [ -z "$(listeners "$port")" ] || { echo "port $port still bound"; exit 1; }; done
    echo "stopped"
    ;;
  status)
    for p in $PORTS; do printf "%s: " "$p"; curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:$p/" || echo down; done
    ;;
  *) echo "usage: $0 start|stop|status|env"; exit 1 ;;
esac
