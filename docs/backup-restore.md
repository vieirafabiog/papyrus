# Procedimento de Backup e Restauração (DocuFlow)

Este guia descreve a estratégia oficial de cópia de segurança e recuperação de desastres (*disaster recovery*) do **DocuFlow**.

## 1. Inventário do que precisa ser salvo

Para garantir recuperação completa sem perda de documentos nem perda de acesso a conectores S3/SMTP configurados na administração:

1. **Banco de dados PostgreSQL** (`scripts/backup/backup-database.sh`): contém documentos, metadados, versões, aprovações, permissões, usuários, conexões de storage (com segredos criptografados) e trilha de auditoria imutável (`audit_events`).
2. **Arquivos binários em armazenamento local** (`scripts/backup/backup-files.sh`): conteúdo do volume `docuflow_storage_data` (`/var/lib/docuflow/storage`) preservando a hierarquia `org/{organizationId}/documents/{documentId}/versions/{versionId}/{objectId}`.
   - *Nota:* quando a organização utiliza storage S3 externo, o versionamento e a redundância dos objetos ficam no bucket S3; ainda assim é obrigatório manter backup do banco e da chave mestra.
3. **Configuração protegida e Chave Mestra externa (`ENCRYPTION_KEY` / `ENCRYPTION_KEYRING`)**:
   - **CRÍTICO:** A chave mestra (`ENCRYPTION_KEY`, 32 bytes em hex ou base64) **nunca** é gravada no banco de dados nem nos dumps `.dump`. Sem a chave mestra correta (e chaves anteriores em `ENCRYPTION_KEYRING`, caso tenha havido rotação), a API e o worker não conseguirão decifrar credenciais de conectores S3 ou SMTP após a restauração.
   - Armazene o arquivo `.env` de produção (ou o conteúdo criptografado no cofre corporativo / gerenciador de segredos) com permissão restrita (`0600`) em local fisicamente separado dos backups de banco.

---

## 2. Rotina de Backup Coordenada

Para manter consistência entre referências no PostgreSQL e objetos no filesystem local:

```bash
# 1. Opcional em janelas críticas: pausar apenas o worker de purga física
docker compose -f infra/compose/docker-compose.yml stop worker

# 2. Backup do PostgreSQL primeiro
DATABASE_URL="postgresql://docuflow:***@postgres:5432/docuflow" \
BACKUP_DIR=/var/backups/docuflow/postgres \
./scripts/backup/backup-database.sh

# 3. Backup do volume/diretório local imediatamente em seguida
STORAGE_DOCKER_VOLUME=docuflow_docuflow_storage_data \
BACKUP_DIR=/var/backups/docuflow/files \
./scripts/backup/backup-files.sh

# 4. Reativar o worker
docker compose -f infra/compose/docker-compose.yml start worker
```

Cada execução gera automaticamente arquivos `.sha256` e `.manifest.sha256` com permissão `0600` e aplica a política de retenção configurada.

---

## 3. Procedimento de Restauração em Ambiente Limpo

Antes de restaurar em um servidor novo:

1. Garanta que os serviços `api` e `worker` estejam parados para impedir escrita concorrente durante o restore.
2. Recupere do cofre seguro o arquivo `.env` protegido contendo `ENCRYPTION_KEY`, `SESSION_SECRET` e credenciais do banco.

### Restauração coordenada automática (`restore-system.sh`)

```bash
CONFIRM_RESTORE=YES \
PROTECTED_ENV_BACKUP=/cofre/docuflow-prod.env \
TARGET_ENV_FILE=/opt/docuflow/.env \
DATABASE_URL="postgresql://docuflow:***@localhost:5432/docuflow" \
DB_BACKUP_FILE=/var/backups/docuflow/postgres/docuflow-db-docuflow-YYYYMMDDTHHMMSSZ.dump \
STORAGE_DOCKER_VOLUME=docuflow_docuflow_storage_data \
FILES_BACKUP_ARCHIVE=/var/backups/docuflow/files/docuflow-files-YYYYMMDDTHHMMSSZ.tar.gz \
./scripts/restore/restore-system.sh
```

O script executa em ordem estrita:

1. Restaura a configuração protegida com permissão `0600` e valida a presença da chave mestra `ENCRYPTION_KEY` (sem imprimir segredos nos logs).
2. Valida o `.sha256` do dump do PostgreSQL, verifica integridade via `pg_restore --list` e aplica o restore com `--clean --if-exists --exit-on-error` (`scripts/restore/restore-database.sh`).
3. Valida o `.sha256` do snapshot `.tar.gz`, extrai em staging temporário, verifica cada arquivo contra o `.manifest.sha256` e popula o volume ou diretório local limpo (`scripts/restore/restore-files.sh`).

### Scripts individuais

- **Somente banco:** `scripts/restore/restore-database.sh --confirm-restore`
- **Somente arquivos:** `scripts/restore/restore-files.sh --confirm-restore`

---

## 4. Validação Pós-Restauração

Após subir a stack (`postgres`, `api`, `worker`, `web`):

1. Confirme a saúde da API e do banco em `GET /api/v1/health/ready`.
2. Autentique-se como usuário autorizado e execute o **download de pelo menos um documento restaurado**, confirmando que o HTTP `200` e o checksum SHA-256 do arquivo baixado conferem integralmente.
3. Em seguida, agende ou execute a verificação de consistência do acervo (`verify-storage-integrity`) para confirmar 100% de aderência entre registros do banco e objetos armazenados.
