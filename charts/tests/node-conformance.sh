#!/usr/bin/env bash
# Conformance test for charts/artifact-node (T82, M8, DESIGN D14/§6.13). Renders the chart with
# `helm template` twice (default writablePaths, then a custom list), parses the output with python3 +
# PyYAML, and asserts every security field, the emptyDir mounts covering each writable path, the CSP filter
# (with connect-src 'self'), labels/annotation and probe ports the raw DESIGN §6.6 posture requires, plus
# the node prototype-specific HTTPRoute filter and expiry header. Also asserts a bad artifactId, missing expiresAt, or
# tag-only image fails to render. No cluster needed. Pattern-matched on
# charts/tests/artifact-conformance.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
chart="$root/charts/artifact-node"
digest="$(printf 'ab%.0s' $(seq 1 32))"   # 64 hex chars, obviously fake
artifact_id="abc123def456"
image="jfrog.corp.com/artifacts/node-$artifact_id@sha256:$digest"
shell_origin="https://artifacts.corp.com"

render() {
  # render <outfile> [extra --set args...]
  out="$1"; shift
  helm template "prototype-$artifact_id" "$chart" \
    --set artifactId="$artifact_id" \
    --set expiresAt=2026-11-01T00:00:00Z \
    --set jobId=job-abc-001 \
    --set image="$image" \
    "$@" \
    > "$out"
}

out_default="$(mktemp)"; out_custom="$(mktemp)"
trap 'rm -f "$out_default" "$out_custom"' EXIT

render "$out_default"
render "$out_custom" --set 'writablePaths[0]=/app/uploads' --set 'writablePaths[1]=/app/cache' --set 'writablePaths[2]=/tmp' --set writablePathSizeLimit=64Mi

assertions=0

python3 - "$out_default" "$out_custom" "$image" "$artifact_id" "$shell_origin" <<'PY'
import sys, yaml

out_default, out_custom, image, artifact_id, shell_origin = sys.argv[1:6]
n = 0

def check(cond, msg):
    global n
    assert cond, msg
    n += 1

def load(path):
    docs = [d for d in yaml.safe_load_all(open(path)) if d]
    kinds = {d["kind"]: d for d in docs}
    return docs, kinds

docs, kinds = load(out_default)
check(set(kinds) == {"Deployment", "Service", "HTTPRoute"}, set(kinds))

for d in docs:
    md = d["metadata"]
    check(md["namespace"] == "artifacts-dynamic", md)
    labels = md["labels"]
    check(labels["artifacts.corp.com/id"] == artifact_id, labels)
    check(labels["artifacts.corp.com/expires-at"] == "2026-11-01T00-00-00Z", labels)
    check(labels["artifacts.corp.com/job"] == "job-abc-001", labels)
    check(labels["app.kubernetes.io/managed-by"] == "Helm", labels)

dep = kinds["Deployment"]
check(dep["metadata"]["name"] == f"prototype-{artifact_id}", dep["metadata"])
check(dep["metadata"]["annotations"]["artifacts.corp.com/expires-at"] == "2026-11-01T00-00-00Z", dep["metadata"])
pod = dep["spec"]["template"]["spec"]
c = pod["containers"][0]

check(pod["automountServiceAccountToken"] is False, "automountServiceAccountToken")
check(pod["enableServiceLinks"] is False, "enableServiceLinks")
check(pod["nodeSelector"] == {"agentpool": "untrusted"}, pod["nodeSelector"])
check(pod["tolerations"] == [{"key": "artifacts.corp.com/untrusted", "operator": "Equal", "value": "true", "effect": "NoSchedule"}], pod["tolerations"])

sc = pod["securityContext"]
check(sc["runAsNonRoot"] is True, sc)
check(sc["runAsUser"] == 65532, sc)
check(sc["runAsGroup"] == 65532, sc)
check(sc["fsGroup"] == 65532, sc)
check(sc["seccompProfile"] == {"type": "RuntimeDefault"}, sc)

check(c["image"] == image, c["image"])
csc = c["securityContext"]
check(csc["allowPrivilegeEscalation"] is False, csc)
check(csc["readOnlyRootFilesystem"] is True, csc)
check(csc["capabilities"]["drop"] == ["ALL"], csc)

check(c["resources"]["requests"] == {"cpu": "100m", "memory": "128Mi"}, c["resources"])
check(c["resources"]["limits"] == {"cpu": "500m", "memory": "512Mi", "ephemeral-storage": "256Mi"}, c["resources"])

check([e["name"] for e in c["env"]] == ["PROTOTYPE_EXPIRES_AT"], c["env"])
check(c["env"][0]["value"] == "2026-11-01T00:00:00Z", c["env"])

check(c["ports"] == [{"containerPort": 8080}], c["ports"])
check(c["readinessProbe"]["httpGet"] == {"path": "/", "port": 8080}, c["readinessProbe"])
check(c["readinessProbe"]["periodSeconds"] == 5, c["readinessProbe"])
check(c["readinessProbe"]["failureThreshold"] == 12, c["readinessProbe"])
check(c["livenessProbe"]["httpGet"] == {"path": "/", "port": 8080}, c["livenessProbe"])
check(c["livenessProbe"]["periodSeconds"] == 30, c["livenessProbe"])

check(dep["spec"]["selector"]["matchLabels"] == {"artifacts.corp.com/id": artifact_id}, dep["spec"]["selector"])

# default writablePaths: /app/data and /tmp, each its own emptyDir, 128Mi default
check([v["name"] for v in pod["volumes"]] == ["app-data", "tmp"], pod["volumes"])
check(pod["volumes"][0]["emptyDir"] == {"sizeLimit": "128Mi"}, pod["volumes"][0])
check(pod["volumes"][1]["emptyDir"] == {"sizeLimit": "128Mi"}, pod["volumes"][1])
mounts = {m["name"]: m["mountPath"] for m in c["volumeMounts"]}
check(mounts == {"app-data": "/app/data", "tmp": "/tmp"}, mounts)
check(len(c["volumeMounts"]) == len(pod["volumes"]), "every writable path has exactly one mount and one volume")

check(kinds["Service"]["spec"]["selector"] == {"artifacts.corp.com/id": artifact_id}, kinds["Service"]["spec"])
check(kinds["Service"]["spec"]["ports"] == [{"name": "http", "port": 8080, "targetPort": 8080}], kinds["Service"]["spec"])

route = kinds["HTTPRoute"]["spec"]
check(route["hostnames"] == [f"{artifact_id}.corp-artifacts.net"], route["hostnames"])
check(route["parentRefs"] == [{"name": "artifacts-internal", "namespace": "artifacts-system", "sectionName": "content"}], route["parentRefs"])
rule = route["rules"][0]
check(rule["backendRefs"] == [{"name": f"prototype-{artifact_id}", "port": 8080}], rule["backendRefs"])

filters = rule["filters"]
check(len(filters) == 1 and filters[0]["type"] == "ResponseHeaderModifier", filters)
headers = {h["name"]: h["value"] for h in filters[0]["responseHeaderModifier"]["set"]}
check(set(headers) == {"Content-Security-Policy", "X-Prototype-Expires"}, headers)
csp = headers["Content-Security-Policy"]
check("default-src 'self'" in csp, csp)
check("script-src 'self' 'unsafe-inline'" in csp, csp)
check("style-src 'self' 'unsafe-inline'" in csp, csp)
check("img-src 'self' data: blob:" in csp, csp)
check("connect-src 'self'" in csp, csp)
check(f"frame-ancestors {shell_origin}" in csp, csp)
check("form-action 'self'" in csp, csp)
check("base-uri 'none'" in csp, csp)
check("object-src 'none'" in csp, csp)
check(headers["X-Prototype-Expires"] == "2026-11-01T00:00:00Z", headers)

print(f"conformance ok  default writablePaths: {', '.join(f'{d['kind']}/{d['metadata']['name']}' for d in docs)}")

# custom writablePaths + custom sizeLimit
_, ckinds = load(out_custom)
cpod = ckinds["Deployment"]["spec"]["template"]["spec"]
ccontainer = cpod["containers"][0]
check([v["name"] for v in cpod["volumes"]] == ["app-uploads", "app-cache", "tmp"], cpod["volumes"])
for v in cpod["volumes"]:
    check(v["emptyDir"] == {"sizeLimit": "64Mi"}, v)
cmounts = {m["name"]: m["mountPath"] for m in ccontainer["volumeMounts"]}
check(cmounts == {"app-uploads": "/app/uploads", "app-cache": "/app/cache", "tmp": "/tmp"}, cmounts)
print(f"conformance ok  custom writablePaths: {sorted(cmounts.values())}")

print(f"ASSERTIONS={n}")
PY

# refusals: a bad artifactId, missing expiresAt, mismatched/tag-only image must fail to render, not degrade
# silently.
expect_fail() {
  if helm template "prototype-x" "$chart" "$@" >/dev/null 2>&1; then
    echo "conformance FAIL: accepted bad input: $*"
    exit 1
  fi
  echo "conformance ok  refused: $*"
}

expect_fail --set artifactId=ABC123DEF456 --set expiresAt=2026-11-01T00:00:00Z --set image="$image"
expect_fail --set artifactId=short --set expiresAt=2026-11-01T00:00:00Z --set image="$image"
expect_fail --set artifactId="$artifact_id" --set expiresAt= --set image="$image"
expect_fail --set artifactId="$artifact_id" --set expiresAt=2026-11-01T00:00:00Z --set image="jfrog.corp.com/artifacts/node-$artifact_id:latest"
# image digest built for a *different* artifactId must also be refused (image regex is tied to artifactId).
expect_fail --set artifactId="$artifact_id" --set expiresAt=2026-11-01T00:00:00Z --set image="jfrog.corp.com/artifacts/node-other999999@sha256:$digest"
# empty writablePaths must be refused.
expect_fail --set artifactId="$artifact_id" --set expiresAt=2026-11-01T00:00:00Z --set image="$image" --set writablePaths='{}'
# relative writablePaths entry must be refused.
expect_fail --set artifactId="$artifact_id" --set expiresAt=2026-11-01T00:00:00Z --set image="$image" --set 'writablePaths[0]=relative/path'

echo "node-conformance: all checks passed"

# --- dev-cluster shape: a different registry prefix and an empty listener name must render (and the
#     default must still refuse a foreign registry) ---
out_dev="$(mktemp)"
render "$out_dev" --set imageRegistry=myacr.azurecr.io/artifacts --set image="myacr.azurecr.io/artifacts/node-$artifact_id@sha256:$digest" --set gateway.sectionName=""
python3 - "$out_dev" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
route = [d for d in docs if d["kind"] == "HTTPRoute"][0]
assert "sectionName" not in route["spec"]["parentRefs"][0], "empty sectionName must be omitted, not rendered empty"
dep = [d for d in docs if d["kind"] == "Deployment"][0]
assert dep["spec"]["template"]["spec"]["containers"][0]["image"].startswith("myacr.azurecr.io/artifacts/node-"), "custom registry accepted"
print("conformance ok  dev-cluster registry + no sectionName")
PY
expect_fail --set artifactId="$artifact_id" --set expiresAt=2026-11-01T00:00:00Z --set image="myacr.azurecr.io/artifacts/node-$artifact_id@sha256:$digest" --set jobId=job-abc-001
echo "conformance ok  default registry still refuses a foreign one"
rm -f "$out_dev"
