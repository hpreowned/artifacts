# scanner

The scan worker. One queue message `{ jobId }` per finalized upload; the worker loads the job, downloads the
zip, runs the stages from DESIGN §5 in order, decides with `src/policy.ts`, and then either copies the files to
the serving store (static) or triggers the Azure DevOps deploy pipeline (python). Every exit writes a one-paragraph
`summary` for Cowork to relay. A GC loop expires static artifacts past their TTL.

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
| intake | `src/extract.ts` | IN-001 … IN-005 | Own strict zip reader (`src/zip-read.ts`): central-directory driven, store/deflate only, no zip64, CRC checked, output capped. Zip-slip, duplicate (case-insensitive) paths, symlinks and special files are refused before anything is written. A bundle that inflates past 100 MiB is reported under IN-001. |
| intake | `src/intake-checks.ts` | IN-006, IN-007, IN-008 | `manifest.json` must validate against `contracts/manifest.schema.json` and agree with the submitted manifest on `tier`, `entrypoint`, `runtime`. Any intake `deny` stops the run: later stages would be noise on a broken bundle. |
| secrets | `src/secrets.ts` | SEC-001, SEC-000 | gitleaks (`GITLEAKS_BIN`, `detect --no-git --report-format json`) **plus** a built-in pattern pack (AWS access key ids, Azure storage account keys, SAS `sig=`, GitHub tokens, private key headers, JWTs) that always runs, so `static-secret` is rejected offline. Missing or failing gitleaks → `SEC-000` (warn) and a loud log line. Messages never echo the matched value. |
| malware | `src/defender.ts` | MAL-001, MAL-002 | `DefenderReader` interface. Fake: `No threats found` unless the job id is in `DEFENDER_FAKE_MALICIOUS`. Real: polls the blob index tag on `intake/<jobId>.zip` (`Malware Scanning scan result`; any key ending in `scan result` is accepted) every `DEFENDER_POLL_SECONDS` up to `DEFENDER_TIMEOUT_SECONDS`. `Malicious` → MAL-001 (rejected). `Error`, `Not scanned`, timeout or any unknown value → MAL-002 and state `failed` (never auto-allow). The wait overlaps the other stages. |
| html | `src/checks.ts`, `src/html-parse.ts` | HTML-001 … HTML-009 | Dependency-free tokenizer: start tags with attributes, script bodies, comments skipped outside script/style. Runs on `.html` and `.svg` (inline `<script>` executes when an SVG is opened as a document); script rules also run on `.js`. HTML-001 compares every external `<script src>` to the manifest `externalScripts` and the CDN pattern from the manifest schema; a `<base href>` to another host is also HTML-001. HTML-002 covers `action` and `formaction` with any scheme or host. HTML-006 flags `eval(`, `new Function(`, `document.write(`/`writeln(` unless every argument is a string literal. HTML-007 is a linear scan for runs ≥ 64 KiB of base64/base64url/hex characters inside scripts. |
| python | `imports.py`, `src/python-stage.ts` | PY-001, PY-002, PY-003, PY-005 | `python3 imports.py <dir> <runtime-manifest.json>` parses every `.py` with `ast` (never imports or executes it) and prints JSON findings. Allowlist = `sys.stdlib_module_names` ∪ `modules` from the runtime manifest ∪ top-level modules and packages in the bundle; relative imports are local. PY-002 covers `subprocess`, `socket`, `ctypes`, `pickle`, `marshal`, `importlib`, `multiprocessing`, `os.system`/`exec*`/`fork*`/`spawn*`/`posix_spawn*`/`popen` in any alias or `from os import` spelling, and `eval`/`exec`/`__import__`/`compile`. PY-003 resolves literal paths, module-level string constants, `os.path.join`, `Path(...) / ...` and `tempfile.*`; a write with an unresolvable path is denied with a message saying so. A file that does not parse is PY-001. |
| python | `src/checks.ts` | PY-004 | `requirements.txt`, `pyproject.toml`, `setup.py`, `*.whl`, `*.tar.gz` anywhere in the bundle. |
| verdict | `src/policy.ts` | all | The one rule → severity table; `src/test/policy.test.ts` parses `contracts/findings.md` and fails if they differ. Any `deny` → `rejected` with every finding. |
| publish | `src/worker.ts` | – | static: `deploying` → copy to the serving store → `live`, `url = ${SHELL_ORIGIN}/view/${artifactId}`, intake bundle deleted. python: job stays `scanning`, `triggerPythonDeploy(jobId)` is called and `runUrl` stored; the pipeline moves it on through `/events`. Trigger failure → `failed`. |
| gc | `src/gc.ts` | – | Every `GC_INTERVAL_SECONDS`: `live` static jobs past `expiresAt` are removed from the serving store and set `expired`. Python expiry belongs to the `artifact-gc` pipeline. |

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
| `GC_INTERVAL_SECONDS` | `600` | Static-tier GC interval. |
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
with a stub container (appears, times out, errors), both pipeline triggers with a stub `fetch`, and GC.

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
- `sys.stdlib_module_names` differs slightly between the laptop's Python and the runtime's 3.12; the scanner
  image should pin the same minor version as the runtime.
