# Guia de Backup e Restauração (DocuFlow)

Este guia define a política operacional e os procedimentos oficiais de cópia de segurança (*backup*) e recuperação de desastres (*disaster recovery*) do **DocuFlow** em implantação self-hosted.

---

## 1. Inventário do que Precisa Ser Salvo

Uma restauração íntegra e operacional depende de **três conjuntos interdependentes**. Recuperar apenas o banco de dados sem os binários ou sem a chave mestra resulta em documentos inacessíveis ou conectores criptografados ilegíveis.

| Componente | O que contém | Mecanismo / Localização | Observação crítica |
| --- | --- | --- | --- |
| **1. Banco de dados PostgreSQL** | Documentos, metadados, versões (`document_versions`), aprovações, permissões, usuários, conexões de storage (`storage_connections.encrypted_secret_payload`), tabela `file_objects` e trilha `audit_events` | `scripts/backup/backup-database.sh` (volume `docuflow_postgres_data`) | Gera dump custom (`-Fc`, comprimido) validado com `pg_restore --list` |
| **2. Arquivos binários locais** | Objetos armazenados no conector local sob `org/{organizationId}/documents/{documentId}/versions/{versionId}/{objectId}` | `scripts/backup/backup-files.sh` (volume `docuflow_storage_data` em `/var/lib/docuflow/storage` ou `STORAGE_LOCAL_ROOT`) | Obrigatório sempre que houver conector local ativo; acompanha `.manifest.sha256` |
| **3. Segredos e configuração externa** | `ENCRYPTION_KEY`, `ENCRYPTION_KEYRING` (se houve rotação), `SESSION_SECRET`, `DATABASE_URL` / `POSTGRES_PASSWORD`, configuração SMTP e domínio `APP_URL` | Arquivo `.env` de produção armazenado em cofre externo (`0600`) | **Nunca** gravados dentro do dump do PostgreSQL; sem `ENCRYPTION_KEY` os segredos S3/SMTP no banco não são decifrados |

### Objetos armazenados em S3 compatível (MinIO / provedor S3 externo)

O script `scripts/backup/backup-files.sh` captura apenas o armazenamento local (`STORAGE_LOCAL_ROOT` ou `STORAGE_DOCKER_VOLUME`). Quando a organização utiliza conectores S3 externos:

- Os objetos binários permanecem no bucket remoto e devem estar cobertos por **versionamento de bucket**, **política de retenção/imutabilidade do provedor** ou **replicação para bucket secundário**.
- Mesmo com S3 externo, o backup do **PostgreSQL** e da **`ENCRYPTION_KEY` / `ENCRYPTION_KEYRING`** continua obrigatório: o banco guarda a chave opaca (`file_objects.object_key`), o vínculo de conector (`storage_connection_id`), o checksum esperado (`checksum_sha256`) e as credenciais S3 cifradas (`encrypted_secret_payload`).

---

## 2. Consistência Coordenada Entre Banco, Arquivos e Segredos

Para impedir que registros restaurados no PostgreSQL apontem para objetos inexistentes no armazenamento local:

1. **Estabilize janelas de exclusão definitiva:** pause o container `worker` durante janelas críticas (ou agende o backup fora da janela do job de purga física de itens em `DELETE_PENDING`).
2. **Capture o PostgreSQL primeiro (`backup-database.sh`):** o schema do DocuFlow grava o objeto binário antes da confirmação final da versão (*append-only*) e só agenda exclusões definitivas assincronamente depois da transição para `DELETE_PENDING`. Capturando o banco antes do snapshot de arquivos, toda referência registrada no dump já existe no storage local no momento da cópia seguinte.
3. **Capture os arquivos locais imediatamente em seguida (`backup-files.sh`).**
4. **Reative o worker**, caso tenha sido pausado.
5. **Mantenha cópia separada dos segredos (`.env` / cofre corporativo):** nunca armazene `ENCRYPTION_KEY` ou `ENCRYPTION_KEYRING` no mesmo arquivo compactado ou sem criptografia junto aos dumps em mídia compartilhada.

### Sequência de execução recomendada (Docker Compose)

```bash
# 1. Pausar worker para impedir purga física concorrente durante a captura
docker compose --env-file .env -f infra/compose/docker-compose.yml stop worker

# 2. Backup do PostgreSQL primeiro (gera .dump + .sha256 com permissão 0600)
DATABASE_URL="postgresql://docuflow:<SENHA>@postgres:5432/docuflow" \
BACKUP_MODE=docker \
DOCKER_NETWORK=docuflow_docuflow_internal \
BACKUP_DIR=/var/backups/docuflow/postgres \
./scripts/backup/backup-database.sh

# Opcional quando o container PostgreSQL do compose estiver acessível diretamente por nome/ID:
# DOCUFLOW_PG_CONTAINER=<id_ou_nome_postgres> BACKUP_MODE=docker ...

# 3. Backup imediato do volume de arquivos locais (gera .tar.gz + .sha256 + .manifest.sha256)
STORAGE_DOCKER_VOLUME=docuflow_docuflow_storage_data \
BACKUP_DIR=/var/backups/docuflow/files \
./scripts/backup/backup-files.sh

# 4. Reativar o worker
docker compose --env-file .env -f infra/compose/docker-compose.yml start worker
```

Em instalações sem volume Docker (diretório direto no host), substitua `STORAGE_DOCKER_VOLUME` por `STORAGE_LOCAL_ROOT=/caminho/do/storage` e, se `pg_dump`/`pg_restore` estiverem instalados localmente no host, utilize `BACKUP_MODE=auto` ou `BACKUP_MODE=pg_dump`.

### Segurança e registro operacional dos backups

- Ambos os scripts aplicam `umask 077`, criam diretórios de destino com `chmod 700` e gravam dumps, arquivos e checksums com permissão `0600`.
- Os logs JSON emitidos por `backup-database.sh` e `restore-database.sh` passam por `sanitize_text`, mascarando URIs `postgresql://` e senhas (`password`, `PGPASSWORD`).
- Registre externamente para cada execução bem-sucedida: data/hora UTC, versão da stack (`DOCUFLOW_IMAGE_TAG`), identificador do destino off-site e os hashes SHA-256 gerados.

---

## 3. Periodicidade Recomendada (Parâmetros Operacionais)

Os intervalos abaixo são **parâmetros operacionais recomendados** e devem ser ajustados conforme o volume de uploads, criticidade dos documentos e capacidade de disco/rede da organização. **RPO (*Recovery Point Objective*) e RTO (*Recovery Time Objective*) oficiais só devem ser assumidos após medição em hardware e volume reais do ambiente de produção.**

| Rotina | Frequência sugerida (parâmetro operacional) | Escopo / Observação |
| --- | --- | --- |
| **Backup completo diário (DB + arquivos locais)** | `1x/dia` em janela de baixa movimentação (ex.: `02:00 UTC` via `cron` ou `systemd` timer no host) | Execução coordenada de `backup-database.sh` seguido de `backup-files.sh` |
| **Snapshot adicional antes de mudanças** | **Obrigatório sob demanda** antes de cada atualização de versão, migration de schema ou manutenção em volume | Conforme [Manual de Operação](./operations.md) (`migrate-entrypoint.sh`) |
| **Cópia externa (*off-site*)** | Após cada execução diária | Enviar `.dump`, `.tar.gz`, `.sha256` e `.manifest.sha256` para repositório fisicamente isolado; manter `.env`/chaves em cofre separado |
| **Teste completo de restore em ambiente limpo** | `1x/mês` (ou a cada release major/minor aplicada) | Executar procedimento da Seção 5 em instância/host isolado de homologação |
| **Verificação de integridade do acervo** | Periódica via job `verify-storage-integrity` (`headObject`) e trimestral com `verifyChecksum: true` | Conferência de existência, tamanho e SHA-256 no storage ativo |

---

## 4. Política de Retenção dos Backups

Tanto `scripts/backup/backup-database.sh` quanto `scripts/backup/backup-files.sh` implementam a mesma política configurável via variáveis de ambiente, executada somente após o novo snapshot ser validado e gravado com sucesso:

| Variável | Padrão no script | Papel operacional |
| --- | --- | --- |
| `BACKUP_RETENTION_DAYS` | `14` | Idade máxima em dias para manter backups antigos no diretório local de backup |
| `BACKUP_MAX_FILES` | `0` | Limite máximo de arquivos mantidos (`0` desabilita corte por quantidade; se `> 0`, remove excedentes ordenados do mais recente ao mais antigo) |
| `BACKUP_MIN_KEEP` | `1` | Quantidade mínima de backups mais recentes sempre preservada, mesmo que tenham idade superior a `BACKUP_RETENTION_DAYS` |

Regras garantidas pelos scripts durante a limpeza (*pruning*):

- O arquivo recém-gerado e os primeiros `BACKUP_MIN_KEEP` backups mais recentes **nunca** são removidos.
- Ao remover um backup expirado, o script remove junto seus arquivos auxiliares (`.dump.sha256` ou `.tar.gz.sha256` e `.manifest.sha256`).
- Recomenda-se combinar retenção curta local (ex.: `BACKUP_RETENTION_DAYS=7` a `14`) com retenção mais longa no destino *off-site* (ex.: cópias semanais/mensais conforme política de governança da organização).

---

## 5. Procedimento de Restauração em Ambiente Limpo

Este procedimento pressupõe um servidor novo ou uma instância completamente limpa (sem dados prévios ou com serviços da aplicação parados).

### Pré-requisitos de segurança antes de iniciar

1. **Interrompa `api` e `worker` (e `web`):** nenhuma requisição HTTP ou job em segundo plano deve escrever durante a restauração.
2. **Garanta PostgreSQL acessível e limpo (ou pronto para `--clean`):** se estiver provisionando um novo servidor via Docker Compose, suba apenas o serviço `postgres`:
   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml up -d postgres
   ```
3. **Recupere do cofre os segredos de produção (`PROTECTED_ENV_BACKUP`):** o arquivo `.env` deve conter exatamente a `ENCRYPTION_KEY` (e eventuais chaves antigas em `ENCRYPTION_KEYRING`) usadas quando as conexões de storage e SMTP foram gravadas.
4. **Se usar diretório local no host (bind mount):** garanta diretório limpo pertencente ao usuário não-root `node` (`UID 1000` / `GID 1000`). Em volumes Docker nomeados, `restore-files.sh` cria ou popula o volume informado em `STORAGE_DOCKER_VOLUME`.

### 5.1 Restauração coordenada completa (`restore-system.sh`)

```bash
CONFIRM_RESTORE=YES \
PROTECTED_ENV_BACKUP=/cofre/docuflow-prod.env \
TARGET_ENV_FILE=/opt/docuflow/.env \
DATABASE_URL="postgresql://docuflow:<SENHA>@postgres:5432/docuflow" \
RESTORE_MODE=docker \
DOCKER_NETWORK=docuflow_docuflow_internal \
DB_BACKUP_FILE=/var/backups/docuflow/postgres/docuflow-db-docuflow-YYYYMMDDTHHMMSSZ.dump \
STORAGE_DOCKER_VOLUME=docuflow_docuflow_storage_data \
FILES_BACKUP_ARCHIVE=/var/backups/docuflow/files/docuflow-files-YYYYMMDDTHHMMSSZ.tar.gz \
./scripts/restore/restore-system.sh
```

> Em instalações que usam exclusivamente conector S3 externo (sem arquivos locais), omita `FILES_BACKUP_ARCHIVE` (o script executará as etapas 1 e 2 e registrará a preservação do storage S3 configurado).

Ordem estrita executada por `scripts/restore/restore-system.sh`:

1. **Etapa 1/3 — Configuração e chave mestra:** copia `PROTECTED_ENV_BACKUP` para `TARGET_ENV_FILE` com permissão `0600` e valida que `ENCRYPTION_KEY` tem ao menos 32 caracteres (sem imprimir nenhum segredo no stdout/stderr).
2. **Etapa 2/3 — Banco de dados (`restore-database.sh`):** exige `CONFIRM_RESTORE=YES` (ou `--confirm-restore`), valida `.dump.sha256` (`VERIFY_CHECKSUM=true`), verifica integridade do arquivo com `pg_restore --list` e aplica `pg_restore --no-owner --no-privileges --exit-on-error --clean --if-exists`.
3. **Etapa 3/3 — Arquivos locais (`restore-files.sh`):** exige `CONFIRM_RESTORE=YES`, valida `.tar.gz.sha256`, extrai em diretório temporário de staging (`/tmp`), valida **cada arquivo individualmente** contra `.manifest.sha256` e só então copia para `STORAGE_LOCAL_ROOT` ou `STORAGE_DOCKER_VOLUME` (recusando destino não vazio, salvo se `RESTORE_CLEAN_TARGET=true`).

### 5.2 Uso individual dos scripts de restore

- **Somente PostgreSQL:**
  ```bash
  BACKUP_FILE=/var/backups/docuflow/postgres/docuflow-db-docuflow-YYYYMMDDTHHMMSSZ.dump \
  DATABASE_URL="postgresql://docuflow:<SENHA>@localhost:5432/docuflow" \
  ./scripts/restore/restore-database.sh --confirm-restore
  ```
- **Somente arquivos locais:**
  ```bash
  BACKUP_ARCHIVE=/var/backups/docuflow/files/docuflow-files-YYYYMMDDTHHMMSSZ.tar.gz \
  STORAGE_DOCKER_VOLUME=docuflow_docuflow_storage_data \
  RESTORE_CLEAN_TARGET=true \
  ./scripts/restore/restore-files.sh --confirm-restore
  ```

---

## 6. Validação Pós-Restauração e Teste em Ambiente Limpo

Após concluir a restauração, alinhe a versão da stack em `.env` (`DOCUFLOW_IMAGE_TAG` compatível com a versão que gerou o backup) e suba todos os serviços:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d api worker web
```

### Checklist obrigatório de verificação após restore

1. **Saúde da aplicação:** confirme HTTP `200` em `GET /api/v1/health/ready` (API + PostgreSQL) e em `GET /api/v1/admin/system-status` (autenticado como administrador).
2. **Decifração de conectores:** acesse **Administração -> Storage** ou verifique o health check da conexão restaurada; se falhar com `MASTER_KEY_INVALID` / erro de decifração, confira se `ENCRYPTION_KEY` (ou `ENCRYPTION_KEYRING`) corresponde exatamente ao `.env` original.
3. **Metadados, versões, permissões e auditoria:** confirme no sistema a presença dos documentos, versões históricas, tags, metadados tipados e eventos em `audit_events`.
4. **Download real e checksum SHA-256:** faça login como usuário autorizado, baixe ao menos um documento (incluindo versão anterior, se aplicável) e compare o hash `sha256sum` do arquivo baixado com o checksum registrado no banco/manifesto.
5. **Verificação abrangente de integridade (`verify-storage-integrity`):** execute a checagem do job `apps/worker/src/jobs/verify-storage-integrity.ts` garantindo `missingObjects = []`, `sizeMismatchObjects = []` e `checksumMismatchObjects = []`.

### Teste automatizado reproduzível em ambiente limpo

O repositório inclui a suíte operacional [tests/operations/backup-restore.spec.ts](../tests/operations/backup-restore.spec.ts), executada com `pnpm test:operations`, que repete todo o ciclo em ambiente isolado e limpo usando containers PostgreSQL efêmeros (*Testcontainers*) e diretórios temporários:

1. Provisiona um PostgreSQL de origem limpo e aplica todas as migrations Drizzle (`packages/database/drizzle`).
2. Cria organização, usuário, categoria com campos tipados, pasta, tag, conexão de storage com segredo cifrado pela `ENCRYPTION_KEY` (`createStorageSecretVault`), documento aprovado com duas versões imutáveis (`v1` e `v2`), objetos binários em storage local e eventos em `audit_events`.
3. Executa `scripts/backup/backup-database.sh` e `scripts/backup/backup-files.sh`, validando permissões `0600`, criação de `.sha256` e `.manifest.sha256` e ausência de vazamento da senha do banco ou da `ENCRYPTION_KEY` nos logs.
4. Sobe um **segundo PostgreSQL completamente vazio** e um **diretório de storage vazio**.
5. Valida negativamente que `restore-system.sh` recusa rodar quando `CONFIRM_RESTORE=NO`.
6. Executa `scripts/restore/restore-system.sh` com `CONFIRM_RESTORE=YES`.
7. Compara linha a linha entre origem e destino restaurado (`documents`, `document_versions`, `document_metadata`, `document_tags`, `file_objects`, `audit_events`), decifra novamente `storage_connections.encrypted_secret_payload` com a `ENCRYPTION_KEY` restaurada e lê ambas as versões via `@docuflow/storage-local` conferindo igualdade exata de bytes e SHA-256.
8. Valida negativamente que `restore-files.sh` aborta quando um snapshot `.tar.gz` é adulterado frente ao `.sha256`.

---

## 7. Limitações Explícitas do Mecanismo Atual (MVP 1.0)

- **Execução fora da interface web:** não há botão nem agendador de backup/restore dentro da UI administrativa; a automação recorrente depende de `cron`, `systemd` timer ou orquestrador do servidor host.
- **Snapshots completos de arquivos locais:** `backup-files.sh` gera arquivos `.tar.gz` completos a cada execução (sem deduplicação por bloco ou incremental binário), o que exige dimensionamento de disco proporcional ao acervo local multiplicado pela retenção.
- **Conectores S3 externos não são copiados por `backup-files.sh`:** ambientes que usam MinIO ou S3 de terceiros precisam configurar versionamento, *Object Lock* ou replicação diretamente no serviço de objetos.
- **Sem *Point-in-Time Recovery* (PITR) contínuo por WAL:** o procedimento padrão usa dumps lógicos consistentes (`pg_dump -Fc`), portanto alterações realizadas entre o último backup e uma falha catastrófica só serão preservadas se o administrador adicionar arquivamento contínuo de WAL externamente.
