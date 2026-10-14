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
| POST | `/v1/publish` | caller identity headers | Validates the manifest against `contracts/manifest.schema.json` (400 with `IN-006` findings). 201 `PublishBegin`. |
| PUT | `/v1/publish/{jobId}/upload` | `Bearer <uploadToken>` | Body is the zip, at most `maxBytes` (25 MiB; 413 is answered before the body is buffered). 201. |
| POST | `/v1/publish/{jobId}/finalize` | `Bearer <uploadToken>` | `{ sha256 }` must equal the stored zip's hash (409 otherwise). Sets `scanning`, enqueues `{ jobId }`. 202 `Status`. |
| GET | `/v1/publish/{jobId}` | caller identity headers | 404 when unknown **or not owned by the caller's oid**. |
| POST | `/v1/publish/{jobId}/events` | `Bearer ${PIPELINE_TOKEN}` | Transitions per `contracts/states.md`; illegal → 409. Never through APIM. |
| POST | `/v1/view-token` | `X-Internal-Caller: ${INTERNAL_SHARED_KEY}` | Token for a `live`, unexpired artifact; otherwise 404. Never through APIM. |
| GET | `/healthz` | none | `{ ok: true }` |

Caller identity is `X-Publisher-Oid` / `X-Publisher-Upn`, set by APIM after Entra validation. Without
`DEV_AUTH=1` both headers are required (401 otherwise). With `DEV_AUTH=1` the headers are honoured when present
and a fixed dev identity (`DEV_PUBLISHER_OID`/`DEV_PUBLISHER_UPN`) is used when absent; any bearer is accepted.

**One-time upload token.** 256 random bits, returned once by `beginPublish`, stored only as a SHA-256 hash on
the job. Valid 10 minutes, bound to its job, accepted once for `PUT /upload` and once more for `POST /finalize`,
then dead. A job still `awaiting_upload` after 10 minutes becomes `expired` (on read, and by a sweeper every
`UPLOAD_EXPIRY_SWEEP_SECONDS`).

**View token** (`src/signed-token.ts`, shared verbatim with the gateway and shell):
`base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, base64url(payloadJson)))`, key = `VIEW_TOKEN_KEY`
base64-decoded, constant-time compare, rejected past `exp`. Payload
`{"t":"view","aid":"<artifactId>","oid":"<viewerOid>","exp":<now+300>}`.

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
`../scanner/README.md`; `npm run dev` honours all of them.

## Layout

`src/main.ts` (API alone) and `src/dev.ts` (API + worker) are the entrypoints; `src/stack.ts` is the composition
both the dev stack and the end-to-end test use. `src/server.ts` routes to `src/routes/{publish,upload,internal}.ts`.
`src/manifest-validator.ts` is a deliberately small JSON Schema validator covering exactly the keywords
`contracts/manifest.schema.json` uses; an unknown keyword throws at load so a contract change cannot pass
unvalidated. Both packages compile with `rootDir: ".."` so each `dist/` carries the other package's sources it
imports; that is why entrypoints live at `dist/intake-api/src/*.js`.

## Tests

`src/test/api.test.ts` covers every operation and response code in the OpenAPI document, the single-use token,
hash mismatch, ownership, the 10-minute window and every `/events` transition. `src/test/e2e.test.ts` runs the
dev-stack composition over HTTP: `static-ok` → `live` with a mintable view token, `static-fetch` → `live` with
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
