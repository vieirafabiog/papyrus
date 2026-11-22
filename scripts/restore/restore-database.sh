#!/usr/bin/env bash
set -euo pipefail
umask 077

# ==============================================================================
# DocuFlow — Restauração segura do PostgreSQL
# Valida checksum SHA-256 e integridade do dump custom (-Fc) antes de restaurar
# com pg_restore (--clean --if-exists --exit-on-error) e logs livres de segredos.
# ==============================================================================

BACKUP_FILE="${BACKUP_FILE:-}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-NO}"
RESTORE_MODE="${RESTORE_MODE:-auto}"
VERIFY_CHECKSUM="${VERIFY_CHECKSUM:-true}"
CLEAN_BEFORE_RESTORE="${CLEAN_BEFORE_RESTORE:-true}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16.8-alpine3.21}"
DOCUFLOW_PG_CONTAINER="${DOCUFLOW_PG_CONTAINER:-}"
DOCKER_NETWORK="${DOCKER_NETWORK:-}"

TMP_DIR=""

usage() {
  cat <<'EOF'
Uso: BACKUP_FILE=/caminho/docuflow-db-*.dump CONFIRM_RESTORE=YES ./scripts/restore/restore-database.sh
Variáveis:
  BACKUP_FILE            Caminho obrigatório do arquivo .dump
  CONFIRM_RESTORE        Deve ser YES para autorizar restauração no banco alvo
  DATABASE_URL           URI PostgreSQL alvo (ou PGHOST/PGUSER/PGDATABASE/PGPASSWORD ou DOCUFLOW_PG_CONTAINER)
  VERIFY_CHECKSUM        true (padrão) | false
  CLEAN_BEFORE_RESTORE   true (padrão) | false
  RESTORE_MODE           auto (padrão) | pg_restore | docker
EOF
}

log_json() {
  local level="$1"
  local message="$2"
  local extra="${3:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "$extra" ]; then
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-db-restore","message":"%s",%s}\n' \
      "$ts" "$level" "$message" "$extra"
  else
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-db-restore","message":"%s"}\n' \
      "$ts" "$level" "$message"
  fi
}

sanitize_text() {
  local raw="$1"
  printf '%s' "$raw" | sed -E \
    -e 's#postgres(ql)?://[^[:space:]'\''"]+#postgresql://[REDACTED]#gi' \
    -e 's/(password|pwd|secret|PGPASSWORD)=[^[:space:];,'\''"]+/\1=[REDACTED]/gi' | tr '\n' ' ' | cut -c1-400
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

resolve_mode() {
  case "$RESTORE_MODE" in
    pg_restore|docker)
      printf '%s' "$RESTORE_MODE"
      ;;
    auto)
      if command -v pg_restore >/dev/null 2>&1; then
        printf 'pg_restore'
      elif command -v docker >/dev/null 2>&1; then
        printf 'docker'
      else
        log_json "error" "Nem pg_restore local nem docker disponivel para restauracao." >&2
        exit 1
      fi
      ;;
    *)
      log_json "error" "RESTORE_MODE invalido; use auto, pg_restore ou docker." >&2
      exit 1
      ;;
  esac
}

main() {
  for arg in "$@"; do
    case "$arg" in
      -h|--help)
        usage
        exit 0
        ;;
      --confirm-restore)
        CONFIRM_RESTORE="YES"
        ;;
      *)
        log_json "error" "Argumento desconhecido: ${arg}" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
    log_json "error" "BACKUP_FILE ausente ou inexistente." >&2
    exit 1
  fi

  if [ "$CONFIRM_RESTORE" != "YES" ]; then
    log_json "error" "Confirmacao obrigatoria ausente: defina CONFIRM_RESTORE=YES ou passe --confirm-restore." >&2
    exit 1
  fi

  if [ -z "${DATABASE_URL:-}" ] && [ -z "$DOCUFLOW_PG_CONTAINER" ] && [ -z "${PGHOST:-}" ]; then
    log_json "error" "Defina DATABASE_URL, DOCUFLOW_PG_CONTAINER ou PGHOST/PGUSER/PGDATABASE." >&2
    exit 1
  fi

  local abs_dump
  abs_dump="$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")"
  local dump_dir
  dump_dir=$(dirname "$abs_dump")
  local dump_base
  dump_base=$(basename "$abs_dump")
  local sha_file="${abs_dump}.sha256"

  if [ "$VERIFY_CHECKSUM" = "true" ]; then
    if [ ! -f "$sha_file" ]; then
      log_json "error" "Arquivo de checksum .sha256 nao encontrado ao lado do dump." >&2
      exit 1
    fi
    if ! (cd "$dump_dir" && sha256sum -c "$(basename "$sha_file")" >/dev/null 2>&1); then
      log_json "error" "Falha na verificacao de checksum SHA-256 do backup do PostgreSQL." >&2
      exit 1
    fi
  fi

  TMP_DIR=$(mktemp -d /tmp/docuflow-db-restore-XXXXXX)
  chmod 700 "$TMP_DIR"
  local err_file="${TMP_DIR}/pg_restore.err"
  local mode
  mode=$(resolve_mode)

  log_json "info" "Validando integridade do dump antes da restauracao" "\"mode\":\"${mode}\",\"file\":\"${dump_base}\""

  local -a restore_flags=(--no-owner --no-privileges --exit-on-error)
  if [ "$CLEAN_BEFORE_RESTORE" = "true" ]; then
    restore_flags+=(--clean --if-exists)
  fi

  if [ "$mode" = "pg_restore" ]; then
    if ! pg_restore --list "$abs_dump" >/dev/null 2>"$err_file"; then
      local safe_err
      safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
      log_json "error" "Dump do PostgreSQL corrompido ou ilegivel" "\"detail\":\"${safe_err}\"" >&2
      exit 1
    fi

    if [ -n "${DATABASE_URL:-}" ]; then
      if ! pg_restore "${restore_flags[@]}" --dbname="$DATABASE_URL" "$abs_dump" 2>"$err_file"; then
        local safe_err
        safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
        log_json "error" "Falha ao restaurar PostgreSQL" "\"detail\":\"${safe_err}\"" >&2
        exit 1
      fi
    else
      if ! pg_restore "${restore_flags[@]}" \
        -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" \
        -U "${PGUSER:-docuflow}" -d "${PGDATABASE:-docuflow}" \
        "$abs_dump" 2>"$err_file"; then
        local safe_err
        safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
        log_json "error" "Falha ao restaurar PostgreSQL" "\"detail\":\"${safe_err}\"" >&2
        exit 1
      fi
    fi
  else
    if [ -n "$DOCUFLOW_PG_CONTAINER" ]; then
      if ! docker exec -i "$DOCUFLOW_PG_CONTAINER" pg_restore --list <"$abs_dump" >/dev/null 2>"$err_file"; then
        local safe_err
        safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
        log_json "error" "Dump do PostgreSQL corrompido ou ilegivel" "\"detail\":\"${safe_err}\"" >&2
        exit 1
      fi
      if ! docker exec -i "$DOCUFLOW_PG_CONTAINER" \
        pg_restore "${restore_flags[@]}" -U "${PGUSER:-docuflow}" -d "${PGDATABASE:-docuflow}" \
        <"$abs_dump" 2>"$err_file"; then
        local safe_err
        safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
        log_json "error" "Falha ao restaurar PostgreSQL via container" "\"detail\":\"${safe_err}\"" >&2
        exit 1
      fi
    else
      if ! docker run --rm -v "${dump_dir}:/backup:ro" "$POSTGRES_IMAGE" \
        pg_restore --list "/backup/${dump_base}" >/dev/null 2>"$err_file"; then
        local safe_err
        safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
        log_json "error" "Dump do PostgreSQL corrompido ou ilegivel" "\"detail\":\"${safe_err}\"" >&2
        exit 1
      fi

      local -a docker_args=(run --rm -v "${dump_dir}:/backup:ro")
      if [ -n "$DOCKER_NETWORK" ]; then
        docker_args+=(--network "$DOCKER_NETWORK")
      fi

      if [ -n "${DATABASE_URL:-}" ]; then
        docker_args+=(-e DATABASE_URL "$POSTGRES_IMAGE" pg_restore "${restore_flags[@]}" --dbname="$DATABASE_URL" "/backup/${dump_base}")
      else
        docker_args+=(
          -e PGHOST="${PGHOST:-postgres}"
          -e PGPORT="${PGPORT:-5432}"
          -e PGUSER="${PGUSER:-docuflow}"
          -e PGDATABASE="${PGDATABASE:-docuflow}"
          -e PGPASSWORD="${PGPASSWORD:-}"
          "$POSTGRES_IMAGE"
          pg_restore "${restore_flags[@]}" "/backup/${dump_base}"
        )
      fi

      if ! docker "${docker_args[@]}" 2>"$err_file"; then
        local safe_err
        safe_err=$(sanitize_text "$(cat "$err_file" 2>/dev/null || true)")
        log_json "error" "Falha ao restaurar PostgreSQL via container" "\"detail\":\"${safe_err}\"" >&2
        exit 1
      fi
    fi
  fi

  log_json "info" "Restauracao do PostgreSQL concluida com sucesso" "\"file\":\"${dump_base}\""
}

main "$@"
