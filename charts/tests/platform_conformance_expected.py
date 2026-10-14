"""Frozen expectations for charts/tests/platform_conformance.py.

These are copied from the raw manifests that charts/artifacts-platform replaces (git history, commit
dd8c196 and earlier: deploy/namespaces.yaml, deploy/gateway.yaml, deploy/routes-static.yaml,
deploy/networkpolicy-*.yaml, deploy/authz-mesh-root.yaml, deploy/platform/*.yaml), not read from those
files at test time -- T71 deletes them once this test passes. If DESIGN.md §6.6-§6.8/§6.11 changes, update
this file by hand and say so in the commit message; this file is the record of what the raw manifests said,
checked against the design, not against files that no longer exist.
"""

# ---- Deployments: pod-level + one container each (tls-sync's container is "pause") ----
# automountServiceAccountToken is a pod-spec field in every raw file (not container-level).
POD_SECURITY_CONTEXT_FULL = {
    "runAsNonRoot": True,
    "runAsUser": 65532,
    "runAsGroup": 65532,
    "fsGroup": 65532,
    "seccompProfile": {"type": "RuntimeDefault"},
}
POD_SECURITY_CONTEXT_NO_FSGROUP = {  # tls-sync's pod has no fsGroup (deploy/platform/tls-sync.yaml)
    "runAsNonRoot": True,
    "runAsUser": 65532,
    "runAsGroup": 65532,
    "seccompProfile": {"type": "RuntimeDefault"},
}
CONTAINER_SECURITY_CONTEXT = {
    "allowPrivilegeEscalation": False,
    "readOnlyRootFilesystem": True,
    "capabilities": {"drop": ["ALL"]},
}

EXPECTED_DEPLOYMENTS = {
    ("artifacts-system", "intake-api"): {
        "replicas": 2,
        "serviceAccountName": "intake-api",
        "automountServiceAccountToken": False,
        "podSecurityContext": POD_SECURITY_CONTEXT_FULL,
        "nodeSelector": None,
        "tolerations": None,
        "volumes": {
            "tmp": {"emptyDir": {"sizeLimit": "256Mi"}},
            "secrets": {"csi_secretProviderClass": "intake-api-secrets"},
        },
        "container": {
            "name": "intake-api",
            "image": "jfrog.corp.com/artifacts/intake-api:<tag>",
            "ports": [{"name": "http", "containerPort": 8080}],
            "env_names": [
                "PORT", "BACKEND", "STORAGE_ACCOUNT_URL", "STORAGE_CONTAINER_INTAKE",
                "STORAGE_CONTAINER_JOBS", "STORAGE_CONTAINER_SERVING", "SERVICEBUS_FQDN", "SCAN_QUEUE",
                "SHELL_ORIGIN", "PUBLIC_BASE_URL", "ENTRA_TENANT_ID", "ENTRA_AUDIENCE",
            ],
            "envFrom_secretRefs": ["intake-api-secrets"],
            "securityContext": CONTAINER_SECURITY_CONTEXT,
            "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "500m", "memory": "512Mi"}},
            "readinessProbe": {"path": "/healthz", "port": "http", "periodSeconds": 5, "failureThreshold": 3},
            "livenessProbe": {"path": "/healthz", "port": "http", "periodSeconds": 30},
            "volumeMounts": [
                {"name": "tmp", "mountPath": "/tmp"},
                {"name": "secrets", "mountPath": "/mnt/secrets", "readOnly": True},
            ],
        },
    },
    ("artifacts-system", "scanner-worker"): {
        "replicas": 2,
        "serviceAccountName": "scanner-worker",
        "automountServiceAccountToken": False,
        "podSecurityContext": POD_SECURITY_CONTEXT_FULL,
        "nodeSelector": None,
        "tolerations": None,
        "volumes": {"tmp": {"emptyDir": {"sizeLimit": "512Mi"}}},
        "container": {
            "name": "scanner-worker",
            "image": "jfrog.corp.com/artifacts/scanner:<tag>",
            "ports": [{"name": "health", "containerPort": 8081}],
            "env_names": [
                "BACKEND", "STORAGE_ACCOUNT_URL", "STORAGE_CONTAINER_INTAKE", "STORAGE_CONTAINER_SERVING",
                "STORAGE_CONTAINER_JOBS", "SERVICEBUS_FQDN", "SCAN_QUEUE", "SHELL_ORIGIN", "GITLEAKS_BIN",
                "DEFENDER_TIMEOUT_SECONDS", "PIPELINE_TIMEOUT_HOURS", "HEALTH_PORT", "INTAKE_INTERNAL_URL",
                "ADO_ORG", "ADO_PROJECT", "ADO_PIPELINE_ID", "RUNTIME_MANIFEST",
            ],
            "envFrom_secretRefs": [],
            "securityContext": CONTAINER_SECURITY_CONTEXT,
            "resources": {
                "requests": {"cpu": "250m", "memory": "256Mi"},
                "limits": {"cpu": "1", "memory": "1Gi", "ephemeral-storage": "1Gi"},
            },
            "readinessProbe": {"path": "/healthz", "port": "health", "periodSeconds": 10, "failureThreshold": 3},
            "livenessProbe": {"path": "/healthz", "port": "health", "periodSeconds": 30},
            "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}],
        },
    },
    ("artifacts-system", "viewer-shell"): {
        "replicas": 2,
        "serviceAccountName": "viewer-shell",
        "automountServiceAccountToken": False,
        "podSecurityContext": POD_SECURITY_CONTEXT_FULL,
        "nodeSelector": None,
        "tolerations": None,
        "volumes": {
            "tmp": {"emptyDir": {"sizeLimit": "64Mi"}},
            "secrets": {"csi_secretProviderClass": "viewer-shell-secrets"},
        },
        "container": {
            "name": "viewer-shell",
            "image": "jfrog.corp.com/artifacts/viewer-shell:<tag>",
            "ports": [{"name": "http", "containerPort": 8080}],
            "env_names": ["PORT", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "SHELL_ORIGIN", "ARTIFACT_DOMAIN", "INTAKE_INTERNAL_URL"],
            "envFrom_secretRefs": ["viewer-shell-secrets"],
            "securityContext": CONTAINER_SECURITY_CONTEXT,
            "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "500m", "memory": "512Mi"}},
            "readinessProbe": {"path": "/healthz", "port": "http", "periodSeconds": 5, "failureThreshold": 3},
            "livenessProbe": {"path": "/healthz", "port": "http", "periodSeconds": 30},
            "volumeMounts": [
                {"name": "tmp", "mountPath": "/tmp"},
                {"name": "secrets", "mountPath": "/mnt/secrets", "readOnly": True},
            ],
        },
    },
    ("artifacts-static", "static-gateway"): {
        "replicas": 2,
        "serviceAccountName": "static-gateway",
        "automountServiceAccountToken": False,
        "podSecurityContext": POD_SECURITY_CONTEXT_FULL,
        "nodeSelector": None,
        "tolerations": None,
        "volumes": {
            "serving": {"pvc": "artifacts-serving"},
            "tmp": {"emptyDir": {"sizeLimit": "64Mi"}},
            "secrets": {"csi_secretProviderClass": "static-gateway-secrets"},
        },
        "container": {
            "name": "serving",
            "image": "jfrog.corp.com/artifacts/static-gateway:<tag>",
            "ports": [{"name": "http", "containerPort": 8080}],
            "env_names": ["PORT", "SERVE_ROOT", "ARTIFACT_DOMAIN", "SHELL_ORIGIN"],
            "envFrom_secretRefs": ["static-gateway-secrets"],
            "securityContext": CONTAINER_SECURITY_CONTEXT,
            "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "500m", "memory": "512Mi"}},
            "readinessProbe": {"path": "/healthz", "port": "http", "periodSeconds": 5, "failureThreshold": 3},
            "livenessProbe": {"path": "/healthz", "port": "http", "periodSeconds": 30},
            "volumeMounts": [
                {"name": "serving", "mountPath": "/srv", "readOnly": True},
                {"name": "tmp", "mountPath": "/tmp"},
                {"name": "secrets", "mountPath": "/mnt/secrets", "readOnly": True},
            ],
        },
    },
    ("artifacts-system", "tls-sync"): {
        "replicas": 1,
        "serviceAccountName": "tls-sync",
        "automountServiceAccountToken": False,
        "podSecurityContext": POD_SECURITY_CONTEXT_NO_FSGROUP,
        "nodeSelector": None,
        "tolerations": None,
        "volumes": {"tls": {"csi_secretProviderClass": "gateway-tls"}},
        "container": {
            "name": "pause",
            "image": "jfrog.corp.com/docker/pause:3.10",
            "ports": [],
            "env_names": [],
            "envFrom_secretRefs": [],
            "securityContext": CONTAINER_SECURITY_CONTEXT,
            "resources": {"requests": {"cpu": "5m", "memory": "8Mi"}, "limits": {"cpu": "20m", "memory": "32Mi"}},
            "readinessProbe": None,
            "livenessProbe": None,
            "volumeMounts": [{"name": "tls", "mountPath": "/mnt/tls", "readOnly": True}],
        },
    },
}

# ---- Services ----
EXPECTED_SERVICES = {
    ("artifacts-system", "intake-api"): {"selector": {"app.kubernetes.io/name": "intake-api"}, "port": 8080, "targetPort": "http"},
    ("artifacts-system", "viewer-shell"): {"selector": {"app.kubernetes.io/name": "viewer-shell"}, "port": 8080, "targetPort": "http"},
    ("artifacts-static", "static-gateway"): {"selector": {"app.kubernetes.io/name": "static-gateway"}, "port": 8080, "targetPort": "http"},
}

# ---- ServiceAccounts: all automountServiceAccountToken: false, all carry the workload-identity annotation ----
EXPECTED_SERVICEACCOUNTS = {
    ("artifacts-system", "intake-api"),
    ("artifacts-system", "scanner-worker"),
    ("artifacts-system", "viewer-shell"),
    ("artifacts-system", "tls-sync"),
    ("artifacts-static", "static-gateway"),
}

# ---- NetworkPolicies (deploy/networkpolicy-dynamic.yaml, deploy/networkpolicy-system.yaml) ----
EXPECTED_NETWORKPOLICIES = {
    ("artifacts-dynamic", "default-deny-all"): {
        "podSelector": {},
        "policyTypes": {"Ingress", "Egress"},
        "ingress_ports": [{"port": 8080, "protocol": "TCP"}],
        "has_namespaceSelector": True,
        "gateway_name_selector": "artifacts-internal",
    },
    ("artifacts-system", "intake-api-ingress"): {
        "podSelector": {"app.kubernetes.io/name": "intake-api"},
        "policyTypes": {"Ingress"},
        "ingress_ports": [{"port": 8080, "protocol": "TCP"}],
        "from_pod_selectors": [
            {"gateway.networking.k8s.io/gateway-name": "artifacts-internal"},
            {"app.kubernetes.io/name": "scanner-worker"},
            {"app.kubernetes.io/name": "viewer-shell"},
        ],
    },
}

# ---- AuthorizationPolicy (deploy/authz-mesh-root.yaml) ----
EXPECTED_AUTHZ_CANARY = ("artifacts-static", "allow-only-mesh-principals-canary")
EXPECTED_AUTHZ_ROOT = ("istio-system", "mesh-allow-only-mesh-principals")
EXPECTED_AUTHZ_PRINCIPALS = ["cluster.local/*"]

# ---- Gateway (deploy/gateway.yaml) ----
EXPECTED_GATEWAY_NAME = ("artifacts-system", "artifacts-internal")
EXPECTED_GATEWAY_LISTENERS = {
    "shell": {"port": 443, "protocol": "HTTPS", "tls_secret": "artifacts-corp-com-tls"},
    "content": {"port": 443, "protocol": "HTTPS", "tls_secret": "wildcard-corp-artifacts-net-tls"},
    "intake": {"port": 8080, "protocol": "HTTP", "tls_secret": None},
}

# ---- HTTPRoutes (deploy/routes-static.yaml) ----
EXPECTED_HTTPROUTES = {
    ("artifacts-system", "viewer-shell"): {"sectionName": "shell", "backend": "viewer-shell", "port": 8080},
    ("artifacts-system", "intake-api"): {"sectionName": "intake", "backend": "intake-api", "port": 8080},
    ("artifacts-static", "static-content"): {"sectionName": "content", "backend": "static-gateway", "port": 8080},
}

# ---- Namespace labels (deploy/namespaces.yaml) ----
EXPECTED_NAMESPACE_LABELS = {
    "artifacts-system": {
        "istio.io/dataplane-mode": "ambient",
        "pod-security.kubernetes.io/enforce": "baseline",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "pod-security.kubernetes.io/warn": "restricted",
        "pod-security.kubernetes.io/warn-version": "latest",
        "artifacts.corp.com/routes": "allowed",
    },
    "artifacts-static": {
        "istio.io/dataplane-mode": "ambient",
        "pod-security.kubernetes.io/enforce": "baseline",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "pod-security.kubernetes.io/warn": "restricted",
        "pod-security.kubernetes.io/warn-version": "latest",
        "artifacts.corp.com/routes": "allowed",
    },
    "artifacts-dynamic": {
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "artifacts.corp.com/routes": "allowed",
    },
}
EXPECTED_NO_DATAPLANE_MODE_NAMESPACE = "artifacts-dynamic"  # D11: must NOT carry istio.io/dataplane-mode

# ---- ResourceQuota (deploy/namespaces.yaml) ----
EXPECTED_QUOTA = ("artifacts-dynamic", "artifacts-dynamic-quota")
EXPECTED_QUOTA_HARD = {
    "pods": "50",
    "requests.cpu": "25",
    "requests.memory": "25Gi",
    "limits.cpu": "25",
    "limits.memory": "25Gi",
    "configmaps": "60",
    "services": "60",
}

# ---- SecretProviderClasses (deploy/platform/secretproviderclass.yaml, static-gateway.yaml) ----
EXPECTED_SPCS = {
    ("artifacts-system", "intake-api-secrets"): {
        "secretName": "intake-api-secrets", "type": "Opaque",
        "keys": {"VIEW_TOKEN_KEY", "PIPELINE_TOKEN", "INTERNAL_SHARED_KEY"},
    },
    ("artifacts-system", "viewer-shell-secrets"): {
        "secretName": "viewer-shell-secrets", "type": "Opaque",
        "keys": {"INTERNAL_SHARED_KEY", "ENTRA_CLIENT_SECRET", "SHELL_SESSION_KEY"},
    },
    ("artifacts-static", "static-gateway-secrets"): {
        "secretName": "static-gateway-secrets", "type": "Opaque",
        "keys": {"VIEW_TOKEN_KEY"},
    },
}
EXPECTED_GATEWAY_TLS_SPC_SECRETS = {"artifacts-corp-com-tls", "wildcard-corp-artifacts-net-tls"}

# ---- Blob CSI PV/PVC (deploy/platform/static-gateway.yaml) ----
EXPECTED_PV_NAME = "artifacts-serving"
EXPECTED_PV = {
    "accessModes": ["ReadOnlyMany"],
    "persistentVolumeReclaimPolicy": "Retain",
    "storageClassName": "",
    "csi_driver": "blob.csi.azure.com",
    "csi_readOnly": True,
    "protocol": "fuse2",
    "AzureStorageAuthType": "MSI",
}
EXPECTED_PV_MOUNT_OPTIONS = {
    "-o ro", "-o allow_other", "--use-attr-cache=true", "--file-cache-timeout-in-seconds=5",
    "-o attr_timeout=5", "-o entry_timeout=5", "-o negative_timeout=5",
    "--cancel-list-on-mount-seconds=10", "--log-level=LOG_WARNING", "--cache-size-mb=512",
}
EXPECTED_PVC = ("artifacts-static", "artifacts-serving")
