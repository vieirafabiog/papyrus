# Manual de Operação, Atualização e Troubleshooting (papyrus)

Este documento reúne os procedimentos operacionais contínuos do **papyrus** em ambiente self-hosted: monitoramento de saúde, atualização segura, rollback, rotação de chaves e resolução de incidentes comuns.

---

## 1. Endpoints e Verificação de Saúde

| Serviço | Endpoint / Mecanismo | Uso recomendado |
| --- | --- | --- |
| `api` (liveness) | `GET http://api:3000/api/v1/health/live` | Healthcheck de container / reinício rápido |
| `api` (readiness) | `GET http://api:3000/api/v1/health/ready` | Verificação de disponibilidade do banco PostgreSQL |
| `api` (admin) | `GET /api/v1/admin/system-status` (autenticado) | Diagnóstico detalhado de banco, worker e conexões de storage na interface **Administração -> Status do Sistema** |
| `worker` (liveness) | `GET http://worker:3001/health/live` | Healthcheck do worker |
| `worker` (readiness) | `GET http://worker:3001/health/ready` | Verificação de runtime e dependências do worker |
| `web` | `GET http://web:8080/healthz` | Healthcheck do servidor estático Nginx não-root |

Consulta rápida do estado da stack:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml ps
docker compose --env-file .env -f infra/compose/docker-compose.yml logs --tail=100 api worker
```

---

## 2. Atualização Segura (Zero Surpresa)

1. **Backup prévio obrigatório (banco + arquivos):**
   Siga [docs/backup-restore.md](./backup-restore.md) executando `scripts/backup/backup-database.sh` e `scripts/backup/backup-files.sh` antes de alterar imagens ou schema.
2. **Defina a tag alvo no `.env`:**
   Atualize `PAPYRUS_IMAGE_TAG=<nova-versao>` (evite `latest` flutuante em produção).
3. **Baixe/compile as novas imagens sem interromper o PostgreSQL:**
   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml build api worker web
   ```
4. **Pause `api` e `worker` para evitar acessos contra schema intermediário:**
   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml stop api worker web
   ```
5. **Execute as migrations com lock advisory:**
   ```bash
   NODE_ENV=production ./scripts/maintenance/migrate-entrypoint.sh
   ```
6. **Suba a nova versão e valide a saúde:**
   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml up -d api worker web
   curl -fsS http://127.0.0.1:8080/healthz
   ```
7. Valide `/api/v1/health/ready`, autenticação e download de um documento existente.

---

## 3. Procedimento de Rollback

Se uma atualização apresentar falha funcional ou de compatibilidade:

1. **Interrompa os containers de aplicação:**
   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml stop api worker web
   ```
2. **Avalie se houve migration de banco executada:**
   - Caso **não** tenha havido alteração de schema nesta release, basta retornar `PAPYRUS_IMAGE_TAG=<versao-anterior>` no `.env` e subir `api worker web`.
   - Caso **tenha havido migration**, execute a restauração coordenada do backup pré-atualização seguindo [docs/backup-restore.md](./backup-restore.md) com `scripts/restore/restore-system.sh --confirm-restore` antes de subir a versão anterior das imagens. **Nunca** faça downgrade apenas dos binários deixando schema novo incompatível.
3. **Suba a versão anterior e valide:**
   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml up -d api worker web
   ```

---

## 4. Rotinas Periódicas Recomendadas

- **Backup diário automatizado:** agendar `scripts/backup/backup-database.sh` seguido de `scripts/backup/backup-files.sh` (quando usar volume local) com retenção configurada (`BACKUP_RETENTION_DAYS`, `BACKUP_MIN_KEEP`).
- **Teste de restore periódico:** executar mensalmente restauração completa em ambiente isolado validando checksum e download real de um documento.
- **Verificação de integridade do acervo:** executar periodicamente o job `verify-storage-integrity` (`apps/worker/src/jobs/verify-storage-integrity.ts`) por `headObject` e sob demanda com verificação de checksum SHA-256. Objetos não reconhecidos nunca são excluídos automaticamente e requerem revisão manual.
- **Rotação de chave mestra:** ao rotacionar `ENCRYPTION_KEY`, mantenha a chave antiga em `ENCRYPTION_KEYRING` até re-encriptar todos os segredos de storage/SMTP armazenados no banco.

---

## 5. Troubleshooting

### 1. Erro `EACCES` ou `Permission denied` ao gravar arquivos em `/var/lib/papyrus/storage`
- **Causa provável:** diretório montado do host pertence a `root` em vez do usuário `node` (`UID 1000`).
- **Solução:** pare `api` e `worker`, ajuste `chown -R 1000:1000 <caminho_no_host>` e `chmod 750 <caminho_no_host>`, depois reinicie os serviços.

### 2. API falha ao iniciar ou decifrar conector S3 (`MASTER_KEY_MISSING` / `MASTER_KEY_INVALID`)
- **Causa provável:** `ENCRYPTION_KEY` ausente no `.env`, menor que 32 bytes (64 hex) ou divergente da chave usada quando a conexão S3 foi salva.
- **Solução:** restaure a chave mestra original do cofre (ou adicione a chave antiga ao `ENCRYPTION_KEYRING` se houve rotação) e reinicie `api` e `worker`.

### 3. Erro `413 Payload Too Large` durante upload
- **Causa provável:** limite do proxy HTTPS (`PAPYRUS_PROXY_MAX_BODY_SIZE` em `infra/caddy/Caddyfile`) menor que `UPLOAD_MAX_BYTES` / `PROXY_MAX_BODY_BYTES`.
- **Solução:** alinhe `PAPYRUS_PROXY_MAX_BODY_SIZE` (>= `PROXY_MAX_BODY_BYTES`, padrão `52MiB` para uploads de `50MiB`) e recarregue o Caddy.

### 4. Uploads presos em quarentena (`QUARANTINED`)
- **Causa provável:** scanner ClamAV indisponível, timeout ou assinatura detectada. O papyrus opera em **falha fechada** e não libera arquivos não verificados para download.
- **Solução:** verifique a saúde do serviço `clamav` (`clamdcheck.sh`) ou conectividade TCP na porta `3310`, e consulte os eventos de auditoria e logs do worker.

### 5. Migration runner falha com timeout de lock (`MigrationLockTimeoutError`)
- **Causa provável:** outra instância de migration em execução simultânea ou conexão encerrada abruptamente mantendo sessão aberta no PostgreSQL.
- **Solução:** verifique conexões ativas em `pg_stat_activity` e `pg_locks` (`locktype = 'advisory'`) antes de repetir ou ajustar `MIGRATION_LOCK_TIMEOUT_MS`.

### 6. Erro `403 CSRF` ou falha de login HTTPS atrás do proxy
- **Causa provável:** divergência entre `APP_URL` no `.env` e o domínio servido pelo Caddy, ou falta de encaminhamento do `Host` original.
- **Solução:** confirme `APP_URL=https://<seu-dominio>` igual ao cabeçalho `Origin`/`Host` do navegador e utilize `infra/caddy/Caddyfile` sem alterar o encaminhamento padrão de `Host` e `X-Forwarded-Proto`.
