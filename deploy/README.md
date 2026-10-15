# deploy/ — AKS policy, node pool, artifact template (platform manifests moved to charts/artifacts-platform)

Everything the cluster needs for Publish-to-AKS (DESIGN §6.6–§6.8, §6.11) outside the one-time, per-artifact
and policy pieces below. The platform itself — namespaces, Gateway, routes, NetworkPolicies, the mesh-root
AuthorizationPolicy, ServiceAccounts, SecretProviderClasses, tls-sync and the four application
Deployments/Services — is `charts/artifacts-platform` (T71; it replaced the raw manifests that used to live
here). Applied by Azure DevOps (`pipelines/platform-deploy.yml`) or by hand for the one-time pieces; nothing
here is applied by a service at run time (D12). Every `<...>` is a placeholder. Validate offline with
`./deploy/validate.sh` (also lints and renders the chart and runs its conformance test).

## Layout

| Path | Contents | Namespace |
|---|---|---|
| `../charts/artifacts-platform/` | namespaces, Gateway, HTTPRoutes, NetworkPolicies, mesh-root AuthorizationPolicy, ServiceAccounts, SecretProviderClasses, tls-sync, the four Deployments/Services, the Blob CSI PV/PVC | artifacts-system, artifacts-static, artifacts-dynamic (namespace/quota only), istio-system (stage 2) |
| `../charts/tests/platform-conformance.sh` | asserts the chart's `helm template` output still carries everything the deleted raw manifests had | laptop |
| `charts/artifact-python/` | Helm chart, one release per artifact (`art-<artifactId>`, namespace `artifacts-dynamic`): ConfigMap + DESIGN §6.6 Deployment + Service + HTTPRoute, rendered from values (`artifactId`, `appPy` via `--set-file`, `expiresAt`, `entrypoint`, `image`, `jobId`). Replaces the old `python-artifact/template.yaml` + `render.sh`. Validated offline with `helm lint` and `charts/tests/artifact-conformance.sh` (wired into `validate.sh`). | artifacts-dynamic |
| `policy/azure-policy-assign.sh` | restricted initiative, allowed images, no capabilities, no hostPath, effect deny | cluster |
| `policy/nodepool-untrusted.sh` | tainted `untrusted` node pool in its own subnet | cluster |
| `validate.sh` | YAML parse of every manifest and pipeline, `bash -n` of every script, `helm lint`/`helm template`/the conformance test, the render test | laptop |

## Helm install order (needs the cluster)

Cluster prerequisites, assumed present: upstream Istio ambient with the Gateway API CRDs; Azure CNI powered by
Cilium; workload identity and the OIDC issuer; the Secrets Store CSI add-on with the Azure provider and secret
rotation; the Blob CSI driver (`az aks update --enable-blob-driver`); the Azure Policy add-on; images reachable
from `jfrog.corp.com`; `helm` v4.

1. `policy/nodepool-untrusted.sh` — pool `untrusted`, taint `artifacts.corp.com/untrusted=true:NoSchedule`, label `agentpool=untrusted` (set by AKS from the pool name).
2. Fill in a values file: copy `charts/artifacts-platform/values.example.yaml`, replace every placeholder with the real tenant id, Key Vault name, domains, Entra ids, image tags, managed-identity client ids, storage account, Service Bus FQDN, Azure DevOps org/project/pipeline id (every value is documented inline in `values.yaml`; none of them are secrets — secret material stays in Key Vault, reached only through the SecretProviderClasses). Leave `authzMeshRoot.enableRootPolicy: false` for the first install.
3. `helm install artifacts-platform charts/artifacts-platform -f <your-values-file>` (or `helm upgrade --install`, idempotent either way; `pipelines/platform-deploy.yml`'s Deploy stage does this with `HelmDeploy@1`, overriding the four `images.*` values with the tag the Build stage just pushed). This creates the namespaces, ServiceAccounts, SecretProviderClasses, tls-sync, the Gateway, the HTTPRoutes, both NetworkPolicies, the canary AuthorizationPolicy, the four application Deployments/Services and the Blob CSI PV/PVC in one pass — Helm resolves the apply order within a release itself (CRDs before CRs, Namespaces before namespaced objects), so there is no more multi-step `kubectl apply` ordering to follow by hand.
4. Wait for Secrets `artifacts-corp-com-tls` and `wildcard-corp-artifacts-net-tls` in artifacts-system (`kubectl get secret -n artifacts-system`). If they never appear, the tls-sync pod's events say why (identity, Key Vault RBAC, certificate names).
5. Read the internal LB IP from `kubectl get gateway -n artifacts-system artifacts-internal`; create private DNS records `artifacts.corp.com`, `*.corp-artifacts.net`, `intake.artifacts.internal` → that IP. APIM's `backendUrl` is `http://intake.artifacts.internal:8080`.
6. `policy/azure-policy-assign.sh`; wait up to 20 minutes; run the DESIGN §8 Phase 2 negative tests 4 and 5.
7. The canary AuthorizationPolicy (stage 1) is already applied by step 3 — it always renders. Stage 2 (the istio-system mesh root): after the canary has run clean for a few days, re-run `helm upgrade --install` with `--set authzMeshRoot.enableRootPolicy=true` against the same values file. Rollback: re-run with it back at `false` (or omitted — that is the chart default), or `kubectl delete authorizationpolicy -n istio-system mesh-allow-only-mesh-principals`.

What runs without the cluster: `validate.sh` (incl. `helm lint`, `helm template` with both `values.yaml` and `values.example.yaml`, and the conformance test), `charts/tests/artifact-conformance.sh`, both policy scripts with `--dry-run`.

## Mesh root policy, audit-first without AUDIT

Research result (2026-10-14): ztunnel enforces only `ALLOW` and `DENY` at L4. `action: AUDIT` and `CUSTOM` policies
"must use targetRefs" to a waypoint and are not enforced by ztunnel (istio.io/latest/docs/ambient/migrate/migrate-policies/).
The `istio.io/dry-run` annotation is also unsupported on ztunnel (istio/istio discussion #57631; maintainers confirmed, info-level
policy logging only arrives with istio/ztunnel#1745). An AUDIT duplicate of the DESIGN §6.8 policy would be silently inert, so
`charts/artifacts-platform/templates/authz-mesh-root.yaml` does not contain one. The staged procedure replaces it:

- **Stage 0, inventory.** Who talks plaintext to mesh workloads today: `kubectl logs -n istio-system -l app=ztunnel --since=24h | grep -E 'direction="inbound"' | grep -v 'src.identity'` lists inbound connections without a source identity. ztunnel's Prometheus metrics give the same picture: `sum by (destination_workload, source_workload) (istio_tcp_connections_opened_total{connection_security_policy!="mutual_tls"})` (confirm the label values against your ztunnel version; UNVERIFIED).
- **Stage 1, canary.** The policy in `charts/artifacts-platform/templates/authz-mesh-root.yaml` applies to artifacts-static only. Its only workload is static-gateway, whose only legitimate client is the Gateway, a mesh principal. Watch for `policy rejection` in the ztunnel logs for a few days: `kubectl logs -n istio-system -l app=ztunnel -f | grep -i 'policy rejection'`. Any hit names an unexpected plaintext client.
- **Stage 2, root.** Set `authzMeshRoot.enableRootPolicy: true` in the values file (or `--set` it) and `helm upgrade --install` again; the istio-system policy in the same template file is gated on that value, so it renders only now. Keep watching for a week. Phase 2 gate test 6 (a non-mesh test pod curling a mesh service is refused) proves it. Rollback: flip the value back to `false` and re-apply, or `kubectl delete authorizationpolicy -n istio-system mesh-allow-only-mesh-principals`.

## Interfaces this directory expects from other directories

**Closed at M2 (T50).** Every env var name, port and probe path in `charts/artifacts-platform/templates/*.yaml` (then `deploy/platform/*.yaml`, since deleted by T71) was read back against
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

- **Blob mount** (`charts/artifacts-platform/templates/static-gateway.yaml`): `protocol: fuse2`, `AzureStorageAuthType: MSI` + `AzureStorageIdentityClientID`, and the mount options are the ones in Microsoft's AKS Blob CSI doc (2026-08-05). Read-only three times: `-o ro`, `csi.readOnly`, `volumeMount.readOnly`. Kernel attribute/entry/negative timeouts are 5 s and the file cache 5 s, so a republished artifact is stale for seconds, not minutes. blobfuse2's own attribute cache keeps its 120 s default: `--attr-cache-timeout` exists in blobfuse2 but is not in the CSI doc's option list, so it is left out (UNVERIFIED; add it if staleness matters).
- **Gateway `intake` listener** is plain HTTP on 8080 inside the VNet; DESIGN §6.11 makes TLS on that hop optional in v1. The file header says how to add it.
- **ResourceQuota** counts limits: 50 × (500m, 512Mi) = 25 CPU, 25Gi exactly.
- **PSA**: artifacts-dynamic `restricted`; the other two `baseline` enforce + `restricted` warn, because the Istio-managed Gateway pod runs in artifacts-system and its securityContext is Istio's, not ours.
- **`expires-at` label** is RFC 3339 with `:` replaced by `-` (label values cannot contain `:`); fixed width UTC, so string comparison orders correctly and `artifact-gc.yml` compares it as text.

## UNVERIFIED (no cluster was available; every manifest parses, nothing was applied)

| Item | Where | How to confirm |
|---|---|---|
| Azure Policy built-in parameter names (`allowedContainerImagesRegex`, `allowedCapabilities`, `requiredDropCapabilities`, `allowedHostPaths.paths`, initiative `namespaces`) | `policy/azure-policy-assign.sh` | `az policy definition show` on each; the script fails loudly on a wrong name |
| Kubelet readiness probes reach pods under the default-deny NetworkPolicy (Cilium allows host traffic by default) and under the ztunnel ALLOW policy (probe traffic is not subject to policy) | `charts/artifacts-platform/templates/networkpolicy-dynamic.yaml`, `authz-mesh-root.yaml` | pods go Ready after apply; the canary stage shows it for static-gateway first |
| Istio Gateway pods under PSA `baseline`; the `infrastructure.annotations` reach the LB Service | `charts/artifacts-platform/templates/namespaces.yaml`, `gateway.yaml` | `kubectl get svc -n artifacts-system` shows an internal IP |
| Secrets Store CSI `objectType: secret` on a Key Vault certificate yields a PEM the provider splits into `tls.key`/`tls.crt` (per the AKS ingress TLS doc); import certificates with an exportable private key | `charts/artifacts-platform/templates/secretproviderclass.yaml` | Secrets appear after step 3 |
| `-o ro` and the v1-style blobfuse flags accepted on the fuse2 path (documented, not run); MSI auth with `allowSharedKeyAccess: false` | `charts/artifacts-platform/templates/static-gateway.yaml` | pod Ready; `kubectl exec ... touch /srv/x` fails |
| Gateway API exact-host precedence over the wildcard route in Istio | `charts/artifacts-platform/templates/httproutes.yaml`, `charts/artifact-python/templates/httproute.yaml` | Phase 2 positive test |
| Azure DevOps stage result strings used by the `always()` reporting job | `pipelines/artifact-python-deploy.yml` | decline one approval, read the callback |
| ztunnel log text `policy rejection` and the metric label values in the audit procedure | this README | read one denied connection in the canary stage |

## Node tier (M8, DESIGN D14, §6.13)

A third, time-boxed offering alongside the static and Python tiers: self-contained Node full-stack
prototypes, approved by a human the same way a Python artifact is, torn down by the same nightly GC.

| Path | Contents |
|---|---|
| `../charts/artifact-node/` | Helm chart, one release per prototype (`node-<artifactId>`, namespace `artifacts-dynamic`): Deployment + Service + HTTPRoute, rendered from values (`artifactId`, `expiresAt`, `image`, `jobId`, `writablePaths`, `shellOrigin`). Unlike `charts/artifact-python`, the app is baked into the image — there is no ConfigMap/`appPy` value. Validated offline with `helm lint` and `charts/tests/node-conformance.sh`. |
| `../charts/tests/node-conformance.sh` | Pattern-matched on `artifact-conformance.sh`: renders with a fake digest image under default and custom `writablePaths`, asserts the §6.6 security posture, the emptyDir mounts, the `ResponseHeaderModifier` CSP/`X-Prototype-Expires` filter, labels/annotation and probe ports; asserts a bad `artifactId`, missing `expiresAt`, or tag-only/mismatched image is refused. |
| `../node-runtime/` | Pipeline-owned Dockerfile **template** (not a buildable image, not shipped by a bundle author): two-stage build on `jfrog.corp.com/docker/node:20-slim`, `npm ci --ignore-scripts` via the JFrog npm mirror, `npm run build --if-present`, then a pruned production runtime stage, `USER 65532:65532`, `CMD ["npm","run","start"]`. Instantiated once per node job by `pipelines/artifact-node-deploy.yml`'s Build stage, which copies this file into the fetched bundle's directory as the build context. |
| `../pipelines/artifact-node-deploy.yml` | Four stages — Fetch (job record, bundle, bundle-shape check, gitleaks), Build (assemble context, `docker build`/push, `npm audit --audit-level=high` as an *advisory* step, callback `awaiting_approval`), Deploy (Environment `artifacts-dynamic` approval gate, `helm upgrade --install`), Report (T52-style Approvals API query on a skipped Deploy stage). Adapts the Python pipeline's T51 step-scoped failure-reporting and T52 approval-outcome query verbatim; see that file's own header comment for the full citation trail. |
| `../pipelines/artifact-gc.yml` | `gc_dynamic`'s release listing now matches `art-*` or `prototype-*` (same expiry annotation, same `helm uninstall`) — one GC pass retires both tiers. |

What needs the cluster (same caveat as the rest of this README — no `kubectl`, no Azure DevOps tenant while
authoring this): `helm upgrade --install --wait` actually rolling out a node prototype release; the Gateway applying
the `ResponseHeaderModifier` filter to real responses (confirm Istio's Gateway API implementation supports
it at `gateway.networking.k8s.io/v1` the way `charts/artifact-node/templates/httproute.yaml`'s header
comment asserts); the deny-all egress NetworkPolicy already in `charts/artifacts-platform` actually blocking
a node prototype pod's DNS and outbound calls; `docker build`/push from the pipeline's VNet pool against the JFrog npm
mirror and Docker registry; and the Azure DevOps routing that sends a `tier: node` job to this pipeline's id
instead of the Python pipeline's (owned by `scanner/`, not this directory — flagged as an open interface in
the T82 final report).
