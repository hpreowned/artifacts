#!/usr/bin/env bash
# Offline validation for deploy/, pipelines/ and the scripts: every manifest and pipeline parses as YAML,
# every script passes bash -n, and the python artifact template renders correctly. No cluster, no Azure.
# Needs python3 with PyYAML. Exit non-zero on any failure.
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

for y in "$root"/deploy/*.yaml "$root"/deploy/platform/*.yaml "$root"/pipelines/*.yml; do
  [ -e "$y" ] || continue
  check_yaml "$y" || fail=1
done
# deploy/python-artifact/template.yaml is not valid YAML until rendered; test-render.sh covers it.

while IFS= read -r s; do
  if bash -n "$s"; then echo "sh ok     $s"; else echo "sh FAIL   $s"; fail=1; fi
done < <(find "$root/deploy" "$root/pipelines" "$root/infra" "$root/python-runtime" -name '*.sh' 2>/dev/null | sort)

if [ -x "$root/deploy/python-artifact/test-render.sh" ]; then
  "$root/deploy/python-artifact/test-render.sh" || fail=1
fi

[ "$fail" = 0 ] && echo "validate: all passed" || echo "validate: FAILURES"
exit "$fail"
