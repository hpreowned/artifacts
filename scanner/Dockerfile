# scanner/Dockerfile — the scan worker (DESIGN §5). Non-root, read-only-root compatible: every write (bundle
# extraction, gitleaks' own scratch report) happens under /tmp, which deploy/platform/scanner-worker.yaml
# already mounts as a writable emptyDir volume.
#
# Build context is the REPO ROOT, not scanner/: scanner/tsconfig.json "include" also compiles
# ../intake-api/src (the job/store types and the Azure store implementations scanner imports), and the image
# needs contracts/manifest.schema.json and tests/runtime-manifest.python-1.json at run time (see REPO_ROOT
# below). Build from the repo root:
#
#   docker build -f scanner/Dockerfile \
#     --build-arg GITLEAKS_VERSION=8.21.2 \
#     --build-arg GITLEAKS_SHA256=<sha256 of gitleaks_8.21.2_linux_x64.tar.gz, from the JFrog repo listing> \
#     -t scanner:dev .
#
# Run:
#   docker run --rm -p 8081:8081 --read-only --tmpfs /tmp -e BACKEND=memory scanner:dev
#   curl localhost:8081/healthz
#
# .dockerignore: this Dockerfile ships with a *Dockerfile.dockerignore* (not a plain .dockerignore) next to
# it — the BuildKit convention for an ignore file scoped to one Dockerfile, resolved against the build
# context above regardless of where the Dockerfile itself lives. See scanner/README.md if your builder
# predates that convention.
#
# Python 3.12: node:20-slim's Debian release does not package Python 3.12 from apt (bookworm ships 3.11 —
# one minor behind the curated runtime that python-runtime/Dockerfile pins, and `sys.stdlib_module_names`
# must match that runtime's minor exactly or imports.py's PY-001 allowlist drifts from it). So this build
# does not apt-install Python; it takes the interpreter from jfrog.corp.com/docker/python:3.12-slim instead —
# the same base image python-runtime/Dockerfile already uses — and copies it into the node-based runtime
# stage below. If your registry mirrors node:20-slim and python:3.12-slim from different Debian releases,
# that copy can fail at run time with a glibc/openssl mismatch between the two; the documented fallback
# (scanner/README.md "Python 3.12 base image") is to flip the stages: base the runtime stage on
# jfrog.corp.com/docker/python:3.12-slim and install Node 20 on top from the official linux-x64 tarball
# under /usr/local, instead of installing Python on top of Node.

# ---- TypeScript build: scanner/ plus the intake-api/ sources it imports types and stores from ----
FROM jfrog.corp.com/docker/node:20-slim AS build
WORKDIR /repo
COPY scanner/package.json scanner/package-lock.json scanner/tsconfig.json scanner/
COPY intake-api/package.json intake-api/package-lock.json intake-api/tsconfig.json intake-api/
RUN cd scanner && npm ci --no-audit --no-fund \
 && cd ../intake-api && npm ci --no-audit --no-fund
COPY scanner/src scanner/src
COPY scanner/imports.py scanner/imports.py
COPY intake-api/src intake-api/src
RUN cd scanner && npm run build && npm prune --omit=dev

# ---- gitleaks: fetched once and checksummed, never built from a moving tag ----
FROM jfrog.corp.com/docker/node:20-slim AS gitleaks
ARG GITLEAKS_VERSION
ARG GITLEAKS_SHA256
RUN [ -n "$GITLEAKS_VERSION" ] || { echo "GITLEAKS_VERSION build arg is required" >&2; exit 1; }
RUN [ -n "$GITLEAKS_SHA256" ] || { echo "GITLEAKS_SHA256 build arg is required" >&2; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/gitleaks
RUN curl -fsSLO "https://jfrog.corp.com/artifactory/generic-remote/gitleaks/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
 && echo "${GITLEAKS_SHA256}  gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | sha256sum -c - \
 && tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" gitleaks \
 && chmod 0755 gitleaks

# ---- Python 3.12, for its interpreter and stdlib only (see the note above) ----
FROM jfrog.corp.com/docker/python:3.12-slim AS python

# ---- runtime ----
FROM jfrog.corp.com/docker/node:20-slim
ENV NODE_ENV=production \
    REPO_ROOT=/app \
    GITLEAKS_BIN=/usr/local/bin/gitleaks \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=build /repo/scanner/package.json ./package.json
COPY --from=build /repo/scanner/node_modules ./node_modules
COPY --from=build /repo/scanner/dist ./dist
COPY --from=build /repo/scanner/imports.py ./scanner/imports.py
COPY contracts/manifest.schema.json ./contracts/manifest.schema.json
COPY tests/runtime-manifest.python-1.json ./tests/runtime-manifest.python-1.json
COPY --from=python /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python /usr/local/lib/python3.12 /usr/local/lib/python3.12
RUN ln -s /usr/local/bin/python3.12 /usr/local/bin/python3
COPY --from=gitleaks /tmp/gitleaks/gitleaks /usr/local/bin/gitleaks
# REPO_ROOT=/app above makes every default path (scanner/imports.py, contracts/manifest.schema.json,
# tests/runtime-manifest.python-1.json) resolve against the layout just copied in; PYTHON_BIN's default
# ("python3") and GITLEAKS_BIN resolve via PATH, which already includes /usr/local/bin.
USER 65532:65532
EXPOSE 8081
CMD ["node", "dist/scanner/src/main.js"]
