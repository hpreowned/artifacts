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

Cases not representable as corpus bundles: a corrupt/unreadable zip (IN-009) cannot be expressed as a `corpus/<name>/` directory, because the test harness zips that directory itself to produce the upload; that case is a scanner unit test instead (`scanner/src/test/corpus.test.ts`, "IN-009: a non-zip upload is rejected").

Not in the corpus on purpose:
- The EICAR malware test string. It would be quarantined by the antivirus on any laptop that clones this repo. `make-eicar.sh` assembles it at run time; run it only inside the cluster test job or on a machine whose AV you can tolerate.
- The runtime containment tests for the Python tier (socket, IMDS, service-account token). Those are hand-deployed pods, see DESIGN.md §8 Phase 2 gate.

## Node tier

Seven bundles exercise the node tier (`tier: "node"`, `runtime: "node-20"`, `entrypoint: "package.json"`, DESIGN D14/§6.13, contracts/findings.md JS-001..JS-006). All seven are a minimal but realistic Node app: `package.json` + `package-lock.json`, `server/index.js` (Express, reads `data/db.json`, serves `src/`), a seed `data/db.json`, and a small client file under `src/`:

- `node-ok`: a clean bundle with pinned dependencies and a lockfile whose `resolved` URLs point at the JFrog npm mirror (`https://jfrog.corp.com/artifactory/api/npm/npm-remote/...`). Expected: `awaiting_approval`, like a python-tier pass — the node tier follows the python state path and hands off to the same pipeline-trigger interface.
- `node-child-process`: `server/index.js` adds `const { execSync } = require("child_process")`. Expected: `rejected`, JS-001.
- `node-no-lockfile`: `package-lock.json` is missing entirely. Expected: `rejected`, JS-002.
- `node-foreign-registry`: the lockfile has one dependency `resolved` at `https://registry.npmjs.org/...` instead of the JFrog mirror. Expected: `rejected`, JS-002.
- `node-node-modules`: ships `node_modules/leftpad/index.js`. Expected: `rejected`, JS-003 (its contents are never scanned for the other JS rules).
- `node-env-file`: ships a `.env` with an innocuous placeholder value (no secret-shaped content — IN-005 lets `.env`/`.env.*`/`.npmrc` extract for node bundles specifically so JS-004 can name them, rather than a generic "unknown file type"). Expected: `rejected`, JS-004.
- `node-lifecycle-script`: `package.json` carries a `postinstall` script alongside `start`. Expected: `rejected`, JS-006.

Unit coverage for the JS-001..JS-006 logic itself (quote styles, lockfile v1/v2/v3 shapes, literal-vs-dynamic arguments) lives in `scanner/src/test/js-checks.test.ts`, independent of the corpus/worker harness.
