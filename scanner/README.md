# scanner

The scan worker. One queue message `{ jobId }` per finalized upload; the worker loads the job, downloads the
zip, runs the stages from DESIGN §5 in order, decides with `src/policy.ts`, and then either copies the files to
the serving store (static) or triggers the Azure DevOps deploy pipeline (python). Every exit writes a one-paragraph
`summary` for Cowork to relay. One maintenance loop expires static artifacts past their TTL and fails python jobs
whose deploy pipeline never reported back (`src/gc.ts`, `src/python-timeout.ts`). `GET /healthz` answers for
Kubernetes (`src/health.ts`); the worker exposes no other API.

Node 20+, TypeScript strict, `node:test`. Python 3.10+ (`python3` on `PATH`, or `PYTHON_BIN`) is needed at run
time for the Python stage; it uses only the standard library. gitleaks is optional (see SEC below).

## Run it

```sh
npm ci
npm test       # builds, then node:test; no network, no Azure, no gitleaks needed
npm start      # the worker alone, consuming the queue chosen by BACKEND (production entrypoint)
```

For a laptop, run `npm run dev` in `../intake-api` instead: it runs this worker in the same process as the API
on an in-process queue. A standalone `BACKEND=memory` worker has its own empty queue and is only useful for
smoke-testing the startup path.

## Stages and rules

| Stage | File | Rules | Notes |
|---|---|---|---|
| intake | `src/extract.ts`, `src/worker.ts` | IN-001 … IN-005, IN-009 | Own strict zip reader (`src/zip-read.ts`): central-directory driven, store/deflate only, no zip64, CRC checked, output capped. Zip-slip, duplicate (case-insensitive) paths, symlinks and special files are refused before anything is written. A bundle that inflates past 100 MiB is reported under IN-001. A zip that cannot be parsed at all — bad signature, bad central directory, truncated, bad CRC — throws `ZipError`, caught in `worker.ts` and reported as IN-009 (distinct from IN-001, which is specifically "too big"). |
| intake | `src/intake-checks.ts` | IN-006, IN-007, IN-008 | `manifest.json` must validate against `contracts/manifest.schema.json` and agree with the submitted manifest on `tier`, `entrypoint`, `runtime`. Any intake `deny` stops the run: later stages would be noise on a broken bundle. |
| secrets | `src/secrets.ts` | SEC-001, SEC-000 | gitleaks (`GITLEAKS_BIN`, `detect --no-git --report-format json`) **plus** a built-in pattern pack (AWS access key ids, Azure storage account keys, SAS `sig=`, GitHub tokens, private key headers, JWTs) that always runs, so `static-secret` is rejected offline. Missing or failing gitleaks → `SEC-000` (warn) and a loud log line. Messages never echo the matched value. |
| malware | `src/defender.ts` | MAL-001, MAL-002 | `DefenderReader` interface. Fake: `No threats found` unless the job id is in `DEFENDER_FAKE_MALICIOUS`. Real: polls the blob index tag on `intake/<jobId>.zip` every `DEFENDER_POLL_SECONDS` up to `DEFENDER_TIMEOUT_SECONDS`. The tag key is matched case-insensitively on "ends with `scan result`", so it accepts both Microsoft's current key (`Scan result`) and the older key some docs/portal versions still show (`Malware Scanning scan result`) — whichever one your storage account's Defender for Storage plan actually writes. `Malicious` → MAL-001 (rejected). `No threats found` → continue. Any other value — `Error`, `Not scanned`, a value from neither key found, or a poll timeout — → MAL-002 and state `failed` (never auto-allow). The wait overlaps the other stages. |
| html | `src/checks.ts`, `src/html-parse.ts` | HTML-001 … HTML-009 | Dependency-free tokenizer: start tags with attributes, script bodies, comments skipped outside script/style. Runs on `.html` and `.svg` (inline `<script>` executes when an SVG is opened as a document); script rules also run on `.js`. HTML-001 compares every external `<script src>` to the manifest `externalScripts` and the CDN pattern from the manifest schema; a `<base href>` to another host is also HTML-001. HTML-002 covers `action` and `formaction` with any scheme or host. HTML-006 flags `eval(`, `new Function(`, `document.write(`/`writeln(` unless every argument is a string literal. HTML-007 is a linear scan for runs ≥ 64 KiB of base64/base64url/hex characters inside scripts. |
| python | `imports.py`, `src/python-stage.ts` | PY-001, PY-002, PY-003, PY-005, PY-006 | `python3 imports.py <dir> <runtime-manifest.json>` parses every `.py` with `ast` (never imports or executes it) and prints JSON findings. Allowlist = `sys.stdlib_module_names` ∪ `modules` from the runtime manifest ∪ top-level modules and packages in the bundle; relative imports are local. PY-002 covers `subprocess`, `socket`, `ctypes`, `pickle`, `marshal`, `importlib`, `multiprocessing`, `os.system`/`exec*`/`fork*`/`spawn*`/`posix_spawn*`/`popen` in any alias or `from os import` spelling, and `eval`/`exec`/`__import__`/`compile`. PY-003 resolves literal paths, module-level string constants, `os.path.join`, `Path(...) / ...` and `tempfile.*`; a write with an unresolvable path is denied with a message saying so. A file that does not parse (a `SyntaxError` or `ValueError` from `ast.parse`) is PY-006, not PY-001 — imports genuinely could not be checked, which is a different claim than "this import is disallowed". |
| python | `src/checks.ts` | PY-004 | `requirements.txt`, `pyproject.toml`, `setup.py`, `*.whl`, `*.tar.gz` anywhere in the bundle. |
| verdict | `src/policy.ts` | all | The one rule → severity table; `src/test/policy.test.ts` parses `contracts/findings.md` and fails if they differ. Any `deny` → `rejected` with every finding. |
| publish | `src/worker.ts` | – | static: `deploying` → copy to the serving store → `live`, `url = ${SHELL_ORIGIN}/view/${artifactId}`, intake bundle deleted. python: job stays `scanning`, `triggerPythonDeploy(jobId)` is called and `runUrl` stored; the pipeline moves it on through `/events`. Trigger failure → `failed`. |
| gc | `src/gc.ts`, `src/python-timeout.ts` | – | Every `GC_INTERVAL_SECONDS`, one timer runs two sweeps: `live` static jobs past `expiresAt` are removed from the serving store and set `expired` (python TTL expiry belongs to the `artifact-gc` pipeline); and every `scanning` python job with a `runUrl` whose `updatedAt` is older than `PIPELINE_TIMEOUT_HOURS` is set `failed` with a finding-free summary naming the run URL (contracts/states.md: the pipeline reached the approval check, or later, and then never called `/events` back). |
| health | `src/health.ts` | – | `GET /healthz` on `HEALTH_PORT` answers `200 {"ok":true,"queue":"<memory\|servicebus>"}` normally and `503` once shutdown begins (SIGINT/SIGTERM). `deploy/platform/scanner-worker.yaml` probes it; no other endpoint exists. |

`SEC-000` is the one rule id not in `contracts/findings.md` (reported in the final report). `multiprocessing`,
`os.popen`, `document.writeln(` and `<base href>` are extra triggers under existing rule ids, not new rules.

## Pipeline trigger

`src/pipeline.ts`. `PipelineTrigger.triggerPythonDeploy(jobId) → { runUrl }`.

- Fake (`PIPELINE_TRIGGER=fake`, the default for `BACKEND=memory`): returns `http://localhost/fake-run/<jobId>`
  and, when `PIPELINE_TOKEN` is set, posts `{ state: "awaiting_approval", runUrl }` to
  `${INTAKE_INTERNAL_URL}/v1/publish/<jobId>/events` exactly as the real pipeline's Fetch stage does.
- Azure DevOps (`PIPELINE_TRIGGER=ado`, the default for `BACKEND=azure`): `POST
  https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/pipelines/${ADO_PIPELINE_ID}/runs?api-version=7.1`
  with `{ templateParameters: { jobId } }`, bearer from `DefaultAzureCredential` for scope
  `499b84ac-1321-427f-aa17-267ca6975798/.default`. `runUrl` is `_links.web.href`.

## Environment variables

Read by `../intake-api/src/config.ts` (shared), together with the API's own variables documented there
(`BACKEND`, `STORAGE_*`, `SERVICEBUS_FQDN`, `SCAN_QUEUE`, `SERVE_ROOT`, `SHELL_ORIGIN`, `APPROVER_GROUP`,
`PIPELINE_TOKEN`, `REPO_ROOT`).

| Variable | Default | Meaning |
|---|---|---|
| `GITLEAKS_BIN` | `gitleaks` | Path to the gitleaks binary. Absent → `SEC-000` warning, built-in pack only. |
| `PYTHON_BIN` | `python3` | Interpreter for `imports.py` (3.10+). |
| `IMPORTS_SCRIPT` | `${REPO_ROOT}/scanner/imports.py` | Path to the Python stage script. |
| `RUNTIME_MANIFEST` | `${REPO_ROOT}/tests/runtime-manifest.python-1.json` | Curated runtime manifest; its `modules` extend the import allowlist. |
| `DEFENDER_TIMEOUT_SECONDS` | `60` | How long to wait for a Defender result before MAL-002. |
| `DEFENDER_POLL_SECONDS` | `2` | Tag polling interval. |
| `DEFENDER_FAKE_MALICIOUS` | empty | Comma-separated job ids the fake reader reports as `Malicious`. |
| `GC_INTERVAL_SECONDS` | `600` | Interval of the one maintenance timer: static-tier GC and the python pipeline-timeout sweep both run on it. |
| `PIPELINE_TIMEOUT_HOURS` | `24` | A `scanning` python job with a `runUrl` whose `updatedAt` is older than this is set `failed` (contracts/states.md). Read directly from `process.env` by `src/main.ts`, not by `../intake-api/src/config.ts` — it is scanner-only. |
| `HEALTH_PORT` | `8081` | Port for `GET /healthz` (`src/health.ts`). Read directly from `process.env` by `src/main.ts`, scanner-only; `deploy/platform/scanner-worker.yaml` probes this port. |
| `PIPELINE_TRIGGER` | `fake` for memory, `ado` for azure | `fake` or `ado`. |
| `ADO_ORG`, `ADO_PROJECT`, `ADO_PIPELINE_ID` | required for `ado` | The deploy pipeline (DESIGN §6.12). |
| `INTAKE_INTERNAL_URL` | `http://localhost:${PORT}` | Where the fake trigger posts `awaiting_approval`. |
| `AZURE_CLIENT_ID` etc. | – | Read by `DefaultAzureCredential` for Blob, Service Bus and Azure DevOps. |

## Tests

`npm test` runs `src/test/*.test.ts`: every `tests/corpus/*` bundle is zipped in the test and pushed through the
worker on memory backends, asserting the exact `state` and every rule in `expected.json` (`static-fetch`,
`static-navigate` and `static-ok` reach `live` with files in a temp serving root; `python-ok` reaches
`awaiting_approval` through the fake pipeline). Separate suites cover the zip limits with hostile archives
(zip-slip, symlinks, fifos, 501 files, 25 MiB + 1, a 101 MiB inflate), every HTML rule including literal versus
non-literal arguments and line numbers, the secret patterns (assembled at run time, never literal in the repo),
gitleaks report parsing through a stand-in script, each Python rule in several spellings, the Defender tag poller
with a stub container (appears, times out, errors, both the current and the legacy tag key spelling), both
pipeline triggers with a stub `fetch`, GC, the python pipeline-timeout sweep with an injectable clock
(`src/test/python-timeout.test.ts`: a 25h-old `scanning` python job with a `runUrl` fails, a 1h-old one does
not, a python job without a `runUrl` yet is left alone, a `scanning` static job is untouched regardless of
age), and the health endpoint (`src/test/health.test.ts`: 200 while up, 503 once marked down, 404 on anything
but `GET /healthz`).

## Build (Docker)

```sh
# from the repo root, not from scanner/ — see the comment at the top of scanner/Dockerfile for why
docker build -f scanner/Dockerfile \
  --build-arg GITLEAKS_VERSION=8.21.2 \
  --build-arg GITLEAKS_SHA256=<sha256 of gitleaks_8.21.2_linux_x64.tar.gz> \
  -t scanner:dev .
docker run --rm -p 8081:8081 --read-only --tmpfs /tmp -e BACKEND=memory scanner:dev
curl localhost:8081/healthz   # {"ok":true,"queue":"memory"}
```

`GITLEAKS_VERSION` and `GITLEAKS_SHA256` are both required build args (the build fails immediately if either is
blank) — there is no default version baked in, so a stale gitleaks is never silently shipped. Get the sha256 from
the JFrog repo listing for `gitleaks_<version>_linux_x64.tar.gz` (or compute it yourself once from a trusted
download and pin it); never pass `--build-arg` without checking it against that listing.

### Python 3.12 base image

`jfrog.corp.com/docker/node:20-slim`'s Debian release ships Python 3.11 from apt, not the 3.12 the curated
runtime is pinned to (`python-runtime/Dockerfile`), so `scanner/Dockerfile` copies the interpreter out of
`jfrog.corp.com/docker/python:3.12-slim` (same image, already used there) in a build stage instead. This is the
standard way to pin an exact Python minor onto a different base image, but it assumes the two images share
compatible system libraries (glibc, openssl, zlib) — generally true when both are the same Debian release. If
your registry's mirrors of these two images are not release-compatible, the copy can fail at run time (not at
build time) with a dynamic-linking error from `python3.12`. The fallback, if that happens: flip the stages —
base the final stage on `jfrog.corp.com/docker/python:3.12-slim` and install Node 20 on top from the official
`node-v20.x.x-linux-x64.tar.gz` under `/usr/local` (a self-contained tarball, not an apt package, so it does not
depend on the base image's own Node packaging), rather than installing Python on top of Node.

## Untested because it needs Azure

- `BlobTagDefenderReader` against a real storage account with Defender for Storage enabled: the exact tag key and
  value strings Microsoft writes (the reader accepts any key ending in `scan result` and treats any value other
  than `No threats found` / `Malicious` / `Not scanned` as an error), and the EICAR path (`tests/make-eicar.sh`,
  cluster only).
- `AzureDevOpsPipelineTrigger` against a real organisation: the `Queue builds` permission on the worker identity,
  the response shape of `_links.web.href`.
- Service Bus consumption (`../intake-api/src/stores/servicebus.ts`): peek-lock redelivery of a job whose scan
  crashed mid-way. The worker is idempotent on redelivery: a job no longer `scanning` is skipped.
- The real gitleaks binary and its report format (tested with a stand-in script that writes a report file; the
  argument list is `detect --no-git --source <dir> --report-format json --report-path <file> --exit-code 0 --no-banner`).
- `sys.stdlib_module_names` differs slightly between the laptop's Python (whatever `python3` resolves to) and
  the runtime's 3.12; `scanner/Dockerfile` now pins 3.12 in the image (see "Python 3.12 base image" above), but
  the `docker build` itself is untested here: no Docker daemon on the authoring machine, the registry path is a
  placeholder, and the gitleaks URL and the cross-image Python copy cannot be reached or verified offline.
