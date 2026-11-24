# Guia de Segurança, Permissões e Controles Técnicos (papyrus)

Este documento descreve o modelo de autorização, proteção de sessões, credenciais, pipeline de arquivos, retenção, auditoria, isolamento de rede, responsabilidades operacionais do administrador e a matriz de verificação automatizada do **papyrus** (MVP self-hosted).

> **Nota:** Controles técnicos e registros de auditoria apoiam a governança corporativa da empresa operadora, mas não substituem assessoria jurídica nem constituem certificação automática de conformidade legal.

---

## 1. Modelo de Acesso: Papéis, Escopos e Herança

O controle de acesso é aplicado **exclusivamente no servidor** antes de contar, paginar, visualizar, baixar ou mutar recursos (`action + resource + scope` em `@papyrus/auth` e `apps/api/src/plugins/authorization.ts`).

### 1.1 Papéis padrão de sistema (`SYSTEM_ROLE_DEFINITIONS`)

| Chave (`key`) | Nome | Escopo de atuação típico |
| --- | --- | --- |
| `admin` | Administrador | Catálogo completo (`PERMISSION_CATALOG`), incluindo usuários, grupos, papéis, conexões de storage, auditoria e organização |
| `document_manager` | Gestor documental | Operação completa em documentos (`READ`, `CREATE`, `UPDATE`, `DELETE`, `UPLOAD`, `DOWNLOAD`, `MANAGE_PERMISSIONS`), pastas, categorias e fluxos |
| `collaborator` | Colaborador | Leitura, criação, edição, upload e download de documentos permitidos; consulta de pastas/categorias e abertura de fluxos |
| `reviewer` | Revisor | Leitura e download de documentos atribuídos; leitura e decisão (`APPROVE`, `REJECT`) em fluxos |
| `viewer` | Consulta | Somente leitura (`READ`, `DOWNLOAD` de documentos autorizados; `READ` em pastas, categorias e fluxos) |

### 1.2 Escopos e herança hierárquica

As atribuições de papéis (`user_role_scopes`, associadas diretamente ao usuário ou herdadas via grupos em `user_groups`) operam em quatro níveis (`evaluateDocumentAuthorization`, `evaluateFolderAuthorization`, `evaluateCategoryAuthorization`):

1. **`GLOBAL`:** aplica-se a toda a organização.
2. **`CATEGORY`:** aplica-se aos documentos classificados na categoria alvo.
3. **`FOLDER`:** aplica-se à pasta e **herda para toda a subárvore de subpastas e documentos internos** via resolução de ancestrais (`loadFolderAncestorIds` + `resolveApplicableScopesForDocument`).
4. **`DOCUMENT`:** exceção explícita aplicada a um documento específico.

### 1.3 Precedência entre concessão e negação

- **Negado por padrão (*default-deny*):** sem atribuição `ALLOW` compatível no escopo direto ou herdado, o acesso retorna `403 Forbidden` (ou omite o item em listagens/buscas).
- **Negação explícita vence concessão (`DENY > ALLOW`):** qualquer atribuição com `effect = "DENY"` aplicável ao papel/ação no escopo direto ou em qualquer pasta ancestral/categoria bloqueia o acesso mesmo que exista um `ALLOW` global ou herdado.
- **Anti-IDOR e ausência de vazamento por contagem:** consultas de listagem (`GET /api/v1/documents`), busca avançada (`GET/POST /api/v1/documents/search`), vencimentos e lixeira aplicam o filtro de autorização no PostgreSQL **antes** de calcular `COUNT(*)` e paginação.

---

## 2. Autenticação, Sessões e Proteção HTTP

- **Armazenamento de senhas (`@papyrus/auth`):** Argon2id com parâmetros padrão `memoryCost = 65536 KiB` (64 MiB), `timeCost = 3`, `parallelism = 1`, `hashLength = 32` e comprimento mínimo padrão de `10` caracteres (`createPasswordService`), com suporte a `needsRehash`.
- **Sessões opacas no servidor (`createSessionService`):**
  - Token aleatório de `32 bytes` (`base64url`); apenas o digest SHA-256 (ou HMAC-SHA256 com pepper quando configurado) é persistido em `sessions.token_hash`.
  - Validade padrão (`ttlMs`) de `12 horas`, com rotação automática quando faltam `<= 2 horas` (`rotationThresholdMs`), revogação individual no logout e suporte a revogação em massa por usuário.
  - Cookie `papyrus_session` emitido com `HttpOnly`, `SameSite=Lax` e `Secure=true` quando `NODE_ENV=production`.
- **Proteção CSRF e CORS (`apps/api/src/plugins/security.ts`):**
  - Todas as requisições mutáveis (`POST`, `PUT`, `PATCH`, `DELETE`) exigem validação em tempo constante (`timingSafeEqual`) entre o cookie `papyrus_csrf` e o cabeçalho `x-csrf-token` emitidos por `GET /api/v1/auth/csrf-token`.
  - CORS restrito explicitamente às origens configuradas (`allowedOrigins` / `APP_URL`).
- **Rate limiting no login:** padrão de `5` tentativas a cada `60 segundos` por IP em `POST /api/v1/auth/login`, retornando `429 RATE_LIMITED` com cabeçalho `Retry-After`.
- **Cabeçalhos de segurança:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` na API e `Strict-Transport-Security` em modo seguro.

---

## 3. Proteção de Credenciais e Segredos

- **Chave mestra externa (`ENCRYPTION_KEY` / `ENCRYPTION_KEYRING`):** segredos de conectores S3 e SMTP são criptografados com AES-256-GCM (`createStorageSecretVault` em `@papyrus/storage-core`) antes da gravação no banco. A chave mestra de 32 bytes jamais é persistida no PostgreSQL nem versionada em `.env.example`.
- **Proibição de exposição ao cliente e logs:**
  - Respostas HTTP de conectores retornam apenas `hasCredentials: boolean` e máscara visual.
  - Logger Fastify (`apps/api/src/app.ts`) aplica `redact` em cookies, `authorization`, `password`, `passwordHash`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `encryptedSecretRef` e `encryptedSecretPayload`.
  - Mensagens de erro de banco e storage passam por `sanitizeDatabaseErrorMessage` e `sanitizeStorageErrorMessage` antes de persistência em fila/operação ou retorno HTTP.

---

## 4. Pipeline de Upload Seguro e Scanner Antimalware

1. **Chave opaca e isolamento:** arquivos recebem chave gerada no backend (`org/{organizationId}/documents/{documentId}/versions/{versionId}/{objectId}`), ignorando caminho ou nome enviado pelo cliente na localização física.
2. **Streaming e limites:** uploads usam streaming validado no servidor sem carregar arquivos inteiros em `Buffer`; limites são aplicados na camada HTTP (`PROXY_MAX_BODY_BYTES`), na política da organização (`UPLOAD_MAX_BYTES`) e por extensão permitida (`UPLOAD_ALLOWED_EXTENSIONS`), bloqueando explicitamente extensões executáveis/ativas perigosas (`DANGEROUS_UPLOAD_EXTENSIONS`).
3. **Quarentena obrigatória:** ao finalizar uma sessão de upload (de forma idempotente por `idempotencyKey`), o objeto entra no estado **`QUARANTINED`** e o job assíncrono `process-upload` é enfileirado em `outbox_events`.
4. **Inspeção binária e antimalware em falha fechada (`apps/worker/src/jobs/process-upload.ts`):**
   - Conferência de tamanho e SHA-256 em tempo constante (`isChecksumEqualConstantTime`).
   - Detecção de tipo MIME pelo conteúdo binário (*magic bytes* em `@papyrus/file-processing`) combinada à allowlist da política.
   - Varredura por stream via protocolo `INSTREAM` no **ClamAV** (`createClamAvScanner`).
   - **Falha fechada:** quando o scanner detecta ameaça (`FOUND`), o objeto passa para **`REJECTED`** com motivo seguro (sem expor nomes técnicos de assinatura/caminhos); quando o scanner está indisponível ou sofre timeout, o objeto **permanece em `QUARANTINED`** (tentativa reagendada com backoff) e **nunca** é promovido a `AVAILABLE`.
5. **Gate de leitura:** endpoints de download e pré-visualização bloqueiam qualquer arquivo cujo estado não seja `AVAILABLE` (recusando `UPLOADING`, `QUARANTINED`, `REJECTED`, `MISSING` e `DELETE_PENDING`).

---

## 5. Retenção, Legal Hold e Auditoria

- **Ciclo controlado de exclusão (`retention-service.ts`, `purge-deleted-documents.ts`):**
  - Documentos excluídos vão primeiro para a lixeira lógica (`status = "DELETED"`).
  - O expurgo físico só ocorre após vencimento de `retentionDays` (quando há política aplicável) **e** `trashGraceDays`, ausência de referência em workflow ativo, **e ausência absoluta de `document_retention_holds` ativos (`releasedAt IS NULL`)**.
  - Objetos compartilhados por versões/documentos ainda ativos não são removidos; objetos elegíveis passam primeiro para `DELETE_PENDING` + `storage_operations` antes da remoção no storage, com reconciliação idempotente e respeito a `maxAttempts`.
- **Auditoria imutável (`audit_events`):**
  - Append-only na aplicação comum (sem `ON DELETE CASCADE` a partir de `documents` ou `document_retention_holds`), preservando todo o histórico documental mesmo após expurgo físico de um documento.
  - `sanitizeAuditMetadata` remove chaves/valores sensíveis (`password`, `token`, `secret`, URLs assinadas, conteúdo binário) e limita cardinalidade e tamanho dos metadados.

---

## 6. Exposição de Rede e Proxy Reverso

A topologia padrão em [docker-compose.yml](../infra/compose/docker-compose.yml) e [Caddyfile](../infra/caddy/Caddyfile) aplica segmentação mínima:

- **Rede isolada (`papyrus_internal`, `internal: true`):** `postgres` (5432) e `clamav` (3310) não possuem rotas externas nem portas publicadas no host.
- **Containers não privilegiados:** `api`, `worker` e `web` rodam sem `root`, com `cap_drop: [ALL]` e `no-new-privileges:true`.
- **Portas não expostas diretamente:** `api:3000` e `worker:3001` usam apenas `expose` interno; `web:8080` publica por padrão somente em `127.0.0.1:8080`.
- **Terminação HTTPS no Caddy:** aplica TLS automático, HSTS (`max-age=31536000; includeSubDomains`), cabeçalhos de hardening, limite de corpo de requisição (`52MiB` padrão alinhado a `PROXY_MAX_BODY_BYTES`) e remove o cabeçalho `Server`.

---

## 7. Responsabilidades do Administrador Self-Hosted

1. **Guarda e backup da chave mestra:** proteger `.env` (`chmod 600`) e manter cópia segura de `ENCRYPTION_KEY` e `SESSION_SECRET` fora do servidor em cofre organizacional.
2. **Exposição segura e HTTPS:** nunca publicar PostgreSQL, MinIO sem TLS ou API HTTP pura diretamente na Internet; configurar `APP_URL` exatamente igual à origem HTTPS pública servida pelo proxy.
3. **Atualizações e patches:** acompanhar avisos de segurança do SO, Docker Engine, imagem PostgreSQL, ClamAV (assinaturas `freshclam`) e executar `pnpm audit:deps` / atualizações conforme [dependencies-and-licenses.md](./dependencies-and-licenses.md).
4. **Governança de acessos e retenção:** revisar periodicamente atribuições `admin`, exceções explícitas, regras de retenção da empresa (sem depender de prazos legais presumidos) e validar mensalmente restauração de backup ([backup-restore.md](./backup-restore.md)).

---

## 8. Matriz de Verificação por Testes e Limitações Explicitadas

| Controle documentado | Cobertura automatizada verificada no repositório |
| --- | --- |
| Papéis, escopos `GLOBAL`/`CATEGORY`/`FOLDER`/`DOCUMENT`, herança e `DENY > ALLOW` | `packages/auth/test/authorization.test.ts`, `packages/auth/test/scope-resolver.test.ts`, `apps/api/test/integration/authorization-routes.integration.test.ts` |
| Anti-IDOR, contagem segura, isolamento horizontal em busca, preview e download | `apps/api/test/security/authorization.spec.ts`, `apps/api/test/security/access-control.test.ts`, `apps/api/test/security/download-authorization.test.ts` |
| Argon2id, sessões SHA-256/HMAC, rotação e logout | `packages/auth/test/password-service.test.ts`, `packages/auth/test/session-service.test.ts`, `apps/api/test/auth.routes.test.ts` |
| Cabeçalhos HTTP, CORS allowlist, CSRF e rate limit de login | `apps/api/test/security.test.ts` |
| Criptografia AES-256-GCM de credenciais e redaction de segredos | `packages/storage-core/test/*` (`secret-vault`), `packages/storage-s3/test/security/s3-security.test.ts` |
| Abuso de upload, traversal, symlink escape, SSRF S3 e TTL curto de URLs assinadas | `apps/api/test/security/upload-abuse.test.ts`, `packages/storage-local/test/security/local-security.test.ts`, `packages/storage-s3/test/security/s3-security.test.ts` |
| Detecção MIME binária, checksum SHA-256 e ClamAV fail-closed | `packages/file-processing/src/content-detection.test.ts`, `packages/file-processing/src/checksum.test.ts`, `packages/file-processing/src/antivirus/clamav-adapter.test.ts`, `apps/worker/test/integration/process-upload.integration.test.ts` |
| Legal hold bloqueando expurgo, reconciliação segura e auditoria preservada | `packages/domain/src/retention/retention-service.test.ts`, `apps/worker/test/integration/purge-deleted-documents.integration.test.ts`, `apps/worker/test/integration/retention-purge.integration.test.ts` |

### Limitações explicitamente fora do escopo no MVP 1.0

- **Autenticação externa e MFA:** OIDC, SAML, LDAP e MFA TOTP na interface de login ficam fora do MVP 1.0 (autenticação atual usa conta local + Argon2id + sessão).
- **Row-Level Security (RLS) multi-tenant:** o MVP atende uma organização por instalação self-hosted com isolamento lógico por `organizationId` em todas as consultas; RLS e provisionamento multi-tenant pertencem à linha pós-MVP.
- **ClamAV opcional:** o serviço `clamav` depende do profile explícito (`clamav` / `lab-storage`) no Compose; quando habilitado no worker, indisponibilidade mantém uploads em quarentena (falha fechada).
- **Exceção controlada em `zod` `3.25.x`:** detalhada e mitigada conforme [dependencies-and-licenses.md](./dependencies-and-licenses.md).
