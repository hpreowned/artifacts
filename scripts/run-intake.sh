#!/usr/bin/env bash
# Foreground: intake API + scanner worker + GC on :8080 (memory backends, DEV_AUTH). Ctrl+C stops it.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/dev-env.sh"
cd "$ROOT/intake-api"; PORT=${PORT:-8080} exec npm run -s dev
