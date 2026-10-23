# The ops console: Next.js standalone output, non-root.
ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile && pnpm --filter @sidequest/console build

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
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/console/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/console/.next/static ./apps/console/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/console/server.js"]
