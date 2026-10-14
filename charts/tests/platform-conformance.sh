#!/usr/bin/env bash
# Conformance test for charts/artifacts-platform: renders the chart and checks the output against
# platform_conformance_expected.py's frozen record of what the raw deploy/ manifests contained (deploy/
# itself is gone once T71 deletes it -- this test does not read it). Needs helm and python3 with the yaml
# module. No cluster, no Azure.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
chart="$root/charts/artifacts-platform"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

helm template artifacts-platform "$chart" -f "$chart/values.yaml" > "$tmp/default.yaml" 2>"$tmp/default.err"
if [ $? -ne 0 ]; then
  echo "helm template (default values) FAILED"
  cat "$tmp/default.err"
  exit 1
fi

helm template artifacts-platform "$chart" -f "$chart/values.yaml" --set authzMeshRoot.enableRootPolicy=true > "$tmp/root.yaml" 2>"$tmp/root.err"
if [ $? -ne 0 ]; then
  echo "helm template (authzMeshRoot.enableRootPolicy=true) FAILED"
  cat "$tmp/root.err"
  exit 1
fi

python3 "$root/charts/tests/platform_conformance.py" "$tmp/default.yaml" "$tmp/root.yaml"
