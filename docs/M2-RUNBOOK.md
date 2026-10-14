# M2 runbook: empty subscription to "static tier live in the AKS dev namespace"

This is the ordered, numbered path from "subscription and private cluster exist, Istio ambient installed"
to M2's gate (`STATUS.md`):

> real internal URL; the corpus passes on the cluster; an EICAR upload is rejected with a Defender alert;
> browser checks for `static-fetch` and `static-navigate` pass.

Read this after `README.md`, `STATUS.md`, `CLAUDE.md`, `DESIGN.md` §6.5–§6.12/§8/§9/§11, `infra/README.md`,
`deploy/README.md`. This file does not repeat their content; it sequences it and adds the verification
command for each step. Every `<placeholder>` matches the name used in the script or manifest it belongs to.

## Who does what

| Role | Shorthand used below | Typically needs |
|---|---|---|
| Platform engineer | platform engineer | Contributor on the subscription/RG, cluster access |
| Identity admin | identity admin | Application Administrator in Entra (Global/Privileged Role Administrator for admin consent) |
| Network team | network team | DNS zone and VNet/subnet ownership |
| Claude org owner | Claude org owner | Owner role in the Claude org (connectors) — **not needed for M2** |
| APIM owner | APIM owner | Contributor on the APIM instance — **not needed for M2** |
| DevOps admin | DevOps admin | Project Administrator in Azure DevOps |
| Security | security | Defender for Cloud / security admin role |

## What is NOT on M2's path

Step 25 (APIM import, MCP server, App Gateway route + public DNS for `mcp.corp.com`) is required for
**M3** (the Cowork connector path), not M2; the custom connector itself (I5) is M4 and is not covered by
this runbook at all. M2's gate only needs the static tier reachable **inside** the VNet — the test
scripts in `tests/m2/` talk to intake-api directly (port-forward or the Gateway's `intake` listener),
never through APIM. Step 25 is listed here in dependency order because the orchestrator asked for the
full path in one document, and because steps 1–3 (Entra) create everything step 25 needs as a side
effect — not because M2 is blocked on it.

## Integration items this runbook exercises

| ID | Item | Blocks M2? |
|---|---|---|
| I1 | Two Entra app registrations (`artifacts-mcp`, `claude-connector`) | No — but the *same script* (step 2) also creates `artifacts-viewer-shell`, which M2's real sign-in needs. Run step 2 fully; only the shell app's output matters for M2. |
| I2 | APIM: import API, MCP server, PRM, policy | No — M3 only (step 25) |
| I3 | App Gateway route + public DNS for `mcp.corp.com` | No — M3 only (step 25). M2 uses the **internal** DNS records created in step 24, which this runbook creates directly. |
| I4 | Cowork egress allowlist | No — M3 only, not covered here |
| I5 | Custom connector | No — M4 only, not covered here |
| I6 | Skill published | No — M3 only, not covered here |
| I7 | Defender for Storage enabled | **Yes.** Steps 7–8. The EICAR gate test (step 28) has nothing to alert on without it. |
| I8 | Azure DevOps: VNet agent pool confirmed; Environment `artifacts-dynamic` approval; Queue-builds permission | **Partially.** The *agent pool* half blocks step 23 (`pipelines/platform-deploy.yml` runs on `<your-vnet-pool>` and needs to reach the private API server and Blob). The *Environment approval* and *Queue-builds* halves are M5-only (Python tier) and are not exercised here. |

## Health endpoints (resolved the same day)

When this runbook was first written, `static-gateway` and `scanner-worker` had no `GET /healthz`, so their readiness probes could never pass. Both landed on 2026-10-14 (STATUS.md T16 and T17, merged to `main`): the gateway answers `/healthz` before host parsing on its main port, and the worker serves it on `HEALTH_PORT` 8081. `deploy/platform/` probes point at both. If a pod is `Running` but never `Ready`, read the service log; it is no longer a missing endpoint.
## Phase 0 — assumed already true

Per the task brief and `DESIGN.md`'s constraints: a subscription and resource group exist; a **private** AKS
cluster exists (API server not publicly reachable); upstream Istio is installed in **ambient** mode with the
Gateway API CRDs (approved, already done per `DESIGN.md` top matter); Azure CNI powered by Cilium is the
network plugin; AKS workload identity and its OIDC issuer are enabled; the Secrets Store CSI add-on (Azure
provider, secret rotation) is enabled; the Blob CSI driver is enabled (`az aks update --enable-blob-driver`);
the Azure Policy add-on is enabled; cluster nodes can reach `jfrog.corp.com`; an Azure DevOps project exists
with AKS and Sonar service connections already configured (`<aks-connection>`, `<sonar-connection>`), and a
VNet-connected agent pool (`<your-vnet-pool>`) exists. None of these are created by this repo — `deploy/README.md`
lists them as cluster prerequisites, and `infra/README.md`'s step 2 is the first thing this repo's scripts touch.

---

## Phase A — identity (I1)

### 1. Verify the MCP hostname's domain is a verified domain in the tenant
- **Who:** identity admin
- **Action:** Entra admin center → Identity → Settings → Domain names → confirm `corp.com` (or whichever
  domain carries `mcp.corp.com`) shows **Verified**. Equivalent from the CLI:
  ```
  az rest --method GET --url "https://graph.microsoft.com/v1.0/domains/corp.com" \
    --query "{domain:id, verified:isVerified}" -o table
  ```
- **Verify:** `isVerified` is `true`.
- **If it fails:** Graph refuses a URL-style Application ID URI on an unverified host (step 2 fails with a
  Graph error, not `AADSTS9010010` — that error is for a *mismatched* URI, this is a *missing* domain).
  Add the domain and complete DNS/TXT verification (not scripted in this repo) before continuing. This step
  only gates the `artifacts-mcp` resource app; it does not block `artifacts-viewer-shell`, so if you are in a
  hurry you could reorder step 2 to create the shell app alone — `create.sh` has no flag for that, so in
  practice just fix the domain first; it is a one-time, same-day fix in most tenants.

### 2. Create the three Entra app registrations
- **Who:** identity admin
- **Action:**
  ```
  MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./infra/entra/create.sh --dry-run
  MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com \
    PUBLISHERS_GROUP_ID=<publishers-group-object-id> ADMIN_CONSENT=1 ./infra/entra/create.sh
  ```
  `PUBLISHERS_GROUP_ID` and `ADMIN_CONSENT` only matter for M3; omit them for an M2-only run and the script
  still creates all three apps (M2 needs `artifacts-viewer-shell`; `artifacts-mcp`/`claude-connector` sit
  unused until M3). Idempotent — safe to re-run.
- **Verify:** the script's own summary block prints the three app ids; keep `Viewer shell client id` for
  step 9 (pushing its secret) and step 22 (substituting it into `deploy/platform/viewer-shell.yaml`'s
  `AZURE_CLIENT_ID`).
- **If it fails:** `AADSTS9010010`-class failures only affect the `artifacts-mcp` resource/connector pair
  (M3), not M2. A failure creating `artifacts-viewer-shell` is almost always a missing Application
  Administrator role for the identity admin, or the `az` CLI version being older than 2.60 (the script needs
  `--is-fallback-public-client` and `--public-client-redirect-uris`, used only for `claude-connector`, so this
  surfaces there, not on the shell app).

### 3. Verify the app registrations
- **Who:** identity admin
- **Action:** `MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./infra/entra/verify.sh`
- **Verify:** script prints `All checks passed.` and exits 0. The tail of its output is the values table —
  copy `AZURE_TENANT_ID` and the shell app id (`AZURE_CLIENT_ID`) into the notes you carry into step 22,
  where they replace the placeholders of the same name in `deploy/platform/viewer-shell.yaml`.
- **If it fails:** the script explains each `FAIL` line by name (see `infra/entra/README.md` "Values that must
  match"). For M2 the only row that matters is `web redirect ${SHELL_ORIGIN}/auth/callback` on
  `artifacts-viewer-shell`; everything above it concerns the MCP resource/connector pair (M3).
- **UNVERIFIED (infra/entra/README.md):** whether `isFallbackPublicClient` + a public-client redirect is
  what Claude's token exchange needs (M3 only); the scope string format Entra expects for a URL-style App ID
  URI. Neither affects the shell app M2 depends on.

---

## Phase B — Azure platform resources (Bicep)

### 4. Create the four workload identities
- **Who:** platform engineer (cluster/RG owner)
- **Action:** one user-assigned managed identity per service, federated later in step 12:
  ```
  for n in intake-api scanner-worker viewer-shell tls-sync; do
    az identity create -g <rg> -n "artifacts-$n"
  done
  ```
  Decide now which identity blobfuse will use for the `static-gateway` mount — either the cluster's existing
  kubelet identity, or a fifth identity attached to the VMSS of whichever node pool `static-gateway`'s pods
  actually land on (its Deployment has no `nodeSelector`, so this is a default/system pool, **not** the
  `untrusted` pool from step 13 — that one is tainted against everything except Python artifact pods).
  `infra/README.md` calls this "not created here because it belongs to the cluster's resource group and
  lifecycle" — there is no script for it in this repo.
- **Verify:** `az identity list -g <rg> --query "[].{name:name, clientId:clientId, principalId:principalId}" -o table`
  shows all four (five with the blobfuse one).
- **If it fails:** nothing repo-specific; standard `az identity create` failures (quota, RG not found).

### 5. Deploy `infra/bicep/main.bicep` (storage + Defender, Service Bus, Key Vault)
- **Who:** platform engineer
- **Action:**
  ```
  cp infra/bicep/main.example.bicepparam infra/bicep/main.bicepparam   # fill in every <placeholder>, do not commit it
  az bicep build --file infra/bicep/main.bicep                        # offline sanity check first
  az deployment group create -g <rg> -f infra/bicep/main.bicep -p infra/bicep/main.bicepparam
  ```
  `*PrincipalId` parameters are the **object ids** (not client ids) from step 4's `az identity list`.
  `defenderCapGBPerMonth` defaults to 50 in the param file — fine for a dev namespace.
- **Verify:**
  ```
  az deployment group show -g <rg> -n main --query properties.provisioningState -o tsv   # Succeeded
  az storage account show -g <rg> -n <storage-account> --query provisioningState -o tsv  # Succeeded
  az servicebus namespace show -g <rg> -n <servicebus-namespace> --query provisioningState -o tsv
  az keyvault show -g <rg> -n <keyvault-name> --query provisioningState -o tsv
  ```
- **If it fails:** `infra/README.md`'s UNVERIFIED table flags
  `Microsoft.Security/defenderForStorageSettings@2025-06-01`'s property names as checked by reading the ARM
  reference, never deployed — if this one resource errors, run
  `az deployment group what-if -g <rg> -f infra/bicep/main.bicep -p infra/bicep/main.bicepparam` to see the
  exact diff Azure computed, and compare against `learn.microsoft.com/azure/defender-for-cloud/on-upload-malware-scanning`.
  With `privateEndpointSubnetId` empty, storage and Key Vault stay publicly reachable (Entra-only) — expected
  for a dev subscription; set it once the private endpoints matter.

### 6. Register the Defender prerequisite provider
- **Who:** platform engineer or security (I7)
- **Action:** `az provider register -n Microsoft.EventGrid`
- **Verify:** `az provider show -n Microsoft.EventGrid --query registrationState -o tsv` → `Registered`
  (registration can take a few minutes; poll).
- **If it fails:** re-run the register command; this is a subscription-level, one-time action with no
  repo-specific failure mode.

### 7. Confirm Defender for Storage is actually on (I7)
- **Who:** security
- **Action:** `storage.bicep` (deployed in step 5) sets `isEnabled: true` and
  `malwareScanning.onUpload.isEnabled: true` with `serving/` excluded. Confirm in the portal (Defender for
  Cloud → Environment settings → your subscription → the storage account's Defender plan) or:
  ```
  az security pricing show --name StorageAccounts -o table
  ```
- **Verify:** the plan is `Standard` with on-upload malware scanning enabled for this account, and the
  `serving/` prefix exclusion is present (`az resource show --ids <storage-account-id>/providers/Microsoft.Security/defenderForStorageSettings/current --query properties.malwareScanning`).
- **If it fails:** this is I7's open item — if the plan shows `Free` or scanning disabled, re-run step 5's
  deployment or enable it directly in the portal; without it the EICAR gate test (step 28) has no scanner to
  trigger and will hang at `MAL-002` after the 60-second timeout instead of `MAL-001`.

---

## Phase C — Key Vault contents

### 8. Generate and store the three platform secrets
- **Who:** platform engineer (Key Vault Secrets Officer — granted via `keyVaultAdminPrincipalId` in step 5)
- **Action:**
  ```
  for s in view-token-key pipeline-token internal-shared-key; do
    v=$(openssl rand -base64 32)
    az keyvault secret set --vault-name <keyvault-name> --name "$s" --value "$v" >/dev/null
    unset v
  done
  ```
  Never paste the generated values into a file in this repo (`CLAUDE.md` "No secrets anywhere").
- **Verify:** `az keyvault secret list --vault-name <keyvault-name> --query "[].name" -o tsv` shows all three
  names (not their values).
- **If it fails:** a 403 here means `keyVaultAdminPrincipalId` in step 5 was wrong or empty; re-run step 5
  with the correct object id, or grant the role by hand:
  `az role assignment create --role "Key Vault Secrets Officer" --assignee <you> --scope <vault-resource-id>`.

### 9. Push the viewer-shell's client secret into Key Vault
- **Who:** identity admin or platform engineer (uses the one-liner `create.sh` printed at the end of step 2)
- **Action:**
  ```
  s=$(az ad app credential reset --id <artifacts-viewer-shell-app-id> --display-name shell --years 1 --query password -o tsv)
  az keyvault secret set --vault-name <keyvault-name> --name entra-shell-client-secret --value "$s" >/dev/null
  unset s
  ```
  This must happen after step 5 (Key Vault must exist) and after step 2 (the app id must exist) — note the
  reorder relative to `infra/README.md`'s numbered deployment order, which lists Entra first but the secret
  push necessarily lands after the vault.
- **Verify:** `az keyvault secret show --vault-name <keyvault-name> --name entra-shell-client-secret --query attributes.enabled -o tsv` → `true`.
- **If it fails:** `az ad app credential reset` needs Application Administrator (or ownership of the app);
  re-run as the identity admin from step 2.

### 10. Import the two TLS certificates
- **Who:** platform engineer (Key Vault Certificates Officer)
- **Action:** obtain (from your internal CA, or a public CA since the domains are yours) a PFX with an
  **exportable** private key for each of:
  - `*.corp.com` or specifically `artifacts.corp.com` → Key Vault certificate **`artifacts-corp-com-tls`**
  - `*.corp-artifacts.net` (the wildcard) → Key Vault certificate **`wildcard-corp-artifacts-net-tls`**

  These exact names are what `deploy/platform/secretproviderclass.yaml`'s `gateway-tls` SecretProviderClass
  and `deploy/gateway.yaml`'s `certificateRefs` expect — do not rename them.
  ```
  az keyvault certificate import --vault-name <keyvault-name> --name artifacts-corp-com-tls --file artifacts-corp-com.pfx
  az keyvault certificate import --vault-name <keyvault-name> --name wildcard-corp-artifacts-net-tls --file wildcard-corp-artifacts-net.pfx
  ```
- **Verify:** `az keyvault certificate show --vault-name <keyvault-name> --name artifacts-corp-com-tls --query "attributes.enabled"` (repeat for the wildcard cert) → `true`.
- **If it fails / UNVERIFIED (`deploy/README.md`):** whether `objectType: secret` on a Key Vault
  **certificate** yields a PEM the Secrets Store CSI provider splits into `tls.key`/`tls.crt` is documented by
  Microsoft but not run here. If the Secrets `artifacts-corp-com-tls` / `wildcard-corp-artifacts-net-tls` never
  appear in step 17, re-check that the PFX had an exportable key and that `objectType: secret` (not `cert`) is
  what `secretproviderclass.yaml` requests — that is deliberate (it is the only `objectType` that returns the
  private key).

---

## Phase D — workload identity federation

### 11. Federate the four identities to their ServiceAccounts
- **Who:** platform engineer / cluster owner
- **Action:**
  ```
  ISSUER=$(az aks show -g <rg> -n <aks> --query oidcIssuerProfile.issuerUrl -o tsv)
  for n in intake-api scanner-worker viewer-shell tls-sync; do
    az identity federated-credential create \
      --name "artifacts-$n" \
      --identity-name "artifacts-$n" -g <rg> \
      --issuer "$ISSUER" \
      --subject "system:serviceaccount:artifacts-system:$n" \
      --audience api://AzureADTokenExchange
  done
  ```
  The ServiceAccount names (`intake-api`, `scanner-worker`, `viewer-shell`, `tls-sync`) and namespace
  (`artifacts-system`) must match `deploy/platform/serviceaccounts.yaml` exactly — that file is what step 16
  applies.
- **Verify:** `az identity federated-credential list --identity-name artifacts-intake-api -g <rg> -o table`
  (repeat per identity) shows the subject string exactly as above.
- **If it fails:** a typo in the subject (namespace or ServiceAccount name) is silent until pods fail to get a
  token at run time (`DefaultAzureCredential` falls through to other credential sources and eventually 401s
  against Blob/Service Bus/Key Vault) — there is no fast failure here, so double-check the string against
  `serviceaccounts.yaml` before moving on.

### 12. Attach the blobfuse identity for the static-gateway mount
- **Who:** platform engineer / cluster owner
- **Action (UNVERIFIED — no script in this repo; `deploy/platform/static-gateway.yaml`'s header names the two
  options):** either use the cluster's existing kubelet identity (nothing to do, just record its client id),
  or attach a dedicated identity to the node pool's VMSS:
  ```
  NODE_RG=$(az aks show -g <rg> -n <aks> --query nodeResourceGroup -o tsv)
  VMSS=$(az vmss list -g "$NODE_RG" --query "[?contains(name,'<node-pool-name>')].name" -o tsv)
  az vmss identity assign -g "$NODE_RG" -n "$VMSS" --identities <blobfuse-identity-resource-id>
  ```
- **Verify:** `az vmss identity show -g "$NODE_RG" -n "$VMSS" --query "userAssignedIdentities"` lists the
  identity. The client id goes into `deploy/platform/static-gateway.yaml`'s
  `AzureStorageIdentityClientID` and the `static-gateway-identity-client-id` placeholder in
  `secretproviderclass.yaml`.
- **If it fails:** this step is genuinely unverified — `infra/README.md` says only "Created by whoever owns
  the cluster," with no script. If blobfuse mount fails in step 23 with an auth error, the identity
  attached here (or the kubelet identity, if you chose that path) is the first thing to re-check; it needs
  **Storage Blob Data Reader** on the `serving` container (granted by `storage.bicep`'s
  `staticGatewayPrincipalId` parameter in step 5 — go back and re-run step 5 if you only decided on this
  identity now).

---

## Phase E — node pool and Azure Policy (gates M5, not M2's own criteria — included because the task asked for the full path)

### 13. Create the `untrusted` node pool
- **Who:** platform engineer
- **Action:**
  ```
  RESOURCE_GROUP=<rg> CLUSTER_NAME=<aks> SUBNET_ID=<untrusted-subnet-resource-id> \
    VM_SIZE=<vm-size> ./deploy/policy/nodepool-untrusted.sh --dry-run
  RESOURCE_GROUP=<rg> CLUSTER_NAME=<aks> SUBNET_ID=<untrusted-subnet-resource-id> \
    VM_SIZE=<vm-size> ./deploy/policy/nodepool-untrusted.sh
  ```
- **Verify:** `kubectl get nodes -l agentpool=untrusted -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints[*].key`
  shows the taint `artifacts.corp.com/untrusted`.
- **If it fails:** the script itself refuses to proceed without `VM_SIZE`; re-running after a partial failure
  is safe (idempotent — it checks for the existing pool by name first). Not required for M2's gate (no
  static-tier component schedules here), but needed before Phase 2 (M5) work starts, so doing it now avoids a
  second pass through this runbook later.

### 14. Assign the Azure Policy definitions
- **Who:** platform engineer / security
- **Action:**
  ```
  CLUSTER_ID=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerService/managedClusters/<aks> \
    ./deploy/policy/azure-policy-assign.sh --dry-run
  CLUSTER_ID=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerService/managedClusters/<aks> \
    ./deploy/policy/azure-policy-assign.sh
  ```
- **Verify:** script prints "Done." and its own closing note; after waiting, confirm sync by running the
  Phase 2 negative tests from `DESIGN.md` §8 (`kubectl apply` a pod with a non-allowlisted image, or
  `privileged: true`, in `artifacts-dynamic` — both must be denied). Not part of M2's gate.
- **If it fails:** `az aks show --ids $CLUSTER_ID --query addonProfiles.azurepolicy.enabled` must be `true`
  first — the script checks this and exits 1 with the enable command if not. Built-in definition display
  names occasionally change; the script's own error message gives the `az policy definition list --query`
  to re-find them. **Azure Policy syncs to Gatekeeper in up to 20 minutes** (`DESIGN.md` §9) — a bad pod
  getting through right after assignment is expected, not a failure; wait and retest.

---

## Phase F — cluster namespaces and networking

### 15. Apply namespaces and the ResourceQuota
- **Who:** platform engineer / DevOps admin
- **Action:** `kubectl apply -f deploy/namespaces.yaml`
- **Verify:** `kubectl get ns artifacts-system artifacts-static artifacts-dynamic --show-labels`
- **If it fails:** no repo-specific failure mode; standard RBAC-on-the-cluster error if `kubectl` is not
  pointed at the right context.

### 16. Apply ServiceAccounts, SecretProviderClasses, and `tls-sync`
- **Who:** platform engineer / DevOps admin
- **Action:**
  ```
  kubectl apply -f deploy/platform/serviceaccounts.yaml -f deploy/platform/secretproviderclass.yaml -f deploy/platform/tls-sync.yaml
  ```
  Every `<...-identity-client-id>` and `<keyvault-name>`/`<tenant-id>` placeholder in these two files must be
  substituted with the values from steps 4, 11 and 5 before applying.
- **Verify:**
  ```
  kubectl get secret -n artifacts-system artifacts-corp-com-tls wildcard-corp-artifacts-net-tls intake-api-secrets viewer-shell-secrets
  ```
  All four Secrets must exist (the first two only after `tls-sync`'s pod has mounted the `gateway-tls` class —
  `secretObjects` only sync while something mounts the SecretProviderClass, which is `tls-sync`'s entire job).
- **If it fails:** `deploy/README.md` says plainly: "If they never appear, the tls-sync pod's events say why
  (identity, Key Vault RBAC, certificate names)." Run `kubectl describe pod -n artifacts-system -l app.kubernetes.io/name=tls-sync`
  and check the three usual causes in order: wrong `clientID` (step 11's federation), missing Key Vault RBAC
  (step 5's `secretReaderPrincipalIds` parameter), or a certificate name typo (step 10).

### 17. Apply the Gateway; read its internal LB IP
- **Who:** platform engineer. (DNS itself is step 24, by the network team — this step only produces the IP
  that step 24 needs; they are not combined because the Gateway can be applied well before the network
  team is ready to act.)
- **Action:** `kubectl apply -f deploy/gateway.yaml`
- **Verify:**
  ```
  kubectl get gateway -n artifacts-system artifacts-internal -o wide
  kubectl get svc -n artifacts-system -l gateway.networking.k8s.io/gateway-name=artifacts-internal
  ```
  Read the internal LB's `EXTERNAL-IP` (an internal address, because of the
  `service.beta.kubernetes.io/azure-load-balancer-internal: "true"` annotation). Carry this IP into step 24.
- **If it fails:** if the Gateway never gets `Programmed: True`, re-check that both TLS Secrets from step 16
  exist (a Gateway with a missing `certificateRefs` Secret stays un-programmed, not errored) — this is a
  common ordering mistake if step 16 was skipped or only partially applied. **UNVERIFIED** (`deploy/README.md`):
  whether Istio Gateway pods run cleanly under PSA `baseline` and whether `infrastructure.annotations` reach
  the LB Service — confirmed only by this verify command actually returning an internal IP.

### 18. Apply HTTPRoutes and the NetworkPolicy
- **Who:** platform engineer / DevOps admin
- **Action:** `kubectl apply -f deploy/routes-static.yaml -f deploy/networkpolicy-dynamic.yaml`
- **Verify:** `kubectl get httproute -A` shows `viewer-shell`, `intake-api`, `static-content`, all with no
  `ResolvedRefs: False` condition. `kubectl get networkpolicy -n artifacts-dynamic default-deny-all`.
- **If it fails:** **UNVERIFIED** (`deploy/README.md`): Gateway API's exact-host-over-wildcard precedence for
  `*.corp-artifacts.net` vs. a later python artifact's exact hostname — only provable once a python artifact
  exists (Phase 2 / M5), not part of M2.

### 19. Apply the mesh-root canary (stage 1 only)
- **Who:** platform engineer
- **Action:** `kubectl apply -f deploy/authz-mesh-root.yaml` (this applies the `artifacts-static`-scoped
  canary; the `istio-system` root policy is commented out in the same file — leave it commented for M2).
- **Verify:** `kubectl get authorizationpolicy -n artifacts-static allow-only-mesh-principals-canary`
- **If it fails / rollback (`deploy/README.md`, `authz-mesh-root.yaml` header):** there is **no `AUDIT`
  mode** — ztunnel does not enforce `action: AUDIT` or `CUSTOM` at L4 (confirmed against Istio's own docs,
  2026-10-14), so there is nothing to dry-run. Watch instead:
  `kubectl logs -n istio-system -l app=ztunnel -f | grep -i 'policy rejection'` for a few days before
  considering stage 2 (the commented-out root policy, uncommented later, not part of M2). Rollback if
  something legitimate breaks: `kubectl delete authorizationpolicy -n artifacts-static allow-only-mesh-principals-canary`.

---

## Phase G — build and deploy the four platform images (I8, partial)

### 20. Confirm the VNet agent pool can reach the private cluster and Blob (I8)
- **Who:** DevOps admin
- **Action:** from a pipeline running on `<your-vnet-pool>`, confirm connectivity once, e.g. a throwaway
  pipeline step running `kubectl get ns` against the `<aks-connection>` service connection and
  `az storage account show --name <storage-account>` against the storage private endpoint. `DESIGN.md` §6.12
  states this as a prerequisite to confirm, not something this repo can verify for you: "Microsoft-hosted
  agents cannot reach this cluster."
- **Verify:** the throwaway step succeeds without a timeout.
- **If it fails (`DESIGN.md` §9):** "Deploy stage cannot reach the private API server or Blob" → "Pin the
  pipeline to your VNet pool" — if `<your-vnet-pool>` itself cannot reach them, this is a VNet/peering/private
  endpoint problem outside this repo's scope; escalate to the network team before continuing.

### 21. Set the `artifacts-platform` variable group
- **Who:** DevOps admin
- **Action:** in Azure DevOps → Pipelines → Library → variable group `artifacts-platform`, set:
  - `STORAGE_ACCOUNT` = `<storage-account>` from step 5
  - `INTAKE_EVENTS_URL` = `http://intake.artifacts.internal:8080/v1/publish` (resolves once step 24's DNS
    record exists; harmless to set now)
  - `PIPELINE_TOKEN` = link this one to the Key Vault secret `pipeline-token` (step 8), not a literal value
  - `PYTHON_RUNTIME_IMAGE` = leave as a placeholder digest for now; `pipelines/platform-deploy.yml`'s `runtime`
    job (triggered by step 22) prints the real digest for a person to paste in here afterwards — this is
    deliberately a human step, not automated (`pipelines/platform-deploy.yml`'s own comment: "deliberate, by a
    person").
- **Verify:** the variable group shows all four values (the Key Vault-linked one shows as linked, not plain
  text).
- **If it fails:** no repo-specific failure; standard Azure DevOps Library permissions.

### 22. Run `pipelines/platform-deploy.yml`
- **Who:** DevOps admin (or whoever has run permission on the pipeline)
- **Action:** trigger a run (push to `main` touching one of the watched paths, or run it manually). It builds
  and pushes `intake-api`, `scanner`, `static-gateway`, `viewer-shell`, and `python-runtime` to
  `jfrog.corp.com/artifacts/*`, substitutes `:<tag>` in `deploy/namespaces.yaml`, `deploy/gateway.yaml`,
  `deploy/routes-static.yaml`, `deploy/networkpolicy-dynamic.yaml` and every `deploy/platform/*.yaml`, applies
  all of them, then runs `kubectl rollout status` for `intake-api`, `scanner-worker`, `viewer-shell`.
- **Verify:** pipeline run is green; then independently (the pipeline does **not** check this one —
  see "Found inconsistent" below):
  ```
  kubectl rollout status -n artifacts-static deploy/static-gateway --timeout=180s
  ```
- **If it fails:** read the `Substitute image tags` step's log — it `grep`s the rendered manifests for any
  leftover `<placeholder>` and fails loudly before `kubectl apply` if one of `<storage-account>`,
  `<servicebus-namespace>`, `<ado-org>`, `<ado-project>`, `<artifact-python-deploy-pipeline-id>` etc. in
  `deploy/platform/*.yaml` was never substituted — go back and replace every placeholder in those manifests
  with the real values from steps 5, 11, 12 first (they are not Bicep parameters; they are literal strings in
  the YAML, edited by hand or by a `sed` pass in a real environment).

### 23. Verify the full rollout
- **Who:** platform engineer
- **Action:**
  ```
  kubectl get pods -n artifacts-system -o wide
  kubectl get pods -n artifacts-static -o wide
  kubectl get gateway -n artifacts-system artifacts-internal
  ```
- **Verify:** every pod `Running` and `Ready`; the Gateway's `Programmed` condition is `True` with both
  listeners accepted.
- **If it fails:** a `static-gateway` pod stuck `Pending` or `CrashLoopBackOff` with a blobfuse mount error
  points back at step 12 (the blobfuse identity) or step 10 (certificate names do not apply here — that is
  the Gateway, not the mount — but the pattern of checking `kubectl describe pod` and `kubectl logs` applies
  equally). If the pod is `Running` but never `Ready` (readiness probe failing, no crash), read the service log (the health endpoints exist since T16/T17)
  first — see "Code-level blocker" above — before assuming anything in this runbook is wrong.

---

## Phase H — internal DNS (I3's internal cousin — not the public record)

### 24. Create the internal DNS records
- **Who:** network team
- **Action:** using the internal LB IP read in step 17, create private DNS A records:
  - `artifacts.corp.com` → `<internal-lb-ip>`
  - `*.corp-artifacts.net` → `<internal-lb-ip>`
  - `intake.artifacts.internal` → `<internal-lb-ip>`

  If using Azure Private DNS zones: `az network private-dns record-set a add-record -g <rg> -z corp.com -n artifacts -a <internal-lb-ip>`
  (and the equivalent for the other two zones/names).
- **Verify:** from a machine inside the VNet (or the Azure DevOps VNet pool): `nslookup artifacts.corp.com`,
  `nslookup <anything>.corp-artifacts.net`, `nslookup intake.artifacts.internal` — all resolve to the internal
  LB IP.
- **If it fails:** this is a network-team-owned DNS zone issue, outside this repo. `DESIGN.md` §6.11 notes
  APIM's `backendUrl` is `http://intake.artifacts.internal:8080` — that record specifically also matters for
  M3 (APIM's backend hop), not just M2.

---

## Phase I — APIM + MCP server (I2, I3 — parallel, NOT on M2's path)

### 25. Import the API, create the MCP server, App Gateway route, public DNS
- **Who:** APIM owner (API/MCP) + network team (App Gateway, public DNS)
- **Action:** can start any time after step 3 (needs the two client ids) and does not block anything in this
  runbook:
  ```
  az deployment group create -g <apim-rg> -f infra/apim/apim.bicep \
    -p apimName=<apim-name> backendUrl=http://intake.artifacts.internal:8080 \
       tenantId=<tenant-id> artifactsMcpClientId=<artifacts-mcp-app-id> claudeConnectorClientId=<claude-connector-app-id>
  ```
  If the `mcpServer` resource is rejected: `SUBSCRIPTION_ID=<sub> RESOURCE_GROUP=<apim-rg> APIM_NAME=<apim-name> ./infra/apim/create-mcp-server.sh [--dry-run]`.
  App Gateway route and public DNS for `mcp.corp.com` are requested from the network team per
  `infra/README.md` step 7 (not Bicep here — shared gateway, owned elsewhere).
- **Verify:** `az apim api show -g <apim-rg> -n <apim-name> --api-id artifacts`. Full discovery-flow
  verification is Phase 0's gate in `DESIGN.md` §8, not M2's.
- **If it fails:** **UNVERIFIED** (`infra/README.md`): the MCP server resource shape
  (`Microsoft.ApiManagement/service/apis@2025-09-01-preview`, `type: 'mcp'`) is taken from a Microsoft sample,
  not the ARM reference; if it is rejected, fall back to `create-mcp-server.sh`, and if that also fails, the
  portal's "Expose an API as an MCP server" wizard with the same two operations is the last resort. None of
  this affects M2 — skip this phase entirely for an M2-only run and come back to it before M3.

---

## Phase J — smoke test

### 26. Run the smoke test
- **Who:** platform engineer / DevOps admin
- **Action:** `./tests/m2/smoke.sh` (see that script's header for every env var; defaults assume
  `kubectl` is pointed at the right cluster and namespace names match this runbook). It health-checks all four
  services, publishes `tests/corpus/static-ok`, and walks the gateway's token→cookie→CSP-header handshake
  without a browser (the full browser walk, including real Entra sign-in, is step 29 /
  `tests/m2/browser-checklist.md`).
- **Verify:** script prints `SMOKE: PASS` and exits 0.
- **If it fails:** the script's own output names which of the four `/healthz` checks, the publish, the
  view-token mint, or the cookie handshake failed — work backward through phases F/G for that specific
  service.

---

## Phase K — the M2 gate tests

### 27. Cluster corpus (21/21)
- **Who:** platform engineer
- **Action:** `./tests/m2/cluster-negative.sh` (documents and performs the exact `az account get-access-token`
  call; see that script's header).
- **Verify:** script prints a line formatted for pasting into `STATUS.md`'s M2 row, e.g.
  `M2 cluster corpus: 21/21 ok (tests/negative.sh against <url>)`.
- **If it fails:** any mismatch reproduces `tests/negative.sh`'s own table (bundle, expected, got, result) —
  diff against the M1 local-stack run already recorded in `STATUS.md` (`21/21`) to see whether the failure is
  cluster-specific (Defender timing, DNS, a missing env var in `deploy/platform/*.yaml`) or a regression.

### 28. EICAR upload rejected with a Defender alert (I7)
- **Who:** security + platform engineer
- **Action:** `./tests/m2/eicar-publish.sh` (reads the **warning at the top of the script** first — it
  quarantines the temp file on a laptop with endpoint AV; run it from the cluster test job or a sandboxed
  machine). It prints the `az security alert list` query (or portal path) for a human to confirm the alert.
- **Verify:** script asserts state `rejected` with rule `MAL-001` and prints `EICAR: PASS`. A human then
  confirms the Defender for Cloud alert appears (can lag by a few minutes — `DESIGN.md` §9: "Microsoft gives
  no SLA").
- **If it fails:** state `failed` with `MAL-002` instead of `rejected`/`MAL-001` means Defender did not return
  `Malicious` within the 60-second window (`scanner/README.md`'s `DEFENDER_TIMEOUT_SECONDS`) — re-check step 7
  (plan actually enabled) before assuming the scan missed the signature.

### 29. Browser checks for `static-fetch` and `static-navigate`, plus the three 403 checks
- **Who:** platform engineer (a human, with a real browser and a real Entra account assigned to sign in)
- **Action:** walk `./tests/m2/browser-checklist.md` top to bottom.
- **Verify:** every item in the checklist is checked off; the exact console strings match.
- **If it fails:** the checklist's own "if this doesn't happen" notes point back at the shell CSP
  (`viewer-shell/README.md`) or the gateway CSP (`static-gateway/README.md`) depending on which block is
  missing.

### 30. Declare the M2 gate passed
- **Who:** orchestrator (not this agent — `CLAUDE.md`: "Never edit another agent's rows, the milestones...")
- **Action:** paste the evidence from steps 27–29 into `STATUS.md`'s M2 milestone row and set its state to
  `done`.

---

## Summary of what is UNVERIFIED in the repo's own READMEs that this runbook depends on

| Step(s) | Claim | Where it is flagged | What to expect |
|---|---|---|---|
| 5 | `defenderForStorageSettings@2025-06-01` property names | `infra/README.md` | `what-if` before assuming a deployment error is this repo's fault |
| 10, 16 | Key Vault certificate `objectType: secret` → CSI splits PEM into `tls.key`/`tls.crt` | `deploy/README.md` | works per Microsoft's doc, never run; re-check the PFX's exportable key if Secrets never appear |
| 12 | blobfuse's node-level identity attachment | `infra/README.md`, `deploy/platform/static-gateway.yaml` | no script here at all; this runbook's step 12 is this agent's best reconstruction, not a verified path |
| 14 | Azure Policy built-in parameter names | `deploy/README.md` | the script fails loudly and names the lookup to re-find them |
| 17 | Istio Gateway pods under PSA `baseline`; `infrastructure.annotations` reaching the LB Service | `deploy/README.md` | only provable by the verify command in step 17 actually returning an IP |
| 18 | Gateway API exact-host precedence over the wildcard route | `deploy/README.md` | not provable until a python artifact exists (M5); irrelevant to M2's static-only gate |
| 25 | APIM MCP server resource shape | `infra/README.md` | not on M2's path; fallback script and portal wizard documented if it matters later |

## Resolved by T18

This runbook used to flag a gap here: `intake-api` trusted `X-Publisher-Oid`/`X-Publisher-Upn`
**unconditionally** whenever present, so a real Entra access token obtained in step 27 was not actually
checked by anything in that direct (non-APIM) test path — only the identity headers were, and anything on the
VNet that could reach the `intake` listener could set them.

T18 closed this with **no shared key**: `intake-api` now verifies the caller's Entra bearer itself
(`intake-api/src/entra-token.ts` — RS256 against the tenant's JWKS, `iss`, `aud`, `exp`/`nbf`, `tid`, and the
`scp` claim) and takes `oid`/`upn` from its own claims; `X-Publisher-*` headers are never read any more, even
when present, unless `DEV_AUTH=1` (not set anywhere in `deploy/platform/intake-api.yaml`). `deploy/platform/
intake-api.yaml` carries the new `ENTRA_TENANT_ID`/`ENTRA_AUDIENCE` env vars, and `deploy/networkpolicy-system.
yaml` additionally restricts who can reach the `intake-api` pods at all (the Gateway, scanner-worker and
viewer-shell pods only). So step 27's direct, non-APIM path now exercises the real thing: the token
`tests/m2/cluster-negative.sh` fetches with `az account get-access-token --resource
https://mcp.corp.com/artifacts-mcp/mcp` is the one intake-api actually verifies — its `--resource` value is
already the right one, because the `artifacts-mcp` app registration's `requestedAccessTokenVersion: 2` makes
Entra issue a v2-format token (`aud` = the client id) regardless of which endpoint requested it (DESIGN
§6.10, `infra/entra/README.md`). No script change was needed; its comments were updated to say so.
