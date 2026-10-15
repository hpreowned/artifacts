#!/usr/bin/env bash
# Foreground: static artifact gateway on :8081, serving $SERVE_ROOT. Ctrl+C stops it.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/dev-env.sh"
cd "$ROOT/static-gateway"; PORT=${PORT:-8081} exec npm run -s dev
