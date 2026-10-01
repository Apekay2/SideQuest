# One Dockerfile for the two Node services, chosen with --build-arg APP=api|worker.
#   docker build -f infra/docker/node.Dockerfile --build-arg APP=api -t sidequest/api .
#
# build: install the workspace, bundle the app (workspace packages are compiled in)
# deploy: a production-only node_modules for just that app
# runtime: distroless-style slim image, non-root, no package manager, no source

ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG APP
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @sidequest/${APP} build \
 && pnpm --filter @sidequest/${APP} deploy --prod --legacy /out \
 && cp -r apps/${APP}/dist /out/dist \
 && mkdir -p /out/migrations && cp packages/db/migrations/*.sql /out/migrations/

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
