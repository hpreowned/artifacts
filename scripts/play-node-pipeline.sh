#!/usr/bin/env bash
# Platform-team tool: play pipelines/artifact-node-deploy.yml (or artifact-python-deploy.yml) by hand from a
# laptop, for the dev-cluster demo where Azure DevOps cannot run them yet (no Blob). Same inputs, same image
# build, same artifact chart, same callbacks — the pipeline YAML is the spec, this script mirrors its steps
# by name. Business users never run this. Usage:
#
#   scripts/play-node-pipeline.sh <jobId> [--dry-run]
#
# Env (required): INTAKE_URL (e.g. http://localhost:8080 via port-forward)  PIPELINE_TOKEN  REGISTRY
#                 (push prefix, e.g. myacr.azurecr.io/artifacts)  ARTIFACT_DOMAIN  SHELL_ORIGIN (http://<shell host>)
# Env (optional): GATEWAY_NAME (ingress-gateway) GATEWAY_NAMESPACE (istio-ingress) GATEWAY_SECTION ("")
#                 NODE_IMAGE (node:20-slim) NPM_REGISTRY (https://registry.npmjs.org/) PLATFORM (linux/amd64 on
#                 Apple silicon) PYTHON_RUNTIME_IMAGE (python tier only: <REGISTRY>/python-runtime@sha256:...)
set -euo pipefail
JOB=${1:-}; DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
[[ "$JOB" =~ ^job_[a-z0-9]{20}$ ]] || { echo "usage: $0 <jobId> [--dry-run]" >&2; exit 2; }
for v in INTAKE_URL PIPELINE_TOKEN REGISTRY ARTIFACT_DOMAIN SHELL_ORIGIN; do [ -n "${!v:-}" ] || { echo "$v is required" >&2; exit 2; }; done
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GATEWAY_NAME=${GATEWAY_NAME:-ingress-gateway}; GATEWAY_NAMESPACE=${GATEWAY_NAMESPACE:-istio-ingress}; GATEWAY_SECTION=${GATEWAY_SECTION:-}
NODE_IMAGE=${NODE_IMAGE:-node:20-slim}; NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}
PLATFORM=${PLATFORM:-}; [ -z "$PLATFORM" ] && [ "$(uname -m)" = "arm64" ] && PLATFORM=linux/amd64
INTAKE=${INTAKE_URL%/}
for tool in curl jq unzip; do command -v $tool >/dev/null || { echo "$tool is required" >&2; exit 2; }; done
run() { if [ $DRY = 1 ]; then printf '+'; printf ' %q' "$@"; echo; else "$@"; fi; }
api() { curl -fsS -H "Authorization: Bearer $PIPELINE_TOKEN" "$@"; }
reported=0
callback() {  # callback <state> [message]   -- the pipeline's EventIn; the dev approval page is the run URL
  local state=$1 message=${2:-}
  local body; body=$(jq -nc --arg s "$state" --arg r "$INTAKE/dev/approval/$JOB" --arg m "$message" '{state:$s, runUrl:$r} + (if $m != "" then {message:$m} else {} end)')
  if [ $DRY = 1 ]; then echo "+ callback $state ${message:+($message)}"; return 0; fi
  api -X POST "$INTAKE/v1/publish/$JOB/events" -H 'content-type: application/json' -d "$body" -o /dev/null
  echo "callback: $state"
}
fail_with() { [ $reported = 1 ] || { reported=1; callback failed "$1" || true; }; echo "FAILED: $1" >&2; exit 1; }

# ---- Fetch stage ----
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
echo "== Download job record"
api "$INTAKE/v1/publish/$JOB/record" > "$WORK/job.json" || fail_with "fetch failed: job record download"
artifactId=$(jq -r .artifactId "$WORK/job.json"); expiresAt=$(jq -r .expiresAt "$WORK/job.json")
tier=$(jq -r .tier "$WORK/job.json"); state=$(jq -r .state "$WORK/job.json"); mode=$(jq -r '.approval.mode // "human"' "$WORK/job.json")
echo "   artifact=$artifactId tier=$tier state=$state approval=$mode expires=$expiresAt"
[ "$state" = scanning ] || [ "$state" = awaiting_approval ] || { echo "job is $state; nothing to play" >&2; exit 1; }
[ "$tier" = node ] || [ "$tier" = python ] || { echo "tier $tier has no pipeline" >&2; exit 1; }
echo "== Download bundle from intake"
api "$INTAKE/v1/publish/$JOB/bundle" -o "$WORK/bundle.zip" || fail_with "fetch failed: bundle download"
mkdir -p "$WORK/bundle" && unzip -q "$WORK/bundle.zip" -d "$WORK/bundle"
echo "== Check bundle shape"
if [ "$tier" = node ]; then
  [ -f "$WORK/bundle/package-lock.json" ] || fail_with "bundle does not match the node manifest: package-lock.json missing"
  if [ -d "$WORK/bundle/node_modules" ] || ls "$WORK/bundle"/.env* "$WORK/bundle/.npmrc" >/dev/null 2>&1; then fail_with "bundle carries node_modules, .env* or .npmrc"; fi
else
  [ -f "$WORK/bundle/app.py" ] || fail_with "bundle does not match the python manifest: app.py missing"
fi
if command -v gitleaks >/dev/null; then
  echo "== gitleaks (deny on finding)"
  gitleaks detect --no-git --source "$WORK/bundle" --no-banner -q || { callback rejected "gitleaks found a secret in the bundle"; reported=1; echo "rejected: gitleaks" >&2; exit 1; }
else
  echo "== gitleaks: not installed on this laptop, skipped (the scanner already ran its own pass)"
fi

# ---- Build stage (node only: one image per prototype from the real Dockerfile) ----
if [ "$tier" = node ]; then
  echo "== docker build and push (node-runtime + bundle)"
  cp "$ROOT/node-runtime/Dockerfile" "$WORK/bundle/Dockerfile"
  tag="$REGISTRY/node-$artifactId:$JOB"
  PLAT=(); [ -n "$PLATFORM" ] && PLAT=(--platform "$PLATFORM")
  run docker build ${PLAT[@]+"${PLAT[@]}"} --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NPM_REGISTRY=$NPM_REGISTRY" -t "$tag" "$WORK/bundle" || fail_with "build failed: docker build and push"
  run docker push "$tag" || fail_with "build failed: docker build and push"
  if [ $DRY = 1 ]; then image="$REGISTRY/node-$artifactId@sha256:$(printf '0%.0s' $(seq 1 64))"; else
    digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$tag" | sed 's/.*@//'); image="$REGISTRY/node-$artifactId@$digest"; fi
  echo "   image=$image"
else
  [ -n "${PYTHON_RUNTIME_IMAGE:-}" ] || { echo "PYTHON_RUNTIME_IMAGE is required for the python tier (build python-runtime/Dockerfile and push it once)" >&2; exit 2; }
  image=$PYTHON_RUNTIME_IMAGE
  # Derive entrypoint style from app.py imports exactly as the pipeline does (ast; anything not streamlit is fastapi).
  entry=$(python3 - "$WORK/bundle/app.py" <<'PYAST'
import ast, sys
tree = ast.parse(open(sys.argv[1], encoding='utf-8').read())
names = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import): names.update(n.name.split('.')[0] for n in node.names)
    elif isinstance(node, ast.ImportFrom) and node.module: names.add(node.module.split('.')[0])
print('streamlit' if 'streamlit' in names else 'fastapi')
PYAST
  ) || fail_with "fetch failed: entrypoint derivation"
  echo "   entrypoint=$entry image=$image"
fi

# ---- Approval (the Azure DevOps Environment check, played by the operator) ----
if [ "$mode" = human ]; then
  callback awaiting_approval "image ready; waiting for a human approval (played by hand)"
  if [ $DRY = 1 ]; then echo "+ (operator would be asked to approve here)"; else
    read -r -p "A reviewer must approve this ${tier} prototype (reasons: $(jq -r '.approval.reasons | join("; ")' "$WORK/job.json")). Approve? [y/N] " yn
    case "$yn" in y|Y) ;; *) callback rejected "approval declined by the operator"; echo "declined" >&2; exit 1 ;; esac
  fi
else
  echo "== approval: auto (clean scan; D16) — deploying without a human"
fi

# ---- Deploy stage ----
callback deploying
SECTION=(); [ -n "$GATEWAY_SECTION" ] && SECTION=(--set "gateway.sectionName=$GATEWAY_SECTION")
if [ "$tier" = node ]; then
  run helm upgrade --install "node-$artifactId" "$ROOT/charts/artifact-node" --namespace artifacts-dynamic \
    --set "artifactId=$artifactId" --set "expiresAt=$expiresAt" --set "image=$image" --set "jobId=$JOB" \
    --set "imageRegistry=$REGISTRY" --set "domain.artifactDomain=$ARTIFACT_DOMAIN" --set "shellOrigin=$SHELL_ORIGIN" \
    --set "gateway.name=$GATEWAY_NAME" --set "gateway.namespace=$GATEWAY_NAMESPACE" --set "gateway.sectionName=" ${SECTION[@]+"${SECTION[@]}"} \
    --wait --timeout 3m || fail_with "deploy failed: helm upgrade"
else
  run helm upgrade --install "art-$artifactId" "$ROOT/charts/artifact-python" --namespace artifacts-dynamic \
    --set "artifactId=$artifactId" --set "expiresAt=$expiresAt" --set "image=$image" --set "jobId=$JOB" --set "entrypoint=$entry" \
    --set-file "appPy=$WORK/bundle/app.py" --set "imageRegistry=$REGISTRY" --set "domain.artifactDomain=$ARTIFACT_DOMAIN" \
    --set "gateway.name=$GATEWAY_NAME" --set "gateway.namespace=$GATEWAY_NAMESPACE" --set "gateway.sectionName=" ${SECTION[@]+"${SECTION[@]}"} \
    --wait --timeout 3m || fail_with "deploy failed: helm upgrade"
fi
callback live
echo
echo "LIVE  $SHELL_ORIGIN/view/$artifactId   (artifact origin http://$artifactId.$ARTIFACT_DOMAIN, only inside the shell's frame)"
