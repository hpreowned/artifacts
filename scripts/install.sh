#!/usr/bin/env bash
# Install every package's dependencies and build the CLI. Run once per clone (and after pulls that change lockfiles).
# In a locked-down network, point npm at your mirror first:  npm config set registry <your JFrog npm mirror URL>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node -e 'const v=+process.versions.node.split(".")[0]; if (v<20) { console.error("Node 20+ required, found "+process.version); process.exit(1); }'
for d in intake-api scanner static-gateway viewer-shell cli; do
  echo "== npm ci: $d"; npm --prefix "$ROOT/$d" ci
done
echo "== build: cli"; npm --prefix "$ROOT/cli" run build
echo "install: done"
