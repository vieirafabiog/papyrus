# Changelog

Todas as mudanças notáveis do **DocuFlow** são documentadas neste arquivo seguindo o formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e **Versionamento Semântico (SemVer 2.0.0)**.

---

## [1.0.0-rc.1] — 2026-11-23

Primeira versão candidata de release (*Release Candidate*) do **DocuFlow 1.0 Self-Hosted** para implantação on-premises / servidor próprio.

### Adicionado
- **Gestão documental completa:** pastas hierárquicas com escopo, categorias com campos personalizados tipados (`TEXT`, `NUMBER`, `DATE`, `BOOLEAN`, `SINGLE_SELECT`, `MULTI_SELECT`), etiquetas transversais, upload seguro em streaming com validação de MIME por assinatura e checksum SHA-256, quarentena/verificação antimalware (ClamAV `INSTREAM` em falha fechada) e versões imutáveis (*append-only*) com restauração não destrutiva.
- **Busca e interface `pt-BR`:** pesquisa global e filtragem/ordenação/paginação executadas diretamente no PostgreSQL, pré-visualização inline privada de PDFs e imagens sem URLs públicas permanentes e tema corporativo em Material UI inspirado em Material Design 3.
- **Governança, fluxos e vencimentos:** controle de acesso por papéis e escopos (`GLOBAL`, `CATEGORY`, `FOLDER`, `DOCUMENT`) com precedência `DENY > ALLOW`, fluxos sequenciais de revisão/aprovação vinculados à versão exata (`document_version_id`), monitoramento de vencimentos por fuso horário da organização, retenção, *legal hold*, lixeira documental com restauração dentro da carência, purga física idempotente e trilha de auditoria *append-only* (`audit_events`).
- **Armazenamento abstrato e cofre de segredos:** conectores com paridade de contrato para **Filesystem Local** e **S3 compatível** (testado com MinIO), seleção por categoria e criptografia AES-256-GCM de credenciais com `ENCRYPTION_KEY` / `ENCRYPTION_KEYRING`.
- **Empacotamento Self-Hosted e operação:** Docker Compose com rede interna isolada (`docuflow_internal`), containers não-root (`api`, `worker`, `web`), proxy reverso HTTPS Caddy de referência, scripts de backup/restauração coordenada (`scripts/backup/*`, `scripts/restore/*`) e executor seguro de migrations com advisory lock (`scripts/maintenance/migrate-entrypoint.sh`).

### Migrations Incluídas
As migrations SQL do Drizzle em `packages/database/drizzle` (`0000_initial.sql` até `0003_eminent_odin.sql`) acompanham tanto o pacote `@docuflow/database` quanto a imagem de runtime `docuflow-api:1.0.0-rc.1` (`/app/packages/database/drizzle` e `/app/scripts/maintenance/migrate-entrypoint.sh`).

### Imagens Fixadas da Release
| Componente / Serviço | Referência fixada | Observação |
| --- | --- | --- |
| `docuflow-api` | `docuflow-api:1.0.0-rc.1` (`node:22.14.0-alpine3.21`) | Usuário `node` (UID `1000`), inclui migrations SQL |
| `docuflow-worker` | `docuflow-worker:1.0.0-rc.1` (`node:22.14.0-alpine3.21`) | Usuário `node` (UID `1000`) |
| `docuflow-web` | `docuflow-web:1.0.0-rc.1` (`nginxinc/nginx-unprivileged:1.27.5-alpine3.21`) | Usuário não-root `101`, estáticos `apps/web/dist` |
| `postgres` | `postgres:16.8-alpine3.21` | Banco relacional principal |
| `clamav` *(profile opcional)* | `clamav/clamav-debian:1.4.2` | Scanner antivírus de laboratório/local |
| `minio` *(profile opcional)* | `minio/minio:RELEASE.2025-02-28T09-55-16Z` | Armazenamento S3 local de laboratório |

### Estratégia de Atualização, Tags e Rollback
- **Convenção de tags:** releases utilizam tags Git anotadas no formato `vMAJOR.MINOR.PATCH` (ou `vMAJOR.MINOR.PATCH-rc.N` para pré-releases, como `v1.0.0-rc.1`), correspondendo à tag de container `DOCUFLOW_IMAGE_TAG=1.0.0-rc.1` (sem uso de `latest` flutuante em produção).
- **Procedimento padrão de atualização:**
  1. Executar backup coordenado obrigatório de banco (`scripts/backup/backup-database.sh`), arquivos (`scripts/backup/backup-files.sh`) e cópia segura do `.env`.
  2. Atualizar `DOCUFLOW_IMAGE_TAG` para a nova versão fixada e construir/baixar as novas imagens (`docker compose --env-file .env -f infra/compose/docker-compose.yml build`).
  3. Parar `api`, `worker` e `web` (`stop api worker web`) para evitar acesso concorrente durante mudanças de schema.
  4. Executar migrations dentro do container `api` com advisory lock (`docker compose --env-file .env -f infra/compose/docker-compose.yml run --rm --no-deps api sh /app/scripts/maintenance/migrate-entrypoint.sh`).
  5. Subir os serviços atualizados (`up -d api worker web`) e validar `GET /api/v1/health/ready`, login e download de documento existente.
- **Rollback:** caso a release não tenha alterado schema, retorne `DOCUFLOW_IMAGE_TAG` para a versão anterior e suba `api worker web`; caso tenha executado migrations, restaure o backup pré-atualização via `scripts/restore/restore-system.sh --confirm-restore` antes de voltar as imagens anteriores.

### Limitações Conhecidas e Aceitação
- **Sem versão anterior publicada:** `1.0.0-rc.1` é a primeira release candidate pública do DocuFlow Self-Hosted (instalações novas partem das migrations `0000`–`0003`, e atualizações de pré-builds com migrations anteriores aplicam incrementalmente o restante via advisory lock).
- Consulte [docs/known-limitations.md](./docs/known-limitations.md) para a lista completa de limitações conhecidas (incluindo composição pendente de bootstrap completo em `server.ts`/`worker.ts` e escopo estritamente self-hosted de organização única sem OCR, OIDC/LDAP, Azure/GCS ou assinatura eletrônica) e [docs/release-checklist.md](./docs/release-checklist.md) para as evidências de aceitação do MVP.
