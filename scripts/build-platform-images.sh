#!/usr/bin/env bash
# Platform-team tool: build the four platform images on a laptop and (optionally) push them to a registry you
# can reach, for the dev-cluster all-in-one deployment (docs/DEV-AKS-DEMO.md). The Dockerfiles are the real
# ones; only the base images and the gitleaks download are redirected, through build arguments the pipeline
# never passes. Business users never run this.
#
# Usage: scripts/build-platform-images.sh <registry-prefix> <tag> [--push] [--platform linux/amd64] [--dry-run]
#   e.g. scripts/build-platform-images.sh myacr.azurecr.io/artifacts dev1 --push
# Env:   NODE_IMAGE (node:20-slim)  PYTHON_IMAGE (python:3.12-slim)  GITLEAKS_VERSION (8.21.2)
#        GITLEAKS_SHA256 (sha256 of the linux_x64 tarball; computed once and printed if unset — dev only)
#        GITLEAKS_URL (GitHub release tarball by default)
set -euo pipefail
PREFIX=${1:-}; TAG=${2:-}; shift 2 || true
[ -n "$PREFIX" ] && [ -n "$TAG" ] || { echo "usage: $0 <registry-prefix> <tag> [--push] [--platform P] [--dry-run]" >&2; exit 2; }
PUSH=0; DRY=0; PLATFORM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --dry-run) DRY=1 ;;
    --platform) PLATFORM=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
# Cluster nodes are amd64; an Apple-silicon laptop must say so or it builds arm64 images that never start.
if [ -z "$PLATFORM" ] && [ "$(uname -m)" = "arm64" ]; then PLATFORM=linux/amd64; fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE_IMAGE=${NODE_IMAGE:-node:20-slim}
PYTHON_IMAGE=${PYTHON_IMAGE:-python:3.12-slim}
GITLEAKS_VERSION=${GITLEAKS_VERSION:-8.21.2}
GITLEAKS_URL=${GITLEAKS_URL:-https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz}

run() { if [ $DRY = 1 ]; then printf '+'; printf ' %q' "$@"; echo; else "$@"; fi; }

if [ -z "${GITLEAKS_SHA256:-}" ]; then
  if [ $DRY = 1 ]; then
    GITLEAKS_SHA256="<computed-from-download>"
  else
    # Dev-only trust-on-first-use: the pipeline pins the checksum in its variable group; here we compute it once.
    echo "GITLEAKS_SHA256 not set: downloading $GITLEAKS_URL once to compute it (dev only; pin it for the pipeline)" >&2
    tmp=$(mktemp); curl -fsSL -o "$tmp" "$GITLEAKS_URL"
    GITLEAKS_SHA256=$(shasum -a 256 "$tmp" | cut -d' ' -f1); rm -f "$tmp"
    echo "GITLEAKS_SHA256=$GITLEAKS_SHA256" >&2
  fi
fi

PLAT=(); [ -n "$PLATFORM" ] && PLAT=(--platform "$PLATFORM")
build() {  # build <name> <context> <dockerfile> [extra build args...]
  local name=$1 ctx=$2 df=$3; shift 3
  local image="$PREFIX/$name:$TAG"
  echo "== $image"
  run docker build "${PLAT[@]}" --build-arg "NODE_IMAGE=$NODE_IMAGE" "$@" -t "$image" -f "$df" "$ctx"
  [ $PUSH = 1 ] && run docker push "$image"
  echo "$image"
}
build intake-api     "$ROOT" "$ROOT/intake-api/Dockerfile"
build scanner        "$ROOT" "$ROOT/scanner/Dockerfile" --build-arg "PYTHON_IMAGE=$PYTHON_IMAGE" \
  --build-arg "GITLEAKS_VERSION=$GITLEAKS_VERSION" --build-arg "GITLEAKS_SHA256=$GITLEAKS_SHA256" --build-arg "GITLEAKS_URL=$GITLEAKS_URL"
build static-gateway "$ROOT/static-gateway" "$ROOT/static-gateway/Dockerfile"
build viewer-shell   "$ROOT/viewer-shell"   "$ROOT/viewer-shell/Dockerfile"
echo
echo "Done. For the all-in-one chart: --set images.platform=$PREFIX/scanner:$TAG --set images.staticGateway=$PREFIX/static-gateway:$TAG --set images.viewerShell=$PREFIX/viewer-shell:$TAG"
echo "(the scanner image runs the combined intake+scanner process: it carries Python, gitleaks and the intake code)"
