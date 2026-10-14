#!/usr/bin/env bash
# Offline validation for deploy/, pipelines/, charts/artifacts-platform and the scripts: every manifest and
# pipeline parses as YAML, every script passes bash -n, the Helm chart lints and renders, its conformance
# test passes, and the python artifact template renders correctly. No cluster, no Azure. Needs python3 with
# PyYAML and helm v4. Exit non-zero on any failure.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

check_yaml() {
  python3 - "$1" <<'PY'
import sys, yaml
path = sys.argv[1]
try:
    docs = [d for d in yaml.safe_load_all(open(path)) if d]
except Exception as e:
    print(f"yaml FAIL {path}: {e}"); sys.exit(1)
names = []
for d in docs:
    if isinstance(d, dict) and "kind" in d:
        names.append(f'{d["kind"]}/{d.get("metadata", {}).get("name", "?")}')
print(f"yaml ok   {path}  ({len(docs)} docs){': ' + ', '.join(names) if names else ''}")
PY
}

for y in "$root"/deploy/*.yaml "$root"/pipelines/*.yml; do
  [ -e "$y" ] || continue
  check_yaml "$y" || fail=1
done
# deploy/python-artifact/template.yaml is not valid YAML until rendered; test-render.sh covers it.
# deploy/platform/, deploy/namespaces.yaml, deploy/gateway.yaml, deploy/routes-static.yaml,
# deploy/networkpolicy-*.yaml and deploy/authz-mesh-root.yaml are gone (T71): charts/artifacts-platform
# replaces them, checked below.

if command -v helm >/dev/null 2>&1; then
  if helm lint "$root/charts/artifacts-platform"; then
    echo "helm lint ok  charts/artifacts-platform"
  else
    echo "helm lint FAIL  charts/artifacts-platform"; fail=1
  fi
  for vf in "$root/charts/artifacts-platform/values.yaml" "$root/charts/artifacts-platform/values.example.yaml"; do
    if helm template artifacts-platform "$root/charts/artifacts-platform" -f "$vf" >/dev/null; then
      echo "helm template ok  $vf"
    else
      echo "helm template FAIL  $vf"; fail=1
    fi
  done
else
  echo "helm not found -- skipping helm lint/template/conformance for charts/artifacts-platform"; fail=1
fi

if [ -x "$root/charts/tests/platform-conformance.sh" ]; then
  if "$root/charts/tests/platform-conformance.sh"; then
    echo "conformance ok  charts/artifacts-platform"
  else
    echo "conformance FAIL  charts/artifacts-platform"; fail=1
  fi
fi

if command -v helm >/dev/null 2>&1; then
  if helm lint "$root/charts/artifact-python" >/dev/null; then
    echo "helm lint ok  charts/artifact-python"
  else
    echo "helm lint FAIL  charts/artifact-python"; fail=1
  fi
fi
if [ -x "$root/charts/tests/artifact-conformance.sh" ]; then
  if "$root/charts/tests/artifact-conformance.sh"; then
    echo "conformance ok  charts/artifact-python"
  else
    echo "conformance FAIL  charts/artifact-python"; fail=1
  fi
fi

while IFS= read -r s; do
  if bash -n "$s"; then echo "sh ok     $s"; else echo "sh FAIL   $s"; fail=1; fi
done < <(find "$root/deploy" "$root/pipelines" "$root/infra" "$root/python-runtime" -name '*.sh' 2>/dev/null | sort)

if [ -x "$root/deploy/python-artifact/test-render.sh" ]; then
  "$root/deploy/python-artifact/test-render.sh" || fail=1
fi
if [ -x "$root/python-runtime/test-emit-manifest.sh" ]; then
  "$root/python-runtime/test-emit-manifest.sh" || fail=1
fi

[ "$fail" = 0 ] && echo "validate: all passed" || echo "validate: FAILURES"
exit "$fail"
