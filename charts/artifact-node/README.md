# charts/artifact-node

Helm chart for one node-tier artifact (DESIGN D14, §6.13, D13). One release per prototype, name
`node-<artifactId>`, namespace `artifacts-dynamic`. Renders a Deployment with the Python tier's exact
security posture, a Service on 8080, and an HTTPRoute for `<artifactId>.<artifactDomain>` attached to the
`artifacts-internal` Gateway in `artifacts-system` -- with a `ResponseHeaderModifier` filter injecting the
§6.13 `Content-Security-Policy` and an `X-Prototype-Expires` header.

Unlike `charts/artifact-python`, the app is **baked into the image** (`node-runtime/Dockerfile` +
the bundle, built per-prototype by `pipelines/artifact-node-deploy.yml`), not mounted from a ConfigMap -- so
this chart has no `appPy`-equivalent value and no `code`/ConfigMap volume. What it adds instead is
`writablePaths`: every directory the app needs to write to at runtime becomes its own `emptyDir`, shadowing
the (read-only) baked copy.

## Values

| Key | Required | Meaning |
|---|---|---|
| `artifactId` | yes | 12 lowercase alphanumeric chars (`contracts/intake-openapi.yaml` `ArtifactId`). Validated with `fail`. |
| `expiresAt` | yes | RFC 3339 UTC, e.g. `2026-10-28T00:00:00Z`. On labels/annotations as `2026-10-28T00-00-00Z` (`:` → `-`); unchanged on `PROTOTYPE_EXPIRES_AT` and the `X-Prototype-Expires` header. |
| `image` | yes | Digest-pinned and tied to this release's own `artifactId`: `jfrog.corp.com/artifacts/node-<artifactId>@sha256:<64 hex>`. Validated with `fail` -- a tag-only reference, or a digest built for a different artifactId, cannot render. |
| `jobId` | no | Job id this release was deployed for; only used for the `artifacts.corp.com/job` label. |
| `writablePaths` | no | List of absolute paths; default `["/app/data", "/tmp"]`. Each becomes its own `emptyDir` volume + mount, sized by `writablePathSizeLimit`. A relative entry, or an empty list, is refused with `fail`. |
| `writablePathSizeLimit` | no | Default `128Mi`, applied to every `writablePaths` entry. |
| `shellOrigin` | no | Default `https://artifacts.corp.com`. The viewer shell's origin; becomes the CSP's `frame-ancestors` value (only the shell is allowed to iframe a node prototype). |
| `domain.artifactDomain` | no | Default `corp-artifacts.net`. The HTTPRoute hostname is `<artifactId>.<artifactDomain>`. |
| `gateway.*` | no | Defaults to `artifacts-internal` / `artifacts-system` / `content`, matching `charts/artifact-python`. |
| `service.port` | no | Default 8080. |
| `resources` | no | Defaults match the Python tier's DESIGN §6.6 pod spec exactly. |

## Labels and annotations on every object

`artifacts.corp.com/id`, `artifacts.corp.com/expires-at`, `artifacts.corp.com/job`,
`app.kubernetes.io/managed-by: Helm` -- identical set to `charts/artifact-python`. The Deployment also
carries `artifacts.corp.com/expires-at` as an **annotation**, so `pipelines/artifact-gc.yml` can read expiry
straight from `helm get manifest prototype-<id> -n artifacts-dynamic` the same way it already does for `art-*`
releases, with no `kubectl get` / pod query.

## Content-Security-Policy

Exactly DESIGN §6.13's string, with `frame-ancestors` filled in from `.Values.shellOrigin`:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
connect-src 'self'; frame-ancestors <shellOrigin>; form-action 'self'; base-uri 'none'; object-src 'none'
```

Set at the Gateway, not in application code, via an HTTPRoute `ResponseHeaderModifier` filter
(`gateway.networking.k8s.io/v1`, the same `apiVersion` every other HTTPRoute in this repo uses). The filter
also sets `X-Prototype-Expires: <expiresAt>` so the browser/shell can show the countdown without a round trip to
the app.

## Render and install

```bash
helm template node-<artifactId> charts/artifact-node \
  --set artifactId=<artifactId> \
  --set expiresAt=<RFC3339> \
  --set image=jfrog.corp.com/artifacts/node-<artifactId>@sha256:<digest> \
  --set jobId=<jobId>

helm upgrade --install node-<artifactId> charts/artifact-node --namespace artifacts-dynamic ... --wait --timeout 3m
```

## Testing

- `helm lint charts/artifact-node` (needs the required `--set` values above; no usable defaults for
  `artifactId`/`expiresAt`/`image` on purpose, same reasoning as `charts/artifact-python`).
- `charts/tests/node-conformance.sh` -- renders with a fake digest image under both default and custom
  `writablePaths`, asserts every security field, the emptyDir mounts, the CSP filter (including
  `connect-src 'self'`), labels/annotation, probe ports, and that a bad `artifactId`, missing `expiresAt`,
  or tag-only image is refused. No cluster needed.

## Untested without a cluster

`helm upgrade --install ... --wait` actually rolling out, the Gateway applying the `ResponseHeaderModifier`
filter to real responses, and NetworkPolicy/PSA interaction with the rendered pod -- all need the AKS
cluster and are out of scope for this pass (no `kubectl`, no cluster available while authoring this).
