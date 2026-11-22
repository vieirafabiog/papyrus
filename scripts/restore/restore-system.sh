#!/usr/bin/env bash
set -euo pipefail
umask 077

# ==============================================================================
# DocuFlow — Restauração coordenada completa
# Orquestra em ordem segura:
#   1) Validação/restauração de configuração protegida (.env) e ENCRYPTION_KEY
#   2) Restauração do PostgreSQL (restore-database.sh)
#   3) Restauração de arquivos locais (restore-files.sh)
# ==============================================================================

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

DB_BACKUP_FILE="${DB_BACKUP_FILE:-}"
FILES_BACKUP_ARCHIVE="${FILES_BACKUP_ARCHIVE:-}"
PROTECTED_ENV_BACKUP="${PROTECTED_ENV_BACKUP:-}"
TARGET_ENV_FILE="${TARGET_ENV_FILE:-.env}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-NO}"

log_json() {
  local level="$1"
  local message="$2"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"timestamp":"%s","level":"%s","service":"docuflow-system-restore","message":"%s"}\n' \
    "$ts" "$level" "$message"
}

validate_encryption_key_value() {
  local key_val="$1"
  if [ ${#key_val} -lt 32 ]; then
    log_json "error" "Chave mestra ENCRYPTION_KEY ausente ou menor que 32 caracteres." >&2
    exit 1
  fi
}

load_and_validate_protected_env() {
  if [ -n "$PROTECTED_ENV_BACKUP" ]; then
    if [ ! -f "$PROTECTED_ENV_BACKUP" ]; then
      log_json "error" "Arquivo de configuracao protegida nao encontrado." >&2
      exit 1
    fi
    local target_dir
    target_dir=$(dirname "$TARGET_ENV_FILE")
    mkdir -p "$target_dir"
    cp "$PROTECTED_ENV_BACKUP" "$TARGET_ENV_FILE"
    chmod 600 "$TARGET_ENV_FILE"
    log_json "info" "Configuracao protegida restaurada com permissao 0600"
  fi

  local key_candidate="${ENCRYPTION_KEY:-}"
  if [ -z "$key_candidate" ] && [ -f "$TARGET_ENV_FILE" ]; then
    key_candidate=$(grep -E '^ENCRYPTION_KEY=' "$TARGET_ENV_FILE" | head -n 1 | cut -d'=' -f2- | tr -d '"' | tr -d "'") || true
  fi

  validate_encryption_key_value "$key_candidate"
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --confirm-restore)
        CONFIRM_RESTORE="YES"
        ;;
      *)
        log_json "error" "Argumento desconhecido: ${arg}" >&2
        exit 1
        ;;
    esac
  done

  if [ "$CONFIRM_RESTORE" != "YES" ]; then
    log_json "error" "Defina CONFIRM_RESTORE=YES ou passe --confirm-restore para executar o restore completo." >&2
    exit 1
  fi

  if [ -z "$DB_BACKUP_FILE" ]; then
    log_json "error" "Defina DB_BACKUP_FILE com o dump do PostgreSQL." >&2
    exit 1
  fi

  log_json "info" "Etapa 1/3: Validando configuracao protegida e chave mestra"
  load_and_validate_protected_env

  log_json "info" "Etapa 2/3: Restaurando banco de dados PostgreSQL"
  BACKUP_FILE="$DB_BACKUP_FILE" CONFIRM_RESTORE="YES" \
    "${SCRIPT_DIR}/restore-database.sh"

  if [ -n "$FILES_BACKUP_ARCHIVE" ]; then
    log_json "info" "Etapa 3/3: Restaurando arquivos de armazenamento local"
    BACKUP_ARCHIVE="$FILES_BACKUP_ARCHIVE" CONFIRM_RESTORE="YES" \
      "${SCRIPT_DIR}/restore-files.sh"
  else
    log_json "info" "Etapa 3/3: FILES_BACKUP_ARCHIVE nao informado; mantendo armazenamento externo S3 configurado"
  fi

  log_json "info" "Restauracao coordenada concluida; execute verificacao de integridade e teste de download"
}

main "$@"
