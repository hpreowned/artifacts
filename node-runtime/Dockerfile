# Pipeline-owned Dockerfile TEMPLATE for the node tier (DESIGN D14, §6.13). This file is never shipped by a
# bundle author -- a node bundle carries only package.json/package-lock.json/src/data, no Dockerfile of its
# own (contracts/manifest.schema.json tier=prototype). `pipelines/artifact-node-deploy.yml`'s build-and-bake stage
# copies this file into the assembled build context next to the fetched bundle and runs `docker build` from
# it, once per prototype, producing `jfrog.corp.com/artifacts/node-<artifactId>:<run id>` (then referenced by
# digest only, per `charts/artifact-node`'s image validation).
#
# Two-stage, same JFrog base as the rest of the platform (CLAUDE.md: images come from jfrog.corp.com/docker/).
#
# Build stage: `npm ci --ignore-scripts` against the JFrog npm mirror only (no install/postinstall scripts
# run -- same posture as the lockfile-mandatory, no-arbitrary-code contract in §6.13), then `npm run build`
# if the bundle declares one (a static client to prebuild; plain Node servers have no build step).
FROM jfrog.corp.com/docker/node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --registry https://jfrog.corp.com/artifactory/api/npm/npm-remote/
COPY . .
RUN npm run build --if-present

# Runtime stage: copy the app plus production-only node_modules (devDependencies -- bundlers, test runners
# -- never ship). uid 65532, read-only root filesystem; the app may only write under the paths
# `charts/artifact-node` mounts as emptyDir (default /app/data and /tmp -- see that chart's `writablePaths`
# value, which must match whatever this app actually writes to).
FROM jfrog.corp.com/docker/node:20-slim
WORKDIR /app
COPY --from=build /app ./
RUN npm prune --omit=dev --ignore-scripts \
 && addgroup --system --gid 65532 app \
 && adduser --system --ingroup app --uid 65532 --home /tmp --no-create-home app
USER 65532:65532
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp
EXPOSE 8080
# Exec form, no shell. `npm run start` (not `node server.js` directly): the self-containment contract
# (§6.13) only guarantees a `start` script exists in package.json, not a fixed entry filename -- every
# AI-generated bundle names its own entrypoint. `npm` itself needs no write access once installed (its own
# cache/config live under $HOME=/tmp here, which is one of the writable mounts), so running it as PID 1 under
# a read-only root is fine; it execs straight into the app's start script rather than keeping a shell alive.
CMD ["npm", "run", "start"]
