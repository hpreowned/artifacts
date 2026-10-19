#!/usr/bin/env bash
# Platform-team tool, not part of the product: run a node bundle the way the cluster would, on a laptop with
# Docker. Business users never need this; they publish from Cowork or Claude Code and the pipeline builds.
#
# It builds the image from the real node-runtime/Dockerfile and runs it under the cluster's constraints:
#   - no egress: the app sits alone on an *internal* Docker network (no route out, like the deny-all policy)
#   - read-only root filesystem, /tmp the only writable path (plus WRITABLE_PATHS), non-root (baked in)
#   - $PORT, CPU and memory limits
# and then reaches it the way the readiness probe does — over the container network, through a small
# forwarder that is the only thing with a published port — so a server bound to 127.0.0.1 fails here
# exactly as it fails there. First real runtime test of the node contract before a cluster exists.
#
# Usage: scripts/run-node-bundle.sh <bundle-dir> [host-port]      --dry-run prints the commands only
# Env:   BASE_IMAGE (node:20-slim)  NPM_REGISTRY (https://registry.npmjs.org/)  SOCAT_IMAGE (alpine/socat)
#        WRITABLE_PATHS (comma-separated extra writable paths, as the chart's emptyDir mounts)
#        — a writable path mounted over a directory baked into the image hides those files, here exactly as
#        the chart's emptyDir does on the cluster; data the app only reads belongs outside WRITABLE_PATHS.
set -euo pipefail

DRY=0; ARGS=()
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) ARGS+=("$a") ;; esac; done
BUNDLE=${ARGS[0]:-}; HOST_PORT=${ARGS[1]:-3080}
[ -n "$BUNDLE" ] && [ -d "$BUNDLE" ] || { echo "usage: $0 <bundle-dir> [host-port] [--dry-run]" >&2; exit 2; }
[ -f "$BUNDLE/package.json" ] && [ -f "$BUNDLE/package-lock.json" ] || { echo "not a node bundle: package.json and package-lock.json are required" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE_IMAGE=${BASE_IMAGE:-node:20-slim}
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}
SOCAT_IMAGE=${SOCAT_IMAGE:-alpine/socat}
ID=$(date +%s)
NAME=$(node -e 'const n=require(process.argv[1]).name||"bundle";console.log(String(n).toLowerCase().replace(/[^a-z0-9-]+/g,"-"))' "$BUNDLE/package.json" 2>/dev/null || basename "$BUNDLE")
IMAGE="artifacts-local/$NAME:$ID"; NET="artifacts-local-$ID"; APP="artifact-app-$ID"; FWD="artifact-fwd-$ID"

run() { if [ $DRY = 1 ]; then printf '+'; printf ' %q' "$@"; echo; else "$@"; fi; }

if [ $DRY = 0 ]; then
  command -v docker >/dev/null || { echo "docker is not installed on this machine; nothing to do (the cluster is the runtime)" >&2; exit 2; }
  docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 2; }
fi

cleanup() {
  [ $DRY = 1 ] && return 0
  docker rm -f "$APP" "$FWD" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# 1. Build context = the bundle + the pipeline-owned Dockerfile (a bundle never ships its own).
CTX=$(mktemp -d)
cp -R "$BUNDLE"/. "$CTX"/ && rm -rf "$CTX/node_modules" && cp "$ROOT/node-runtime/Dockerfile" "$CTX/Dockerfile"
echo "== build $IMAGE from node-runtime/Dockerfile (base $BASE_IMAGE, registry $NPM_REGISTRY)"
run docker build --build-arg "BASE_IMAGE=$BASE_IMAGE" --build-arg "NPM_REGISTRY=$NPM_REGISTRY" -t "$IMAGE" "$CTX"
rm -rf "$CTX"

# 2. Internal network: containers on it can talk to each other and to nothing else.
echo "== run under cluster constraints (no egress, read-only, /tmp only, PORT=8080, 1 cpu, 512m)"
run docker network create --internal "$NET"
TMPFS=(--tmpfs /tmp:rw,nosuid,size=64m)
IFS=',' read -r -a extra <<< "${WRITABLE_PATHS:-}"
for p in ${extra[@]+"${extra[@]}"}; do [ -n "$p" ] && TMPFS+=(--tmpfs "$p:rw,nosuid,size=64m"); done   # bash 3.2 + set -u
run docker run -d --name "$APP" --network "$NET" --read-only "${TMPFS[@]}" \
  --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 1 -e PORT=8080 "$IMAGE"

# 3. The forwarder is the readiness probe's stand-in: it reaches the app over the internal network, by
#    container name, on 8080. Only it publishes a port, on loopback, so the laptop stays loopback-only.
run docker run -d --name "$FWD" -p "127.0.0.1:$HOST_PORT:8080" "$SOCAT_IMAGE" "TCP-LISTEN:8080,fork,reuseaddr" "TCP:$APP:8080"
run docker network connect "$NET" "$FWD"
[ $DRY = 1 ] && { echo "(dry run: nothing was built or started)"; exit 0; }

# 4. Readiness, with the chart's budget: 12 tries, 5 s apart.
ready=0
for _ in $(seq 1 12); do
  if curl -sf -o /dev/null "http://127.0.0.1:$HOST_PORT/"; then ready=1; break; fi
  sleep 5
done
if [ $ready = 0 ]; then
  echo "NOT READY after 60 s — the same outcome the cluster's readiness probe would report. App log:" >&2
  docker logs --tail 40 "$APP" >&2 || true
  echo "If the log says it is listening on 127.0.0.1 or localhost, that is the loopback bind the contract forbids." >&2
  exit 1
fi
# 5. Egress check from inside the app's own network namespace: must fail.
if docker exec "$APP" node -e "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(2)).catch(()=>process.exit(0))" >/dev/null 2>&1; then
  echo "egress: denied (as in the cluster)"
else
  echo "egress: REACHED THE INTERNET — the internal network did not isolate the container; do not trust this run" >&2
fi
echo
echo "READY  http://127.0.0.1:$HOST_PORT/   (image $IMAGE; Ctrl+C stops and removes everything)"
echo "       docker logs -f $APP   to watch the app"
while docker ps -q --filter "name=^$APP$" | grep -q .; do sleep 2; done
echo "app container exited:" >&2; docker logs --tail 20 "$APP" >&2 || true; exit 1
