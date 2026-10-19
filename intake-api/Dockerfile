# Build (context is the REPO ROOT, not this directory -- tsconfig.json's "include" pulls in
# ../scanner/src, which src/stack.ts imports for the combined dev-stack entrypoint; nothing from
# scanner ships in the final image, but it must type-check):
#   docker build -f intake-api/Dockerfile -t intake-api:dev .
# Run:
#   docker run --rm -p 8080:8080 --read-only \
#     -e BACKEND=azure -e STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net \
#     -e SERVICEBUS_FQDN=<namespace>.servicebus.windows.net \
#     -e PIPELINE_TRIGGER=fake `# or ADO_ORG/ADO_PROJECT/ADO_PIPELINE_ID for the real pipeline` \
#     -e PUBLIC_BASE_URL=https://mcp.corp.com/artifacts -e SHELL_ORIGIN=https://artifacts.corp.com \
#     -e VIEW_TOKEN_KEY="$VIEW_TOKEN_KEY" -e PIPELINE_TOKEN="$PIPELINE_TOKEN" -e INTERNAL_SHARED_KEY="$INTERNAL_SHARED_KEY" \
#     intake-api:dev
#
# Nothing in src/routes/*.ts, server.ts, job.ts or the stores ever calls ServingStore.publish/remove --
# that happens only in the scanner worker, which ships in its own container (../scanner/Dockerfile).
# So this image's filesystem is never written to by its own CMD (dist/intake-api/src/main.js), in
# either BACKEND mode, and it runs read-only. The one thing to know: if this image is ever started
# with the combined dev entrypoint (dist/intake-api/src/dev.js) instead of main.js -- it isn't, by
# this Dockerfile -- that entrypoint also runs the worker in-process, which does write published
# files under SERVE_ROOT when BACKEND=memory; that path needs a writable volume if anyone ever uses it.
# uid 65532, read-only root filesystem.

# Build arguments exist so the platform team can build this file on a laptop that cannot reach JFrog
# (scripts/build-platform-images.sh). The pipeline passes none: production is the defaults below.
ARG NODE_IMAGE=jfrog.corp.com/docker/node:20-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY intake-api/package.json intake-api/package-lock.json intake-api/tsconfig.json ./intake-api/
RUN cd intake-api && npm ci --no-audit --no-fund
COPY scanner/package.json scanner/package-lock.json ./scanner/
RUN cd scanner && npm ci --no-audit --no-fund
COPY intake-api/src ./intake-api/src
COPY scanner/src ./scanner/src
RUN cd intake-api && npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# repo-root.ts derives REPO_ROOT from the compiled file's own nested dist path by default; a container
# doesn't reproduce that layout, so it is set explicitly here to find contracts/manifest.schema.json.
ENV REPO_ROOT=/app
WORKDIR /app
COPY --from=build /app/intake-api/package.json ./package.json
COPY --from=build /app/intake-api/node_modules ./node_modules
COPY --from=build /app/intake-api/dist/intake-api/src ./dist/intake-api/src
COPY contracts/manifest.schema.json ./contracts/manifest.schema.json
USER 65532:65532
EXPOSE 8080
CMD ["node", "dist/intake-api/src/main.js"]
