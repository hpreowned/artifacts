# Build: docker build -t viewer-shell:dev .
# Run:   docker run --rm -p 8082:8082 --read-only \
#          -e SHELL_ORIGIN=http://localhost:8082 -e ARTIFACT_DOMAIN=localhost:8081 -e ARTIFACT_SCHEME=http \
#          -e INTAKE_INTERNAL_URL=http://host.docker.internal:8080 -e INTERNAL_SHARED_KEY="$INTERNAL_SHARED_KEY" \
#          -e DEV_AUTH=1 viewer-shell:dev
# The image writes nothing at run time; it runs as uid 65532 with a read-only root filesystem.

FROM jfrog.corp.com/docker/node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM jfrog.corp.com/docker/node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
USER 65532:65532
EXPOSE 8082
CMD ["node", "dist/src/server.js"]
