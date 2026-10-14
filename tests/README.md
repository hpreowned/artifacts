# Tests

`corpus/<name>/` is a bundle (`dist/` contents) plus `expected.json`:
`{ "state": "<terminal or awaiting state>", "rules": ["<rule ids that must appear>"], "browser"?: "<what the browser must block when live>" }`.

`runtime-manifest.python-1.json` is a sample of what the platform's CI publishes alongside the curated runtime image. The scanner's import allowlist and the skill's library reference are both generated from it.

`negative.sh` (owned by the `client` agent) publishes every corpus bundle through `artifactctl` against a running intake API and asserts `expected.json`. Run it against the local dev stack (milestone M1) and again against the cluster (M2).

Running it against the local dev stack (intake on 8080 with memory backends, see `intake-api/README.md`):

```
npm --prefix cli ci && npm --prefix cli run build        # once; builds cli/dist/artifactctl.js
tests/negative.sh --dry-run                               # lists every bundle with its expected state and rules
ARTIFACTS_DEV_OID=dev-user tests/negative.sh              # ARTIFACTS_API_URL defaults to http://localhost:8080
ARTIFACTS_DEV_OID=dev-user tests/negative.sh --only static-password
```

Each bundle is published with `artifactctl publish --wait --json` (poll every `--interval` seconds, default 2; give up after `--timeout`, default 600). The table shows expected and observed state and the observed rule ids; exit 0 when all match, 1 on any mismatch, 2 when the API is unreachable. Against the cluster set `ARTIFACTS_API_URL=https://mcp.corp.com/artifacts` and `ARTIFACTS_TOKEN` to an Entra token instead of `ARTIFACTS_DEV_OID`. `tests/lib/selftest.sh` runs the script against a fake intake driven by the corpus expectations, to check the script itself without the real stack; `tests/lib/compare.py` (python3, standard library) does the per-bundle comparison.

Not in the corpus on purpose:
- The EICAR malware test string. It would be quarantined by the antivirus on any laptop that clones this repo. `make-eicar.sh` assembles it at run time; run it only inside the cluster test job or on a machine whose AV you can tolerate.
- The runtime containment tests for the Python tier (socket, IMDS, service-account token). Those are hand-deployed pods, see DESIGN.md §8 Phase 2 gate.
