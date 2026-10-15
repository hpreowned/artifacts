#!/usr/bin/env bash
# Shared local-dev environment. Source this; do not execute it.
# Generates per-checkout dev keys once into .local/dev.env, then exports the memory-backend configuration
# every component agrees on (same VIEW_TOKEN_KEY on intake+gateway, same INTERNAL_SHARED_KEY on intake+shell).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
L="$ROOT/.local"; mkdir -p "$L/serving" "$L/logs"
ENV_FILE="$L/dev.env"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "VIEW_TOKEN_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
    echo "INTERNAL_SHARED_KEY=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
    echo "PIPELINE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  } > "$ENV_FILE"
fi
set -a; . "$ENV_FILE"; set +a
export DEV_AUTH=1 DEV_INSECURE_COOKIES=1
export SERVE_ROOT="$L/serving"
export PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:8080}
export SHELL_ORIGIN=${SHELL_ORIGIN:-http://localhost:8082}
export ARTIFACT_DOMAIN=${ARTIFACT_DOMAIN:-localhost:8081}
export ARTIFACT_SCHEME=http
export HOST=127.0.0.1               # dev servers bind loopback only; unset in cluster manifests (pods must bind all interfaces)
export INTAKE_INTERNAL_URL=${INTAKE_INTERNAL_URL:-http://localhost:8080}
export RUNTIME_MANIFEST="$ROOT/tests/runtime-manifest.python-1.json"
