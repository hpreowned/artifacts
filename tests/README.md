# Tests

`corpus/<name>/` is a bundle (`dist/` contents) plus `expected.json`:
`{ "state": "<terminal or awaiting state>", "rules": ["<rule ids that must appear>"], "browser"?: "<what the browser must block when live>" }`.

`runtime-manifest.python-1.json` is a sample of what the platform's CI publishes alongside the curated runtime image. The scanner's import allowlist and the skill's library reference are both generated from it.

`negative.sh` (owned by the `client` agent) publishes every corpus bundle through `artifactctl` against a running intake API and asserts `expected.json`. Run it against the local dev stack (milestone M1) and again against the cluster (M2).

Not in the corpus on purpose:
- The EICAR malware test string. It would be quarantined by the antivirus on any laptop that clones this repo. `make-eicar.sh` assembles it at run time; run it only inside the cluster test job or on a machine whose AV you can tolerate.
- The runtime containment tests for the Python tier (socket, IMDS, service-account token). Those are hand-deployed pods, see DESIGN.md §8 Phase 2 gate.
