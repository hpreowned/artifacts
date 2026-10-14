# infra/ — Azure resources for Publish-to-AKS

Bicep for the platform's Azure dependencies, APIM configuration applied to an existing instance, and the
Entra app registrations. No file here contains a real tenant value: every `<...>` is a placeholder, and
the policy XML says `mcp.corp.com` until `apim.bicep` substitutes `publicHostname`.

## Layout

| Path | Creates | Applied with |
|---|---|---|
| `bicep/main.bicep` | the three modules below, resource-group scope | `az deployment group create -g <rg> -f infra/bicep/main.bicep -p infra/bicep/main.bicepparam` |
| `bicep/storage.bicep` | StorageV2 account (Entra-only, no shared key), containers `intake`, `serving`, `jobs`, Defender for Storage on-upload scanning, optional blob private endpoint, container-scoped RBAC | module of `main.bicep` |
| `bicep/messaging.bicep` | Service Bus Standard namespace, queue `artifact-scan` (dedup on message id = jobId, DLQ), sender/receiver RBAC | module of `main.bicep` |
| `bicep/keyvault.bicep` | Key Vault (RBAC mode, purge protection), optional private endpoint, reader/admin/pipeline RBAC. Creates **no** secrets | module of `main.bicep` |
| `bicep/main.example.bicepparam` | every parameter with a placeholder; copy to `main.bicepparam` | — |
| `apim/apim.bicep` | on an existing APIM: REST API `artifacts` from the frozen contract, MCP server `artifacts-mcp`, PRM operation, three named values, six policies | `az deployment group create -g <apim-rg> -f infra/apim/apim.bicep -p apimName=<apim-name> backendUrl=<url> tenantId=<tenant-id> artifactsMcpClientId=<id> claudeConnectorClientId=<id>` |
| `apim/create-mcp-server.sh` | fallback for the MCP server resource if the Bicep shape is rejected (see UNVERIFIED) | `SUBSCRIPTION_ID=… RESOURCE_GROUP=… APIM_NAME=… ./create-mcp-server.sh [--dry-run]` |
| `apim/policies/*.xml` | policy documents loaded by `apim.bicep` | — |
| `entra/create.sh`, `entra/verify.sh` | the three app registrations (DESIGN §6.10) and the values for the connector dialog | see `entra/README.md` |

## Deployment order

1. **Entra** — `infra/entra/create.sh`. Outputs the two client ids that `apim.bicep` needs. Prerequisite: the host of the MCP URL (`mcp.corp.com`) is a verified domain in the tenant, otherwise Graph refuses the Application ID URI.
2. **Workload identities** — four user-assigned managed identities (`intake-api`, `scanner-worker`, `viewer-shell`, `tls-sync`) plus the identity blobfuse uses on the nodes. Created by whoever owns the cluster (`az identity create`), federated to the ServiceAccounts in `deploy/platform/` (`az identity federated-credential create --issuer <aks-oidc-issuer> --subject system:serviceaccount:artifacts-system:<sa>`). Their **object ids** go into the bicepparam file. Not created here because they belong to the cluster's resource group and lifecycle.
3. **`bicep/main.bicep`** — storage, Service Bus, Key Vault, private endpoints, RBAC. With `privateEndpointSubnetId` empty the accounts stay publicly reachable (Entra-only) for a dev subscription; with it set, `publicNetworkAccess` flips to `Disabled` automatically.
4. **Key Vault contents** (people, Secrets Officer + Certificates Officer): secrets `view-token-key` (32 random bytes, base64), `pipeline-token` (32 random bytes, base64), `internal-shared-key` (same), `shell-session-key` (same; signs the viewer-shell session cookie), `entra-shell-client-secret` (from `entra/README.md`); certificates `artifacts-corp-com-tls` and `wildcard-corp-artifacts-net-tls` (import PFX). Generate with `openssl rand -base64 32`; never paste into a file in this repo.
5. **Defender prerequisite** — `az provider register -n Microsoft.EventGrid` in the subscription. Defender for Storage itself is in `storage.bicep` (integration item I7).
6. **`apim/apim.bicep`** against the existing APIM instance. If the `mcpServer` resource is rejected, run `apim/create-mcp-server.sh` and re-run the Bicep (every other resource is idempotent).
7. **App Gateway + public DNS** (integration item I3, network team): listener `mcp.corp.com` → APIM; path rules `/artifacts-mcp/*`, `/.well-known/oauth-protected-resource/*`, `/artifacts/v1/*/upload`, `/artifacts/v1/*/finalize`; WAF custom rule allowing `/artifacts-mcp/*` and the PRM path only from `160.79.104.0/21`; everything else 403. Not expressed in Bicep here because the gateway is shared and owned elsewhere.
8. `deploy/` then `pipelines/` (their own READMEs).

## Parameters

`bicep/main.bicep`

| Parameter | Meaning |
|---|---|
| `storageAccountName`, `serviceBusNamespaceName`, `keyVaultName` | resource names (storage: 3–24 lowercase alphanumerics) |
| `privateEndpointSubnetId` | subnet for both private endpoints; empty disables them and keeps public access on |
| `blobPrivateDnsZoneId`, `vaultPrivateDnsZoneId` | `privatelink.blob.core.windows.net` / `privatelink.vaultcore.azure.net` zone ids |
| `defenderCapGBPerMonth` | on-upload scan cap, default 50 GB (thousands of 25 MiB bundles); `-1` uncapped |
| `intakeApiPrincipalId`, `scannerPrincipalId`, `staticGatewayPrincipalId`, `viewerShellPrincipalId`, `tlsSyncPrincipalId` | object ids of the workload identities; empty skips that role assignment |
| `pipelinePrincipalId` | object id of the Azure DevOps service connection principal (`<storage-connection>`): reads `intake`, deletes in `serving`, reads `pipeline-token` |
| `keyVaultAdminPrincipalId` | person or group that creates the secrets and imports the certificates |

`apim/apim.bicep`

| Parameter | Meaning |
|---|---|
| `apimName` | existing instance, Developer…Premium v2 (not Consumption: no MCP support) |
| `backendUrl` | intake-api as APIM reaches it over the VNet, e.g. `https://intake.artifacts.internal` (DESIGN §6.11) |
| `publicHostname` | default `mcp.corp.com`; substituted into the MCP and PRM policies |
| `tenantId`, `artifactsMcpClientId`, `claudeConnectorClientId` | become named values `tenant-id`, `artifacts-mcp-client-id`, `claude-connector-client-id` |
| `apimMode` | `internal` (behind App Gateway, IP decisions in the WAF) or `external` (adds the `ip-filter` policy for `160.79.104.0/21` at MCP scope only) |

## Role assignments (least privilege, container/queue scoped)

| Identity | Storage | Service Bus | Key Vault |
|---|---|---|---|
| intake-api | Data Contributor on `intake`, `jobs` | Data Sender | Secrets User |
| scanner-worker | Data Reader on `intake`; Contributor on `serving`, `jobs` | Data Receiver | — |
| static-gateway (blobfuse identity) | Data Reader on `serving` | — | Secrets User |
| viewer-shell | — | — | Secrets User |
| tls-sync (Secrets Store CSI) | — | — | Secrets User |
| pipeline (ADO service connection) | Reader on `intake`; Contributor on `serving` | — | Secrets User |

## Defender for Storage

Resource `Microsoft.Security/defenderForStorageSettings@2025-06-01`, name `current`, scoped to the storage account
(`storage.bicep`). Properties used: `isEnabled`, `overrideSubscriptionLevelSettings`,
`malwareScanning.onUpload.{isEnabled,capGBPerMonth,filters.excludeBlobsWithPrefix}`,
`malwareScanning.blobScanResultsOptions: blobIndexTags`, optional `scanResultsEventGridTopicResourceId`,
`sensitiveDataDiscovery.isEnabled: false`. The `serving/` prefix is excluded so only intake uploads are billed. The
POC reads the result from the blob index tag (DESIGN §5); production consumes Event Grid.
Do not set blob metadata after the upload call: Microsoft documents that this can fail the scan (DESIGN §9).

## APIM module: what was checked

- REST API id `artifacts`, path `artifacts`, `format: 'openapi'` with the inline YAML of `contracts/intake-openapi.yaml`, so public URLs are `https://<host>/artifacts/v1/...`, matching the contract's first `servers` entry. Operation ids are the contract's `operationId`s.
- MCP server `artifacts-mcp` lists exactly `beginPublish` and `getPublishStatus`, the two `x-mcp-tool: true` operations. APIM does not read that extension; the list is explicit in `apim.bicep` and in `create-mcp-server.sh`. Endpoint `https://<host>/artifacts-mcp/mcp`.
- PRM: API `artifacts-prm` at path `.well-known/oauth-protected-resource`, operation `GET /artifacts-mcp/mcp`, `return-response` with the DESIGN §6.10 JSON verbatim (`{{tenant-id}}` named value, `resource` = `https://<host>/artifacts-mcp/mcp`).
- Named values `tenant-id`, `artifacts-mcp-client-id`, `claude-connector-client-id` (identifiers, `secret: false`).
- `policies/mcp-server.xml` is DESIGN §6.10 verbatim. `rest-entra.xml` applies the same validation to direct REST calls of the two tool operations (no PRM header).
- `policies/upload-finalize.xml`: no Entra validation; `validate-content max-size="33554432"` (32 MiB, `size-exceeded-action="prevent"`); `rate-limit-by-key` 30/min keyed on the `Authorization` header (the one-time token); missing bearer → 401 before the backend; caller-supplied `X-Publisher-*` headers deleted.
- `postPublishEvent` and `createViewToken` (`x-internal`) get `internal-404.xml` so the import does not expose them.

## Validation performed here

- `az bicep build` (Bicep CLI 0.46.1) clean, no warnings, on `bicep/main.bicep` and `apim/apim.bicep`; `az bicep build-params` clean on `main.example.bicepparam`.
- Every `apim/policies/*.xml` parses as XML. `create-mcp-server.sh --dry-run` runs without a tenant.
- **Nothing was deployed.** No subscription, tenant, APIM instance, or App Gateway was available.

## UNVERIFIED

| Item | Risk | How to confirm |
|---|---|---|
| APIM MCP server resource: `Microsoft.ApiManagement/service/apis@2025-09-01-preview` with `type: 'mcp'` and `mcpTools[]` (shape taken from Microsoft's AI-Gateway sample, not from the ARM reference, which only documents `mcpProperties` for pass-through servers) | deployment of that one resource fails | run `apim.bicep`; on failure run `create-mcp-server.sh`, whose `API_VERSION=2025-03-01-preview` is the portal's version and is itself unverified; last resort is the portal's "Expose an API as an MCP server" wizard with the same two operations |
| Whether APIM re-runs operation-scope policies (`rest-entra.xml`) when an MCP tool call is proxied to `beginPublish`/`getPublishStatus` | tool calls 401 while direct REST works | Phase 0 gate; if so, drop the operation policies on those two operations and keep MCP-scope validation only |
| `Microsoft.Security/defenderForStorageSettings@2025-06-01` property names, checked by the previous agent instance against the ARM template reference on 2026-10-14, not re-checked and not deployed | `az deployment` validation error on that resource | `az deployment group what-if` |
| Scope string in `scopes_supported` for a URL-style App ID URI (`<App ID URI>/artifacts.publish`) | Claude's discovery or Entra's consent prompt rejects the scope | Phase 0 gate (DESIGN §11) |
| Service Bus Standard has no private endpoint and no network rules; Entra RBAC is the only control | namespace is internet-reachable | accept for POC, or switch `messaging.bicep` to Premium and add a private endpoint |
| `allowSharedKeyAccess: false` with the Blob CSI driver in MSI mode (`deploy/platform/static-gateway.yaml`): the driver's static-provisioning MSI path should not need the key | blobfuse mount fails on the node | M2 gate; if it fails, the identity used is wrong, not the account setting |
| Cache header on the PRM response (`public, max-age=300`) is harmless but not required by RFC 9728 | none | — |

## Not here

- App Gateway rules, WAF custom rule, public DNS record: request text in step 7 above (I3).
- Cowork egress allowlist (I4), custom connector (I5), Azure DevOps Environment and service connections (I8): human steps, see `STATUS.md`.
