# Checklist de Aceitação do MVP — DocuFlow 1.0.0-rc.1

Este checklist registra a execução e comprovação objetiva dos critérios de aceitação definidos em [project.md](../project.md) (**Entregáveis H.2, H.3, I.2 e I.3**) sobre a versão candidata **`1.0.0-rc.1`** (tag `v1.0.0-rc.1`).

---

## 1. Resumo das Suítes Executadas na Candidata `1.0.0-rc.1`

Todas as verificações abaixo foram executadas após o congelamento da configuração de release `1.0.0-rc.1`:

| Gate / Suíte | Comando executado | Resultado observado |
| --- | --- | --- |
| **Typecheck do monorepo** | `pnpm -r --if-present typecheck` | Aprovado em todos os pacotes e apps (`0` erros TypeScript `strict`) |
| **Lint e formatação** | `biome check .` | **458 arquivos** verificados, `0` erros |
| **Build de pacotes e web** | `pnpm -r --if-present build` | Build completo (`tsc` + `vite build`) sem erros |
| **Testes unitários e de contrato** | `vitest run` | **101 arquivos / 305 testes aprovados** |
| **Integração PostgreSQL (`@docuflow/database`)** | `@docuflow/database test:integration` | **5 arquivos / 9 testes aprovados** (PostgreSQL 16 real) |
| **Contrato MinIO (`@docuflow/storage-s3`)** | `@docuflow/storage-s3 test:integration` | **1 arquivo / 24 testes aprovados** (`minio-contract.integration.test.ts`) |
| **Integração Worker (`@docuflow/worker`)** | `@docuflow/worker test:integration` | **3 arquivos / 4 testes aprovados** |
| **Integração & Segurança API (`@docuflow/api`)** | `@docuflow/api test:integration` e `test` | **34 arquivos / 34 testes** de integração + testes de segurança aprovados |
| **Backup & Restore em ambiente limpo** | `vitest run --root tests/operations` | **1 arquivo / 1 teste aprovado** ([backup-restore.spec.ts](../tests/operations/backup-restore.spec.ts)) |
| **E2E no navegador real (Playwright)** | `playwright test` | **3 cenários aprovados em 32.4s** (`accessibility`, `documents`, `workflows`) |
| **Auditoria de licenças e dependências** | `node scripts/ci/check-dependencies.mjs` | Aprovado (**187** deps prod, `0` críticas, exceção documentada Zod `1243066`) |
| **Build e versão de containers** | `docker compose ... build api worker web` | Imagens `1.0.0-rc.1` construídas e validadas (`api`, `worker`, `web`) |

---

## 2. Matriz de Aceitação Funcional e Não Funcional (`project.md` H.2)

| Capacidade (`project.md` H.2) | Status na `1.0.0-rc.1` | Evidência objetiva verificada |
| --- | --- | --- |
| **Instalação Docker** | **Comprovado** | `infra/compose/docker-compose.yml` validado; imagens pinadas `docuflow-api:1.0.0-rc.1`, `docuflow-worker:1.0.0-rc.1` e `docuflow-web:1.0.0-rc.1` construídas com migrations incluídas e guia [docs/installation.md](./installation.md) |
| **Login local** | **Comprovado** | Argon2id, sessão server-side (`HttpOnly`, rotação), CSRF double-submit, logout e rate limit validados em `@docuflow/auth`, `apps/api/test/security.test.ts` e E2E (`documents.spec.ts`); rota `/recuperar-senha` e fluxo documentados em [docs/user-guide.md](./user-guide.md) |
| **Usuários / grupos / papéis** | **Comprovado** | Precedência `DENY > ALLOW`, herança hierárquica e negação `403` comprovadas em `apps/api/test/security/authorization.spec.ts`, `access-control.test.ts`, `users.integration.test.ts` e `groups.integration.test.ts` |
| **Pastas / categorias / tags** | **Comprovado** | Criação, edição, movimentação, desativação e filtros testados em `folders.integration.test.ts`, `categories.integration.test.ts`, `tags.integration.test.ts` e percorridos na UI na Step 17.04 |
| **Metadados** | **Comprovado** | Campos tipados (`TEXT`, `NUMBER`, `DATE`, `BOOLEAN`, `SINGLE_SELECT`, `MULTI_SELECT`) validados no cliente e servidor em `category-fields.integration.test.ts` e `documents-create.integration.test.ts` |
| **Storage local** | **Comprovado** | Upload/download em streaming, `headObject`, health check e bloqueio de traversal/symlinks testados em `packages/storage-local/test/*` e `apps/api/test/integration/storage-local.integration.test.ts` |
| **S3 compatível** | **Comprovado em MinIO** *(serviço S3 cloud externo pendente do operador)* | Paridade completa de contrato comprovada contra **MinIO** em `minio-contract.integration.test.ts` (`24` testes), `storage-s3.integration.test.ts` e `upload-s3-signed.integration.test.ts`. **Nota:** provedor S3 externo em nuvem (AWS/R2) não foi testado neste ambiente offline por ausência de credenciais externas; validar via health check da administração antes de ativar em produção |
| **Upload seguro** | **Comprovado** | Limite configurável, MIME por assinatura binária, SHA-256, quarentena, ClamAV fail-closed e finalização idempotente validados em `upload-abuse.test.ts`, `upload-local-streaming.integration.test.ts` e `process-upload.integration.test.ts` |
| **Versões** | **Comprovado** | Histórico *append-only*, preservação de versões anteriores, vínculo imutável a aprovações e restauração não destrutiva validados em `documents-versions.integration.test.ts` e `tests/e2e/documents.spec.ts` |
| **Busca** | **Comprovado** | Pesquisa textual, filtros, ordenação e paginação executados no PostgreSQL com escopo autorizado antes da contagem em `documents-list.integration.test.ts`, `documents-search.integration.test.ts` e `documents-authorization.integration.test.ts` |
| **PDF / imagem preview** | **Comprovado** | Entrega privada autenticada com `Cache-Control: no-store` e bloqueio fora de `AVAILABLE` validados em `documents-preview.integration.test.ts` e `download-authorization.test.ts` |
| **Aprovação humana** | **Comprovado** | Fluxo sequencial, solicitação de ajustes com comentário obrigatório, envio de nova versão e aprovação final rastreada validados em `workflow-tasks-generation.integration.test.ts`, `task-inbox.integration.test.ts` e `tests/e2e/workflows.spec.ts` |
| **Auditoria** | **Comprovado** | Tabela `audit_events` *append-only* sem segredos/tokens, filtragem server-side e proteção de escopo validados em `document-audit-events.integration.test.ts` e `audit-query.integration.test.ts` |
| **Vencimentos** | **Comprovado** | Cálculo por fuso horário da organização, abas de situação, janela configurável e notificações internas validados em `document-expirations.integration.test.ts`, `notifications.integration.test.ts` e `apps/worker/test/expiration-notifications.test.ts` |
| **Retenção / *legal hold*** | **Comprovado** | Bloqueio de exclusão/expurgo por *legal hold*, lixeira com janela de restauração e purga física idempotente validados em `documents-trash.integration.test.ts`, `documents-restore.integration.test.ts`, `retention-policies.integration.test.ts` e `retention-purge.integration.test.ts` |
| **Backup / restore** | **Comprovado** | Restauração coordenada completa (PostgreSQL + arquivos locais + `.env` com `ENCRYPTION_KEY`) comprovada em ambiente limpo com conferência de SHA-256 em [tests/operations/backup-restore.spec.ts](../tests/operations/backup-restore.spec.ts) |

---

## 3. Cenário de Ponta a Ponta (`project.md` H.3 — Contrato de Fornecedor)

Todos os passos do cenário de referência H.3 foram comprovados pelas suítes automatizadas integradas (`documents-lifecycle.integration.test.ts`, `tests/e2e/workflows.spec.ts`, `tests/e2e/documents.spec.ts`, `document-audit-events.integration.test.ts`, `dashboard-summary.integration.test.ts` e `tests/operations/backup-restore.spec.ts`):

- [x] **1. Ambiente e storage:** Instalação Docker Compose e configuração de conector local ou S3/MinIO validadas.
- [x] **2–3. Categoria, campos e papéis:** Categoria com campos tipados (`Fornecedor`, `CNPJ`, emissão, vencimento, responsável) e usuários distintos (`solicitante`, `jurídico`, `gestor`) validados.
- [x] **4–6. Upload seguro e `v1`:** Envio em streaming validado na API, processado pelo worker com checksum e scanner antimalware, disponibilizando `v1`.
- [x] **7–9. Solicitação de ajustes e `v2`:** Fluxo sequencial `jurídico → gestor`, solicitação de ajuste em `v1` com comentário obrigatório, retorno para rascunho, envio de `v2` imutável e reinício explícito do fluxo apontando para `v2`.
- [x] **10–11. Aprovação vinculada à versão:** `jurídico` e `gestor` aprovam `v2`; documento transiciona para `APPROVED` vinculado exatamente à versão `v2`.
- [x] **12–13. Dashboard e auditoria:** Painel exibe documentos, tarefas concluídas, vencimentos e atividades; trilha `audit_events` registra quem enviou, revisou e aprovou sem vazar segredos.
- [x] **14. Backup, restore e checksum:** Snapshot coordenado restaurado em instância limpa com `100%` de paridade nos metadados, versões, segredos cifrados e SHA-256 dos binários.

---

## 4. Itens Explicitamente Fora do Escopo do MVP 1.0 (`project.md` H.2)

Os itens abaixo **não** fazem parte desta release `1.0.0-rc.1` e permanecem documentados como pós-MVP:

- **OCR e extração de texto integral** — fora do escopo.
- **OIDC / LDAP / SSO corporativo externo** — fora do escopo (somente autenticação local com Argon2id).
- **Conectores Azure Blob Storage e Google Cloud Storage** — fora do escopo (apenas adaptadores `local` e `s3`).
- **Migração automática de objetos entre provedores de storage** — fora do escopo.
- **SaaS multi-tenant e isolamento por RLS multi-cliente** — fora do escopo (implantação self-hosted de organização única).
- **Assinatura eletrônica externa e edição colaborativa em tempo real** — fora do escopo.
