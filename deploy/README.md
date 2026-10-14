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
| `networkpolicy-system.yaml` | ingress to intake-api only from the Gateway, scanner-worker and viewer-shell pods on 8080 (T18); no egress rules | artifacts-system |
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
5. `kubectl apply -f routes-static.yaml -f networkpolicy-dynamic.yaml -f networkpolicy-system.yaml`
6. `kubectl apply -f platform/` with image tags substituted (`pipelines/platform-deploy.yml` does this; by hand: `sed "s|:<tag>|:<build-id>|g"`). `platform/intake-api.yaml` needs `ENTRA_TENANT_ID` and `ENTRA_AUDIENCE` substituted too (T18; the artifacts-mcp app registration's client id, not its Application ID URI — `infra/entra/README.md`).
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

**Closed at M2 (T50).** Every env var name, port and probe path in `platform/*.yaml` was read back against
`intake-api/src/config.ts` (shared by the worker), `static-gateway/README.md` and `viewer-shell/README.md` —
not guessed. Fixed in this pass: `STORAGE_ACCOUNT`→`STORAGE_ACCOUNT_URL` (full blob endpoint, not a bare
name), the three container names→`STORAGE_CONTAINER_{JOBS,INTAKE,SERVING}`, `SERVICEBUS_NAMESPACE`→
`SERVICEBUS_FQDN`, `SHELL_URL`→`SHELL_ORIGIN` (all three services), `PUBLIC_API_URL`→`PUBLIC_BASE_URL` (now
via the Secrets Store CSI secret, not a plain env), `DEFENDER_WAIT_SECONDS`→`DEFENDER_TIMEOUT_SECONDS`,
`ADO_ORG_URL`→`ADO_ORG` (bare org name, not a URL), `RUNTIME_MANIFEST_PATH`→`RUNTIME_MANIFEST`,
`AUTH_MODE`/`REDIRECT_URI` dropped (not read; `DEV_AUTH` unset selects Entra, the redirect URI is built from
`SHELL_ORIGIN`), `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`INTAKE_URL`→`ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`/
`INTAKE_INTERNAL_URL`, `AZURE_CLIENT_SECRET`→`ENTRA_CLIENT_SECRET`; `ARTIFACT_DOMAIN`, `MAX_UPLOAD_BYTES` and
`WORK_DIR` dropped (never read — `MAX_BYTES` is a 25 MiB constant, not configurable). Added where a service
needed something it was never given: `GITLEAKS_BIN`, `PIPELINE_TIMEOUT_HOURS` (T13), `HEALTH_PORT` (T17) and
`SHELL_ORIGIN` on scanner-worker; `SHELL_SESSION_KEY` on viewer-shell (`secretproviderclass.yaml` was missing
it entirely — a real gap, not a naming one). `scanner/src/pipeline.ts` already sends
`templateParameters: { jobId }` only; `pipelines/artifact-python-deploy.yml` now takes only `jobId` and reads
`jobs/<jobId>.json` for the rest, matching `intake-api/src/job.ts`'s `JobRecord` exactly (confirmed against
`intake-api/src/stores/blob.ts`, which is what actually writes that blob).

What is left needs the cluster, not more reading:

| Item | Needs | Verification |
|---|---|---|
| Workload Identity: `intake-api`, `scanner-worker`, `static-gateway`'s federated credential resolves to a token `DefaultAzureCredential` can use against Storage, Service Bus, Key Vault and (scanner-worker only) Azure DevOps | the AKS OIDC issuer binding and the RBAC `infra/bicep` assigns to each identity, all actually applied | publish `tests/corpus/static-ok` for real; a job stuck in `scanning` with no scanner error is this failing silently — `kubectl -n artifacts-system logs deploy/scanner-worker --since=10m` |
| Secrets Store CSI mirrors every key this pass wired up — `intake-api-secrets` (now 4 keys, incl. the new `public-base-url`) and `viewer-shell-secrets` (now 3 keys, incl. the renamed `entra-shell-client-secret`→`ENTRA_CLIENT_SECRET` and the new `shell-session-key`) — into the right env var names | the two new Key Vault secrets created; `infra/README.md` step 4's checklist updated to include them (flagged, not fixed here — outside this task's two directories) | `kubectl -n artifacts-system exec deploy/intake-api -- env \| cut -d= -f1 \| sort` (names only, never the values) lists `PUBLIC_BASE_URL` |
| `GET /healthz` on static-gateway's main port and scanner-worker's `HEALTH_PORT` (8081, named port `health` in `scanner-worker.yaml`) actually exists and answers 200 | T16 and T17 landing in `static-gateway/` and `scanner/` (in progress alongside this task) | pods go `Ready`; `kubectl -n artifacts-static exec deploy/static-gateway -- wget -qO- localhost:8080/healthz` |
| scanner-worker's identity has `Queue builds` on the one Azure DevOps pipeline (integration item I8) | a person, in Azure DevOps | trigger a real python publish; `awaiting_approval` reached with no 401/403 in the worker's logs |

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
