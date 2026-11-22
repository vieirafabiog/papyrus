# syntax=docker/dockerfile:1.7

FROM node:22.14.0-alpine3.21 AS builder

WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile --filter @docuflow/web...

COPY packages/contracts packages/contracts
COPY packages/ui packages/ui
COPY apps/web apps/web

RUN pnpm --filter @docuflow/contracts build \
  && pnpm --filter @docuflow/ui build \
  && pnpm --filter @docuflow/web build

FROM nginxinc/nginx-unprivileged:1.27.5-alpine3.21 AS runtime

USER 101

COPY --chown=101:101 apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=101:101 /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
