# cli/ — `artifactctl`

Terminal client for the artifact intake API (`contracts/intake-openapi.yaml`). Used by developers from
Claude Code or a shell, and by `tests/negative.sh`. Cowork users never see it; they use the skill.

```
artifactctl preflight <dir>                                   # runs skill/publish-to-aks/scripts/preflight.sh
artifactctl publish <dir> [--wait] [--interval 10] [--timeout 600] [--json]
artifactctl status <jobId> [--json]
```

`publish` zips `<dir>` deterministically (files at the zip root, byte-order sorted, no directory entries,
symlinks refused), then `POST /v1/publish` with `<dir>/manifest.json`, `PUT` the zip to `uploadUrl` with the
one-time `uploadToken`, `POST .../finalize` with the zip's SHA-256, and with `--wait` polls
`GET /v1/publish/{jobId}` every `--interval` seconds until `rejected`, `awaiting_approval`, `live`, `failed`,
`expired`, or `--timeout` seconds have passed.

Human output is `key value` rows (`state`, `url` and `expires` when live, `run` and `group` when awaiting
approval, `summary`) followed by one `RULE file:line message` line per finding, the same shape `preflight.sh`
prints. `--json` prints the `Status` object from the contract instead, and keeps stderr empty.

A `400` from `beginPublish` (manifest refused before a job exists) is reported as state `rejected` with the
server's findings, or `IN-006` when the server sent none, and an empty `jobId`.

**Publishing a demo bundle (D14/§6.13).** `artifactctl` is tier-agnostic: nothing in `publish`, `status` or
`preflight` branches on `tier`. A demo manifest (`tier: "demo"`, `runtime: "node-20"`, `entrypoint:
"package.json"`) zips and uploads exactly like a static or python one —
`artifactctl publish --wait demo-app/` works as long as `demo-app/manifest.json`, `package.json`,
`package-lock.json` and the rest of the self-contained Node app follow `skill/publish-to-aks/SKILL.md`'s
demo-tier output contract. The one behavioral difference, same as python: a passing scan lands on
`awaiting_approval`, not `live` — `--wait` returns 0 and prints `run`/`group` from `Status.approval`, not a
`url`. There is no `demo`-only flag or subcommand to add.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | `live`, `awaiting_approval`, an in-progress state without `--wait`, or a clean preflight |
| 1 | usage error, local bundle problem (no manifest, symlink, over `maxBytes`), or an API error (401/404/409/413/5xx) |
| 2 | network: DNS, connect, TLS, timeout, or an HTTP 403 from a proxy in front of the API |
| 3 | `rejected`, or preflight found a deny-level rule |
| 4 | `failed`, `expired`, or `--timeout` reached (the job keeps running; check it with `status`) |

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ARTIFACTS_API_URL` | no | Base URL of the intake API. Default `http://localhost:8080`. Production: `https://mcp.corp.com/artifacts`. |
| `ARTIFACTS_TOKEN` | yes, unless `ARTIFACTS_DEV_OID` is set | Bearer for `beginPublish` and `getPublishStatus`. Against a cluster (DEV_AUTH unset) this **must be a real Entra access token** for the `artifacts-mcp` audience — intake-api verifies it itself (T18), APIM no longer derives an identity from it on intake-api's behalf. Get one with `az account get-access-token --resource https://mcp.corp.com/artifacts-mcp/mcp --query accessToken -o tsv` (the Application ID URI; the `artifacts-mcp` app registration's `requestedAccessTokenVersion: 2` makes the resulting token's `aud` the client id, which is what intake-api checks — see `infra/entra/README.md`). Any value against the local dev stack (`DEV_AUTH=1`). |
| `ARTIFACTS_DEV_OID` | no | **Dev-only.** Sent as `X-Publisher-Oid: <oid>` and `X-Publisher-Upn: <oid>@dev`. Only honoured by intake-api under `DEV_AUTH=1`; ignored entirely otherwise, even when present (T18). When set and `ARTIFACTS_TOKEN` is not, the token `dev` is sent. |
| `ARTIFACTS_PREFLIGHT` | no | Path to `preflight.sh`. Default: `skill/publish-to-aks/scripts/preflight.sh` found by walking up from the built file, so a checkout works without configuration. |

Upload and finalize use the one-time `uploadToken` from `beginPublish`, never `ARTIFACTS_TOKEN`. No token is
written to disk or logged.

## Build and run

```
npm --prefix cli ci            # typescript and @types/node only, pinned
npm --prefix cli run build     # tsc → cli/dist/
node cli/dist/artifactctl.js --help
cli/bin/artifactctl.js --help  # same thing through the bin shim (npm link / npx)
```

Node 20 or newer; uses the built-in `fetch`, `node:zlib`, `node:crypto`. No runtime dependencies.

Against the local dev stack (intake on 8080, memory backends; see `intake-api/README.md`):

```
ARTIFACTS_DEV_OID=dev-user node cli/dist/artifactctl.js publish --wait tests/corpus/static-ok
```

## Tests

```
npm --prefix cli test
```

Builds, then runs `node:test` suites under `cli/test/` offline: a zip reader round-trips the deterministic
writer; `readBundle` on corpus bundles; argument and config parsing; output formatting; and `cli.test.ts`,
which drives `run()` end to end against `test/fake-intake.ts`, an in-memory `node:http` implementation of the
contract flow (one-time upload token, hash check at finalize, scripted state sequences). Covered paths: live,
live with info findings, rejected, awaiting_approval, failed, expired, timeout, no `--wait`, 400 at
`beginPublish`, over `maxBytes`, 403 proxy, connection refused, `status`, `preflight`, usage, every exit code.

`test/corpus-fake.ts` starts the same fake as a process with one scenario per `tests/corpus/*/expected.json`;
`tests/lib/selftest.sh` uses it to exercise `tests/negative.sh` without the real intake.

## Not tested here

- Entra tokens and APIM: the fake accepts any bearer. The 403 path is simulated by the fake.
- The real intake-api's exact `Status` payloads; the fake follows the contract, the contract is the agreement.
