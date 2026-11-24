# syntax=docker/dockerfile:1.7

FROM node:22.14.0-alpine3.21 AS builder

WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/auth/package.json packages/auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/file-processing/package.json packages/file-processing/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/storage-core/package.json packages/storage-core/package.json
COPY packages/storage-local/package.json packages/storage-local/package.json
COPY packages/storage-s3/package.json packages/storage-s3/package.json
COPY apps/api/package.json apps/api/package.json

RUN pnpm install --frozen-lockfile --filter @docuflow/api...

COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY packages/notifications packages/notifications
COPY packages/storage-core packages/storage-core
COPY packages/storage-local packages/storage-local
COPY packages/storage-s3 packages/storage-s3
COPY packages/auth packages/auth
COPY packages/database packages/database
COPY packages/file-processing packages/file-processing
COPY apps/api apps/api

RUN pnpm --filter @docuflow/api... build

FROM node:22.14.0-alpine3.21 AS prod-deps

WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/auth/package.json packages/auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/storage-core/package.json packages/storage-core/package.json
COPY packages/storage-local/package.json packages/storage-local/package.json
COPY packages/storage-s3/package.json packages/storage-s3/package.json
COPY apps/api/package.json apps/api/package.json

RUN pnpm install --prod --frozen-lockfile --filter-prod @docuflow/api...

FROM node:22.14.0-alpine3.21 AS runtime

ARG DOCUFLOW_VERSION=1.0.0-rc.1
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="docuflow-api" \
      org.opencontainers.image.description="DocuFlow API server with Drizzle schema migrations" \
      org.opencontainers.image.version="${DOCUFLOW_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DOCUFLOW_VERSION="${DOCUFLOW_VERSION}"

WORKDIR /app

# Strip package managers and dev-only tooling from the production runtime image
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
  && mkdir -p /var/lib/docuflow/storage \
  && chown -R node:node /var/lib/docuflow/storage

COPY --from=prod-deps --chown=node:node /app /app

COPY --from=builder --chown=node:node /app/packages/domain/dist packages/domain/dist
COPY --from=builder --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder --chown=node:node /app/packages/notifications/dist packages/notifications/dist
COPY --from=builder --chown=node:node /app/packages/storage-core/dist packages/storage-core/dist
COPY --from=builder --chown=node:node /app/packages/storage-local/dist packages/storage-local/dist
COPY --from=builder --chown=node:node /app/packages/storage-s3/dist packages/storage-s3/dist
COPY --from=builder --chown=node:node /app/packages/auth/dist packages/auth/dist
COPY --from=builder --chown=node:node /app/packages/database/dist packages/database/dist
COPY --from=builder --chown=node:node /app/packages/database/drizzle packages/database/drizzle
COPY --chown=node:node scripts/maintenance/migrate-entrypoint.sh scripts/maintenance/migrate-entrypoint.sh
COPY --from=builder --chown=node:node /app/apps/api/dist apps/api/dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/v1/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
