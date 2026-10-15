#!/usr/bin/env bash
# Foreground: viewer shell on :8082 (dev auth, viewer oid dev-viewer). Ctrl+C stops it.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/dev-env.sh"
cd "$ROOT/viewer-shell"; PORT=${PORT:-8082} exec npm run -s dev
