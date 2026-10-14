#!/usr/bin/env bash
# Renders tests/corpus/python-ok/app.py and checks the output against DESIGN §6.6. Also checks that bad
# inputs are refused. No cluster needed; python3 with PyYAML.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
app="$root/tests/corpus/python-ok/app.py"
manifest="$root/tests/runtime-manifest.python-1.json"
digest="$(printf 'ab%.0s' $(seq 1 32))"   # 64 hex chars, obviously fake
image="jfrog.corp.com/artifacts/python-runtime@sha256:$digest"
out="$(mktemp)"; trap 'rm -f "$out"' EXIT

"$here/render.sh" abc123def456 "$app" 2026-10-28T00:00:00Z streamlit "$image" > "$out"

python3 - "$out" "$manifest" "$app" "$image" <<'PY'
import json, sys, yaml
out, manifest, app, image = sys.argv[1:5]
docs = [d for d in yaml.safe_load_all(open(out)) if d]
kinds = {d["kind"]: d for d in docs}
assert set(kinds) == {"ConfigMap", "Deployment", "Service", "HTTPRoute"}, set(kinds)
for d in docs:
    assert d["metadata"]["namespace"] == "artifacts-dynamic", d["metadata"]
    assert d["metadata"]["labels"]["artifacts.corp.com/id"] == "abc123def456"
    assert d["metadata"]["labels"]["artifacts.corp.com/expires-at"] == "2026-10-28T00-00-00Z"
dep = kinds["Deployment"]
pod = dep["spec"]["template"]["spec"]
c = pod["containers"][0]
assert pod["automountServiceAccountToken"] is False
assert pod["enableServiceLinks"] is False
assert pod["securityContext"]["runAsNonRoot"] is True
assert pod["securityContext"]["runAsUser"] == 65532
assert pod["securityContext"]["seccompProfile"] == {"type": "RuntimeDefault"}
assert pod["nodeSelector"] == {"agentpool": "untrusted"}
assert pod["tolerations"] == [{"key": "artifacts.corp.com/untrusted", "operator": "Equal", "value": "true", "effect": "NoSchedule"}]
assert c["image"] == image
assert c["securityContext"]["readOnlyRootFilesystem"] is True
assert c["securityContext"]["allowPrivilegeEscalation"] is False
assert c["securityContext"]["capabilities"]["drop"] == ["ALL"]
assert c["args"] == json.load(open(manifest))["entrypoints"]["streamlit"], c["args"]
assert [v["name"] for v in pod["volumes"]] == ["code", "tmp"]
assert pod["volumes"][0]["configMap"]["name"] == "art-abc123def456-code"
assert dep["spec"]["selector"]["matchLabels"] == {"artifacts.corp.com/id": "abc123def456"}
src = open(app).read()
assert kinds["ConfigMap"]["data"]["app.py"].rstrip("\n") == src.rstrip("\n"), "app.py altered by rendering"
assert kinds["Service"]["spec"]["selector"] == {"artifacts.corp.com/id": "abc123def456"}
route = kinds["HTTPRoute"]["spec"]
assert route["hostnames"] == ["abc123def456.corp-artifacts.net"]
assert route["parentRefs"] == [{"name": "artifacts-internal", "namespace": "artifacts-system", "sectionName": "content"}]
assert route["rules"][0]["backendRefs"] == [{"name": "art-abc123def456", "port": 8080}]
print("render ok  " + ", ".join(f'{d["kind"]}/{d["metadata"]["name"]}' for d in docs))
PY

# fastapi args come from the same manifest
"$here/render.sh" abc123def456 "$app" 2026-10-28T00:00:00Z fastapi "$image" \
  | python3 -c 'import sys,json,yaml; d=[x for x in yaml.safe_load_all(sys.stdin) if x and x["kind"]=="Deployment"][0]; m=json.load(open(sys.argv[1])); assert d["spec"]["template"]["spec"]["containers"][0]["args"]==m["entrypoints"]["fastapi"]; print("render ok  fastapi args")' "$manifest"

# refusals
expect_fail() {
  if "$here/render.sh" "$@" >/dev/null 2>&1; then echo "render FAIL: accepted bad input: $*"; exit 1; fi
  echo "render ok  refused: $1 $4 ${5##*/python-runtime}"
}
expect_fail "ABC123DEF456" "$app" 2026-10-28T00:00:00Z streamlit "$image"
expect_fail abc123def456 "$app" 2026-10-28 streamlit "$image"
expect_fail abc123def456 "$app" 2026-10-28T00:00:00Z node "$image"
expect_fail abc123def456 "$app" 2026-10-28T00:00:00Z streamlit "jfrog.corp.com/artifacts/python-runtime:latest"
expect_fail abc123def456 "$app" 2026-10-28T00:00:00Z streamlit "docker.io/library/python@sha256:$digest"
big="$(mktemp)"; head -c 1048577 /dev/zero | tr '\0' '#' > "$big"
expect_fail abc123def456 "$big" 2026-10-28T00:00:00Z streamlit "$image"; rm -f "$big"
