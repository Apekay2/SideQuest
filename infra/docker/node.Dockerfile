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
# Runtime hardening: take the distribution's security updates (the base image lags them), and
# remove the package managers. Nothing at runtime installs anything, and npm's own bundled
# dependencies (tar, among others) were the image's critical findings.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
