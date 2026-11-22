#!/bin/sh
set -eu

NODE_ENV_NORMALIZED=$(printf '%s' "${NODE_ENV:-production}" | tr '[:upper:]' '[:lower:]')

if [ "$NODE_ENV_NORMALIZED" = "production" ]; then
  case "${DOCUFLOW_RUN_DESTRUCTIVE_SEED:-}" in
    1|true|TRUE|yes|YES)
      printf '{"status":"error","message":"Seed destrutivo bloqueado em produção (NODE_ENV=production)."}\n' >&2
      exit 1
      ;;
  esac
fi

if [ -z "${DATABASE_URL:-}" ]; then
  printf '{"status":"error","message":"Variável DATABASE_URL é obrigatória para executar migrations."}\n' >&2
  exit 1
fi

MIGRATE_SCRIPT="${DOCUFLOW_MIGRATE_SCRIPT:-/app/packages/database/dist/migrate-cli.js}"
if [ ! -f "$MIGRATE_SCRIPT" ]; then
  MIGRATE_SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/packages/database/dist/migrate-cli.js"
fi

node "$MIGRATE_SCRIPT"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
