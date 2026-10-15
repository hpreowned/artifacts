# python-runtime/ — the curated runtime image (DESIGN §6.5, D6)

One image, built by your CI from your JFrog Python base, with a pinned set of libraries in a venv. Every
approved Python artifact runs on it with `app.py` mounted from a ConfigMap; the artifact never brings
dependencies. `runtime-manifest.json`, generated at build time from what pip actually installed, is the
allow-list the scanner enforces (`tests/runtime-manifest.python-1.json` is the frozen shape) and the source of
the skill's library reference.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | two stages: install the pins into `/venv` and emit the manifest; copy both onto a clean base, uid 65532, `WORKDIR /app`, `EXPOSE 8080`, no entrypoint |
| `emit-manifest.py` | stdlib: `pip list --format json` on stdin → manifest JSON on stdout; fails if a curated distribution is missing |
| `test-emit-manifest.sh` | runs the script on a fake pip list and compares with `tests/runtime-manifest.python-1.json` |

## Build and run locally

```
docker build -t python-runtime:dev python-runtime/            # needs the JFrog base image, or substitute python:3.12-slim for a laptop build
docker run --rm python-runtime:dev cat /runtime-manifest.json
docker run --rm -p 8080:8080 -v "$PWD/tests/corpus/python-ok/app.py:/app/app.py:ro" python-runtime:dev \
  streamlit run /app/app.py --server.port=8080 --server.address=0.0.0.0 --server.headless=true --browser.gatherUsageStats=false
```

Pinned versions in the Dockerfile are known-good releases at the time of writing. CI resolves them against
the JFrog mirror; a pin that does not exist fails the build. Bump pins deliberately, rebuild, and let
`pipelines/platform-deploy.yml` publish the new `runtime-manifest.python-1.json` and the image digest; then a
person sets `PYTHON_RUNTIME_IMAGE` in the `artifacts-platform` variable group to the new digest and agent-client
regenerates `references/python-1-libraries.md` from the manifest.

The manifest's `modules` are the curated distributions' top-level import names only. Transitive dependencies
(click, jinja2, pydantic_core, ...) are installed but **not** allowed as imports: the scanner rejects them, which
keeps the published surface to what we chose. The extra `distributions` key records resolved versions for humans.

## Runtime contract

- Runs as uid 65532 with `readOnlyRootFilesystem`; writable `/tmp` only (`HOME=/tmp`, Streamlit writes its config there).
- Listens on 8080; the Deployment passes the args from `entrypoints` (`streamlit` or `fastapi`).
- No network, no service account token, no storage at run time (NetworkPolicy and the pod spec, not the image).
- Environment variables: none required. `STREAMLIT_BROWSER_GATHER_USAGE_STATS=false` is baked in.

## Tests

`./python-runtime/test-emit-manifest.sh` — offline, python3 only. `deploy/validate.sh` runs it too.

## Not tested here

- The Docker build itself: no Docker and no `hadolint` on this machine, and the base image is on JFrog. The Dockerfile was checked by reading; `addgroup`/`adduser` are the Debian tools present in `python:3.12-slim`.
- That the pinned set resolves together on the mirror (fastapi 0.115 requires starlette 0.46; pydantic 2.11 is within fastapi's range; streamlit 1.45 accepts pandas 2.3 and numpy 2.3). First CI build confirms.
- Phase 2 gate tests 3 and 5 (socket and IMDS calls time out; no token under `/var/run/secrets`) need the cluster.
