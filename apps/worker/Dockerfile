# syntax=docker/dockerfile:1.7

FROM node:22.14.0-alpine3.21 AS builder

WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/file-processing/package.json packages/file-processing/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/storage-core/package.json packages/storage-core/package.json
COPY packages/storage-local/package.json packages/storage-local/package.json
COPY packages/storage-s3/package.json packages/storage-s3/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN pnpm install --frozen-lockfile --filter @papyrus/worker...

COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY packages/notifications packages/notifications
COPY packages/file-processing packages/file-processing
COPY packages/storage-core packages/storage-core
COPY packages/storage-local packages/storage-local
COPY packages/storage-s3 packages/storage-s3
COPY packages/database packages/database
COPY apps/worker apps/worker

RUN pnpm --filter @papyrus/worker... build

FROM node:22.14.0-alpine3.21 AS prod-deps

WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/file-processing/package.json packages/file-processing/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/storage-core/package.json packages/storage-core/package.json
COPY packages/storage-local/package.json packages/storage-local/package.json
COPY packages/storage-s3/package.json packages/storage-s3/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN pnpm install --prod --frozen-lockfile --filter-prod @papyrus/worker...

FROM node:22.14.0-alpine3.21 AS runtime

ARG PAPYRUS_VERSION=1.0.0-rc.1
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="papyrus-worker" \
      org.opencontainers.image.description="papyrus background worker (upload scan, retention, notifications)" \
      org.opencontainers.image.version="${PAPYRUS_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production
ENV WORKER_HEALTH_HOST=0.0.0.0
ENV WORKER_HEALTH_PORT=3001
ENV PAPYRUS_VERSION="${PAPYRUS_VERSION}"

WORKDIR /app

# Remove package managers and dev tooling from final worker runtime image
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
  && mkdir -p /var/lib/papyrus/storage \
  && chown -R node:node /var/lib/papyrus/storage

COPY --from=prod-deps --chown=node:node /app /app

COPY --from=builder --chown=node:node /app/packages/domain/dist packages/domain/dist
COPY --from=builder --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder --chown=node:node /app/packages/notifications/dist packages/notifications/dist
COPY --from=builder --chown=node:node /app/packages/file-processing/dist packages/file-processing/dist
COPY --from=builder --chown=node:node /app/packages/storage-core/dist packages/storage-core/dist
COPY --from=builder --chown=node:node /app/packages/storage-local/dist packages/storage-local/dist
COPY --from=builder --chown=node:node /app/packages/storage-s3/dist packages/storage-s3/dist
COPY --from=builder --chown=node:node /app/packages/database/dist packages/database/dist
COPY --from=builder --chown=node:node /app/apps/worker/dist apps/worker/dist

USER node

EXPOSE 3001

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.WORKER_HEALTH_PORT || '3001') + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/worker/dist/worker.js"]
