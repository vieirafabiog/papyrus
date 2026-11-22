#!/usr/bin/env bash
set -euo pipefail
umask 077

# ==============================================================================
# DocuFlow — Backup seguro do PostgreSQL
# Gera dumps em formato custom (-Fc) com escrita atômica, checksum SHA-256,
# validação de integridade, política de retenção e logs livres de segredos.
# ==============================================================================

BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_MAX_FILES="${BACKUP_MAX_FILES:-0}"
BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP:-1}"
BACKUP_MODE="${BACKUP_MODE:-auto}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16.8-alpine3.21}"
DOCUFLOW_PG_CONTAINER="${DOCUFLOW_PG_CONTAINER:-}"
DOCKER_NETWORK="${DOCKER_NETWORK:-}"
DB_NAME_LABEL="${POSTGRES_DB:-docuflow}"

TMP_DIR=""

log_json() {
  local level="$1"
  local message="$2"
  local extra="${3:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "$extra" ]; then
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-db-backup","message":"%s",%s}\n' \
      "$ts" "$level" "$message" "$extra"
  else
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-db-backup","message":"%s"}\n' \
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

require_non_negative_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    log_json "error" "Parametro numerico invalido: ${name}" >&2
    exit 1
  fi
}

require_positive_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    log_json "error" "Parametro numerico positivo invalido: ${name}" >&2
    exit 1
  fi
}

resolve_mode() {
  case "$BACKUP_MODE" in
    pg_dump|docker)
      printf '%s' "$BACKUP_MODE"
      ;;
    auto)
      if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
        printf 'pg_dump'
      elif command -v docker >/dev/null 2>&1; then
        printf 'docker'
      else
        log_json "error" "Nem pg_dump local nem docker disponivel para executar backup." >&2
        exit 1
      fi
      ;;
    *)
      log_json "error" "BACKUP_MODE invalido; use auto, pg_dump ou docker." >&2
      exit 1
      ;;
  esac
}

extract_db_label_from_url() {
  local url="$1"
  local no_query="${url%%\?*}"
  local candidate="${no_query##*/}"
  local safe
  safe=$(printf '%s' "$candidate" | tr -cd '[:alnum:]_-')
  if [ -n "$safe" ]; then
    printf '%s' "$safe"
  else
    printf 'docuflow'
  fi
}

run_pg_dump_local() {
  local out_file="$1"
  local err_file="$2"
  if [ -n "${DATABASE_URL:-}" ]; then
    pg_dump --format=custom --compress=9 --no-owner --no-privileges \
      --dbname="$DATABASE_URL" >"$out_file" 2>"$err_file"
  else
    pg_dump --format=custom --compress=9 --no-owner --no-privileges \
      -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" \
      -U "${PGUSER:-docuflow}" -d "${PGDATABASE:-docuflow}" \
      >"$out_file" 2>"$err_file"
  fi
}

run_pg_restore_list_local() {
  local dump_file="$1"
  local err_file="$2"
  pg_restore --list "$dump_file" >/dev/null 2>"$err_file"
}

run_pg_dump_docker() {
  local out_file="$1"
  local err_file="$2"
  if [ -n "$DOCUFLOW_PG_CONTAINER" ]; then
    docker exec -i "$DOCUFLOW_PG_CONTAINER" \
      pg_dump --format=custom --compress=9 --no-owner --no-privileges \
      -U "${PGUSER:-docuflow}" -d "${PGDATABASE:-docuflow}" \
      >"$out_file" 2>"$err_file"
    return $?
  fi

  local -a docker_args=(run --rm -i)
  if [ -n "$DOCKER_NETWORK" ]; then
    docker_args+=(--network "$DOCKER_NETWORK")
  fi

  if [ -n "${DATABASE_URL:-}" ]; then
    docker_args+=(-e DATABASE_URL "$POSTGRES_IMAGE" pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$DATABASE_URL")
  else
    docker_args+=(
      -e PGHOST="${PGHOST:-postgres}"
      -e PGPORT="${PGPORT:-5432}"
      -e PGUSER="${PGUSER:-docuflow}"
      -e PGDATABASE="${PGDATABASE:-docuflow}"
      -e PGPASSWORD="${PGPASSWORD:-}"
      "$POSTGRES_IMAGE"
      pg_dump --format=custom --compress=9 --no-owner --no-privileges
    )
  fi

  docker "${docker_args[@]}" >"$out_file" 2>"$err_file"
}

run_pg_restore_list_docker() {
  local dump_file="$1"
  local err_file="$2"
  local dump_dir
  local dump_base
  dump_dir=$(cd "$(dirname "$dump_file")" && pwd)
  dump_base=$(basename "$dump_file")

  if [ -n "$DOCUFLOW_PG_CONTAINER" ]; then
    docker exec -i "$DOCUFLOW_PG_CONTAINER" pg_restore --list <"$dump_file" >/dev/null 2>"$err_file"
    return $?
  fi

  docker run --rm -v "${dump_dir}:/backup:ro" "$POSTGRES_IMAGE" \
    pg_restore --list "/backup/${dump_base}" >/dev/null 2>"$err_file"
}

apply_retention_policy() {
  local backup_dir="$1"
  local current_file="$2"
  local retention_days="$3"
  local max_files="$4"
  local min_keep="$5"

  mapfile -t all_dumps < <(find "$backup_dir" -maxdepth 1 -type f -name 'docuflow-db-*.dump' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  local total=${#all_dumps[@]}
  local pruned=0

  if [ "$total" -le "$min_keep" ]; then
    printf '%s' "$pruned"
    return 0
  fi

  local now_epoch
  now_epoch=$(date +%s)
  local cutoff_epoch=$((now_epoch - retention_days * 86400))

  local idx=0
  for file_path in "${all_dumps[@]}"; do
    idx=$((idx + 1))
    if [ "$idx" -le "$min_keep" ]; then
      continue
    fi
    if [ "$file_path" = "$current_file" ]; then
      continue
    fi

    local should_delete=0
    if [ "$max_files" -gt 0 ] && [ "$idx" -gt "$max_files" ]; then
      should_delete=1
    fi

    if [ "$retention_days" -gt 0 ]; then
      local file_mtime
      file_mtime=$(stat -c '%Y' "$file_path" 2>/dev/null || printf '%s' "$now_epoch")
      if [ "$file_mtime" -lt "$cutoff_epoch" ]; then
        should_delete=1
      fi
    fi

    if [ "$should_delete" -eq 1 ]; then
      rm -f "$file_path" "${file_path}.sha256"
      pruned=$((pruned + 1))
    fi
  done

  printf '%s' "$pruned"
}

main() {
  require_positive_int "BACKUP_RETENTION_DAYS" "$BACKUP_RETENTION_DAYS"
  require_non_negative_int "BACKUP_MAX_FILES" "$BACKUP_MAX_FILES"
  require_positive_int "BACKUP_MIN_KEEP" "$BACKUP_MIN_KEEP"

  if [ -z "${DATABASE_URL:-}" ] && [ -z "$DOCUFLOW_PG_CONTAINER" ] && [ -z "${PGHOST:-}" ]; then
    log_json "error" "Defina DATABASE_URL, DOCUFLOW_PG_CONTAINER ou PGHOST/PGUSER/PGDATABASE." >&2
    exit 1
  fi

  local mode
  mode=$(resolve_mode)

  if [ -n "${DATABASE_URL:-}" ]; then
    DB_NAME_LABEL=$(extract_db_label_from_url "$DATABASE_URL")
  elif [ -n "${PGDATABASE:-}" ]; then
    DB_NAME_LABEL=$(printf '%s' "$PGDATABASE" | tr -cd '[:alnum:]_-')
    DB_NAME_LABEL="${DB_NAME_LABEL:-docuflow}"
  fi

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" || true
  BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)

  TMP_DIR=$(mktemp -d "${BACKUP_DIR}/.tmp-backup-XXXXXX")
  chmod 700 "$TMP_DIR"

  local timestamp
  timestamp=$(date -u +"%Y%m%dT%H%M%SZ")
  local base_name="docuflow-db-${DB_NAME_LABEL}-${timestamp}.dump"
  local tmp_dump="${TMP_DIR}/${base_name}"
  local tmp_err="${TMP_DIR}/pg_dump.err"
  local final_dump="${BACKUP_DIR}/${base_name}"
  local final_sha="${final_dump}.sha256"

  log_json "info" "Iniciando backup do PostgreSQL" "\"mode\":\"${mode}\",\"database\":\"${DB_NAME_LABEL}\""

  if [ "$mode" = "pg_dump" ]; then
    if ! run_pg_dump_local "$tmp_dump" "$tmp_err"; then
      local safe_err
      safe_err=$(sanitize_text "$(cat "$tmp_err" 2>/dev/null || true)")
      log_json "error" "Falha ao executar pg_dump local" "\"detail\":\"${safe_err}\"" >&2
      exit 1
    fi
  else
    if ! run_pg_dump_docker "$tmp_dump" "$tmp_err"; then
      local safe_err
      safe_err=$(sanitize_text "$(cat "$tmp_err" 2>/dev/null || true)")
      log_json "error" "Falha ao executar pg_dump via container" "\"detail\":\"${safe_err}\"" >&2
      exit 1
    fi
  fi

  if [ ! -s "$tmp_dump" ]; then
    log_json "error" "Arquivo de backup gerado esta vazio; operacao abortada." >&2
    exit 1
  fi

  if [ "$mode" = "pg_dump" ]; then
    if ! run_pg_restore_list_local "$tmp_dump" "$tmp_err"; then
      local safe_err
      safe_err=$(sanitize_text "$(cat "$tmp_err" 2>/dev/null || true)")
      log_json "error" "Validacao de integridade do dump falhou" "\"detail\":\"${safe_err}\"" >&2
      exit 1
    fi
  else
    if ! run_pg_restore_list_docker "$tmp_dump" "$tmp_err"; then
      local safe_err
      safe_err=$(sanitize_text "$(cat "$tmp_err" 2>/dev/null || true)")
      log_json "error" "Validacao de integridade do dump falhou" "\"detail\":\"${safe_err}\"" >&2
      exit 1
    fi
  fi

  chmod 600 "$tmp_dump"
  mv "$tmp_dump" "$final_dump"

  local sha256_value
  sha256_value=$(sha256sum "$final_dump" | awk '{print $1}')
  (cd "$BACKUP_DIR" && printf '%s  %s\n' "$sha256_value" "$(basename "$final_dump")" >"$final_sha")
  chmod 600 "$final_sha"

  local size_bytes
  size_bytes=$(stat -c '%s' "$final_dump")

  local pruned_count
  pruned_count=$(apply_retention_policy "$BACKUP_DIR" "$final_dump" "$BACKUP_RETENTION_DAYS" "$BACKUP_MAX_FILES" "$BACKUP_MIN_KEEP")

  log_json "info" "Backup do PostgreSQL concluido com sucesso" \
    "\"file\":\"${base_name}\",\"sizeBytes\":${size_bytes},\"sha256\":\"${sha256_value}\",\"prunedBackups\":${pruned_count}"
}

main "$@"
