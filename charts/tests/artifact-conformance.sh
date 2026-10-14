#!/usr/bin/env bash
# Conformance test for charts/artifact-python (T72, M7, DESIGN §6.6). Renders the chart with `helm template`
# twice (streamlit and fastapi) against tests/corpus/python-ok/app.py, parses the output with python3 +
# PyYAML, and asserts every security field, label, probe port, entrypoint arg list and HTTPRoute hostname
# the raw deploy/python-artifact/template.yaml used to carry. Also asserts a bad artifactId or entrypoint
# fails to render. No cluster needed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
chart="$root/charts/artifact-python"
app="$root/tests/corpus/python-ok/app.py"
manifest="$root/tests/runtime-manifest.python-1.json"
digest="$(printf 'ab%.0s' $(seq 1 32))"   # 64 hex chars, obviously fake
image="jfrog.corp.com/artifacts/python-runtime@sha256:$digest"

render() {
  # render <entrypoint> <outfile>
  helm template art-abc123def456 "$chart" \
    --set artifactId=abc123def456 \
    --set-file appPy="$app" \
    --set expiresAt=2026-11-01T00:00:00Z \
    --set entrypoint="$1" \
    --set jobId=job-abc-001 \
    --set image="$image" \
    > "$2"
}

out_streamlit="$(mktemp)"; out_fastapi="$(mktemp)"
trap 'rm -f "$out_streamlit" "$out_fastapi"' EXIT

render streamlit "$out_streamlit"
render fastapi "$out_fastapi"

python3 - "$out_streamlit" "$out_fastapi" "$manifest" "$app" "$image" <<'PY'
import json, sys, yaml

out_streamlit, out_fastapi, manifest_path, app_path, image = sys.argv[1:6]
manifest = json.load(open(manifest_path))

def load(path):
    docs = [d for d in yaml.safe_load_all(open(path)) if d]
    kinds = {d["kind"]: d for d in docs}
    assert set(kinds) == {"ConfigMap", "Deployment", "Service", "HTTPRoute"}, set(kinds)
    return docs, kinds

docs, kinds = load(out_streamlit)

for d in docs:
    md = d["metadata"]
    assert md["namespace"] == "artifacts-dynamic", md
    labels = md["labels"]
    assert labels["artifacts.corp.com/id"] == "abc123def456", labels
    assert labels["artifacts.corp.com/expires-at"] == "2026-11-01T00-00-00Z", labels
    assert labels["artifacts.corp.com/job"] == "job-abc-001", labels
    assert labels["app.kubernetes.io/managed-by"] == "Helm", labels

dep = kinds["Deployment"]
pod = dep["spec"]["template"]["spec"]
c = pod["containers"][0]

assert pod["automountServiceAccountToken"] is False
assert pod["enableServiceLinks"] is False
assert pod["nodeSelector"] == {"agentpool": "untrusted"}
assert pod["tolerations"] == [{"key": "artifacts.corp.com/untrusted", "operator": "Equal", "value": "true", "effect": "NoSchedule"}]

sc = pod["securityContext"]
assert sc["runAsNonRoot"] is True
assert sc["runAsUser"] == 65532
assert sc["runAsGroup"] == 65532
assert sc["fsGroup"] == 65532
assert sc["seccompProfile"] == {"type": "RuntimeDefault"}

assert c["image"] == image
csc = c["securityContext"]
assert csc["allowPrivilegeEscalation"] is False
assert csc["readOnlyRootFilesystem"] is True
assert csc["capabilities"]["drop"] == ["ALL"]

assert c["resources"]["requests"] == {"cpu": "100m", "memory": "128Mi"}
assert c["resources"]["limits"] == {"cpu": "500m", "memory": "512Mi", "ephemeral-storage": "256Mi"}

assert [v["name"] for v in pod["volumes"]] == ["code", "tmp"]
assert pod["volumes"][0]["configMap"]["name"] == "art-abc123def456-code"
assert pod["volumes"][1]["emptyDir"] == {"sizeLimit": "128Mi"}

mounts = [m["name"] for m in c["volumeMounts"]]
assert mounts == ["code", "tmp"]
assert [m for m in c["volumeMounts"] if m["name"] == "code"][0]["readOnly"] is True

assert c["ports"] == [{"containerPort": 8080}]
assert c["readinessProbe"]["httpGet"] == {"path": "/", "port": 8080}
assert c["readinessProbe"]["periodSeconds"] == 5
assert c["readinessProbe"]["failureThreshold"] == 12
assert c["livenessProbe"]["httpGet"] == {"path": "/", "port": 8080}
assert c["livenessProbe"]["periodSeconds"] == 30

assert dep["spec"]["selector"]["matchLabels"] == {"artifacts.corp.com/id": "abc123def456"}
assert c["args"] == manifest["entrypoints"]["streamlit"], c["args"]

src = open(app_path).read()
assert kinds["ConfigMap"]["data"]["app.py"].rstrip("\n") == src.rstrip("\n"), "app.py altered by rendering"

assert kinds["Service"]["spec"]["selector"] == {"artifacts.corp.com/id": "abc123def456"}
assert kinds["Service"]["spec"]["ports"] == [{"name": "http", "port": 8080, "targetPort": 8080}]

route = kinds["HTTPRoute"]["spec"]
assert route["hostnames"] == ["abc123def456.corp-artifacts.net"], route["hostnames"]
assert route["parentRefs"] == [{"name": "artifacts-internal", "namespace": "artifacts-system", "sectionName": "content"}]
assert route["rules"][0]["backendRefs"] == [{"name": "art-abc123def456", "port": 8080}]

print("conformance ok  streamlit: " + ", ".join(f'{d["kind"]}/{d["metadata"]["name"]}' for d in docs))

# fastapi args come from the same manifest
_, fkinds = load(out_fastapi)
fargs = fkinds["Deployment"]["spec"]["template"]["spec"]["containers"][0]["args"]
assert fargs == manifest["entrypoints"]["fastapi"], fargs
print("conformance ok  fastapi args")
PY

# refusals: a bad artifactId or entrypoint must fail to render, not degrade silently.
expect_fail() {
  if helm template art-x "$chart" "$@" >/dev/null 2>&1; then
    echo "conformance FAIL: accepted bad input: $*"
    exit 1
  fi
  echo "conformance ok  refused: $*"
}

expect_fail --set artifactId=ABC123DEF456 --set-file appPy="$app" --set expiresAt=2026-11-01T00:00:00Z --set entrypoint=streamlit --set image="$image"
expect_fail --set artifactId=short --set-file appPy="$app" --set expiresAt=2026-11-01T00:00:00Z --set entrypoint=streamlit --set image="$image"
expect_fail --set artifactId=abc123def456 --set-file appPy="$app" --set expiresAt=2026-11-01T00:00:00Z --set entrypoint=node --set image="$image"
expect_fail --set artifactId=abc123def456 --set-file appPy="$app" --set expiresAt= --set entrypoint=streamlit --set image="$image"
expect_fail --set artifactId=abc123def456 --set-file appPy="$app" --set expiresAt=2026-11-01T00:00:00Z --set entrypoint=streamlit --set image="jfrog.corp.com/artifacts/python-runtime:latest"

echo "artifact-conformance: all checks passed"
