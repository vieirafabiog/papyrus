# Limitações Conhecidas e Notas de Atualização — papyrus 1.0.0-rc.1

Este documento registra as **limitações técnicas e funcionais conhecidas** da versão candidata **`1.0.0-rc.1`** (tag `v1.0.0-rc.1`), as capacidades explicitamente **fora do escopo** do MVP 1.0 e as instruções de atualização aplicáveis.

---

## 1. Capacidades Fora do Escopo (Não Entregues na `1.0.0-rc.1`)

As funcionalidades abaixo pertencem ao roadmap pós-MVP e **não** estão presentes nem devem ser anunciadas nesta release:

- **SaaS multi-tenant e RLS multi-cliente:** implantação dedicada a uma única organização por instância self-hosted.
- **Autenticação externa / SSO (`OIDC`, `LDAP`, `SAML`):** apenas autenticação local com Argon2id e sessões server-side (`MFA/TOTP` também não está incluído).
- **OCR e indexação por conteúdo completo:** a busca utiliza título, nome de arquivo, categoria, pasta, status, responsável, datas e tags no PostgreSQL.
- **Assinatura eletrônica e edição colaborativa em tempo real.**
- **Conectores adicionais de storage (`Azure Blob`, `Google Cloud Storage`):** o enum no modelo reserva identificadores futuros, mas apenas **`local`** e **`s3`** possuem adaptadores ativos.
- **Migração automática de objetos entre conectores de armazenamento.**

---

## 2. Limitações Técnicas e Operacionais Conhecidas

### 2.1 Composição padrão dos processos standalone (`server.ts` e `worker.ts`)
- Os módulos de domínio, rotas HTTP, repositórios Drizzle e handlers assíncronos de worker (`process-upload`, `purge-deleted-documents`, `verify-storage-integrity`, `expiration-notifications`, `cleanup-uploads`) estão implementados, integrados via `buildApp(options)` e comprovados nas suítes integradas e E2E.
- **Limitação na `1.0.0-rc.1`:** o entrypoint padrão `apps/api/src/server.ts` inicia `buildApp({ logger: true })` apenas com segurança HTTP e rotas de saúde (`/api/v1/health/live` e `/api/v1/health/ready`), sem compor automaticamente o bootstrap de conexão PostgreSQL/repositórios por variáveis de ambiente; da mesma forma, `apps/worker/src/worker.ts` inicia `createWorkerRuntime` e os endpoints de saúde `/health/live` e `/health/ready`, aguardando composição explícita dos loops de fila para execução contínua em produção.

### 2.2 Conectores de Armazenamento (`local` e `s3`)
- **`multipartUpload` e `serverSideCopy`:** retornam `false` nas capacidades atuais; uploads respeitam o teto em stream único (`UPLOAD_MAX_BYTES`, até `1 GiB` na configuração, padrão `50 MiB`).
- **Homologação S3:** o conector `@papyrus/storage-s3` foi comprovado contra **MinIO** em testes integrados de contrato e URL assinada; provedores S3 comerciais em nuvem (AWS S3, Cloudflare R2, etc.) exigem teste de saúde e upload/download prévio pelo operador com suas credenciais antes de uso em produção.
- **Conexões inativas:** desativar uma conexão (`INACTIVE`) bloqueia novos uploads e downloads de arquivos gravados nela até reativação ou substituição futura; apenas a purga física (`allowInactive: true`) continua permitida.

### 2.3 Upload, Antivírus e Pré-visualização
- **ClamAV em falha fechada:** quando um scanner ClamAV (`TCP 3310`) está configurado e fica indisponível, novos arquivos permanecem em `QUARANTINED` sem liberação para download ou preview.
- **Pré-visualização inline:** limitada a PDF e imagens seguras (`AVAILABLE`) via entrega autenticada; formatos Office (`.docx`, `.xlsx`, `.pptx`), texto e CSV são baixados normalmente após aprovação, sem renderização LibreOffice no servidor.
- **Campos personalizados obrigatórios no upload inicial:** o diálogo rápido **Enviar documentos** cria o documento inicial antes da edição detalhada de campos personalizados; se a categoria possuir campo marcado como `required: true`, preencha ou mantenha os campos opcionais até a edição em **Editar metadados** (ou crie via API já com `metadata`).

### 2.4 Fluxos, Lixeira e Interface Web
- **Envio à lixeira via API:** a interface web (`/lixeira` e detalhes de documento `DELETED`) permite pesquisar itens na lixeira, acompanhar o prazo de carência e executar **Restaurar**, enquanto a movimentação lógica de um documento ativo para a lixeira é feita via `POST /api/v1/documents/:id/trash` ou `DELETE /api/v1/documents/:id`.
- **Seções `/fluxos` e `/relatorios`:** `/fluxos` permite criar definições sequenciais versionadas, publicar novas versões imutáveis e ativar/inativar fluxos; `/relatorios` consolida métricas autorizadas do acervo com filtros no PostgreSQL e exportação CSV auditada. A inicialização e o acompanhamento por documento continuam em `/documentos/:id` e a revisão em `/tarefas` (**Minhas tarefas**).
- **Backup e restore:** não há disparo de backup/restore pela UI administrativa; utilize exclusivamente `scripts/backup/*` e `scripts/restore/*`.

### 2.5 Dependências, Backups e Observabilidade
- **Advisory `1243066` em `zod` (`3.25.x`):** mantido sob exceção temporária documentada em [dependencies-and-licenses.md](./dependencies-and-licenses.md), mitigado por limites de payload HTTP no Fastify/Caddy e limites de paginação (`pageSize <= 100`).
- **Snapshots de arquivos locais:** `scripts/backup/backup-files.sh` gera `.tar.gz` completo por execução (sem deduplicação incremental); recuperação *Point-in-Time* por WAL no PostgreSQL exige configuração externa adicional.
- **Sem telemetria externa:** o produto não envia métricas ou logs para servidores externos por padrão.

---

## 3. Instruções de Instalação Nova e Atualização

### 3.1 Versão anterior suportada
A tag **`v1.0.0-rc.1`** é a **primeira versão candidata pública** do papyrus. Não existe versão release anterior (`0.x` publicada) suportada para upgrade em produção:

- **Instalação nova:** siga integralmente [docs/installation.md](./installation.md), aplicando todas as migrations (`0000_initial.sql` até `0003_eminent_odin.sql`) com `/app/scripts/maintenance/migrate-entrypoint.sh`.
- **Atualização a partir de builds/commits de desenvolvimento anteriores (com schema `0000`–`0002`) ou futura atualização `1.0.0-rc.1` → `1.0.0`:**
  1. Execute o backup coordenado completo ([docs/backup-restore.md](./backup-restore.md)): PostgreSQL + arquivos locais + cópia externa de `.env` (`ENCRYPTION_KEY`).
  2. Interrompa `api`, `worker` e `web`:
     ```bash
     docker compose --env-file .env -f infra/compose/docker-compose.yml stop api worker web
     ```
  3. Atualize `PAPYRUS_IMAGE_TAG` no `.env` e construa/baixe as novas imagens fixadas (`docker compose --env-file .env -f infra/compose/docker-compose.yml build api worker web`).
  4. Execute as migrations pendentes usando o runner com advisory lock incluído na imagem `api`:
     ```bash
     docker compose --env-file .env -f infra/compose/docker-compose.yml run --rm --no-deps api sh /app/scripts/maintenance/migrate-entrypoint.sh
     ```
  5. Suba os serviços (`up -d api worker web`) e confirme `GET /api/v1/health/ready`, versão dos containers (`PAPYRUS_VERSION`) e acesso aos dados preservados.
  6. **Rollback:** se nenhuma migration foi aplicada, retorne `PAPYRUS_IMAGE_TAG` e reinicie os containers; se houve migration de schema, restaure o backup pré-atualização via `scripts/restore/restore-system.sh --confirm-restore` antes de retornar às imagens anteriores.
