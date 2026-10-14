# artifacts-platform

Helm chart for the Publish-to-AKS platform tier (DESIGN.md §6.6-§6.8, §6.11; STATUS.md T71). Renders
everything that used to be the raw files under `deploy/`:

| Raw file (removed) | Template | Contents |
|---|---|---|
| `deploy/namespaces.yaml` | `templates/namespaces.yaml` | 3 namespaces (PSA + mesh labels), `artifacts-dynamic-quota` ResourceQuota |
| `deploy/gateway.yaml` | `templates/gateway.yaml` | Gateway `artifacts-internal`: `shell`, `content`, `intake` listeners |
| `deploy/routes-static.yaml` | `templates/httproutes.yaml` | HTTPRoutes `viewer-shell`, `intake-api`, `static-content` |
| `deploy/networkpolicy-dynamic.yaml` | `templates/networkpolicy-dynamic.yaml` | default-deny-all in `artifacts-dynamic` |
| `deploy/networkpolicy-system.yaml` | `templates/networkpolicy-system.yaml` | intake-api-ingress in `artifacts-system` |
| `deploy/authz-mesh-root.yaml` | `templates/authz-mesh-root.yaml` | mesh-root AuthorizationPolicy, staged |
| `deploy/platform/serviceaccounts.yaml` | `templates/serviceaccounts.yaml` | 4 workload-identity ServiceAccounts |
| `deploy/platform/secretproviderclass.yaml` | `templates/secretproviderclass.yaml` | `intake-api-secrets`, `viewer-shell-secrets`, `gateway-tls` |
| `deploy/platform/tls-sync.yaml` | `templates/tls-sync.yaml` | pause Deployment that mounts `gateway-tls` |
| `deploy/platform/intake-api.yaml` | `templates/intake-api.yaml` | Deployment + Service |
| `deploy/platform/scanner-worker.yaml` | `templates/scanner-worker.yaml` | Deployment (no Service) |
| `deploy/platform/viewer-shell.yaml` | `templates/viewer-shell.yaml` | Deployment + Service |
| `deploy/platform/static-gateway.yaml` | `templates/static-gateway.yaml` | ServiceAccount, SecretProviderClass, Blob CSI PV/PVC, Deployment, Service |

Namespace names, resource names, label keys, Service/Secret/SecretProviderClass names are **not**
parameterised — they are referenced by name from other templates (and from `deploy/python-artifact/` /
`charts/artifact-python`, owned separately), so changing them here would break those references. Only the
things that were `<placeholder>` text in the raw manifests became values.

## What you must supply

See `values.yaml` for the full list with comments, and `values.example.yaml` for a filled-in (fake) shape.
At minimum, for a real cluster:

- `tenantId`, `keyVaultName`
- `domains.shell`, `domains.artifacts`, `domains.intakeInternal`, `domains.publicBase`
- `entra.audience`, `entra.viewerShellClientId`
- `images.*` (set by the pipeline per build, see `pipelines/platform-deploy.yml`)
- `identities.*.clientId` (one per workload-identity ServiceAccount, plus `identities.blobfuse` for the node identity)
- `storage.accountName`, `storage.resourceGroup`
- `serviceBus.fqdn`
- `ado.org`, `ado.project`, `ado.pipelineId`

Nothing in this chart is a secret. Secret material (`VIEW_TOKEN_KEY`, `PIPELINE_TOKEN`,
`INTERNAL_SHARED_KEY`, `ENTRA_CLIENT_SECRET`, `SHELL_SESSION_KEY`, the TLS private keys) stays in Key Vault
and reaches pods only through the `SecretProviderClass` objects this chart renders.

## Use

```sh
helm lint charts/artifacts-platform
helm template artifacts-platform charts/artifacts-platform -f charts/artifacts-platform/values.yaml
helm template artifacts-platform charts/artifacts-platform -f charts/artifacts-platform/values.example.yaml
helm upgrade --install artifacts-platform charts/artifacts-platform -f <your-values.yaml> \
  --set images.intakeApi=<registry>/intake-api:<tag> \
  --set images.scannerWorker=<registry>/scanner:<tag> \
  --set images.staticGateway=<registry>/static-gateway:<tag> \
  --set images.viewerShell=<registry>/viewer-shell:<tag>
```

`kubectl` is not available in this environment; everything above was checked with `helm lint` /
`helm template` only (no cluster). The apply order (node pool, namespaces, ServiceAccounts before Secrets,
Gateway, routes, policies, Azure Policy, then the mesh-root canary) is unchanged from `deploy/README.md` —
this chart is just a different way to produce the same manifests, not a different order of operations.

## Conformance

`charts/tests/platform-conformance.sh` renders this chart and asserts, against assertions taken from the
original raw manifests (frozen into the test itself, since those files no longer exist), that every
container name, image, env var name, port, probe, securityContext field,
`automountServiceAccountToken`, volume, resource request/limit, NetworkPolicy, AuthorizationPolicy, Gateway
listener, HTTPRoute hostname, namespace label and ResourceQuota value is still present. Run it with:

```sh
charts/tests/platform-conformance.sh
```

## Known gaps vs. the raw manifests

- `deploy/gateway.yaml`'s commented-out `azure-load-balancer-internal-subnet` annotation is now a real
  value (`gateway.internalLbSubnet`), defaulted to empty (annotation omitted) instead of being commented
  out — same effect, cleaner to turn on.
- Everything else renders byte-for-byte equivalent YAML once the placeholders are filled in; see the table
  above for the exact raw-file-to-template mapping.
