# node-runtime

A pipeline-owned Dockerfile **template**, not a buildable image on its own and not something a node prototype
bundle's author ever sees or ships (DESIGN D14, §6.13; contracts/manifest.schema.json `tier: node`).

## What instantiates it

`pipelines/artifact-node-deploy.yml`'s build-and-bake stage, once per node job:

1. Downloads and unpacks the bundle (`package.json`, `package-lock.json`, the app's own source and data
   files -- `node_modules/` and `.env*` are forbidden in the bundle per the manifest contract).
2. Copies `node-runtime/Dockerfile` into that same directory as the build context.
3. Runs `docker build -t jfrog.corp.com/artifacts/node-<artifactId>:<run id> .` from it, then pushes and
   captures the resulting digest.

The author's bundle supplies the `start` script (and a `build` script if the client needs building); this
file supplies everything around that: the JFrog base images, the no-install-scripts npm posture, the
non-root user, and the production `node_modules` prune.

## Contract this Dockerfile enforces

- **Two stages**, both on `jfrog.corp.com/docker/node:20-slim` (CLAUDE.md: images only from
  `jfrog.corp.com/docker/`).
- **Build stage**: `npm ci --ignore-scripts` resolved only through the JFrog npm mirror
  (`--registry https://jfrog.corp.com/artifactory/api/npm/npm-remote/`) -- the lockfile is mandatory
  (`package-lock.json`, checked by the manifest contract before this ever runs) and no `preinstall`/
  `postinstall`/`prepare` script runs during the image build. `npm run build --if-present` so a bundle with
  a client to prebuild (React/Vite/etc.) gets one, and a plain Node server with no `build` script is a no-op.
- **Runtime stage**: copies the built app plus a `npm prune --omit=dev` `node_modules` (devDependencies --
  bundlers, test runners, type packages -- never ship). `USER 65532:65532`, `HOME=/tmp` (no writable home
  directory otherwise exists under the read-only root). `NODE_ENV=production`, `PORT=8080`, `EXPOSE 8080`.
- **`CMD ["npm", "run", "start"]`**, exec form (no shell, so no shell-injection surface and clean signal
  handling for SIGTERM). `npm` is acceptable here rather than calling `node <entry.js>` directly because the
  self-containment contract (§6.13) only guarantees a bundle's `package.json` has a `start` script, not a
  fixed entry filename -- every AI-generated app names its own entrypoint, and `npm run start` is the one
  invocation that always resolves it. `npm` itself needs no filesystem write access beyond `$HOME` once the
  image is built, so running it as PID 1 under `readOnlyRootFilesystem: true` is safe; it execs straight into
  the app's own process.
- **Read-only-root compatible**: the only paths this image (or the app it bakes in) can write to at runtime
  are whatever `charts/artifact-node`'s `writablePaths` value mounts as `emptyDir` over the baked directory
  (default `/app/data` and `/tmp`). A bundle that writes anywhere else fails at runtime, by design -- that is
  the ephemerality wall §6.13 describes, not a bug to work around here.

## Not covered here

Dependency vetting beyond the lockfile audit (`npm audit --audit-level=high`, run by the pipeline as an
*advisory* step against the same JFrog registry -- it reports, it does not block; see the pipeline's own
comment for why) and the server-side deny list (`child_process`, `vm`, raw sockets) are scanner-stage
concerns, not this Dockerfile's. This file only builds and runs what the scanner already approved.
