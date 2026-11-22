#!/usr/bin/env bash
set -euo pipefail
umask 077

# ==============================================================================
# DocuFlow — Restauração segura de arquivos locais
# Valida checksum do arquivo .tar.gz, extrai em staging temporário, valida
# integridade por arquivo contra o .manifest.sha256 e aplica no destino.
# ==============================================================================

BACKUP_ARCHIVE="${BACKUP_ARCHIVE:-}"
STORAGE_LOCAL_ROOT="${STORAGE_LOCAL_ROOT:-./data/storage}"
STORAGE_DOCKER_VOLUME="${STORAGE_DOCKER_VOLUME:-}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.21}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-NO}"
RESTORE_CLEAN_TARGET="${RESTORE_CLEAN_TARGET:-false}"
VERIFY_CHECKSUM="${VERIFY_CHECKSUM:-true}"

TMP_DIR=""

usage() {
  cat <<'EOF'
Uso: BACKUP_ARCHIVE=/caminho/docuflow-files-*.tar.gz CONFIRM_RESTORE=YES ./scripts/restore/restore-files.sh
Variáveis:
  BACKUP_ARCHIVE        Caminho obrigatório do arquivo .tar.gz
  CONFIRM_RESTORE       Deve ser YES para autorizar restauração no destino
  STORAGE_LOCAL_ROOT    Diretório local alvo (padrão ./data/storage)
  STORAGE_DOCKER_VOLUME Nome do volume Docker alvo (alternativa a STORAGE_LOCAL_ROOT)
  RESTORE_CLEAN_TARGET  true | false (padrão false; exige diretório vazio se false)
  VERIFY_CHECKSUM       true (padrão) | false
EOF
}

log_json() {
  local level="$1"
  local message="$2"
  local extra="${3:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "$extra" ]; then
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-files-restore","message":"%s",%s}\n' \
      "$ts" "$level" "$message" "$extra"
  else
    printf '{"timestamp":"%s","level":"%s","service":"docuflow-files-restore","message":"%s"}\n' \
      "$ts" "$level" "$message"
  fi
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

restore_to_directory() {
  local abs_archive="$1"
  local manifest_file="$2"
  local target_dir="$3"

  mkdir -p "$target_dir"
  local abs_target
  abs_target=$(cd "$target_dir" && pwd)

  if [ -n "$(find "$abs_target" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
    if [ "$RESTORE_CLEAN_TARGET" != "true" ]; then
      log_json "error" "Diretorio de destino nao esta vazio; use diretorio limpo ou RESTORE_CLEAN_TARGET=true." >&2
      exit 1
    fi
  fi

  local staging_dir="${TMP_DIR}/staging"
  mkdir -p "$staging_dir"
  tar -xzf "$abs_archive" -C "$staging_dir"

  if [ "$VERIFY_CHECKSUM" = "true" ] && [ -f "$manifest_file" ]; then
    if ! (cd "$staging_dir" && sha256sum -c "$manifest_file" >/dev/null 2>&1); then
      log_json "error" "Falha na verificacao SHA-256 dos arquivos extraidos contra o manifesto." >&2
      exit 1
    fi
  fi

  if [ "$RESTORE_CLEAN_TARGET" = "true" ]; then
    find "$abs_target" -mindepth 1 -delete
  fi

  tar -cf - -C "$staging_dir" . | tar -xf - -C "$abs_target"
  local restored_count
  restored_count=$(find "$abs_target" -type f | wc -l | tr -d ' ')
  log_json "info" "Restauracao de arquivos locais concluida" "\"mode\":\"directory\",\"restoredFiles\":${restored_count}"
}

restore_to_docker_volume() {
  local abs_archive="$1"
  local manifest_file="$2"
  local volume_name="$3"

  if ! command -v docker >/dev/null 2>&1; then
    log_json "error" "CLI docker nao encontrada para restaurar volume." >&2
    exit 1
  fi

  if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
    docker volume create "$volume_name" >/dev/null
  fi

  local archive_dir
  archive_dir=$(dirname "$abs_archive")
  local archive_base
  archive_base=$(basename "$abs_archive")
  local manifest_base=""
  if [ -f "$manifest_file" ]; then
    manifest_base=$(basename "$manifest_file")
  fi

  docker run --rm \
    -v "${volume_name}:/target" \
    -v "${archive_dir}:/backup:ro" \
    -e VERIFY_CHECKSUM="$VERIFY_CHECKSUM" \
    -e RESTORE_CLEAN_TARGET="$RESTORE_CLEAN_TARGET" \
    -e ARCHIVE_BASE="$archive_base" \
    -e MANIFEST_BASE="$manifest_base" \
    "$ALPINE_IMAGE" \
    sh -eu -c '
      if [ -n "$(find /target -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
        if [ "$RESTORE_CLEAN_TARGET" != "true" ]; then
          echo "Volume alvo nao esta vazio e RESTORE_CLEAN_TARGET != true" >&2
          exit 1
        fi
        find /target -mindepth 1 -delete
      fi
      mkdir -p /tmp/staging
      tar -xzf "/backup/${ARCHIVE_BASE}" -C /tmp/staging
      if [ "$VERIFY_CHECKSUM" = "true" ] && [ -n "$MANIFEST_BASE" ] && [ -f "/backup/${MANIFEST_BASE}" ]; then
        (cd /tmp/staging && sha256sum -c "/backup/${MANIFEST_BASE}" >/dev/null)
      fi
      tar -cf - -C /tmp/staging . | tar -xf - -C /target
    '

  log_json "info" "Restauracao de volume Docker concluida" "\"mode\":\"docker-volume\",\"volume\":\"${volume_name}\""
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

  if [ -z "$BACKUP_ARCHIVE" ] || [ ! -f "$BACKUP_ARCHIVE" ]; then
    log_json "error" "BACKUP_ARCHIVE ausente ou inexistente." >&2
    exit 1
  fi

  if [ "$CONFIRM_RESTORE" != "YES" ]; then
    log_json "error" "Confirmacao obrigatoria ausente: defina CONFIRM_RESTORE=YES ou passe --confirm-restore." >&2
    exit 1
  fi

  local abs_archive
  abs_archive="$(cd "$(dirname "$BACKUP_ARCHIVE")" && pwd)/$(basename "$BACKUP_ARCHIVE")"
  local archive_dir
  archive_dir=$(dirname "$abs_archive")
  local archive_base
  archive_base=$(basename "$abs_archive")
  local archive_sha="${abs_archive}.sha256"
  local manifest_file="${abs_archive%.tar.gz}.manifest.sha256"

  if [ "$VERIFY_CHECKSUM" = "true" ]; then
    if [ ! -f "$archive_sha" ]; then
      log_json "error" "Arquivo .sha256 do snapshot de arquivos nao encontrado." >&2
      exit 1
    fi
    if ! (cd "$archive_dir" && sha256sum -c "$(basename "$archive_sha")" >/dev/null 2>&1); then
      log_json "error" "Falha na verificacao SHA-256 do snapshot de arquivos." >&2
      exit 1
    fi
  fi

  TMP_DIR=$(mktemp -d /tmp/docuflow-files-restore-XXXXXX)
  chmod 700 "$TMP_DIR"

  log_json "info" "Iniciando restauracao de arquivos locais" "\"file\":\"${archive_base}\""

  if [ -n "$STORAGE_DOCKER_VOLUME" ]; then
    restore_to_docker_volume "$abs_archive" "$manifest_file" "$STORAGE_DOCKER_VOLUME"
  else
    restore_to_directory "$abs_archive" "$manifest_file" "$STORAGE_LOCAL_ROOT"
  fi
}

main "$@"
