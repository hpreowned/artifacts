#!/usr/bin/env python3
"""Conformance check: does `helm template` of charts/artifacts-platform still carry everything the raw
deploy/ manifests had? Compares the rendered output against the frozen expectations in
platform_conformance_expected.py (captured from the raw files before T71 deleted them), never against the
raw files themselves (they are gone).

Usage: platform_conformance.py <default-render.yaml> <root-policy-render.yaml>
  default-render.yaml      helm template output with the chart's default values.yaml (authzMeshRoot off)
  root-policy-render.yaml  helm template output with authzMeshRoot.enableRootPolicy=true

Exits 0 and prints "<n> assertions, 0 failures" on success; exits 1 and lists every failure otherwise.
"""
import sys
import os
import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from platform_conformance_expected import (  # noqa: E402
    EXPECTED_DEPLOYMENTS, EXPECTED_SERVICES, EXPECTED_SERVICEACCOUNTS, EXPECTED_NETWORKPOLICIES,
    EXPECTED_AUTHZ_CANARY, EXPECTED_AUTHZ_ROOT, EXPECTED_AUTHZ_PRINCIPALS, EXPECTED_GATEWAY_NAME,
    EXPECTED_GATEWAY_LISTENERS, EXPECTED_HTTPROUTES, EXPECTED_NAMESPACE_LABELS,
    EXPECTED_NO_DATAPLANE_MODE_NAMESPACE, EXPECTED_QUOTA, EXPECTED_QUOTA_HARD, EXPECTED_SPCS,
    EXPECTED_GATEWAY_TLS_SPC_SECRETS, EXPECTED_PV_NAME, EXPECTED_PV, EXPECTED_PV_MOUNT_OPTIONS, EXPECTED_PVC,
)

COUNT = 0
FAILURES = []


def check(desc, actual, expected):
    global COUNT
    COUNT += 1
    if actual != expected:
        FAILURES.append(f"{desc}: expected {expected!r}, got {actual!r}")


def check_true(desc, cond):
    global COUNT
    COUNT += 1
    if not cond:
        FAILURES.append(f"{desc}: expected true, got false")


def load_docs(path):
    with open(path) as f:
        return [d for d in yaml.safe_load_all(f) if d]


def index(docs):
    by_kind_name = {}
    for d in docs:
        kind = d.get("kind")
        ns = d.get("metadata", {}).get("namespace")
        name = d.get("metadata", {}).get("name")
        by_kind_name.setdefault(kind, {})[(ns, name)] = d
    return by_kind_name


def normalize_volume(v):
    if "emptyDir" in v:
        return {"emptyDir": v["emptyDir"]}
    if "csi" in v:
        return {"csi_secretProviderClass": v["csi"]["volumeAttributes"]["secretProviderClass"]}
    if "persistentVolumeClaim" in v:
        return {"pvc": v["persistentVolumeClaim"]["claimName"]}
    return v


def normalize_probe(p):
    if p is None:
        return None
    http_get = p.get("httpGet", {})
    out = {"path": http_get.get("path"), "port": http_get.get("port"), "periodSeconds": p.get("periodSeconds")}
    if "failureThreshold" in p:
        out["failureThreshold"] = p["failureThreshold"]
    return out


def normalize_volume_mount(vm):
    out = {"name": vm["name"], "mountPath": vm["mountPath"]}
    if "readOnly" in vm:
        out["readOnly"] = vm["readOnly"]
    return out


def check_deployments(by_kind):
    deployments = by_kind.get("Deployment", {})
    for (ns, name), expected in EXPECTED_DEPLOYMENTS.items():
        doc = deployments.get((ns, name))
        check_true(f"Deployment {ns}/{name} exists", doc is not None)
        if doc is None:
            continue
        spec = doc["spec"]
        pod_spec = spec["template"]["spec"]
        check(f"{ns}/{name} replicas", spec.get("replicas"), expected["replicas"])
        check(f"{ns}/{name} serviceAccountName", pod_spec.get("serviceAccountName"), expected["serviceAccountName"])
        check(f"{ns}/{name} automountServiceAccountToken", pod_spec.get("automountServiceAccountToken"), expected["automountServiceAccountToken"])
        check(f"{ns}/{name} podSecurityContext", pod_spec.get("securityContext"), expected["podSecurityContext"])
        check(f"{ns}/{name} nodeSelector", pod_spec.get("nodeSelector"), expected["nodeSelector"])
        check(f"{ns}/{name} tolerations", pod_spec.get("tolerations"), expected["tolerations"])

        volumes_actual = {v["name"]: normalize_volume(v) for v in pod_spec.get("volumes", [])}
        check(f"{ns}/{name} volumes", volumes_actual, expected["volumes"])

        containers = pod_spec.get("containers", [])
        check_true(f"{ns}/{name} has exactly one container", len(containers) == 1)
        c = containers[0] if containers else {}
        ec = expected["container"]
        check(f"{ns}/{name} container name", c.get("name"), ec["name"])
        check(f"{ns}/{name} container image", c.get("image"), ec["image"])
        check(f"{ns}/{name} container ports", c.get("ports", []), ec["ports"])
        check(f"{ns}/{name} env names", [e["name"] for e in c.get("env", [])], ec["env_names"])
        check(
            f"{ns}/{name} envFrom secretRefs",
            [e["secretRef"]["name"] for e in c.get("envFrom", [])],
            ec["envFrom_secretRefs"],
        )
        check(f"{ns}/{name} container securityContext", c.get("securityContext"), ec["securityContext"])
        check(f"{ns}/{name} resources", c.get("resources"), ec["resources"])
        check(f"{ns}/{name} readinessProbe", normalize_probe(c.get("readinessProbe")), ec["readinessProbe"])
        check(f"{ns}/{name} livenessProbe", normalize_probe(c.get("livenessProbe")), ec["livenessProbe"])
        check(
            f"{ns}/{name} volumeMounts",
            [normalize_volume_mount(vm) for vm in c.get("volumeMounts", [])],
            ec["volumeMounts"],
        )


def check_services(by_kind):
    services = by_kind.get("Service", {})
    for (ns, name), expected in EXPECTED_SERVICES.items():
        doc = services.get((ns, name))
        check_true(f"Service {ns}/{name} exists", doc is not None)
        if doc is None:
            continue
        spec = doc["spec"]
        check(f"{ns}/{name} service selector", spec.get("selector"), expected["selector"])
        ports = spec.get("ports", [])
        check_true(f"{ns}/{name} service has one port", len(ports) == 1)
        p = ports[0] if ports else {}
        check(f"{ns}/{name} service port", p.get("port"), expected["port"])
        check(f"{ns}/{name} service targetPort", p.get("targetPort"), expected["targetPort"])


def check_serviceaccounts(by_kind):
    sas = by_kind.get("ServiceAccount", {})
    for (ns, name) in EXPECTED_SERVICEACCOUNTS:
        doc = sas.get((ns, name))
        check_true(f"ServiceAccount {ns}/{name} exists", doc is not None)
        if doc is None:
            continue
        check(f"{ns}/{name} SA automountServiceAccountToken", doc.get("automountServiceAccountToken"), False)
        annotations = doc.get("metadata", {}).get("annotations", {})
        check_true(f"{ns}/{name} SA has workload-identity client-id annotation", "azure.workload.identity/client-id" in annotations)


def check_networkpolicies(by_kind):
    nps = by_kind.get("NetworkPolicy", {})
    for (ns, name), expected in EXPECTED_NETWORKPOLICIES.items():
        doc = nps.get((ns, name))
        check_true(f"NetworkPolicy {ns}/{name} exists", doc is not None)
        if doc is None:
            continue
        spec = doc["spec"]
        pod_selector = spec.get("podSelector", {})
        pod_selector = pod_selector.get("matchLabels", {}) if pod_selector else pod_selector
        check(f"{ns}/{name} podSelector", pod_selector, expected["podSelector"])
        check(f"{ns}/{name} policyTypes", set(spec.get("policyTypes", [])), expected["policyTypes"])
        ingress = spec.get("ingress", [])
        check_true(f"{ns}/{name} has one ingress rule", len(ingress) == 1)
        rule = ingress[0] if ingress else {}
        check(f"{ns}/{name} ingress ports", rule.get("ports", []), expected["ingress_ports"])
        check_true(f"{ns}/{name} has no egress rules", "egress" not in spec or spec.get("egress") in (None, []))

        if "has_namespaceSelector" in expected:
            frm = rule.get("from", [{}])[0]
            check(f"{ns}/{name} ingress has namespaceSelector", "namespaceSelector" in frm, expected["has_namespaceSelector"])
            check(
                f"{ns}/{name} ingress gateway name selector",
                frm.get("podSelector", {}).get("matchLabels", {}).get("gateway.networking.k8s.io/gateway-name"),
                expected["gateway_name_selector"],
            )
        if "from_pod_selectors" in expected:
            selectors = [f.get("podSelector", {}).get("matchLabels") for f in rule.get("from", [])]
            check(f"{ns}/{name} from pod selectors", selectors, expected["from_pod_selectors"])


def check_authz(by_kind_default, by_kind_root):
    aps = by_kind_default.get("AuthorizationPolicy", {})
    ns, name = EXPECTED_AUTHZ_CANARY
    doc = aps.get((ns, name))
    check_true(f"AuthorizationPolicy canary {ns}/{name} exists", doc is not None)
    if doc is not None:
        principals = doc["spec"]["rules"][0]["from"][0]["source"]["principals"]
        check("canary principals", principals, EXPECTED_AUTHZ_PRINCIPALS)
        check("canary action", doc["spec"].get("action"), "ALLOW")

    ns, name = EXPECTED_AUTHZ_ROOT
    check_true(f"AuthorizationPolicy root {ns}/{name} absent with enableRootPolicy=false", (ns, name) not in aps)

    root_aps = by_kind_root.get("AuthorizationPolicy", {})
    root_doc = root_aps.get((ns, name))
    check_true(f"AuthorizationPolicy root {ns}/{name} exists with enableRootPolicy=true", root_doc is not None)
    if root_doc is not None:
        principals = root_doc["spec"]["rules"][0]["from"][0]["source"]["principals"]
        check("root principals", principals, EXPECTED_AUTHZ_PRINCIPALS)
        check("root action", root_doc["spec"].get("action"), "ALLOW")


def check_gateway(by_kind):
    gws = by_kind.get("Gateway", {})
    ns, name = EXPECTED_GATEWAY_NAME
    doc = gws.get((ns, name))
    check_true(f"Gateway {ns}/{name} exists", doc is not None)
    if doc is None:
        return
    listeners = {l["name"]: l for l in doc["spec"].get("listeners", [])}
    for lname, expected in EXPECTED_GATEWAY_LISTENERS.items():
        l = listeners.get(lname)
        check_true(f"Gateway listener {lname} exists", l is not None)
        if l is None:
            continue
        check(f"Gateway listener {lname} port", l.get("port"), expected["port"])
        check(f"Gateway listener {lname} protocol", l.get("protocol"), expected["protocol"])
        tls = l.get("tls")
        tls_secret = tls["certificateRefs"][0]["name"] if tls else None
        check(f"Gateway listener {lname} tls secret", tls_secret, expected["tls_secret"])


def check_httproutes(by_kind):
    routes = by_kind.get("HTTPRoute", {})
    for (ns, name), expected in EXPECTED_HTTPROUTES.items():
        doc = routes.get((ns, name))
        check_true(f"HTTPRoute {ns}/{name} exists", doc is not None)
        if doc is None:
            continue
        parent_refs = doc["spec"].get("parentRefs", [{}])
        check(f"{ns}/{name} route sectionName", parent_refs[0].get("sectionName"), expected["sectionName"])
        rules = doc["spec"].get("rules", [{}])
        backend_refs = rules[0].get("backendRefs", [{}])
        check(f"{ns}/{name} route backend name", backend_refs[0].get("name"), expected["backend"])
        check(f"{ns}/{name} route backend port", backend_refs[0].get("port"), expected["port"])


def check_namespaces(by_kind):
    nss = by_kind.get("Namespace", {})
    for name, expected_labels in EXPECTED_NAMESPACE_LABELS.items():
        doc = nss.get((None, name))
        check_true(f"Namespace {name} exists", doc is not None)
        if doc is None:
            continue
        check(f"Namespace {name} labels", doc.get("metadata", {}).get("labels", {}), expected_labels)
    doc = nss.get((None, EXPECTED_NO_DATAPLANE_MODE_NAMESPACE))
    if doc is not None:
        check_true(
            f"Namespace {EXPECTED_NO_DATAPLANE_MODE_NAMESPACE} has no istio.io/dataplane-mode label",
            "istio.io/dataplane-mode" not in doc.get("metadata", {}).get("labels", {}),
        )


def check_quota(by_kind):
    quotas = by_kind.get("ResourceQuota", {})
    ns, name = EXPECTED_QUOTA
    doc = quotas.get((ns, name))
    check_true(f"ResourceQuota {ns}/{name} exists", doc is not None)
    if doc is None:
        return
    check(f"{ns}/{name} quota hard", doc["spec"].get("hard"), EXPECTED_QUOTA_HARD)


def check_spcs(by_kind):
    spcs = by_kind.get("SecretProviderClass", {})
    for (ns, name), expected in EXPECTED_SPCS.items():
        doc = spcs.get((ns, name))
        check_true(f"SecretProviderClass {ns}/{name} exists", doc is not None)
        if doc is None:
            continue
        secret_objects = doc["spec"].get("secretObjects", [])
        check_true(f"{ns}/{name} has one secretObject", len(secret_objects) == 1)
        so = secret_objects[0] if secret_objects else {}
        check(f"{ns}/{name} SPC secretName", so.get("secretName"), expected["secretName"])
        check(f"{ns}/{name} SPC type", so.get("type"), expected["type"])
        check(f"{ns}/{name} SPC keys", {d["key"] for d in so.get("data", [])}, expected["keys"])

    ns, name = "artifacts-system", "gateway-tls"
    doc = spcs.get((ns, name))
    check_true(f"SecretProviderClass {ns}/{name} exists", doc is not None)
    if doc is not None:
        secret_names = {so["secretName"] for so in doc["spec"].get("secretObjects", [])}
        check(f"{ns}/{name} SPC secret names", secret_names, EXPECTED_GATEWAY_TLS_SPC_SECRETS)
        for so in doc["spec"].get("secretObjects", []):
            check(f"{ns}/{name} SPC secretObject {so.get('secretName')} type", so.get("type"), "kubernetes.io/tls")


def check_blob_storage(by_kind):
    pvs = by_kind.get("PersistentVolume", {})
    doc = pvs.get((None, EXPECTED_PV_NAME))
    check_true(f"PersistentVolume {EXPECTED_PV_NAME} exists", doc is not None)
    if doc is not None:
        spec = doc["spec"]
        check("PV accessModes", spec.get("accessModes"), EXPECTED_PV["accessModes"])
        check("PV persistentVolumeReclaimPolicy", spec.get("persistentVolumeReclaimPolicy"), EXPECTED_PV["persistentVolumeReclaimPolicy"])
        check("PV storageClassName", spec.get("storageClassName"), EXPECTED_PV["storageClassName"])
        csi = spec.get("csi", {})
        check("PV csi driver", csi.get("driver"), EXPECTED_PV["csi_driver"])
        check("PV csi readOnly", csi.get("readOnly"), EXPECTED_PV["csi_readOnly"])
        attrs = csi.get("volumeAttributes", {})
        check("PV protocol", attrs.get("protocol"), EXPECTED_PV["protocol"])
        check("PV AzureStorageAuthType", attrs.get("AzureStorageAuthType"), EXPECTED_PV["AzureStorageAuthType"])
        check("PV mountOptions", set(spec.get("mountOptions", [])), EXPECTED_PV_MOUNT_OPTIONS)

    pvcs = by_kind.get("PersistentVolumeClaim", {})
    ns, name = EXPECTED_PVC
    pvc_doc = pvcs.get((ns, name))
    check_true(f"PersistentVolumeClaim {ns}/{name} exists", pvc_doc is not None)
    if pvc_doc is not None:
        check(f"{ns}/{name} PVC volumeName", pvc_doc["spec"].get("volumeName"), EXPECTED_PV_NAME)
        check(f"{ns}/{name} PVC storageClassName", pvc_doc["spec"].get("storageClassName"), "")
        check(f"{ns}/{name} PVC accessModes", pvc_doc["spec"].get("accessModes"), ["ReadOnlyMany"])


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    default_docs = load_docs(sys.argv[1])
    root_docs = load_docs(sys.argv[2])
    by_kind = index(default_docs)
    by_kind_root = index(root_docs)

    check_true("default render has 30 documents", len(default_docs) == 30)

    check_deployments(by_kind)
    check_services(by_kind)
    check_serviceaccounts(by_kind)
    check_networkpolicies(by_kind)
    check_authz(by_kind, by_kind_root)
    check_gateway(by_kind)
    check_httproutes(by_kind)
    check_namespaces(by_kind)
    check_quota(by_kind)
    check_spcs(by_kind)
    check_blob_storage(by_kind)

    if FAILURES:
        for f in FAILURES:
            print(f"FAIL: {f}")
        print(f"{COUNT} assertions, {len(FAILURES)} failures")
        return 1
    print(f"{COUNT} assertions, 0 failures")
    return 0


if __name__ == "__main__":
    sys.exit(main())
