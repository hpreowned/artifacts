# intake-api

The publish API from `contracts/intake-openapi.yaml`: begin a job, take the one-time upload, finalize with a
hash, report status, accept pipeline callbacks on `/events`, and mint view tokens for the viewer shell on
`/view-token`. It also hosts the local dev stack (`npm run dev`), which runs this API and the scanner worker
(`../scanner`) in one process on memory backends.

Node 20+, TypeScript strict, no framework: `node:http`, `node:crypto`, `node:test`. The only dependencies are
the Azure SDKs, and every one of them sits behind an interface with a memory or local-disk implementation.

## Run it

```sh
npm ci
npm test        # builds, then node:test; no network, no Azure
npm run dev     # API + worker in one process, DEV_AUTH=1, memory backends, serving from ./.local/serving
npm start       # the API alone (production entrypoint; pair it with `npm start` in ../scanner)
```

`npm run dev` prints the values it generated for `VIEW_TOKEN_KEY`, `PIPELINE_TOKEN` and `INTERNAL_SHARED_KEY`
when they are not in the environment. Export the same `VIEW_TOKEN_KEY` to the static gateway and the viewer
shell so they can verify the tokens this API mints, and `INTERNAL_SHARED_KEY` to the shell so it can call
`/view-token`.

A publish by hand against the dev stack:

```sh
cd ../tests/corpus/static-ok && zip -q -r /tmp/static-ok.zip index.html manifest.json && cd -
BEGIN=$(curl -s -X POST localhost:8080/v1/publish -H 'content-type: application/json' --data @../tests/corpus/static-ok/manifest.json)
JOB=$(echo "$BEGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])')
TOKEN=$(echo "$BEGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["uploadToken"])')
curl -s -X PUT "localhost:8080/v1/publish/$JOB/upload" -H "authorization: Bearer $TOKEN" -H 'content-type: application/zip' --data-binary @/tmp/static-ok.zip
SHA=$(shasum -a 256 /tmp/static-ok.zip | cut -d' ' -f1)
curl -s -X POST "localhost:8080/v1/publish/$JOB/finalize" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"sha256\":\"$SHA\"}"
curl -s "localhost:8080/v1/publish/$JOB"     # → state live, url http://localhost:8082/view/<artifactId>
```

## Operations

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/publish` | Entra `Bearer` token (dev: identity headers) | Validates the manifest against `contracts/manifest.schema.json` (400 with `IN-006` findings). 201 `PublishBegin`. |
| PUT | `/v1/publish/{jobId}/upload` | `Bearer <uploadToken>` | Body is the zip, at most `maxBytes` (25 MiB; 413 is answered before the body is buffered). 201. |
| POST | `/v1/publish/{jobId}/finalize` | `Bearer <uploadToken>` | `{ sha256 }` must equal the stored zip's hash (409 otherwise). Sets `scanning`, enqueues `{ jobId }`. 202 `Status`. |
| GET | `/v1/publish/{jobId}` | Entra `Bearer` token (dev: identity headers) | 404 when unknown **or not owned by the caller's oid**. |
| POST | `/v1/publish/{jobId}/events` | `Bearer ${PIPELINE_TOKEN}` | Transitions per `contracts/states.md`; illegal → 409. Never through APIM. |
| POST | `/v1/view-token` | `X-Internal-Caller: ${INTERNAL_SHARED_KEY}` | Token for a `live`, unexpired artifact; otherwise 404. Never through APIM. |
| GET | `/healthz` | none | `{ ok: true }` |

**Caller identity (T18).** `beginPublish` and `getPublishStatus` are the only two operations that need the
caller's identity (upload and finalize use the one-time `uploadToken` instead, see below). Without `DEV_AUTH=1`
they require `Authorization: Bearer <Entra access token>` and verify it themselves — RS256 signature against
the tenant's JWKS, `iss`, `aud` (`ENTRA_AUDIENCE`), `exp`/`nbf` with 60 s skew, `tid`, and optionally `scp`
(`ENTRA_REQUIRED_SCOPE`) — then take `oid`/`upn` from the token's own claims (`src/entra-token.ts`). There is
no shared key with APIM and nothing new in Key Vault: APIM stays the authorization point (Entra group
membership via `validate-azure-ad-token`) and forwards the caller's bearer unchanged; intake-api checks it
again on its own. `X-Publisher-Oid` / `X-Publisher-Upn` are never read in this mode, even when present —
they are not trusted input, since anything on the VNet that can reach the `intake` listener could set them.
Starting without `DEV_AUTH=1` and without both `ENTRA_TENANT_ID` and `ENTRA_AUDIENCE` set refuses to start.

With `DEV_AUTH=1` (`npm run dev`, tests), today's behaviour is unchanged: `X-Publisher-Oid`/`X-Publisher-Upn`
are honoured when present, a fixed dev identity (`DEV_PUBLISHER_OID`/`DEV_PUBLISHER_UPN`) is used when absent,
and any bearer is accepted — a warning is logged on startup. Never set `DEV_AUTH=1` in production.

intake-api needs egress to `login.microsoftonline.com` to fetch the tenant's OpenID discovery document and
JWKS the first time it verifies a token, and again (at most once a minute) when an unrecognised `kid` arrives.

**One-time upload token.** 256 random bits, returned once by `beginPublish`, stored only as a SHA-256 hash on
the job. Valid 10 minutes, bound to its job, accepted once for `PUT /upload` and once more for `POST /finalize`,
then dead. A job still `awaiting_upload` after 10 minutes becomes `expired` (on read, and by a sweeper every
`UPLOAD_EXPIRY_SWEEP_SECONDS`).

**View token** (`src/signed-token.ts`, shared verbatim with the gateway and shell):
`base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, base64url(payloadJson)))`, key = `VIEW_TOKEN_KEY`
base64-decoded, constant-time compare, rejected past `exp`. Payload
`{"t":"view","aid":"<artifactId>","oid":"<viewerOid>","exp":<now+300>}`.

`POST /v1/view-token` also returns `artifactExpiresAt`, the job record's `expiresAt` (the artifact's TTL, not
the token's 5-minute `expiresAt`), so the shell can show "Expires &lt;date&gt;" in its banner.
`contracts/intake-openapi.yaml`'s `createViewToken` response documents it as optional.

## Job record and stores

`src/job.ts` is the record: `jobId` (`job_` + 20 lowercase alnum), `artifactId` (12 lowercase alnum, assigned
at begin, becomes the artifact subdomain), `ownerOid`, `ownerUpn`, `manifest`, `tier`, `state`, `createdAt`,
`updatedAt`, `expiresAt` (`createdAt + ttlDays`), `uploadTokenHash`, `uploadTokenUses`, `uploadExpiresAt`,
`sha256`, `findings[]`, `runUrl?`, `summary?`, `url?`. `toStatus()` projects it onto the OpenAPI `Status`.

| Interface (`src/stores/types.ts`) | `BACKEND=memory` | `BACKEND=azure` |
|---|---|---|
| `JobStore` | in-process map | Blob container `jobs`: `<jobId>.json`, `by-artifact/<artifactId>` |
| `BundleStore` | in-process map | Blob container `intake`: `<jobId>.zip` (what Defender scans) |
| `ServingStore` | `SERVE_ROOT/<artifactId>/<files>` | Blob container `serving`: `<artifactId>/<file>` |
| `ScanQueue` | in-process, in order | Service Bus queue `SCAN_QUEUE`, peek-lock, one at a time |

The Azure implementations authenticate with `DefaultAzureCredential` (workload identity in the cluster,
`az login` on a laptop).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Prefix of `uploadUrl` in `PublishBegin` (the APIM-facing URL in production). |
| `SHELL_ORIGIN` | `http://localhost:8082` | Live artifact URL is `${SHELL_ORIGIN}/view/${artifactId}`. |
| `DEV_AUTH` | unset | `1` trusts the identity headers as-is, substitutes a dev identity when absent, accepts any bearer. |
| `DEV_PUBLISHER_OID` / `DEV_PUBLISHER_UPN` | `dev-oid` / `dev@localhost` | The dev identity used under `DEV_AUTH=1` when headers are absent. |
| `ENTRA_TENANT_ID` | required unless `DEV_AUTH=1` | Tenant whose `v2.0/.well-known/openid-configuration` and JWKS verify the bearer; also checked against the token's `tid`. |
| `ENTRA_AUDIENCE` | required unless `DEV_AUTH=1` | The `artifacts-mcp` app registration's **client id** (not its Application ID URI — v2 tokens carry `aud = <client id>`, DESIGN §6.10). Checked against the token's `aud`. |
| `ENTRA_REQUIRED_SCOPE` | `artifacts.publish` | Checked against the token's space-separated `scp` claim. Set to an empty string to disable the check. |
| `PIPELINE_TOKEN` | unset (→ `/events` answers 401) | Bearer the Azure DevOps pipeline presents on `/events`. From Key Vault in production. |
| `INTERNAL_SHARED_KEY` | unset (→ `/view-token` answers 401) | `X-Internal-Caller` value the viewer shell presents. |
| `VIEW_TOKEN_KEY` | random per process (warned) | Base64 of at least 32 key bytes for view-token HMACs. Must match the gateway and shell. |
| `BACKEND` | `memory` | `memory` or `azure`. |
| `SERVE_ROOT` | `./.local/serving` | Local serving directory for `BACKEND=memory`. |
| `APPROVER_GROUP` | `artifacts-approvers` | Reported in `Status.approval.group`. |
| `UPLOAD_EXPIRY_SWEEP_SECONDS` | `60` | How often `awaiting_upload` jobs past their window are expired. |
| `STORAGE_ACCOUNT_URL` | required for `azure` | `https://<account>.blob.core.windows.net`. |
| `STORAGE_CONTAINER_JOBS` / `_INTAKE` / `_SERVING` | `jobs` / `intake` / `serving` | Container names. |
| `SERVICEBUS_FQDN` | required for `azure` | `<namespace>.servicebus.windows.net`. |
| `SCAN_QUEUE` | `scan` | Service Bus queue name. |
| `REPO_ROOT` | derived from the build layout | Where `contracts/`, `scanner/imports.py` and `tests/` are found; set it in containers. |
| `MANIFEST_SCHEMA` | `${REPO_ROOT}/contracts/manifest.schema.json` | Override the schema path. |
| `AZURE_CLIENT_ID` etc. | – | Read by `DefaultAzureCredential` when `BACKEND=azure`. |

The worker's variables (`GITLEAKS_BIN`, `PYTHON_BIN`, `RUNTIME_MANIFEST`, `DEFENDER_*`, `GC_INTERVAL_SECONDS`,
`PIPELINE_TRIGGER`, `ADO_*`, `INTAKE_INTERNAL_URL`) are read by the same `src/config.ts` and documented in
`../scanner/README.md`; `npm run dev` honours all of them. One addition for the demo tier (D14/§6.13):
`ADO_DEMO_PIPELINE_ID` sits next to `ADO_PIPELINE_ID` — the python-tier run id is still `ADO_PIPELINE_ID`,
the demo-tier run id (`artifact-demo-deploy`) is `ADO_DEMO_PIPELINE_ID`. With `PIPELINE_TRIGGER=ado`, both are
required at startup, same as `ADO_ORG`/`ADO_PROJECT`/`ADO_PIPELINE_ID` always were; `PIPELINE_TRIGGER=fake`
(the default off `BACKEND=memory`) needs neither. Which pipeline id a given job actually posts to is the
trigger implementation's call (`cfg.worker.ado.pipelineId` vs `.demoPipelineId`, picked by `job.tier`), not
this config module's — see `../scanner/README.md` for how the real Azure DevOps trigger uses it.

## Layout

`src/main.ts` (API alone) and `src/dev.ts` (API + worker) are the entrypoints; `src/stack.ts` is the composition
both the dev stack and the end-to-end test use. `src/server.ts` routes to `src/routes/{publish,upload,internal}.ts`.
`src/manifest-validator.ts` is a deliberately small JSON Schema validator covering exactly the keywords
`contracts/manifest.schema.json` uses; an unknown keyword throws at load so a contract change cannot pass
unvalidated. `src/entra-token.ts` (T18) verifies Entra bearer tokens — discovery and JWKS fetch behind a
`DiscoverySource` interface, the real one in the same file, a fake one in `src/test/entra-fixture.ts` — and
`src/auth.ts` calls it from `beginPublish`/`getPublishStatus` when `DEV_AUTH` is unset. Both packages compile
with `rootDir: ".."` so each `dist/` carries the other package's sources it imports; that is why entrypoints
live at `dist/intake-api/src/*.js`.

## Container

```sh
docker build -f intake-api/Dockerfile -t intake-api:dev .   # from the REPO ROOT, not this directory
docker run --rm -p 8080:8080 --read-only \
  -e BACKEND=azure -e STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net \
  -e SERVICEBUS_FQDN=<namespace>.servicebus.windows.net \
  -e PIPELINE_TRIGGER=fake \
  -e PUBLIC_BASE_URL=https://mcp.corp.com/artifacts -e SHELL_ORIGIN=https://artifacts.corp.com \
  -e VIEW_TOKEN_KEY="$VIEW_TOKEN_KEY" -e PIPELINE_TOKEN="$PIPELINE_TOKEN" -e INTERNAL_SHARED_KEY="$INTERNAL_SHARED_KEY" \
  intake-api:dev
```

Multi-stage on `jfrog.corp.com/docker/node:20-slim` (placeholder registry path), mirroring `../viewer-shell/Dockerfile`'s
shape. The build context is the **repo root**, not `intake-api/`: `tsconfig.json`'s `include` pulls in
`../scanner/src` (imported by `src/stack.ts`, the combined dev-stack composition), so the build stage runs
`npm ci` in both `intake-api/` and `scanner/` and type-checks both; nothing from `scanner/` is copied into the
final image. The final stage also gets `contracts/manifest.schema.json` (`src/manifest-validator.ts` reads it)
and `ENV REPO_ROOT=/app`, since `src/repo-root.ts`'s own path-climbing default assumes the uncontained repo
layout. Because the build context isn't this directory, the ignore file is `Dockerfile.dockerignore` here
(Docker's convention for a non-default context: see that file's header) rather than a plain `.dockerignore`.

The final stage runs as `USER 65532:65532`, `CMD` is exec form, and no code path in this package ever writes
to disk at run time: `src/stores/select.ts`'s `LocalServingStore` (the only thing in this package that touches
the filesystem) is constructed but never called by `src/main.ts`'s routes — publishing files is the scanner
worker's job, in its own container. So the image runs with `readOnlyRootFilesystem: true` and no writable
volumes. `BACKEND=azure` also pulls in the worker's config validation (shared `src/config.ts`), which defaults
`PIPELINE_TRIGGER` to `ado` and then requires `ADO_ORG`/`ADO_PROJECT`/`ADO_PIPELINE_ID`/`ADO_DEMO_PIPELINE_ID`;
pass `PIPELINE_TRIGGER=fake` if those aren't set, even though this image's own entrypoint never triggers a
pipeline.

Not executed here: no Docker daemon on the authoring machine. The two build-stage `npm ci` steps, the `tsc`
build, `npm prune --omit=dev`, and the assembled final-stage layout (package.json, pruned node_modules,
`dist/intake-api/src`, `contracts/manifest.schema.json`, `REPO_ROOT=/app`) were verified by hand: reproducing
each `COPY` outside Docker, then running `node dist/intake-api/src/main.js` against that tree answered
`GET /healthz` with `{"ok":true}` and `POST /v1/publish` with a schema-validated `400`/`IN-006`, proving the
schema file and the module layout resolve correctly. `docker build` itself is unverified.

## Tests

`src/test/api.test.ts` covers every operation and response code in the OpenAPI document, the single-use token,
hash mismatch, ownership, the 10-minute window and every `/events` transition, plus (T18) a strict-mode block
with an in-test Entra token: no token → 401, headers alone → 401, a valid token with a forged `X-Publisher-Oid`
alongside it → identity from the token, header ignored, and bad signature / wrong audience / expired → 401;
a separate test asserts the server refuses to start without `ENTRA_TENANT_ID`/`ENTRA_AUDIENCE` when `DEV_AUTH`
is unset. `src/test/entra-token.test.ts` unit-tests `entra-token.ts` directly against an in-test RSA key pair
and a fake JWKS (`src/test/entra-fixture.ts`): every typed failure reason, the upn fallback chain, and the
unknown-`kid` refresh capped at once a minute. `src/test/e2e.test.ts` runs the dev-stack composition over HTTP
(always `DEV_AUTH=1`): `static-ok` → `live` with a mintable view token, `static-fetch` → `live` with
`HTML-009`, `static-secret` → `rejected` with `SEC-001` (no gitleaks installed), `python-ok` → `awaiting_approval`
through the fake pipeline's `/events` call, a forced `Malicious` Defender result → `MAL-001`.
`src/test/signed-token.test.ts` pins the token format byte for byte.

## Untested because it needs Azure

`src/stores/blob.ts` and `src/stores/servicebus.ts` compile and follow the SDK documentation but have never
run against a storage account or namespace: container existence, `ifNoneMatch: "*"` on job creation, the
`by-artifact/` index blobs, peek-lock redelivery after a thrown handler, and `DefaultAzureCredential` under
workload identity. `BlobBundleStore.put` deliberately sets no metadata after upload (DESIGN §6.11).

## Known gaps

- `beginPublish` rejects an invalid manifest with 400 before a job exists, so `tests/corpus/static-bad-manifest`
  never gets a job id. The worker also emits `IN-006` for an invalid `manifest.json` inside the bundle (covered by
  the scanner's corpus test). `tests/negative.sh` should treat a 400 with `IN-006` findings as the expected
  `rejected`.
- Rate limiting (429) is APIM's job; this service does not implement it.
