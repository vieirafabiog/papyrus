# DOCUFLOW — PLANO MESTRE DE EXECUÇÃO GRANULAR (PARA AGENTE DE DESENVOLVIMENTO)

> **Objetivo:** construir o GED DocuFlow a partir de um monorepo vazio até uma versão self-hosted estável e utilizável.
>
> **Documento de referência obrigatório:** `project.md`. Ele define visão, limites de produto, arquitetura, contratos, modelo de dados, decisões e critérios de aceite.
>
> **Idioma:** documentação e interface inicial em português do Brasil. Identificadores, nomes de arquivos, funções, classes, tabelas e código em inglês. Mensagens técnicas podem ser em inglês quando forem dependências ou logs de infraestrutura; mensagens destinadas ao usuário final devem estar em `pt-BR`.
>
> **Regra de execução:** uma única etapa `- [ ] Step XX.YY` por prompt, salvo quando o usuário autorizar explicitamente uma quantidade maior ou apontar outra etapa específica.

---

## 0. PROTOCOLO OBRIGATÓRIO DO AGENTE

### Regra 0.1 — Leitura antes da implementação

No início de cada prompt de implementação:

1. Ler este `EXECUTION_PLAN.md` e localizar a primeira etapa ainda marcada como `- [ ]`.
2. Ler integralmente `project.md`. Se o agente ou ferramenta tiver limite de contexto, dividir a leitura em blocos contíguos até cobrir o arquivo inteiro. Não usar apenas resumo, título ou trechos isolados.
3. Ler os arquivos existentes que serão modificados e os `src/index.ts`/exports dos pacotes dos quais haverá importação. Confirmar assinaturas reais; nunca inventar imports cross-package.
4. Verificar o estado atual do repositório, scripts disponíveis, dependências já instaladas e testes relacionados.
5. Informar ao usuário qual etapa única será executada.

### Regra 0.2 — Uma etapa por vez

1. Implementar somente a próxima etapa não concluída, a menos que o usuário indique outra etapa ou autorize explicitamente múltiplas etapas.
2. Não antecipar etapas futuras para “adiantar” o projeto. Uma dependência mínima pode ser criada quando for estritamente necessária à etapa atual; não implementar funcionalidades fora do escopo.
3. Não marcar uma etapa como concluída antes de executar a verificação especificada com código de saída `0`.
4. Se a verificação falhar, corrigir o problema e repetir a verificação na mesma execução.
5. Ao final, marcar somente a etapa implementada como `- [x]`, resumir arquivos alterados, teste executado e próxima etapa. Depois, parar.

### Regra 0.3 — Qualidade do código

- TypeScript com `strict: true`, `noImplicitAny: true` e `noUncheckedIndexedAccess: true`.
- Não usar `any`, `@ts-ignore`, casts duplos para esconder erros ou `eslint-disable`/supressões equivalentes sem justificativa documentada e localizada.
- Não deixar `TODO`, `FIXME`, stubs vazios, funções que retornam valores fictícios ou botões sem comportamento.
- Não usar dados falsos como se fossem registros reais na aplicação. Fixtures são permitidas apenas em testes, story/demo explicitamente identificados ou ambiente de desenvolvimento.
- Validar entrada na fronteira da API. Tipos TypeScript não substituem validação em runtime.
- Tratar erros de forma explícita; não capturar exceções e ignorá-las.
- Preferir funções pequenas, módulos coesos e contratos explícitos.
- Código e nomes técnicos em inglês; interface e conteúdo inicial do produto em português do Brasil.

### Regra 0.4 — Fronteiras de arquitetura

1. A camada de domínio não importa Fastify, React, Drizzle nem SDK de storage concreto.
2. A API não acessa filesystem ou S3 diretamente. Usa o contrato de `storage-core`.
3. A UI nunca recebe credenciais permanentes de storage nem decide autorização final.
4. O pacote `storage-core` define as interfaces; `storage-local` e `storage-s3` implementam essas interfaces.
5. A camada de persistência implementa repositórios; não coloca regras de negócio em rotas HTTP.
6. O worker reutiliza casos de uso e contratos; não cria regras paralelas.
7. Upload/download devem usar streams ou mecanismos de transferência direta com URL temporária; nunca carregar arquivos grandes inteiros em memória.
8. O registro documental, versões e objetos binários são entidades distintas.
9. Arquivos em quarentena/rejeitados não podem ser baixados pelo fluxo normal.
10. Toda ação sobre documento passa por autorização no backend.

### Regra 0.5 — Contratos entre workspaces

Antes de importar algo de outro pacote `@docuflow/*`:

1. Ler `src/index.ts` ou o `exports` público do pacote.
2. Ler os tipos relevantes para confirmar assinaturas.
3. Importar somente pelo caminho público exportado.
4. Não criar dependência circular entre workspaces.
5. Atualizar testes de contrato quando a interface pública mudar.

### Regra 0.6 — Interface Material Design 3

- Usar React + MUI (`@mui/material`) como biblioteca de componentes e um tema próprio inspirado nos tokens e padrões do Material Design 3.
- Não afirmar que o tema padrão do MUI implementa integralmente Material Design 3; a aproximação visual deve ser feita pelo tema, tokens e componentes do produto.
- Aparência empresarial, clara, discreta e orientada a documentos: tabelas legíveis, filtros visíveis, hierarquia consistente e ações contextuais.
- Não usar gradientes decorativos, glassmorphism, neon, blobs, excesso de cartões ou animações sem função.
- Não usar emojis como ícones. Utilizar MUI Icons com tamanho e alinhamento consistentes.
- Todos os estados de hover, foco, carregamento, vazio, erro, desabilitado e sucesso devem ser tratados.
- Todos os controles visíveis devem executar uma ação real e apresentar feedback.
- Garantir navegação por teclado, foco visível, labels e contraste.
- Não exagerar no arredondamento; manter superfícies e densidade compatíveis com um GED empresarial.

### Regra 0.7 — Segurança e arquivos

- Nunca confiar em nome, caminho, extensão ou MIME informado pelo navegador.
- Chaves de objeto são geradas pelo backend e não contêm nomes originais ou dados pessoais.
- Segredos de storage são criptografados e nunca aparecem em logs ou respostas.
- URL assinada, quando suportada, deve ter escopo e validade curtos.
- Verificar tamanho, checksum, MIME detectado e estado de processamento.
- Não remover objeto físico antes de confirmar o fluxo de exclusão e suas condições de retenção.
- Testar falha de storage, interrupção de upload, retry, idempotência e restauração.

### Regra 0.8 — Verificação e encerramento

Executar o comando exato especificado na etapa. Quando a etapa alterar contratos compartilhados, executar também o typecheck dos consumidores afetados. Não declarar “produção pronta” apenas porque o frontend abriu. A conclusão do MVP exige testes de API, storage real, permissões, upload, aprovação, backup e restauração.

---

## 1. MAPA DO MONOREPO

A raiz do projeto deve seguir esta estrutura. Ajustes só podem ser feitos por decisão arquitetural documentada no `project.md` e refletidos neste plano.

```text
docuflow/
├── project.md
├── EXECUTION_PLAN.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── biome.json
├── vitest.workspace.ts
├── .gitignore
├── .env.example
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── contracts/
│   ├── domain/
│   ├── database/
│   ├── auth/
│   ├── storage-core/
│   ├── storage-local/
│   ├── storage-s3/
│   ├── file-processing/
│   ├── notifications/
│   ├── ui/
│   └── config/
├── infra/
│   ├── compose/
│   ├── caddy/
│   └── monitoring/
├── scripts/
│   ├── backup/
│   ├── restore/
│   └── maintenance/
├── docs/
└── tests/
    └── e2e/
```

---

# PHASE 1 — BOOTSTRAP DO MONOREPO E TOOLING

### Stage 1.1 — Configuração da raiz

- [x] **Step 01.01 — Criar `.gitignore` da raiz**
  - **Arquivo:** `.gitignore`
  - **Ação:** Ignorar `node_modules/`, `dist/`, `build/`, `coverage/`, `.env`, `.env.*` (preservando `.env.example`), logs, arquivos temporários, dados locais, volumes, uploads de teste, relatórios e arquivos de IDE.
  - **Verificação:** Confirmar que `.gitignore` existe e que as regras não ignoram `project.md`, `EXECUTION_PLAN.md` nem `.env.example`.

- [x] **Step 01.02 — Criar `pnpm-workspace.yaml`**
  - **Arquivo:** `pnpm-workspace.yaml`
  - **Ação:** Declarar `apps/*` e `packages/*` como workspaces.
  - **Verificação:** Validar sintaxe YAML e confirmar que o pnpm reconhece a raiz.

- [x] **Step 01.03 — Criar `package.json` da raiz**
  - **Arquivo:** `package.json`
  - **Ação:** Configurar nome `docuflow`, repositório privado, engines Node `>=22`, versão do pnpm fixada e scripts `build`, `typecheck`, `test`, `lint`, `format`, `test:integration` e `test:e2e`. Incluir TypeScript, Biome, Vitest e tipos Node como ferramentas de desenvolvimento compartilhadas.
  - **Verificação:** Executar `pnpm install` e `pnpm run` sem erro.

- [x] **Step 01.04 — Criar configuração TypeScript estrita**
  - **Arquivo:** `tsconfig.base.json`
  - **Ação:** Definir `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` quando compatível, `forceConsistentCasingInFileNames`, source maps e declarações para pacotes.
  - **Verificação:** Executar `pnpm exec tsc --version` e validar o JSON de configuração.

- [x] **Step 01.05 — Configurar Biome**
  - **Arquivo:** `biome.json`
  - **Ação:** Definir formatação, indentação, largura de linha, organização de imports e regras recomendadas de lint. Evitar regras que conflitem com o padrão de código TypeScript definido no projeto.
  - **Verificação:** Executar `pnpm lint`.

- [x] **Step 01.06 — Configurar workspace do Vitest**
  - **Arquivo:** `vitest.workspace.ts`
  - **Ação:** Configurar descoberta de testes em `packages/*` e `apps/*`, permitindo ambientes Node e jsdom conforme o pacote.
  - **Verificação:** Executar `pnpm test` sem testes encontrados com falha ou erro de configuração.

- [x] **Step 01.07 — Criar `.env.example` seguro**
  - **Arquivo:** `.env.example`
  - **Ação:** Documentar somente nomes de variáveis e exemplos fictícios não funcionais: `NODE_ENV`, `APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `STORAGE_DEFAULT_CONNECTION`, `UPLOAD_MAX_BYTES`, `SMTP_*` e variáveis de observabilidade local. Não incluir credenciais reais.
  - **Verificação:** Validar sintaxe/estrutura e executar scanner de segredos no repositório.

- [x] **Step 01.08 — Criar pipeline básico de CI**
  - **Arquivo:** `.github/workflows/ci.yml`
  - **Ação:** Executar install com lockfile, lint, typecheck, testes e build em pull requests e branches principais. Fixar versões das actions por release estável ou SHA conforme política do repositório.
  - **Verificação:** Validar YAML e executar localmente os comandos equivalentes.

- [x] **Step 01.09 — Criar README inicial do repositório**
  - **Arquivo:** `README.md`
  - **Ação:** Descrever o produto, estado do projeto, stack prevista, requisitos locais e links para os documentos mestres. Não declarar funcionalidades ainda não implementadas como disponíveis.
  - **Verificação:** Conferir links relativos e consistência com `project.md`.

---

# PHASE 2 — SCAFFOLD DOS WORKSPACES

### Stage 2.1 — Aplicações

- [x] **Step 02.01 — Scaffold de `apps/web`**
  - **Arquivos:** `apps/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`
  - **Ação:** Criar aplicação React + TypeScript + Vite com scripts `dev`, `build`, `typecheck` e `test`. Não instalar componentes de negócio nesta etapa.
  - **Verificação:** `pnpm --filter @docuflow/web typecheck` e `pnpm --filter @docuflow/web build`.

- [x] **Step 02.02 — Scaffold de `apps/api`**
  - **Arquivos:** `apps/api/package.json`, `tsconfig.json`, `src/server.ts`, `src/app.ts`
  - **Ação:** Criar API Fastify com inicialização tipada, encerramento gracioso e scripts de desenvolvimento, build, typecheck e teste.
  - **Verificação:** `pnpm --filter @docuflow/api typecheck` e `pnpm --filter @docuflow/api test`.

- [x] **Step 02.03 — Scaffold de `apps/worker`**
  - **Arquivos:** `apps/worker/package.json`, `tsconfig.json`, `src/worker.ts`
  - **Ação:** Criar processo separado para jobs, com inicialização, shutdown gracioso, logger e health reporting local.
  - **Verificação:** `pnpm --filter @docuflow/worker typecheck` e `pnpm --filter @docuflow/worker test`.

### Stage 2.2 — Pacotes compartilhados

- [x] **Step 02.04 — Scaffold de `packages/contracts`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Configurar pacote para schemas Zod e contratos públicos compartilhados.
  - **Verificação:** `pnpm --filter @docuflow/contracts typecheck`.

- [x] **Step 02.05 — Scaffold de `packages/domain`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Configurar pacote sem dependência de framework, banco ou SDK de storage.
  - **Verificação:** `pnpm --filter @docuflow/domain typecheck`.

- [x] **Step 02.06 — Scaffold de `packages/database`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `drizzle.config.ts`, `src/index.ts`
  - **Ação:** Configurar Drizzle, cliente PostgreSQL, diretório de schema e migrations.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 02.07 — Scaffold de `packages/auth`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Preparar pacote de credenciais, sessões e políticas de autorização, sem implementar ainda as regras.
  - **Verificação:** `pnpm --filter @docuflow/auth typecheck`.

- [x] **Step 02.08 — Scaffold de `packages/storage-core`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Criar pacote-base independente dos SDKs concretos.
  - **Verificação:** `pnpm --filter @docuflow/storage-core typecheck`.

- [x] **Step 02.09 — Scaffold de `packages/storage-local`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Configurar pacote que implementará filesystem local e dependerá de `storage-core` por `workspace:*`.
  - **Verificação:** `pnpm --filter @docuflow/storage-local typecheck`.

- [x] **Step 02.10 — Scaffold de `packages/storage-s3`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Configurar pacote isolado para S3 e SDK compatível. Evitar dependência do SDK no restante da aplicação.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 typecheck`.

- [x] **Step 02.11 — Scaffold de `packages/file-processing`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Preparar validação MIME, checksum, quarentena, antivírus e geração de prévias.
  - **Verificação:** `pnpm --filter @docuflow/file-processing typecheck`.

- [x] **Step 02.12 — Scaffold de `packages/notifications`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Preparar contratos de notificações internas e e-mail SMTP.
  - **Verificação:** `pnpm --filter @docuflow/notifications typecheck`.

- [x] **Step 02.13 — Scaffold de `packages/ui`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Criar pacote de tema MUI, tokens e componentes compartilhados. Não copiar componentes da aplicação web para este pacote.
  - **Verificação:** `pnpm --filter @docuflow/ui typecheck`.

- [x] **Step 02.14 — Scaffold de `packages/config`**
  - **Arquivos:** `package.json`, `tsconfig.json`, `src/index.ts`
  - **Ação:** Criar schemas de configuração tipados para API, worker, storage e web. Segredos devem ser representados por referências/configuração segura, nunca por valores em logs.
  - **Verificação:** `pnpm --filter @docuflow/config test` e `pnpm --filter @docuflow/config typecheck`.

---

# PHASE 3 — CONTRATOS, DOMÍNIO E REGRAS DE NEGÓCIO

- [x] **Step 03.01 — Implementar schemas comuns e identificadores**
  - **Arquivos:** `packages/contracts/src/common.schema.ts`, `packages/contracts/src/index.ts`
  - **Ação:** Criar schemas para UUID, paginação, ordenação permitida, datas ISO, códigos de erro e resposta padrão. Exportar pela API pública.
  - **Verificação:** `pnpm --filter @docuflow/contracts test`.

- [x] **Step 03.02 — Implementar tipos de documento e versão**
  - **Arquivos:** `packages/contracts/src/document.schema.ts`, `packages/domain/src/documents/document.types.ts`
  - **Ação:** Definir estados independentes de documento, versão e objeto binário, conforme `project.md` D.4.
  - **Verificação:** `pnpm --filter @docuflow/contracts test` e `pnpm --filter @docuflow/domain typecheck`.

- [x] **Step 03.03 — Implementar schemas de categorias e metadados**
  - **Arquivos:** `packages/contracts/src/category.schema.ts`, `packages/domain/src/categories/metadata-validation.ts`
  - **Ação:** Suportar campos extras tipados: texto, número, data, booleano, opção única e múltipla. Validar obrigatoriedade e opções permitidas no servidor.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [x] **Step 03.04 — Implementar contratos de storage**
  - **Arquivos:** `packages/storage-core/src/storage.types.ts`, `storage.errors.ts`, `storage-provider.ts`, `index.ts`
  - **Ação:** Implementar interfaces de provider, metadados, objetos, capacidades, upload/download por stream, health check e alvos temporários opcionais. Normalizar erros sem vazar segredo.
  - **Verificação:** `pnpm --filter @docuflow/storage-core test` e `pnpm --filter @docuflow/storage-core typecheck`.

- [x] **Step 03.05 — Implementar contratos de sessão e autorização**
  - **Arquivos:** `packages/domain/src/access/access.types.ts`, `packages/contracts/src/access.schema.ts`
  - **Ação:** Definir usuário, grupo, papel, permissão, ação e escopos global/categoria/pasta/documento.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [x] **Step 03.06 — Implementar estados e transições documentais**
  - **Arquivos:** `packages/domain/src/documents/document-state.ts`, `document-state.test.ts`
  - **Ação:** Definir transições permitidas entre estados de documento e impedir transições arbitrárias. Estado de arquivo deve permanecer separado.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [x] **Step 03.07 — Implementar contratos de workflow e tarefas**
  - **Arquivos:** `packages/contracts/src/workflow.schema.ts`, `packages/domain/src/workflows/workflow.types.ts`
  - **Ação:** Definir fluxo sequencial versionado, instância, tarefa, decisão e estados terminais.
  - **Verificação:** `pnpm --filter @docuflow/contracts test` e `pnpm --filter @docuflow/domain typecheck`.

- [x] **Step 03.08 — Definir portas de repositório e serviços de domínio**
  - **Arquivos:** `packages/domain/src/ports/*.ts`, `packages/domain/src/index.ts`
  - **Ação:** Declarar interfaces para documentos, versões, usuários, auditoria, storage connections e transações. Não importar Drizzle ou Fastify.
  - **Verificação:** `pnpm --filter @docuflow/domain typecheck`.

- [x] **Step 03.09 — Implementar regras de versionamento imutável**
  - **Arquivos:** `packages/domain/src/documents/versioning.ts`, `versioning.test.ts`
  - **Ação:** Definir criação de próxima versão, versão corrente, restauração como nova versão e vínculo de aprovação a uma versão exata.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [x] **Step 03.10 — Criar testes de invariantes do domínio**
  - **Arquivos:** `packages/domain/test/document-invariants.test.ts`, `workflow-invariants.test.ts`
  - **Ação:** Cobrir estados inválidos, concorrência conceitual, versão imutável, hold e decisões duplicadas.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

---

# PHASE 4 — POSTGRESQL, DRIZZLE E PERSISTÊNCIA

- [x] **Step 04.01 — Implementar conexão PostgreSQL tipada**
  - **Arquivos:** `packages/database/src/client.ts`, `src/index.ts`
  - **Ação:** Criar pool com limites configuráveis, timeouts, shutdown e logs sem string de conexão.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.02 — Criar schema de organização e usuários**
  - **Arquivo:** `packages/database/src/schema/identity.ts`
  - **Ação:** Criar `organizations`, `users`, `groups`, `user_groups`, `roles`, `permissions`, `role_permissions`, `user_role_scopes` e `sessions` com PKs UUID e constraints.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.03 — Criar schema de pastas e categorias**
  - **Arquivo:** `packages/database/src/schema/taxonomy.ts`
  - **Ação:** Criar `folders`, `categories`, `category_fields` e `tags`, com unicidade por escopo e relações corretas.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.04 — Criar schema de storage e upload**
  - **Arquivo:** `packages/database/src/schema/storage.ts`
  - **Ação:** Criar `storage_connections`, `storage_routing_rules`, `file_objects`, `upload_sessions` e `storage_operations`. Guardar segredos somente como payload criptografado ou referência segura.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.05 — Criar schema documental**
  - **Arquivo:** `packages/database/src/schema/documents.ts`
  - **Ação:** Criar `documents`, `document_versions`, `document_metadata` e `document_tags`; criar chaves estrangeiras sem cascatas físicas perigosas.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.06 — Criar schema de processos e tarefas**
  - **Arquivo:** `packages/database/src/schema/workflows.ts`
  - **Ação:** Criar definições/versionamento de fluxo, instâncias, tarefas, decisões e notificações.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.07 — Criar schema de auditoria e retenção**
  - **Arquivo:** `packages/database/src/schema/governance.ts`
  - **Ação:** Criar `audit_events`, `retention_policies`, `document_retention_holds` e `outbox_events`. Auditoria sem operação de update/delete na camada comum.
  - **Verificação:** `pnpm --filter @docuflow/database typecheck`.

- [x] **Step 04.08 — Criar índices e constraints de integridade**
  - **Arquivos:** `packages/database/src/schema/*.ts`, `packages/database/test/schema-constraints.test.ts`
  - **Ação:** Adicionar índices para paginação e filtros, unicidade de versão, chave de objeto e constraints de estado/relacionamento.
  - **Verificação:** `pnpm --filter @docuflow/database test:integration`.

- [x] **Step 04.09 — Criar migration inicial**
  - **Arquivos:** `packages/database/drizzle/0001_initial.sql`, `drizzle.config.ts`
  - **Ação:** Gerar migration revisável a partir dos schemas. Confirmar que a migration não depende de dados preexistentes.
  - **Verificação:** `pnpm --filter @docuflow/database db:generate` e `pnpm --filter @docuflow/database test:integration`.

- [x] **Step 04.10 — Implementar repositórios básicos**
  - **Arquivos:** `packages/database/src/repositories/*.ts`
  - **Ação:** Implementar repositórios exigidos pelas portas do domínio, com paginação no banco, ordenação permitida e transações explícitas.
  - **Verificação:** `pnpm --filter @docuflow/database test:integration`.

---

# PHASE 5 — DESIGN SYSTEM MATERIAL DESIGN 3 E SHELL WEB

- [x] **Step 05.01 — Definir tokens do tema MUI inspirado em Material 3**
  - **Arquivos:** `packages/ui/src/theme/tokens.ts`, `theme.ts`
  - **Ação:** Centralizar cores semânticas, superfícies, tipografia, espaçamento, shape, densidade, foco e estados. Documentar que MUI é a implementação de componentes e MD3 é a direção visual.
  - **Verificação:** `pnpm --filter @docuflow/ui typecheck`.

- [x] **Step 05.02 — Criar providers globais do frontend**
  - **Arquivos:** `apps/web/src/app/providers.tsx`, `src/main.tsx`
  - **Ação:** Registrar ThemeProvider, CssBaseline, QueryClientProvider, roteador e boundary global de erro.
  - **Verificação:** `pnpm --filter @docuflow/web typecheck`.

- [x] **Step 05.03 — Implementar roteamento principal**
  - **Arquivos:** `apps/web/src/app/router.tsx`, `route-guards.tsx`
  - **Ação:** Definir rotas públicas de autenticação e rotas privadas do sistema. Guard deve reagir ao estado real de sessão fornecido pela API.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [x] **Step 05.04 — Criar shell principal**
  - **Arquivos:** `apps/web/src/layout/AppShell.tsx`, `AppHeader.tsx`, `AppSidebar.tsx`
  - **Ação:** Montar navegação lateral, cabeçalho, área de conteúdo, perfil do usuário e adaptação responsiva. Não criar links sem destino funcional.
  - **Verificação:** `pnpm --filter @docuflow/web typecheck`.

- [x] **Step 05.05 — Criar componentes de feedback compartilhados**
  - **Arquivos:** `packages/ui/src/components/LoadingState.tsx`, `EmptyState.tsx`, `ErrorState.tsx`, `ConfirmDialog.tsx`
  - **Ação:** Implementar estados acessíveis, textos em pt-BR e callbacks funcionais.
  - **Verificação:** `pnpm --filter @docuflow/ui test`.

- [x] **Step 05.06 — Criar tela de login**
  - **Arquivos:** `apps/web/src/features/auth/LoginPage.tsx`, componentes relacionados
  - **Ação:** Criar formulário responsivo, validação, exibição de erro, loading e prevenção de múltiplos envios.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [x] **Step 05.07 — Criar componentes de tabela e filtros**
  - **Arquivos:** `packages/ui/src/components/DataTable.tsx`, `FilterBar.tsx`
  - **Ação:** Criar componentes com paginação e ordenação controladas pelo servidor, seleção acessível e estados vazios. Não implementar busca client-side sobre toda a coleção.
  - **Verificação:** `pnpm --filter @docuflow/ui test`.

- [x] **Step 05.08 — Criar dashboard conectado à API**
  - **Arquivos:** `apps/web/src/features/dashboard/DashboardPage.tsx`, hooks e contracts
  - **Ação:** Consumir endpoint real de resumo. Enquanto o endpoint ainda não existir, manter a rota em estado vazio informativo; não inventar KPIs reais.
  - **Verificação:** `pnpm --filter @docuflow/web typecheck` e `pnpm --filter @docuflow/web test`.

- [x] **Step 05.09 — Validar acessibilidade do shell**
  - **Arquivos:** testes do shell e componentes compartilhados
  - **Ação:** Cobrir foco, labels, navegação por teclado, dialogs, responsividade e contraste dos estados principais.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

---

# PHASE 6 — AUTENTICAÇÃO, USUÁRIOS E AUTORIZAÇÃO

- [x] **Step 06.01 — Implementar serviço de hash de senha**
  - **Arquivos:** `packages/auth/src/password-service.ts`, testes
  - **Ação:** Implementar hash e verificação com algoritmo apropriado (preferencialmente Argon2id), parâmetros configuráveis e comparação segura.
  - **Verificação:** `pnpm --filter @docuflow/auth test`.

- [x] **Step 06.02 — Implementar serviço de sessão**
  - **Arquivos:** `packages/auth/src/session-service.ts`, `session.types.ts`
  - **Ação:** Gerar tokens aleatórios, armazenar somente hash, aplicar expiração, revogação e rotação conforme política definida.
  - **Verificação:** `pnpm --filter @docuflow/auth test`.

- [x] **Step 06.03 — Implementar rotas de login e logout**
  - **Arquivos:** `apps/api/src/modules/auth/auth.routes.ts`, `auth.service.ts`
  - **Ação:** Implementar login, logout e `GET /auth/me`, com cookie seguro e respostas sem dados internos.
  - **Verificação:** `pnpm --filter @docuflow/api test`.

- [x] **Step 06.04 — Implementar proteção CSRF, cookies e rate limit**
  - **Arquivos:** `apps/api/src/plugins/security.ts`, testes de segurança
  - **Ação:** Configurar cookies, CORS estrito, CSRF para mutações, headers de segurança e limitação de tentativas de login.
  - **Verificação:** `pnpm --filter @docuflow/api test`.

- [x] **Step 06.05 — Implementar criação do primeiro administrador**
  - **Arquivos:** `apps/api/src/modules/setup/*`, `scripts/maintenance/create-admin.ts`
  - **Ação:** Criar fluxo seguro de bootstrap que só funcione quando não existir administrador e não exponha senha em logs.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 06.06 — Implementar administração de usuários**
  - **Arquivos:** `packages/domain/src/users/*`, rotas e repositories
  - **Ação:** Criar, editar, desativar e reativar usuários; impedir que o último administrador ativo seja removido sem substituição.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 06.07 — Implementar grupos e associação de usuários**
  - **Arquivos:** módulos de grupos no domínio, database e API
  - **Ação:** Criar grupos, vincular usuários e impedir vínculos duplicados.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 06.08 — Implementar papéis e permissões**
  - **Arquivos:** `packages/auth/src/authorization/*`
  - **Ação:** Implementar catálogo de ações, papéis e verificação `action + resource + scope`; negar por padrão.
  - **Verificação:** `pnpm --filter @docuflow/auth test`.

- [x] **Step 06.09 — Implementar escopos por pasta, categoria e documento**
  - **Arquivos:** `packages/auth/src/authorization/scope-resolver.ts`, testes
  - **Ação:** Resolver permissões herdadas de pasta e exceções documentais, com precedência formal para negação explícita.
  - **Verificação:** `pnpm --filter @docuflow/auth test`.

- [x] **Step 06.10 — Integrar autorização em rotas e repositórios**
  - **Arquivos:** plugins e módulos da API
  - **Ação:** Aplicar autorização antes de buscar/contar/retornar documentos e antes de executar mutações.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 06.11 — Implementar testes negativos de acesso**
  - **Arquivos:** `apps/api/test/security/access-control.test.ts`
  - **Ação:** Cobrir IDOR, busca, preview, download, listagem, contagem e alteração de permissão.
  - **Verificação:** `pnpm --filter @docuflow/api test`.

---

# PHASE 7 — STORAGE CORE E CONECTOR DE FILESYSTEM LOCAL

- [x] **Step 07.01 — Implementar registry de provedores**
  - **Arquivos:** `packages/storage-core/src/storage-registry.ts`, testes
  - **Ação:** Registrar factories por tipo e resolver provider por conexão, sem importar drivers concretos no domínio.
  - **Verificação:** `pnpm --filter @docuflow/storage-core test`.

- [x] **Step 07.02 — Implementar validação de capacidades**
  - **Arquivos:** `packages/storage-core/src/capability-validator.ts`, testes
  - **Ação:** Validar operações requeridas contra capabilities do provider; nunca presumir suporte a signed URL, multipart ou copy.
  - **Verificação:** `pnpm --filter @docuflow/storage-core test`.

- [x] **Step 07.03 — Implementar normalização de erros de storage**
  - **Arquivos:** `packages/storage-core/src/storage-errors.ts`, testes
  - **Ação:** Normalizar not found, unauthorized, timeout, throttling, unavailable, checksum mismatch e conflict, sem incluir credenciais.
  - **Verificação:** `pnpm --filter @docuflow/storage-core test`.

- [x] **Step 07.04 — Implementar resolução segura de diretório local**
  - **Arquivos:** `packages/storage-local/src/safe-path.ts`, testes
  - **Ação:** Resolver somente paths dentro da raiz configurada, bloquear traversal, symlink escape e nomes de objeto inesperados.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test`.

- [x] **Step 07.05 — Implementar escrita local por stream**
  - **Arquivos:** `packages/storage-local/src/local-storage-provider.ts`
  - **Ação:** Implementar `putObject` com stream, arquivo temporário, checksum e rename atômico quando suportado. Não usar `readFile` para arquivo de tamanho arbitrário.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test`.

- [x] **Step 07.06 — Implementar leitura, head e exclusão local**
  - **Arquivos:** `packages/storage-local/src/local-storage-provider.ts`, testes
  - **Ação:** Implementar `getObject`, `headObject` e `deleteObject`, diferenciando not found de falha de permissão/I/O.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test`.

- [x] **Step 07.07 — Implementar health check do filesystem**
  - **Arquivos:** `packages/storage-local/src/local-health.ts`, testes
  - **Ação:** Verificar existência, permissões, leitura/escrita controlada e espaço disponível quando possível sem expor o path ao usuário comum.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test`.

- [x] **Step 07.08 — Implementar criptografia de credenciais de conectores**
  - **Arquivos:** `packages/storage-core/src/secret-vault.ts`, `packages/config/src/secrets.ts`
  - **Ação:** Criptografar credenciais com chave mestra externa ao banco; validar formato e falhar com erro explícito se a chave estiver ausente ou inválida.
  - **Verificação:** `pnpm --filter @docuflow/storage-core test`.

- [x] **Step 07.09 — Implementar casos de uso de conexões de storage**
  - **Arquivos:** `packages/domain/src/storage/*`
  - **Ação:** Criar, editar, ativar, desativar e testar conexão; impedir desativação quando ainda for necessária para leitura de arquivos existentes.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [x] **Step 07.10 — Implementar rotas administrativas de storage local**
  - **Arquivos:** `apps/api/src/modules/storage/*`
  - **Ação:** Expor listagem e cadastro de conexão local, teste de saúde e seleção do destino padrão, com acesso somente de administrador.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 07.11 — Criar testes de contrato do provider local**
  - **Arquivos:** `packages/storage-local/test/storage-contract.test.ts`
  - **Ação:** Reutilizar suíte de contrato para stream vazio, stream grande, abort, objeto inexistente, checksum e reexecução idempotente.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test`.

---

# PHASE 8 — CONECTOR S3 COMPATÍVEL

- [x] **Step 08.01 — Implementar schema de configuração S3**
  - **Arquivos:** `packages/storage-s3/src/s3-config.schema.ts`
  - **Ação:** Validar endpoint, região, bucket, estilo de path, TLS, credenciais e timeouts. Não aceitar endpoint sem validação de segurança.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 test`.

- [x] **Step 08.02 — Implementar provider S3 com streaming**
  - **Arquivos:** `packages/storage-s3/src/s3-storage-provider.ts`
  - **Ação:** Implementar escrita e leitura usando SDK isolado, stream e tratamento de abort/timeout.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 typecheck`.

- [x] **Step 08.03 — Implementar HEAD, checksum e exclusão S3**
  - **Arquivos:** `packages/storage-s3/src/s3-storage-provider.ts`, testes
  - **Ação:** Implementar existência, metadados, checksum conforme suporte real do provedor e exclusão idempotente.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 test`.

- [x] **Step 08.04 — Implementar upload/download assinados opcionais**
  - **Arquivos:** `packages/storage-s3/src/signed-targets.ts`, testes
  - **Ação:** Gerar URL temporária para chave específica, método específico e expiração curta. Não expor credenciais nem permitir escolha arbitrária de chave pelo navegador.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 test`.

- [x] **Step 08.05 — Implementar health check S3**
  - **Arquivos:** `packages/storage-s3/src/s3-health.ts`
  - **Ação:** Verificar credenciais, bucket e permissões mínimas sem listar conteúdo desnecessariamente.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 test`.

- [x] **Step 08.06 — Executar provider S3 contra MinIO**
  - **Arquivos:** `packages/storage-s3/test/integration/*`, configuração de teste
  - **Ação:** Criar ambiente MinIO efêmero e executar suíte de contrato completa, incluindo falhas e restart.
  - **Verificação:** `pnpm --filter @docuflow/storage-s3 test:integration`.

- [x] **Step 08.07 — Implementar cadastro de conexões S3 na API**
  - **Arquivos:** módulo storage da API e contracts
  - **Ação:** Permitir cadastrar, editar e testar conexão S3, mascarando campos secretos em respostas e logs.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 08.08 — Implementar roteamento por instalação e categoria**
  - **Arquivos:** `packages/domain/src/storage/storage-router.ts`, testes
  - **Ação:** Resolver conexão padrão com override por categoria; persistir a conexão efetivamente usada em cada objeto. Alterar a regra não deve mover arquivos existentes.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

---

# PHASE 9 — PIPELINE DE UPLOAD, QUARENTENA E PROCESSAMENTO

- [x] **Step 09.01 — Implementar criação de sessão de upload**
  - **Arquivos:** módulos upload no domínio, database e API
  - **Ação:** Criar sessão com usuário, destino, tamanho declarado, expiração e chave de idempotência; não criar versão disponível ainda.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 09.02 — Implementar upload via API para storage local**
  - **Arquivos:** `apps/api/src/modules/uploads/upload.routes.ts`
  - **Ação:** Receber multipart/stream com limite e backpressure, persistir em objeto temporário e responder com progresso/estado documentado.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 09.03 — Implementar upload direto assinado para S3**
  - **Arquivos:** módulo upload da API e integração storage-s3
  - **Ação:** Emitir destino temporário apenas para upload session autorizada; exigir finalização na API.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [x] **Step 09.04 — Implementar finalização idempotente de upload**
  - **Arquivos:** `packages/domain/src/uploads/finalize-upload.ts`, testes
  - **Ação:** Verificar objeto, tamanho e checksum antes de marcar como quarentena; repetição da mesma finalização não pode criar versões duplicadas.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [x] **Step 09.05 — Implementar detector de MIME e allowlist**
  - **Arquivos:** `packages/file-processing/src/content-detection.ts`, testes
  - **Ação:** Detectar tipo pelo conteúdo, comparar extensão e tipo declarado, aplicar allowlist configurável e registrar rejeição segura.
  - **Verificação:** `pnpm --filter @docuflow/file-processing test`.

- [x] **Step 09.06 — Implementar cálculo e validação SHA-256 por stream**
  - **Arquivos:** `packages/file-processing/src/checksum.ts`, testes
  - **Ação:** Calcular checksum sem armazenar todo o arquivo na memória e comparar com o valor esperado.
  - **Verificação:** `pnpm --filter @docuflow/file-processing test`.

- [x] **Step 09.07 — Implementar adapter ClamAV**
  - **Arquivos:** `packages/file-processing/src/antivirus/*`
  - **Ação:** Integrar scanner por protocolo/serviço configurado, com timeout, falha fechada e estado explícito quando indisponível.
  - **Verificação:** `pnpm --filter @docuflow/file-processing test`.

- [x] **Step 09.08 — Implementar worker de processamento de arquivo**
  - **Arquivos:** `apps/worker/src/jobs/process-upload.ts`
  - **Ação:** Consumir job persistido, executar MIME, checksum e scanner, e atualizar estado de objeto/documento em transação coerente.
  - **Verificação:** `pnpm --filter @docuflow/worker test:integration`.

- [x] **Step 09.09 — Implementar limpeza de uploads abandonados**
  - **Arquivos:** `apps/worker/src/jobs/cleanup-uploads.ts`
  - **Ação:** Expirar sessões incompletas, excluir temporários após janela de segurança e registrar falha de remoção para reconciliação.
  - **Verificação:** `pnpm --filter @docuflow/worker test`.

- [x] **Step 09.10 — Implementar componente de upload na UI**
  - **Arquivos:** `apps/web/src/features/documents/UploadDialog.tsx`, hooks
  - **Ação:** Upload múltiplo, barra de progresso, formulário de metadados inicial, cancelamento e resultado individual por arquivo.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [x] **Step 09.11 — Implementar feedback de quarentena e rejeição**
  - **Arquivos:** componentes de status documental na UI
  - **Ação:** Mostrar “Em análise”, “Disponível” ou “Rejeitado” sem expor detalhes técnicos ou liberar preview antes da aprovação do processamento.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [x] **Step 09.12 — Criar testes de abuso de upload**
  - **Arquivos:** testes de segurança de upload
  - **Ação:** Cobrir tamanho excedido, MIME falso, nome malicioso, arquivo vazio, interrupção, repetição, timeout e scanner indisponível.
  - **Verificação:** `pnpm --filter @docuflow/api test:security`.

---

# PHASE 10 — DOCUMENTOS, PASTAS, CATEGORIAS, METADADOS E VERSÕES

- [x] **Step 10.01 — Implementar CRUD de pastas**
  - **Arquivos:** `packages/domain/src/folders/*`, repositório e rotas
  - **Ação:** Criar, renomear, mover e arquivar pastas; impedir ciclo na hierarquia e validar permissões herdadas.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.02 — Implementar CRUD de categorias**
  - **Arquivos:** `packages/domain/src/categories/*`, API
  - **Ação:** Criar, editar, desativar e listar categorias, com validação contra documentos existentes.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.03 — Implementar campos personalizados por categoria**
  - **Arquivos:** domínio, contracts, database e API de categorias
  - **Ação:** Permitir configurar campos tipados e obrigatoriedade; impedir alteração incompatível sem estratégia de migração dos metadados existentes.
  - **Verificação:** `pnpm --filter @docuflow/domain test` e `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.04 — Implementar etiquetas**
  - **Arquivos:** `packages/domain/src/tags/*`, API e UI
  - **Ação:** Criar tags, associar e remover de documentos, validar unicidade e autorização.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.05 — Implementar criação do registro documental**
  - **Arquivos:** `packages/domain/src/documents/create-document.ts`, rotas
  - **Ação:** Criar documento com categoria, pasta, responsável, metadados e vínculo ao upload finalizado. Não permitir status aprovado no envio inicial.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [ ] **Step 10.06 — Implementar listagem paginada de documentos**
  - **Arquivos:** repository, API `GET /documents` e contracts
  - **Ação:** Filtrar e paginar no PostgreSQL, aplicar autorização antes de count e retornar DTO mínimo.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.07 — Implementar detalhe do documento**
  - **Arquivos:** rota de detalhe, queries e `DocumentDetailsPage.tsx`
  - **Ação:** Exibir metadados, categoria, pasta, status, responsável e datas, respeitando autorização.
  - **Verificação:** `pnpm --filter @docuflow/web test` e `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.08 — Implementar editor de metadados na UI**
  - **Arquivos:** `apps/web/src/features/documents/DocumentMetadataForm.tsx`
  - **Ação:** Renderizar campos conforme schema da categoria, validar no cliente e no servidor e apresentar erros próximos dos campos.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 10.09 — Implementar criação de nova versão**
  - **Arquivos:** `packages/domain/src/documents/create-version.ts`, API
  - **Ação:** Criar nova versão append-only vinculada a um novo file object disponível; usar controle de concorrência para impedir número duplicado.
  - **Verificação:** `pnpm --filter @docuflow/domain test` e `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.10 — Implementar histórico de versões na UI**
  - **Arquivos:** `apps/web/src/features/documents/VersionHistory.tsx`
  - **Ação:** Exibir número, data, autor, observação e ações permitidas; restaurar versão antiga deve criar nova versão, não reescrever histórico.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 10.11 — Implementar movimentação e arquivamento**
  - **Arquivos:** casos de uso, rotas e ações da UI
  - **Ação:** Mover documento entre pastas e arquivar com validação de permissão e registro de auditoria.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 10.12 — Implementar lixeira lógica**
  - **Arquivos:** `packages/domain/src/documents/trash-document.ts`, rotas
  - **Ação:** Marcar documento como excluído logicamente, ocultar das listagens comuns e preservar versões/auditoria até expurgo autorizado.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

---

# PHASE 11 — PESQUISA, VISUALIZAÇÃO, DOWNLOAD E DASHBOARD

- [ ] **Step 11.01 — Implementar filtros avançados no repositório**
  - **Arquivos:** `packages/database/src/repositories/document-search.ts`
  - **Ação:** Implementar filtros para nome, categoria, pasta, status, autor, responsável, datas, tags e metadados suportados, com ordenação permitida.
  - **Verificação:** `pnpm --filter @docuflow/database test:integration`.

- [ ] **Step 11.02 — Implementar endpoint de pesquisa**
  - **Arquivos:** `apps/api/src/modules/documents/search.routes.ts`
  - **Ação:** Validar filtros, paginação, ordenação e escopo; aplicar permissão antes de contagens e resultados.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 11.03 — Implementar barra de busca global**
  - **Arquivos:** `apps/web/src/components/GlobalSearch.tsx`
  - **Ação:** Pesquisar título/nome e navegar para resultados autorizados, com debounce, cancelamento de requisição e estado vazio.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 11.04 — Implementar filtros e tabela de documentos**
  - **Arquivos:** `apps/web/src/features/documents/DocumentListPage.tsx`, componentes
  - **Ação:** Exibir filtros por categoria, pasta, status, responsável e vencimento; paginação e ordenação controladas pela API.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 11.05 — Implementar preview de PDF autorizado**
  - **Arquivos:** `apps/api` endpoint de preview e `apps/web` PDF viewer
  - **Ação:** Entregar stream ou URL curta após autorização. Definir CSP e impedir cache público indevido.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration` e `pnpm --filter @docuflow/web test`.

- [ ] **Step 11.06 — Implementar preview de imagens**
  - **Arquivos:** componente de preview e endpoint de conteúdo
  - **Ação:** Renderizar formatos de imagem permitidos, respeitando tamanho e autorização; outros formatos devem oferecer download.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 11.07 — Implementar download autorizado**
  - **Arquivos:** `apps/api/src/modules/documents/download.routes.ts`
  - **Ação:** Verificar usuário, documento, versão, estado do arquivo e provider; usar URL assinada curta ou streaming pela API.
  - **Verificação:** `pnpm --filter @docuflow/api test:security`.

- [ ] **Step 11.08 — Implementar dashboard de indicadores reais**
  - **Arquivos:** endpoint de dashboard e `DashboardPage.tsx`
  - **Ação:** Exibir totais de documentos, pendências, vencimentos e armazenamento com agregações autorizadas no banco. Não calcular métricas em coleções completas no navegador.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration` e `pnpm --filter @docuflow/web test`.

- [ ] **Step 11.09 — Implementar breadcrumbs e navegação por pastas**
  - **Arquivos:** hooks e componentes de pastas
  - **Ação:** Exibir caminho hierárquico com autorização em cada navegação e tratamento de pasta removida/arquivada.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 11.10 — Implementar busca por texto extraído como extensão opcional**
  - **Arquivos:** `packages/file-processing/src/text-extraction/*`
  - **Ação:** Somente executar após PoC de extração, limites e qualidade; salvar texto extraído separado do binário e indexar no PostgreSQL. Deve ser possível desativar o recurso.
  - **Verificação:** `pnpm --filter @docuflow/file-processing test`.

---

# PHASE 12 — WORKFLOWS, TAREFAS E NOTIFICAÇÕES

- [ ] **Step 12.01 — Implementar definições versionadas de fluxo**
  - **Arquivos:** `packages/domain/src/workflows/definitions/*`
  - **Ação:** Criar fluxo sequencial com etapas, grupos/papéis aprovadores, prazos e regras de comentário obrigatório.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [ ] **Step 12.02 — Implementar início de instância vinculada à versão**
  - **Arquivos:** `packages/domain/src/workflows/start-workflow.ts`
  - **Ação:** Criar instância apontando para a versão imutável da definição e para `document_version_id` específico.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [ ] **Step 12.03 — Implementar geração de tarefas**
  - **Arquivos:** `packages/domain/src/workflows/create-tasks.ts`, repositories
  - **Ação:** Gerar tarefas para usuários/grupos autorizados sem duplicidade em retries.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 12.04 — Implementar caixa de tarefas da API**
  - **Arquivos:** `apps/api/src/modules/tasks/*`
  - **Ação:** Listar tarefas do usuário/grupos, com filtros, paginação e autorização.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 12.05 — Implementar decisão concorrente de tarefa**
  - **Arquivos:** `packages/domain/src/workflows/decide-task.ts`
  - **Ação:** Implementar aprovar, rejeitar, solicitar alteração e cancelar. Usar transação/controle de versão para decisão única; retornos repetidos devem ser idempotentes quando a mesma requisição for repetida.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [ ] **Step 12.06 — Implementar UI de Minhas tarefas**
  - **Arquivos:** `apps/web/src/features/tasks/TaskInboxPage.tsx`
  - **Ação:** Criar lista com filtros, contagem e acesso ao documento relacionado sem permitir acesso além do escopo da tarefa.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 12.07 — Implementar detalhe e ações de aprovação**
  - **Arquivos:** `apps/web/src/features/tasks/TaskReviewPage.tsx`
  - **Ação:** Exibir versão exata, metadados, histórico e caixa de comentário; desabilitar ação durante envio e atualizar estado somente após confirmação da API.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 12.08 — Implementar linha do tempo do processo**
  - **Arquivos:** componente de workflow no detalhe documental
  - **Ação:** Exibir etapas, responsáveis, decisões e horários de forma somente leitura para usuários autorizados.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 12.09 — Implementar notificações internas**
  - **Arquivos:** `packages/notifications/src/in-app/*`, API e UI
  - **Ação:** Criar notificações para tarefas atribuídas, decisões e vencimentos; leitura individual e idempotência.
  - **Verificação:** `pnpm --filter @docuflow/notifications test` e `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 12.10 — Implementar SMTP opcional**
  - **Arquivos:** `packages/notifications/src/email/*`, configuração e testes
  - **Ação:** Enviar e-mails por SMTP configurado pelo administrador, sem depender de provedor externo fixo. Segredos protegidos e envio assíncrono.
  - **Verificação:** `pnpm --filter @docuflow/notifications test`.

---

# PHASE 13 — AUDITORIA, VENCIMENTOS E RETENÇÃO

- [ ] **Step 13.01 — Implementar writer central de auditoria**
  - **Arquivos:** `packages/domain/src/audit/audit-writer.ts`
  - **Ação:** Criar evento mínimo e append-only dentro da transação de negócio quando aplicável. Redigir segredos e dados excessivos.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [ ] **Step 13.02 — Instrumentar eventos documentais**
  - **Arquivos:** casos de uso de documento, versão, download, permissões e workflow
  - **Ação:** Registrar eventos definidos em `project.md` C.10 sem duplicidade nem conteúdo sensível.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 13.03 — Implementar consulta de auditoria**
  - **Arquivos:** API e `apps/web/src/features/audit/AuditPage.tsx`
  - **Ação:** Filtrar por usuário, ação, recurso e período; limitar exportações a usuários autorizados.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration` e `pnpm --filter @docuflow/web test`.

- [ ] **Step 13.04 — Implementar listagem de vencimentos**
  - **Arquivos:** endpoint de vencimentos e `ExpirationsPage.tsx`
  - **Ação:** Filtrar documentos vencidos, próximos do vencimento e sem data, respeitando fuso horário e permissões.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 13.05 — Implementar job de alertas de vencimento**
  - **Arquivos:** `apps/worker/src/jobs/expiration-notifications.ts`
  - **Ação:** Agendar notificações com idempotência para evitar alertas duplicados em retries e mudanças de data.
  - **Verificação:** `pnpm --filter @docuflow/worker test`.

- [ ] **Step 13.06 — Implementar políticas de retenção e holds**
  - **Arquivos:** domínio, database e API de retenção
  - **Ação:** Permitir regras configuráveis e bloqueio de expurgo por hold. Não fornecer prazos legais universais pré-cadastrados como orientação jurídica.
  - **Verificação:** `pnpm --filter @docuflow/domain test`.

- [ ] **Step 13.07 — Implementar restauração da lixeira**
  - **Arquivos:** `packages/domain/src/documents/restore-document.ts`, rotas e UI
  - **Ação:** Restaurar documento enquanto permitido, preservando histórico e permissões; registrar auditoria.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 13.08 — Implementar expurgo físico seguro**
  - **Arquivos:** `apps/worker/src/jobs/purge-deleted-documents.ts`
  - **Ação:** Verificar janela de retenção, hold, referências e estado; marcar operação pendente, apagar objeto e reconciliar. Falha deve ser repetível.
  - **Verificação:** `pnpm --filter @docuflow/worker test:integration`.

- [ ] **Step 13.09 — Testar concorrência e trilha de auditoria**
  - **Arquivos:** testes de integração de governance
  - **Ação:** Provar que ações concorrentes não apagam versões/decisões e que auditoria permanece mesmo após lixeira/restauração.
  - **Verificação:** `pnpm --filter @docuflow/database test:integration`.

---

# PHASE 14 — ADMINISTRAÇÃO E CONFIGURAÇÃO DA INSTALAÇÃO

- [ ] **Step 14.01 — Implementar dados e preferências da organização**
  - **Arquivos:** módulo organization da API e UI
  - **Ação:** Administrar nome, fuso horário, idioma e preferências permitidas da instalação.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 14.02 — Implementar UI de usuários e grupos**
  - **Arquivos:** `apps/web/src/features/admin/UsersPage.tsx`, `GroupsPage.tsx`
  - **Ação:** Criar, editar, desativar, associar e filtrar usuários/grupos conforme permissões.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 14.03 — Implementar UI de papéis e escopos**
  - **Arquivos:** `apps/web/src/features/admin/PermissionsPage.tsx`
  - **Ação:** Apresentar matriz compreensível de permissões, herança e exceções; não expor expressões SQL ou detalhes internos.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 14.04 — Implementar UI de conexões de storage**
  - **Arquivos:** `apps/web/src/features/admin/StorageSettingsPage.tsx`
  - **Ação:** Cadastrar local/S3, editar configurações, testar saúde, mascarar credenciais, escolher destino padrão e regras por categoria.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 14.05 — Implementar UI de categorias e campos**
  - **Arquivos:** `apps/web/src/features/admin/CategoriesPage.tsx`, `CategoryEditor.tsx`
  - **Ação:** Gerenciar categoria, campos personalizados, opções e política de storage por categoria.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

- [ ] **Step 14.06 — Implementar configurações de limites de upload**
  - **Arquivos:** módulo de configuração e UI administrativa
  - **Ação:** Configurar limites de tamanho e extensões permitidas com validação consistente no proxy, API e worker.
  - **Verificação:** `pnpm --filter @docuflow/api test`.

- [ ] **Step 14.07 — Implementar health e readiness endpoints**
  - **Arquivos:** `apps/api/src/modules/health/*`, worker health
  - **Ação:** Separar liveness e readiness, verificando banco e dependências críticas sem expor detalhes internos publicamente.
  - **Verificação:** `pnpm --filter @docuflow/api test`.

- [ ] **Step 14.08 — Implementar tela de status operacional**
  - **Arquivos:** `apps/web/src/features/admin/SystemStatusPage.tsx`
  - **Ação:** Exibir saúde de banco, worker e conexões de storage para administradores, com horário da última verificação.
  - **Verificação:** `pnpm --filter @docuflow/web test`.

---

# PHASE 15 — DOCKER, BACKUP, RESTAURAÇÃO E OPERAÇÃO SELF-HOSTED

- [ ] **Step 15.01 — Criar Dockerfile de produção para web**
  - **Arquivo:** `apps/web/Dockerfile`
  - **Ação:** Build multi-stage, servidor estático mínimo, usuário não-root e imagem base fixada.
  - **Verificação:** `docker build -f apps/web/Dockerfile -t docuflow-web:test .`.

- [ ] **Step 15.02 — Criar Dockerfile de produção para API**
  - **Arquivo:** `apps/api/Dockerfile`
  - **Ação:** Build multi-stage, dependências de produção, usuário não-root, health check e sem ferramentas de desenvolvimento na imagem final.
  - **Verificação:** `docker build -f apps/api/Dockerfile -t docuflow-api:test .`.

- [ ] **Step 15.03 — Criar Dockerfile de produção para worker**
  - **Arquivo:** `apps/worker/Dockerfile`
  - **Ação:** Imagem separada com dependências necessárias aos jobs, shutdown gracioso e usuário não-root.
  - **Verificação:** `docker build -f apps/worker/Dockerfile -t docuflow-worker:test .`.

- [ ] **Step 15.04 — Criar Docker Compose base**
  - **Arquivo:** `infra/compose/docker-compose.yml`
  - **Ação:** Declarar web, API, worker, PostgreSQL, volumes persistentes, rede interna e health checks. Storage local deve usar volume próprio.
  - **Verificação:** `docker compose -f infra/compose/docker-compose.yml config`.

- [ ] **Step 15.05 — Criar profile opcional de ClamAV e MinIO**
  - **Arquivo:** `infra/compose/docker-compose.storage.yml`
  - **Ação:** Declarar serviços opcionais para laboratório/instalações que não possuem scanner ou endpoint S3 externo. Não tornar MinIO obrigatório para clientes com storage próprio.
  - **Verificação:** `docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.storage.yml config`.

- [ ] **Step 15.06 — Configurar proxy HTTPS de referência**
  - **Arquivos:** `infra/caddy/Caddyfile`, documentação
  - **Ação:** Configurar TLS, headers, limite de corpo coerente com upload, timeouts e encaminhamento de headers confiáveis.
  - **Verificação:** Validar configuração do Caddy e testar rota web/API local.

- [ ] **Step 15.07 — Implementar migration runner seguro**
  - **Arquivos:** script de entrypoint/migrations
  - **Ação:** Executar migrations com lock advisory no PostgreSQL para impedir duas instâncias de migrarem simultaneamente; não executar seed destrutivo em produção.
  - **Verificação:** `pnpm --filter @docuflow/database test:integration`.

- [ ] **Step 15.08 — Implementar backup do PostgreSQL**
  - **Arquivos:** `scripts/backup/backup-database.sh` ou versão multiplataforma documentada
  - **Ação:** Gerar backup com nome/horário, código de saída confiável, política de retenção e log sem segredos.
  - **Verificação:** Executar backup contra PostgreSQL de teste e validar arquivo gerado.

- [ ] **Step 15.09 — Implementar backup de arquivos locais**
  - **Arquivos:** `scripts/backup/backup-files.sh`
  - **Ação:** Copiar/snapshot do volume local preservando estrutura e integridade; documentar consistência com backup de banco.
  - **Verificação:** Restaurar cópia em diretório temporário e comparar checksums.

- [ ] **Step 15.10 — Implementar procedimento de restore**
  - **Arquivos:** `scripts/restore/*`, `docs/backup-restore.md`
  - **Ação:** Documentar e automatizar restauração coordenada do PostgreSQL, arquivos, configuração protegida e chave mestra.
  - **Verificação:** Executar restore completo em ambiente limpo e baixar um documento restaurado.

- [ ] **Step 15.11 — Implementar verificação de consistência do acervo**
  - **Arquivos:** `apps/worker/src/jobs/verify-storage-integrity.ts`
  - **Ação:** Comparar referências do banco com `headObject`, identificar ausências e permitir verificação de checksum sob demanda; não apagar automaticamente objetos não reconhecidos.
  - **Verificação:** `pnpm --filter @docuflow/worker test`.

- [ ] **Step 15.12 — Documentar instalação e atualização**
  - **Arquivos:** `docs/installation.md`, `docs/operations.md`
  - **Ação:** Documentar pré-requisitos, DNS/HTTPS, volumes, permissões, variáveis, primeiro administrador, atualização, rollback e troubleshooting.
  - **Verificação:** Seguir a documentação em uma instalação limpa sem depender de conhecimento implícito.

---

# PHASE 16 — TESTES INTEGRADOS, SEGURANÇA E PERFORMANCE

- [ ] **Step 16.01 — Criar suíte de contrato para todos os conectores**
  - **Arquivos:** `packages/storage-core/test/contract/*`
  - **Ação:** Reutilizar o mesmo conjunto de testes para filesystem local e S3/MinIO, cobrindo capabilities e erros normalizados.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test` e `pnpm --filter @docuflow/storage-s3 test:integration`.

- [ ] **Step 16.02 — Criar testes de integração da API documental**
  - **Arquivos:** `apps/api/test/integration/documents/*`
  - **Ação:** Cobrir criação, listagem, detalhe, upload finalizado, versão, lixeira e autorização com PostgreSQL real.
  - **Verificação:** `pnpm --filter @docuflow/api test:integration`.

- [ ] **Step 16.03 — Criar E2E de login e gestão documental**
  - **Arquivos:** `tests/e2e/documents.spec.ts`, configuração Playwright
  - **Ação:** Automatizar login, envio, processamento, pesquisa, preview, download e criação de versão.
  - **Verificação:** `pnpm test:e2e -- documents.spec.ts`.

- [ ] **Step 16.04 — Criar E2E de revisão e aprovação**
  - **Arquivo:** `tests/e2e/workflows.spec.ts`
  - **Ação:** Automatizar envio para aprovação, solicitação de ajuste, nova versão, aprovação final e histórico.
  - **Verificação:** `pnpm test:e2e -- workflows.spec.ts`.

- [ ] **Step 16.05 — Criar testes de isolamento e IDOR**
  - **Arquivos:** `apps/api/test/security/authorization.spec.ts`
  - **Ação:** Testar usuário sem permissão em busca, count, preview, download, versão, workflow e exportação.
  - **Verificação:** `pnpm --filter @docuflow/api test:security`.

- [ ] **Step 16.06 — Criar testes de segurança de storage**
  - **Arquivos:** `packages/storage-local/test/security/*`, `packages/storage-s3/test/security/*`
  - **Ação:** Cobrir traversal, symlink escape, SSRF de endpoint, segredo exposto, URL assinada expirada e objeto em conexão desativada.
  - **Verificação:** `pnpm --filter @docuflow/storage-local test` e `pnpm --filter @docuflow/storage-s3 test`.

- [ ] **Step 16.07 — Criar testes de exclusão e retenção**
  - **Arquivos:** testes de domain/worker para retenção
  - **Ação:** Provar que hold bloqueia expurgo, que retry não apaga objetos errados e que auditoria é preservada.
  - **Verificação:** `pnpm --filter @docuflow/worker test:integration`.

- [ ] **Step 16.08 — Criar teste automatizado de backup/restore**
  - **Arquivos:** `tests/operations/backup-restore.spec.ts`
  - **Ação:** Instalar ambiente temporário, criar documento, executar backup, restaurar e comparar arquivo e metadados.
  - **Verificação:** `pnpm test:operations -- backup-restore.spec.ts`.

- [ ] **Step 16.09 — Definir e executar teste de carga básico**
  - **Arquivos:** `tests/performance/*`, relatório
  - **Ação:** Medir listagem paginada, busca, login e uploads concorrentes com dataset conhecido; registrar hardware, volume e resultados, sem inventar SLA.
  - **Verificação:** Executar script de carga e salvar relatório reproduzível.

- [ ] **Step 16.10 — Verificar acessibilidade dos fluxos críticos**
  - **Arquivos:** testes Playwright/a11y
  - **Ação:** Verificar login, lista, upload, detalhe, tarefa e administração por teclado, labels e contraste.
  - **Verificação:** `pnpm test:e2e -- accessibility.spec.ts`.

- [ ] **Step 16.11 — Executar auditoria de dependências e licenças**
  - **Arquivos:** `docs/dependencies-and-licenses.md`, pipeline CI
  - **Ação:** Identificar dependências diretas/transitivas, licenças, CVEs relevantes e política de atualização. Resolver bloqueadores antes do release.
  - **Verificação:** Executar scanner escolhido e registrar resultado datado.

- [ ] **Step 16.12 — Executar gate completo de qualidade**
  - **Arquivos:** raiz do monorepo e CI
  - **Ação:** Corrigir problemas de lint, typecheck, unit, integração, E2E e build; confirmar que lockfile está atualizado.
  - **Verificação:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

---

# PHASE 17 — DOCUMENTAÇÃO FINAL E RELEASE SELF-HOSTED 1.0

- [ ] **Step 17.01 — Finalizar guia de conectores de storage**
  - **Arquivo:** `docs/storage-connectors.md`
  - **Ação:** Documentar filesystem, S3 compatível, endpoint, bucket, TLS, permissões mínimas, credenciais, health check, seleção por categoria e limitações conhecidas.
  - **Verificação:** Conferir guia em instalação local e MinIO.

- [ ] **Step 17.02 — Finalizar guia de segurança e permissões**
  - **Arquivo:** `docs/security.md`
  - **Ação:** Documentar papéis, escopos, herança, sessões, proteção de credenciais, scanner, retenção, auditoria, exposição de rede e responsabilidades do administrador.
  - **Verificação:** Verificar que cada controle descrito existe e está coberto por teste ou identificar explicitamente limitações.

- [ ] **Step 17.03 — Finalizar guia de backup e restauração**
  - **Arquivo:** `docs/backup-restore.md`
  - **Ação:** Descrever backup coerente do banco, arquivos e segredos necessários, periodicidade recomendada como parâmetro operacional, retenção e teste de restore.
  - **Verificação:** Repetir o procedimento em máquina/ambiente limpo.

- [ ] **Step 17.04 — Finalizar manual de usuário inicial**
  - **Arquivo:** `docs/user-guide.md`
  - **Ação:** Documentar login, pastas, categorias, envio, metadados, versões, busca, aprovação, vencimentos e lixeira com capturas atualizadas.
  - **Verificação:** Percorrer todos os fluxos do manual na versão candidata.

- [ ] **Step 17.05 — Preparar configuração de release**
  - **Arquivos:** `package.json`, tags, `CHANGELOG.md`, imagens Docker
  - **Ação:** Definir versão semântica, changelog, imagens fixadas, migrations incluídas e estratégia de atualização.
  - **Verificação:** Build de release e validação de versão dos containers.

- [ ] **Step 17.06 — Executar checklist de aceitação do MVP**
  - **Arquivo:** `docs/release-checklist.md`
  - **Ação:** Executar todos os critérios do `project.md` H.2/H.3, incluindo local, S3, permissões, fluxo, auditoria e restore.
  - **Verificação:** Todos os itens obrigatórios comprovados; itens não implementados devem permanecer explicitamente fora do escopo.

- [ ] **Step 17.07 — Publicar release candidate e registrar limitações**
  - **Arquivos:** `CHANGELOG.md`, `docs/known-limitations.md`
  - **Ação:** Preparar release candidate, documentar limitações conhecidas e instruções de atualização. Não anunciar SaaS multi-tenant, OCR, assinatura eletrônica ou conectores não entregues.
  - **Verificação:** Instalação nova e upgrade a partir da versão anterior suportada concluídos com sucesso.

---

## 2. DEFINITION OF DONE GLOBAL

Uma etapa só pode ser marcada como concluída quando:

- os arquivos solicitados existem e estão integrados ao projeto;
- os contratos públicos estão exportados e os consumidores usam esses exports;
- não existem erros de TypeScript ou lint introduzidos pela etapa;
- testes da etapa foram executados e passaram;
- estados de loading/erro/vazio/sucesso foram tratados quando houver UI;
- autorização do backend foi considerada quando houver dado protegido;
- a documentação necessária foi atualizada;
- não foram introduzidos placeholders ou comportamento fictício;
- a etapa marcada não inclui trabalho pertencente a etapas futuras.

## 3. CRITÉRIO DE CONCLUSÃO DO PROJETO

O projeto não está concluído apenas porque o dashboard aparece no navegador. A versão self-hosted 1.0 só pode ser considerada entregue quando a instalação documentada funcionar em ambiente limpo, os conectores local e S3 passarem pela mesma suíte de contrato, os arquivos forem transferidos sem consumo de memória proporcional ao tamanho total, as permissões forem testadas negativamente, as versões e aprovações forem rastreáveis e um backup tiver sido restaurado com sucesso.

---

## 4. MODELO DE PROMPT PARA O AGENTE DE CÓDIGO

```text
Siga rigorosamente o protocolo de @EXECUTION_PLAN.md.

1. Leia EXECUTION_PLAN.md e encontre a primeira etapa ainda marcada com [ ].
2. Leia integralmente project.md antes de implementar; divida a leitura em blocos caso necessário.
3. Leia os arquivos existentes e os exports públicos dos pacotes que serão importados.
4. Informe qual única etapa será executada.
5. Implemente somente essa etapa, respeitando as fronteiras do monorepo, TypeScript strict, Material UI com tema inspirado em Material Design 3, interface pt-BR e os requisitos de segurança documental.
6. Não use any, @ts-ignore, placeholders, TODOs, dados fictícios em produção ou botões sem ação.
7. Execute exatamente o comando de verificação indicado na etapa; corrija qualquer falha e repita.
8. Marque somente essa etapa como [x] após sucesso comprovado.
9. Informe arquivos alterados, teste executado, resultado e ID da próxima etapa. Pare.
```
