#!/usr/bin/env bash
# Conformance test for charts/artifacts-dev-allinone (dev-cluster demo, docs/DEV-AKS-DEMO.md). Renders the
# chart with `helm template` and asserts: every container restricted (non-root 65532, read-only root, no
# caps, seccomp); the platform container runs the combined process on BACKEND=disk with PIPELINE_TRIGGER=manual
# and DEV_AUTH=1; secrets only from the existing Secret; PVC-backed /data and /serving (gateway read-only);
# HTTPRoutes attach to the given gateway with the shell host and the artifact wildcard; sectionName omitted
# when empty and present when set; the optional intake route; artifacts-dynamic default-deny allowing only
# the gateway's pods on 8080; required values fail to render. Also asserts the PRODUCTION platform chart
# renders no DEV_AUTH or DEV_INSECURE_COOKIES — the dev switches live only here. No cluster needed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
chart="$root/charts/artifacts-dev-allinone"
base=(--set images.platform=r/scanner:t --set images.staticGateway=r/sg:t --set images.viewerShell=r/vs:t
      --set hosts.shell=shell.10-1-1-1.nip.io --set hosts.artifactDomain=a.10-1-1-1.sslip.io)
out="$(mktemp)"; out_section="$(mktemp)"; out_prod="$(mktemp)"
helm template demo "$chart" "${base[@]}" > "$out"
helm template demo "$chart" "${base[@]}" --set gateway.sectionName=https --set hosts.intake=intake.10-1-1-1.nip.io > "$out_section"
out_nosection="$(mktemp)"; helm template demo "$chart" "${base[@]}" --set gateway.sectionName= > "$out_nosection"
# required values
for missing in images.platform hosts.shell hosts.artifactDomain; do
  if helm template demo "$chart" "${base[@]}" --set "$missing=" >/dev/null 2>&1; then echo "FAIL: renders without $missing"; exit 1; fi
done
if helm template demo "$chart" "${base[@]}" --set hosts.artifactDomain=shell.10-1-1-1.nip.io >/dev/null 2>&1; then echo "FAIL: shell and artifact hosts may not be equal"; exit 1; fi
# production platform chart must carry no dev switches (it has its own required values; render with its test helper's args if any)
if helm template prod "$root/charts/artifacts-platform" > "$out_prod" 2>/dev/null; then :; else helm template prod "$root/charts/artifacts-platform" --set domains.artifacts=x.test --set domains.shell=s.test > "$out_prod" 2>/dev/null || true; fi
python3 - "$out" "$out_section" "$out_prod" "$out_nosection" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
docs_s = [d for d in yaml.safe_load_all(open(sys.argv[2])) if d]
prod = open(sys.argv[3]).read()
fails = []
def ok(cond, msg):
    if not cond: fails.append(msg)
by = lambda ds, kind: [d for d in ds if d.get("kind") == kind]
dep = by(docs, "Deployment")[0]
spec = dep["spec"]["template"]["spec"]
ok(dep["spec"]["replicas"] == 1, "replicas must be 1 (one process owns the disk stores)")
ok(spec.get("automountServiceAccountToken") is False, "no service account token (D12)")
ok(spec["securityContext"].get("fsGroup") == 65532, "fsGroup 65532 so the PVC is writable by the non-root user")
cs = {c["name"]: c for c in spec["containers"]}
ok(set(cs) == {"platform", "static-gateway", "viewer-shell"}, f"three containers, got {sorted(cs)}")
for name, c in cs.items():
    sc = c["securityContext"]
    ok(sc.get("runAsNonRoot") is True and sc.get("runAsUser") == 65532, f"{name}: non-root 65532")
    ok(sc.get("readOnlyRootFilesystem") is True, f"{name}: read-only root filesystem")
    ok(sc.get("allowPrivilegeEscalation") is False and sc.get("capabilities", {}).get("drop") == ["ALL"], f"{name}: no caps, no escalation")
    ok(sc.get("seccompProfile", {}).get("type") == "RuntimeDefault", f"{name}: seccomp RuntimeDefault")
    ok("readinessProbe" in c and "resources" in c, f"{name}: probe and resources")
    ok(any(m["mountPath"] == "/tmp" for m in c["volumeMounts"]), f"{name}: writable /tmp")
    for e in c["env"]:
        if e["name"] in ("PIPELINE_TOKEN", "INTERNAL_SHARED_KEY", "VIEW_TOKEN_KEY"):
            ok("valueFrom" in e and e["valueFrom"]["secretKeyRef"]["name"] == "artifacts-dev-secrets", f"{name}: {e['name']} from the existing Secret only")
env = {e["name"]: e.get("value") for e in cs["platform"]["env"]}
ok(cs["platform"]["command"] == ["node", "dist/intake-api/src/dev.js"], "platform runs the combined process")
ok(env.get("BACKEND") == "disk" and env.get("DATA_ROOT") == "/data" and env.get("SERVE_ROOT") == "/serving", "disk backend on the PVC")
ok(env.get("PIPELINE_TRIGGER") == "manual", "nothing deploys by itself")
ok(env.get("DEV_AUTH") == "1" and env.get("SHELL_ORIGIN") == "http://shell.10-1-1-1.nip.io", "dev auth + shell origin")
genv = {e["name"]: e.get("value") for e in cs["static-gateway"]["env"]}
ok(genv.get("ARTIFACT_DOMAIN") == "a.10-1-1-1.sslip.io" and genv.get("DEV_INSECURE_COOKIES") == "1", "gateway artifact domain + http cookies")
ok(any(m["mountPath"] == "/serving" and m.get("readOnly") for m in cs["static-gateway"]["volumeMounts"]), "gateway serves read-only")
senv = {e["name"]: e.get("value") for e in cs["viewer-shell"]["env"]}
ok(senv.get("ARTIFACT_SCHEME") == "http" and senv.get("INTAKE_INTERNAL_URL") == "http://127.0.0.1:8080" and senv.get("DEV_AUTH") == "1", "shell dev config")
ok(len(by(docs, "PersistentVolumeClaim")) == 1, "one PVC")
routes = {r["metadata"]["name"]: r for r in by(docs, "HTTPRoute")}
ok(set(routes) == {"artifacts-dev-shell", "artifacts-dev-artifacts"}, f"two routes by default, got {sorted(routes)}")
ok(routes["artifacts-dev-artifacts"]["spec"]["hostnames"] == ["*.a.10-1-1-1.sslip.io"], "artifact wildcard hostname")
pr = routes["artifacts-dev-shell"]["spec"]["parentRefs"][0]
ok(pr["name"] == "ingress-gateway" and pr["namespace"] == "istio-ingress" and pr.get("sectionName") == "http", "parentRef to the existing gateway on its plain-HTTP listener by default")
routes_s = {r["metadata"]["name"]: r for r in by(docs_s, "HTTPRoute")}
ok("artifacts-dev-intake" in routes_s, "intake route appears when hosts.intake is set")
ok(routes_s["artifacts-dev-shell"]["spec"]["parentRefs"][0].get("sectionName") == "https", "sectionName follows the value")
nosec = [d for d in yaml.safe_load_all(open(sys.argv[4])) if d and d.get("kind") == "HTTPRoute"]
ok(all("sectionName" not in r["spec"]["parentRefs"][0] for r in nosec), "empty sectionName is omitted, not rendered empty")
nss = {n["metadata"]["name"]: n for n in by(docs, "Namespace")}
for n in ("artifacts-dev", "artifacts-dynamic"):
    ok(nss[n]["metadata"]["labels"].get("pod-security.kubernetes.io/enforce") == "restricted", f"{n}: PSA restricted")
    ok(nss[n]["metadata"]["labels"].get("ingress-access") == "true", f"{n}: carries the label the gateway's allowedRoutes selector requires")
np = by(docs, "NetworkPolicy")[0]
ok(np["metadata"]["namespace"] == "artifacts-dynamic" and np["spec"]["policyTypes"] == ["Ingress", "Egress"] and "egress" not in np["spec"], "artifacts-dynamic default-deny, no egress")
frm = np["spec"]["ingress"][0]["from"][0]
ok(frm["podSelector"]["matchLabels"]["gateway.networking.k8s.io/gateway-name"] == "ingress-gateway" and frm["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] == "istio-ingress", "only the gateway's pods may reach artifact pods")
# The production chart may *mention* the switches in comments (it says never to set them); what matters is
# that no rendered container carries them as environment variables.
prod_env = set()
for d in yaml.safe_load_all(prod):
    if not d or d.get("kind") not in ("Deployment", "StatefulSet", "DaemonSet"): continue
    for c in d["spec"]["template"]["spec"].get("containers", []):
        prod_env.update(e["name"] for e in c.get("env", []))
ok(len(prod) > 0, "production chart rendered for the dev-switch check")
ok(not ({"DEV_AUTH", "DEV_INSECURE_COOKIES"} & prod_env), f"the production platform chart carries no dev switches (env: {sorted(prod_env & {'DEV_AUTH','DEV_INSECURE_COOKIES'})})")
if fails:
    print("FAIL:\n  " + "\n  ".join(fails)); sys.exit(1)
print(f"allinone-conformance: {len(docs)} documents, all assertions passed")
PY
rm -f "$out" "$out_section" "$out_prod" "$out_nosection"
