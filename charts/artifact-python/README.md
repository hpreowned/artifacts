# charts/artifact-python

Helm chart for one Python artifact (DESIGN §6.6, §6.12, D13). One release per artifact, name `art-<artifactId>`,
namespace `artifacts-dynamic`. Renders a ConfigMap (the app's `app.py`), a Deployment with the exact §6.6
security posture, a Service on 8080, and an HTTPRoute for `<artifactId>.<artifactDomain>` attached to the
`artifacts-internal` Gateway in `artifacts-system`.

Replaces the old `deploy/python-artifact/template.yaml` + `render.sh` (removed).

## Values

| Key | Required | Meaning |
|---|---|---|
| `artifactId` | yes | 12 lowercase alphanumeric chars (`contracts/intake-openapi.yaml` `ArtifactId`). Validated with `fail` — a bad value cannot render anything. |
| `appPy` | yes | Contents of `app.py`. Always set with `--set-file appPy=<path>`, never inline. |
| `expiresAt` | yes | RFC 3339 UTC, e.g. `2026-10-28T00:00:00Z`. Stored on labels/annotations as `2026-10-28T00-00-00Z` (`:` → `-`, matching `render.sh`'s old form so text comparison still orders correctly). |
| `entrypoint` | yes | `streamlit` or `fastapi`. Validated with `fail`. Maps to the exact arg lists in `tests/runtime-manifest.python-1.json`. |
| `image` | yes | Digest-pinned: `jfrog.corp.com/artifacts/python-runtime@sha256:<64 hex>`. Validated with `fail`. |
| `jobId` | no | Job id this release was deployed for; only used for the `artifacts.corp.com/job` label. |
| `domain.artifactDomain` | no | Default `corp-artifacts.net`. The HTTPRoute hostname is `<artifactId>.<artifactDomain>`. |
| `gateway.*` | no | Defaults to `artifacts-internal` / `artifacts-system` / `content`, matching `deploy/gateway.yaml`. |
| `service.port` | no | Default 8080. |
| `resources`, `tmp.sizeLimit` | no | Defaults match DESIGN §6.6 exactly. |

## Labels on every object

`artifacts.corp.com/id`, `artifacts.corp.com/expires-at`, `artifacts.corp.com/job`, `app.kubernetes.io/managed-by: Helm`.
The Deployment additionally carries `artifacts.corp.com/expires-at` as an **annotation** (same value), so
`pipelines/artifact-gc.yml` can read expiry from `helm get manifest` without a `kubectl get` / pod query —
`helm get metadata` does not surface per-release custom fields, only chart-level ones.

## Render and install

```bash
helm template art-<artifactId> charts/artifact-python \
  --set artifactId=<artifactId> \
  --set-file appPy=<bundle>/app.py \
  --set expiresAt=<RFC3339> \
  --set entrypoint=<streamlit|fastapi> \
  --set image=<digest-pinned image> \
  --set jobId=<jobId>

helm upgrade --install art-<artifactId> charts/artifact-python --namespace artifacts-dynamic ... --wait --timeout 3m
```

## Testing

- `helm lint charts/artifact-python` (needs the required `--set`/`--set-file` values above; the chart has no
  usable defaults on purpose, so a lint with no values will fail the `fail()` validations — that is the
  point, not a bug).
- `charts/tests/artifact-conformance.sh` — renders twice (streamlit, fastapi), asserts every DESIGN §6.6
  field, the labels, probe ports, HTTPRoute hostname, and that a bad `artifactId`/`entrypoint` is refused.
  No cluster needed.

## Untested without a cluster

`helm upgrade --install ... --wait` actually rolling out, the Gateway routing real traffic to the Service,
and NetworkPolicy/PSA interaction with the rendered pod — all need the AKS cluster and are out of scope for
this pass (no `kubectl`, no cluster available while authoring this).
