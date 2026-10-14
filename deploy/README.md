# deploy/ — AKS manifests, policy, node pool, artifact template

Everything the cluster needs for Publish-to-AKS (DESIGN §6.6–§6.8, §6.11). Applied by Azure DevOps
(`pipelines/platform-deploy.yml`) or by hand for the one-time pieces; nothing here is applied by a service at
run time (D12). Every `<...>` is a placeholder. Validate offline with `./deploy/validate.sh`.

## Layout

| Path | Contents | Namespace |
|---|---|---|
| `namespaces.yaml` | three namespaces with PSA and mesh labels, ResourceQuota (50 pods / 25 CPU / 25Gi) | — |
| `gateway.yaml` | Gateway `artifacts-internal`, internal LB, listeners `shell`, `content`, `intake` | artifacts-system |
| `routes-static.yaml` | HTTPRoutes `viewer-shell`, `intake-api` (artifacts-system), `static-content` (artifacts-static) | both |
| `networkpolicy-dynamic.yaml` | default deny both directions; ingress only from the Gateway pods on 8080 | artifacts-dynamic |
| `authz-mesh-root.yaml` | mesh-root ALLOW policy, staged (see below) | artifacts-static, then istio-system |
| `platform/serviceaccounts.yaml`, `platform/secretproviderclass.yaml` | workload-identity ServiceAccounts; Key Vault → Secret mirrors incl. the two `kubernetes.io/tls` certs | artifacts-system |
| `platform/tls-sync.yaml` | pause pod that keeps the TLS SecretProviderClass mounted so the Gateway's Secrets exist | artifacts-system |
| `platform/intake-api.yaml`, `scanner-worker.yaml`, `viewer-shell.yaml` | Deployments and Services | artifacts-system |
| `platform/static-gateway.yaml` | ServiceAccount, SecretProviderClass, read-only Blob CSI PV/PVC, Deployment, Service | artifacts-static |
| `python-artifact/template.yaml`, `render.sh`, `test-render.sh` | DESIGN §6.6 Deployment + ConfigMap + Service + HTTPRoute per artifact | artifacts-dynamic |
| `policy/azure-policy-assign.sh` | restricted initiative, allowed images, no capabilities, no hostPath, effect deny | cluster |
| `policy/nodepool-untrusted.sh` | tainted `untrusted` node pool in its own subnet | cluster |
| `validate.sh` | YAML parse of every manifest and pipeline, `bash -n` of every script, the render test | laptop |

## Apply order (needs the cluster)

Cluster prerequisites, assumed present: upstream Istio ambient with the Gateway API CRDs; Azure CNI powered by
Cilium; workload identity and the OIDC issuer; the Secrets Store CSI add-on with the Azure provider and secret
rotation; the Blob CSI driver (`az aks update --enable-blob-driver`); the Azure Policy add-on; images reachable
from `jfrog.corp.com`.

1. `policy/nodepool-untrusted.sh` — pool `untrusted`, taint `artifacts.corp.com/untrusted=true:NoSchedule`, label `agentpool=untrusted` (set by AKS from the pool name).
2. `kubectl apply -f namespaces.yaml`
3. `kubectl apply -f platform/serviceaccounts.yaml -f platform/secretproviderclass.yaml -f platform/tls-sync.yaml`, then wait for Secrets `artifacts-corp-com-tls` and `wildcard-corp-artifacts-net-tls` in artifacts-system (`kubectl get secret -n artifacts-system`). If they never appear, the tls-sync pod's events say why (identity, Key Vault RBAC, certificate names).
4. `kubectl apply -f gateway.yaml`; read the internal LB IP from `kubectl get gateway -n artifacts-system artifacts-internal`; create private DNS records `artifacts.corp.com`, `*.corp-artifacts.net`, `intake.artifacts.internal` → that IP. APIM's `backendUrl` is `http://intake.artifacts.internal:8080`.
5. `kubectl apply -f routes-static.yaml -f networkpolicy-dynamic.yaml`
6. `kubectl apply -f platform/` with image tags substituted (`pipelines/platform-deploy.yml` does this; by hand: `sed "s|:<tag>|:<build-id>|g"`).
7. `policy/azure-policy-assign.sh`; wait up to 20 minutes; run the DESIGN §8 Phase 2 negative tests 4 and 5.
8. `kubectl apply -f authz-mesh-root.yaml` (stage 1 canary); stage 2 later, below.

What runs without the cluster: `validate.sh`, `python-artifact/test-render.sh`, both policy scripts with `--dry-run`.

## Mesh root policy, audit-first without AUDIT

Research result (2026-10-14): ztunnel enforces only `ALLOW` and `DENY` at L4. `action: AUDIT` and `CUSTOM` policies
"must use targetRefs" to a waypoint and are not enforced by ztunnel (istio.io/latest/docs/ambient/migrate/migrate-policies/).
The `istio.io/dry-run` annotation is also unsupported on ztunnel (istio/istio discussion #57631; maintainers confirmed, info-level
policy logging only arrives with istio/ztunnel#1745). An AUDIT duplicate of the DESIGN §6.8 policy would be silently inert, so
`authz-mesh-root.yaml` does not contain one. The staged procedure replaces it:

- **Stage 0, inventory.** Who talks plaintext to mesh workloads today: `kubectl logs -n istio-system -l app=ztunnel --since=24h | grep -E 'direction="inbound"' | grep -v 'src.identity'` lists inbound connections without a source identity. ztunnel's Prometheus metrics give the same picture: `sum by (destination_workload, source_workload) (istio_tcp_connections_opened_total{connection_security_policy!="mutual_tls"})` (confirm the label values against your ztunnel version; UNVERIFIED).
- **Stage 1, canary.** The policy in `authz-mesh-root.yaml` applies to artifacts-static only. Its only workload is static-gateway, whose only legitimate client is the Gateway, a mesh principal. Watch for `policy rejection` in the ztunnel logs for a few days: `kubectl logs -n istio-system -l app=ztunnel -f | grep -i 'policy rejection'`. Any hit names an unexpected plaintext client.
- **Stage 2, root.** Uncomment the istio-system policy in the same file, apply, keep watching for a week. Phase 2 gate test 6 (a non-mesh test pod curling a mesh service is refused) proves it. Rollback: `kubectl delete authorizationpolicy -n istio-system mesh-allow-only-mesh-principals`.

## Interfaces this directory expects from other directories

The manifests set these; the code in `intake-api/`, `scanner/`, `static-gateway/`, `viewer-shell/` must read them
or we reconcile the names at M2. Nothing else in the cluster depends on them.

| Component | Expects |
|---|---|
| all | `PORT=8080`, `GET /healthz` → 200 for readiness; uid 65532; writable `/tmp` only |
| intake-api | `BACKEND=azure`, `STORAGE_ACCOUNT`, `INTAKE_CONTAINER`, `JOBS_CONTAINER`, `SERVICEBUS_NAMESPACE`, `SCAN_QUEUE`, `PUBLIC_API_URL`, `SHELL_URL`, `ARTIFACT_DOMAIN`, `MAX_UPLOAD_BYTES`; secrets `VIEW_TOKEN_KEY`, `PIPELINE_TOKEN`, `INTERNAL_SHARED_KEY` as env; job records at `jobs/<jobId>.json` with `artifactId`, `tier`, `state`, `expiresAt` (read by `pipelines/artifact-gc.yml`) |
| scanner-worker | same storage/queue variables plus `SERVING_CONTAINER`, `DEFENDER_WAIT_SECONDS`, `INTAKE_INTERNAL_URL`, `ADO_ORG_URL`, `ADO_PROJECT`, `ADO_PIPELINE_ID`, `RUNTIME_MANIFEST_PATH`, `WORK_DIR`; health on port 8081; triggers the pipeline with `templateParameters: { jobId, artifactId }` (artifactId is needed by `render.sh`; DESIGN §6.12 lists jobId only) |
| static-gateway | `SERVE_ROOT=/srv` (read-only), `ARTIFACT_DOMAIN`, `SHELL_URL`, secret `VIEW_TOKEN_KEY` |
| viewer-shell | `AUTH_MODE=entra`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `REDIRECT_URI`, `SHELL_URL`, `ARTIFACT_DOMAIN`, `INTAKE_URL`, secrets `AZURE_CLIENT_SECRET`, `INTERNAL_SHARED_KEY` |

## Notes on specific choices

- **Blob mount** (`platform/static-gateway.yaml`): `protocol: fuse2`, `AzureStorageAuthType: MSI` + `AzureStorageIdentityClientID`, and the mount options are the ones in Microsoft's AKS Blob CSI doc (2026-08-05). Read-only three times: `-o ro`, `csi.readOnly`, `volumeMount.readOnly`. Kernel attribute/entry/negative timeouts are 5 s and the file cache 5 s, so a republished artifact is stale for seconds, not minutes. blobfuse2's own attribute cache keeps its 120 s default: `--attr-cache-timeout` exists in blobfuse2 but is not in the CSI doc's option list, so it is left out (UNVERIFIED; add it if staleness matters).
- **Gateway `intake` listener** is plain HTTP on 8080 inside the VNet; DESIGN §6.11 makes TLS on that hop optional in v1. The file header says how to add it.
- **ResourceQuota** counts limits: 50 × (500m, 512Mi) = 25 CPU, 25Gi exactly.
- **PSA**: artifacts-dynamic `restricted`; the other two `baseline` enforce + `restricted` warn, because the Istio-managed Gateway pod runs in artifacts-system and its securityContext is Istio's, not ours.
- **`expires-at` label** is RFC 3339 with `:` replaced by `-` (label values cannot contain `:`); fixed width UTC, so string comparison orders correctly and `artifact-gc.yml` compares it as text.

## UNVERIFIED (no cluster was available; every manifest parses, nothing was applied)

| Item | Where | How to confirm |
|---|---|---|
| Azure Policy built-in parameter names (`allowedContainerImagesRegex`, `allowedCapabilities`, `requiredDropCapabilities`, `allowedHostPaths.paths`, initiative `namespaces`) | `policy/azure-policy-assign.sh` | `az policy definition show` on each; the script fails loudly on a wrong name |
| Kubelet readiness probes reach pods under the default-deny NetworkPolicy (Cilium allows host traffic by default) and under the ztunnel ALLOW policy (probe traffic is not subject to policy) | `networkpolicy-dynamic.yaml`, `authz-mesh-root.yaml` | pods go Ready after apply; the canary stage shows it for static-gateway first |
| Istio Gateway pods under PSA `baseline`; the `infrastructure.annotations` reach the LB Service | `namespaces.yaml`, `gateway.yaml` | `kubectl get svc -n artifacts-system` shows an internal IP |
| Secrets Store CSI `objectType: secret` on a Key Vault certificate yields a PEM the provider splits into `tls.key`/`tls.crt` (per the AKS ingress TLS doc); import certificates with an exportable private key | `platform/secretproviderclass.yaml` | Secrets appear after step 3 |
| `-o ro` and the v1-style blobfuse flags accepted on the fuse2 path (documented, not run); MSI auth with `allowSharedKeyAccess: false` | `platform/static-gateway.yaml` | pod Ready; `kubectl exec ... touch /srv/x` fails |
| Gateway API exact-host precedence over the wildcard route in Istio | `routes-static.yaml`, `python-artifact/template.yaml` | Phase 2 positive test |
| Azure DevOps stage result strings used by the `always()` reporting job | `pipelines/artifact-python-deploy.yml` | decline one approval, read the callback |
| ztunnel log text `policy rejection` and the metric label values in the audit procedure | this README | read one denied connection in the canary stage |
