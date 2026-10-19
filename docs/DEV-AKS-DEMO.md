# Demo on the dev AKS cluster — no new Azure resources

The platform running on a real cluster, the real images, the real sandboxing, the real artifact charts under
the real namespace policies — with the three things that need other teams deferred and their cost written
down. This is the subset of `docs/M2-RUNBOOK.md` a platform engineer with `kubectl`, Docker and a registry
can do alone. Business users never see any of this; they publish from Cowork or Claude Code.

| Runs for real here | Deferred, and what it costs |
|---|---|
| The four platform images, built from the real Dockerfiles | Blob / Service Bus / Key Vault: one pod, disk-backed stores, in-process queue (`charts/artifacts-dev-allinone`). Not multi-process, not durable beyond the PVC. Phase 2 request: `infra/bicep` translated for the Terraform project |
| Static artifacts end to end: gateway, shell, per-artifact origins (M2's content) | Entra at intake and shell: `DEV_AUTH=1`. Anyone who can reach intake's address can publish as `dev-user`; every viewer is `dev-viewer`. Private cluster, demo only |
| Node and Python artifacts on the real charts, restricted PSA, default-deny (most of M8) | Azure DevOps pipelines: they fetch from Blob. `scripts/play-node-pipeline.sh` plays them by hand with the same inputs, image, chart and callbacks |
| Istio ambient posture, Gateway API routes on the existing ingress | TLS and corporate DNS: HTTP on wildcard-IP hostnames (`nip.io` for the shell, `sslip.io` for artifacts — different registrable domains, so cross-site stays faithful) |
| D16 approval policy, duplicate refusal, precedent | APIM and the connector: Claude Code via `mcp-local` pointed at the cluster; Cowork waits for APIM |

**Shared-cluster rule:** nothing here is cluster-scoped except two namespaces. No Azure Policy, no node pool, no
mesh-root authorization policy. Remove this chart before `charts/artifacts-platform` is installed on the
same cluster (both own `artifacts-dynamic`).

## 0. Facts to confirm first

```sh
kubectl get crd gateways.gateway.networking.k8s.io                              # Gateway API present
kubectl get gateway -A                                                          # the gateway to attach to
kubectl get gateway <name> -n <ns> -o yaml | sed -n '/listeners:/,/status:/p'   # listener hostnames + allowedRoutes
nslookup x.<ip-with-dashes>.sslip.io; nslookup x.<ip-with-dots>.nip.io          # wildcard-IP DNS resolves on your network
kubectl get storageclass                                                        # a default class for the PVC
```

On the dev cluster (checked 2026-10-18): both listeners, `http` (80) and `https` (443, the org's certificate),
admit routes from namespaces labeled `ingress-access: "true"` and pin no hostname. The chart labels its two
namespaces accordingly (`gateway.routeNamespaceLabels`) and attaches to the `http` listener
(`gateway.sectionName`); the artifact charts' routes live in `artifacts-dynamic`, which carries the same label.
`sslip.io` resolves through the VPN resolver; check `nip.io` the same way for the shell host — if it does not
resolve, put the shell on `sslip.io` too (e.g. `shell.10-142-65-220.sslip.io`) at the cost of the shell and
the artifacts being same-site, which the viewer sandboxing tolerates but production never would.
Ambient note: the artifact namespaces are deliberately *not* in the mesh, so the gateway reaches them over
plain HTTP on 8080 and the default-deny policy's single allow rule is exact.

## 1. Build and push the images (laptop)

```sh
scripts/build-platform-images.sh <registry-prefix> dev1 --push
```

Overrides when your registry mirrors differently: `NODE_IMAGE`, `PYTHON_IMAGE`, `GITLEAKS_URL`,
`GITLEAKS_SHA256` (pin it; the script computes it once if unset, dev only). Apple silicon builds amd64 by
default.

## 2. Secrets, then the chart

```sh
kubectl create namespace artifacts-dev
kubectl -n artifacts-dev create secret generic artifacts-dev-secrets \
  --from-literal=PIPELINE_TOKEN="$(openssl rand -base64 32)" \
  --from-literal=INTERNAL_SHARED_KEY="$(openssl rand -base64 32)" \
  --from-literal=VIEW_TOKEN_KEY="$(openssl rand -base64 32)"
helm upgrade --install artifacts-dev charts/artifacts-dev-allinone \
  --set images.platform=<registry-prefix>/scanner:dev1 \
  --set images.staticGateway=<registry-prefix>/static-gateway:dev1 \
  --set images.viewerShell=<registry-prefix>/viewer-shell:dev1 \
  --set hosts.shell=shell.<ip-with-dots>.nip.io \
  --set hosts.artifactDomain=a.<ip-with-dashes>.sslip.io \
  --set gateway.name=ingress-gateway --set gateway.namespace=istio-ingress   # sectionName defaults to http
kubectl -n artifacts-dev rollout status deploy/artifacts-dev
```

The platform image is the scanner image: it carries Python, gitleaks and the intake code, and runs the
combined process. `helm get notes artifacts-dev` prints the URLs. If the platform container never becomes
ready, `kubectl -n artifacts-dev logs deploy/artifacts-dev -c platform` — the usual cause is the PVC.

## 3. Reach intake from the laptop

```sh
kubectl -n artifacts-dev port-forward svc/artifacts-dev-intake 8080:8080
```

`publicBaseUrl` defaults to `http://localhost:8080`, which is exactly this. Then, for Claude Code,
`mcp-local` needs nothing new: `ARTIFACTS_API_URL=http://localhost:8080` is its default. The skill's
`upload.sh` uploads to the `uploadUrl` intake returns, which is also this address.

## 4. Static artifact, end to end

Open Claude Code, build something, say "publish this internally". Expected: `live` within a minute and a
link `http://shell.<ip>.nip.io/view/<id>` that renders the artifact inside the shell's frame from
`http://<id>.a.<ip>.sslip.io/`. That is M2's content on a real cluster.

## 5. Node or Python artifact, with the pipeline played by hand

After the publish reaches `scanning` with a run URL (nothing deploys by itself: `PIPELINE_TRIGGER=manual`;
the dev approval page says so), from the laptop:

```sh
export INTAKE_URL=http://localhost:8080 PIPELINE_TOKEN=<from the secret> REGISTRY=<registry-prefix>
export ARTIFACT_DOMAIN=a.<ip-with-dashes>.sslip.io SHELL_ORIGIN=http://shell.<ip-with-dots>.nip.io
scripts/play-node-pipeline.sh <jobId>            # add --dry-run to see the commands first
```

It fetches the job record and bundle from intake, builds the image from `node-runtime/Dockerfile`, pushes,
asks you to approve when the policy says a human must (D16), installs `charts/artifact-node` into
`artifacts-dynamic`, waits for the rollout, and posts the callbacks. For Python, build and push
`python-runtime/Dockerfile` once and set `PYTHON_RUNTIME_IMAGE=<registry-prefix>/python-runtime@sha256:...`.

If the rollout never becomes healthy, the artifact server is probably bound to loopback (the contract
requires all interfaces) — `kubectl -n artifacts-dynamic logs deploy/node-<artifactId>`.

## Alternative to steps 1, 2 and 5: Azure DevOps instead of the laptop

Since Azure DevOps already deploys to this cluster, nothing has to be built or pushed from a laptop:

1. **Platform:** `pipelines/dev-allinone-deploy.yml` builds the four images on the VNet pool (JFrog base
   images, no overrides) and deploys `charts/artifacts-dev-allinone` through the AKS service connection,
   creating the Secret from the `artifacts-dev` variable group's secret variables. Set `DEV_INTAKE_HOST` so
   intake is reachable by hostname — the pipelines and the laptop then need no port-forward, and
   `ARTIFACTS_API_URL=http://<DEV_INTAKE_HOST>` is what `mcp-local` gets.
2. **Artifacts:** the real `artifact-node-deploy.yml` / `artifact-python-deploy.yml` run against the dev
   cluster with `INTAKE_FETCH=1` in their variable group: the Fetch stage reads the job record and bundle
   from intake (`/record`, `/bundle`) instead of Blob. Queue a run by hand with the `jobId` and
   `approvalMode` the dev approval page shows — the scanner runs `PIPELINE_TRIGGER=manual` here because it
   has no Azure identity to queue runs with until workload identity exists:
   ```sh
   az pipelines run --name artifact-node-deploy --parameters jobId=<jobId> approvalMode=<auto|human>
   ```
   With `approvalMode=human` the run waits on the `artifacts-dynamic` Environment's approval check, so D16's
   two Environments (`artifacts-dynamic` with the check, `artifacts-dynamic-auto` without) are exercised for
   real. `scripts/play-node-pipeline.sh` remains the fallback when Azure DevOps is not available.

What this buys over the laptop route: the images come from the registry the platform will use, the approval
is the real Environment check, and the only manual act left is queuing the run with a job id.

## 6. Tear down

```sh
helm -n artifacts-dynamic list -q | xargs -r -n1 helm -n artifacts-dynamic uninstall
helm uninstall artifacts-dev; kubectl delete ns artifacts-dev artifacts-dynamic
```

## What this does not prove

Workload identity, Blob/Service Bus/Key Vault behaviour, Defender for Storage, Entra token verification, APIM
policies, Cowork's egress, TLS, and the Azure DevOps pipelines themselves. Those are I1–I8 and M2's real
criteria, and they start the day the Terraform request lands.
