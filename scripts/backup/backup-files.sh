#!/usr/bin/env bash
set -euo pipefail
umask 077

# ==============================================================================
# DocuFlow — Backup de arquivos do armazenamento local
# Gera snapshot compactado (.tar.gz) preservando estrutura de diretórios e
# integridade via manifesto SHA-256 por arquivo e checksum do arquivo final.
#
# Consistência com PostgreSQL (backup-database.sh):
#   Execute backup-database.sh primeiro e backup-files.sh imediatamente depois
#   (preferencialmente com o worker de purga física pausado ou em janela tranquila).
#   Como novas versões são append-only antes de exclusões definitivas, essa ordem
#   evita referências no banco apontando para objetos já removidos do disco.
# ==============================================================================

BACKUP_DIR="${BACKUP_DIR:-./backups/files}"
STORAGE_LOCAL_ROOT="${STORAGE_LOCAL_ROOT:-./data/storage}"
STORAGE_DOCKER_VOLUME="${STORAGE_DOCKER_VOLUME:-}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.21}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_MAX_FILES="${BACKUP_MAX_FILES:-0}"
BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP:-1}"

TMP_DIR=""

log_json() {
  local level="$1"
  local message="$2"
  local extra="${3:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "$extra" ]; then
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-files-backup","message":"%s",%s}\n' \
      "$ts" "$level" "$message" "$extra"
  else
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-files-backup","message":"%s"}\n' \
      "$ts" "$level" "$message"
  fi
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

apply_retention_policy() {
  local backup_dir="$1"
  local current_file="$2"
  local retention_days="$3"
  local max_files="$4"
  local min_keep="$5"

  mapfile -t all_archives < <(find "$backup_dir" -maxdepth 1 -type f -name 'docuflow-files-*.tar.gz' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  local total=${#all_archives[@]}
  local pruned=0

  if [ "$total" -le "$min_keep" ]; then
    printf '%s' "$pruned"
    return 0
  fi

  local now_epoch
  now_epoch=$(date +%s)
  local cutoff_epoch=$((now_epoch - retention_days * 86400))

  local idx=0
  for file_path in "${all_archives[@]}"; do
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
      local base_prefix="${file_path%.tar.gz}"
      rm -f "$file_path" "${file_path}.sha256" "${base_prefix}.manifest.sha256"
      pruned=$((pruned + 1))
    fi
  done

  printf '%s' "$pruned"
}

backup_from_directory() {
  local source_dir="$1"
  local out_archive="$2"
  local out_manifest="$3"

  if [ ! -d "$source_dir" ]; then
    log_json "error" "Diretorio de armazenamento local nao encontrado" "\"path\":\"${source_dir}\"" >&2
    exit 1
  fi

  local abs_source
  abs_source=$(cd "$source_dir" && pwd)

  (
    cd "$abs_source"
    find . -type f | LC_ALL=C sort | while IFS= read -r rel_file; do
      sha256sum "$rel_file"
    done >"$out_manifest"
    tar -czf "$out_archive" .
  )
}

backup_from_docker_volume() {
  local volume_name="$1"
  local out_archive="$2"
  local out_manifest="$3"

  if ! command -v docker >/dev/null 2>&1; then
    log_json "error" "CLI docker nao encontrada para snapshot de volume." >&2
    exit 1
  fi

  if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
    log_json "error" "Volume Docker nao encontrado" "\"volume\":\"${volume_name}\"" >&2
    exit 1
  fi

  docker run --rm \
    -v "${volume_name}:/source:ro" \
    -v "${TMP_DIR}:/backup" \
    "$ALPINE_IMAGE" \
    sh -eu -c '
      cd /source
      find . -type f | LC_ALL=C sort | while IFS= read -r rel_file; do
        sha256sum "$rel_file"
      done > "/backup/$(basename "$1")"
      tar -czf "/backup/$(basename "$2")" .
    ' -- "$out_manifest" "$out_archive"
}

main() {
  require_positive_int "BACKUP_RETENTION_DAYS" "$BACKUP_RETENTION_DAYS"
  require_non_negative_int "BACKUP_MAX_FILES" "$BACKUP_MAX_FILES"
  require_positive_int "BACKUP_MIN_KEEP" "$BACKUP_MIN_KEEP"

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" || true
  BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)

  TMP_DIR=$(mktemp -d "${BACKUP_DIR}/.tmp-files-backup-XXXXXX")
  chmod 700 "$TMP_DIR"

  local timestamp
  timestamp=$(date -u +"%Y%m%dT%H%M%SZ")
  local base_prefix="docuflow-files-${timestamp}"
  local archive_name="${base_prefix}.tar.gz"
  local tmp_archive="${TMP_DIR}/${archive_name}"
  local tmp_manifest="${TMP_DIR}/${base_prefix}.manifest.sha256"
  local final_archive="${BACKUP_DIR}/${archive_name}"
  local final_archive_sha="${final_archive}.sha256"
  local final_manifest="${BACKUP_DIR}/${base_prefix}.manifest.sha256"

  local mode="directory"
  if [ -n "$STORAGE_DOCKER_VOLUME" ]; then
    mode="docker-volume"
  fi

  log_json "info" "Iniciando backup de arquivos locais" "\"mode\":\"${mode}\""

  if [ "$mode" = "docker-volume" ]; then
    backup_from_docker_volume "$STORAGE_DOCKER_VOLUME" "$tmp_archive" "$tmp_manifest"
  else
    backup_from_directory "$STORAGE_LOCAL_ROOT" "$tmp_archive" "$tmp_manifest"
  fi

  if [ ! -s "$tmp_archive" ]; then
    log_json "error" "Arquivo tar.gz gerado esta vazio; operacao abortada." >&2
    exit 1
  fi

  if ! tar -tzf "$tmp_archive" >/dev/null 2>&1; then
    log_json "error" "Validacao do arquivo compactado falhou." >&2
    exit 1
  fi

  local file_count
  file_count=$(wc -l <"$tmp_manifest" | tr -d ' ')

  chmod 600 "$tmp_archive" "$tmp_manifest"
  mv "$tmp_archive" "$final_archive"
  mv "$tmp_manifest" "$final_manifest"

  local archive_sha256
  archive_sha256=$(sha256sum "$final_archive" | awk '{print $1}')
  (cd "$BACKUP_DIR" && printf '%s  %s\n' "$archive_sha256" "$archive_name" >"$final_archive_sha")
  chmod 600 "$final_archive_sha"

  local size_bytes
  size_bytes=$(stat -c '%s' "$final_archive")

  local pruned_count
  pruned_count=$(apply_retention_policy "$BACKUP_DIR" "$final_archive" "$BACKUP_RETENTION_DAYS" "$BACKUP_MAX_FILES" "$BACKUP_MIN_KEEP")

  log_json "info" "Backup de arquivos locais concluido com sucesso" \
    "\"file\":\"${archive_name}\",\"fileCount\":${file_count},\"sizeBytes\":${size_bytes},\"sha256\":\"${archive_sha256}\",\"prunedBackups\":${pruned_count}"
}

main "$@"
