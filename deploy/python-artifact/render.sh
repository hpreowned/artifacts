#!/usr/bin/env bash
# Renders the DESIGN §6.6 manifests for one approved Python artifact to stdout. Run by the Deploy stage of
# pipelines/artifact-python-deploy.yml; never calls the Kubernetes API (D12).
#
#   render.sh <artifactId> <app.py> <expiresAt> <streamlit|fastapi> <image@digest> > manifests.yaml
#
#   artifactId  ^[a-z0-9]{12}$                    (contracts/intake-openapi.yaml ArtifactId)
#   app.py      path, at most 1 MiB               (DESIGN §6.6 ConfigMap cap)
#   expiresAt   RFC 3339 UTC, e.g. 2026-10-28T00:00:00Z; stored as label 2026-10-28T00-00-00Z
#   runtime     streamlit | fastapi               (entrypoints from tests/runtime-manifest.python-1.json)
#   image       ^jfrog\.corp\.com/artifacts/python-runtime@sha256:[a-f0-9]{64}$  (same regex as Azure Policy)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
template="${TEMPLATE:-$here/template.yaml}"

usage() { sed -n '2,13p' "$0" >&2; exit 2; }
[ $# -eq 5 ] || usage
id="$1"; app="$2"; expires="$3"; runtime="$4"; image="$5"

die() { echo "render.sh: $*" >&2; exit 1; }

printf '%s' "$id" | grep -Eq '^[a-z0-9]{12}$' || die "artifactId '$id' must match ^[a-z0-9]{12}$"
[ -f "$app" ] || die "app.py not found: $app"
size=$(wc -c < "$app" | tr -d ' ')
[ "$size" -le 1048576 ] || die "app.py is $size bytes, over the 1 MiB ConfigMap cap"
printf '%s' "$expires" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || die "expiresAt '$expires' must be like 2026-10-28T00:00:00Z"
printf '%s' "$image" | grep -Eq '^jfrog\.corp\.com/artifacts/python-runtime@sha256:[a-f0-9]{64}$' || die "image '$image' must be the digest-pinned python-runtime"

# Entrypoints, identical to tests/runtime-manifest.python-1.json (test-render.sh asserts this).
case "$runtime" in
  streamlit) args='["streamlit", "run", "/app/app.py", "--server.port=8080", "--server.address=0.0.0.0", "--server.headless=true", "--browser.gatherUsageStats=false"]' ;;
  fastapi)   args='["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app"]' ;;
  *) die "runtime must be streamlit or fastapi, got '$runtime'" ;;
esac

expires_label="$(printf '%s' "$expires" | tr ':' '-')"

# Scalars first, then app.py spliced in verbatim (indented 4) so its contents are never run through sed.
sed -e "s|__ID__|$id|g" \
    -e "s|__EXPIRES_AT__|$expires_label|g" \
    -e "s|__IMAGE__|$image|g" \
    -e "s|__ARGS__|$args|g" \
    "$template" \
| awk -v f="$app" '
    /^__APP_PY__$/ { while ((getline line < f) > 0) print "    " line; close(f); next }
    { print }
  '
