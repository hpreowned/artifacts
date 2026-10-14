# Build: docker build -t static-gateway:dev .
# Run:   docker run --rm -p 8081:8081 --read-only \
#          -e SERVE_ROOT=/srv -v "$PWD/../serving:/srv:ro" \
#          -e ARTIFACT_DOMAIN=localhost:8081 -e SHELL_ORIGIN=http://localhost:8082 \
#          -e VIEW_TOKEN_KEY="$VIEW_TOKEN_KEY" static-gateway:dev
# The image writes nothing at run time; it runs as uid 65532 with a read-only root filesystem.

FROM jfrog.corp.com/docker/node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM jfrog.corp.com/docker/node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/src ./dist/src
# No runtime dependencies: nothing from node_modules is copied.
USER 65532:65532
EXPOSE 8081
CMD ["node", "dist/src/server.js"]
