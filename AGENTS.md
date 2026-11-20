# AGENTS.md — DocuFlow

Instruções permanentes para o agente de desenvolvimento neste repositório.
Referências mestras obrigatórias: `project.md` e `EXECUTION_PLAN.md`.

## 1. Protocolo de Execução (`EXECUTION_PLAN.md`)

1. Ler `EXECUTION_PLAN.md` e localizar a primeira etapa marcada com `- [ ]`, salvo instrução explícita do usuário para outra etapa.
2. Ler integralmente `project.md` (em blocos se necessário) antes de implementar quando ainda não estiver no contexto da sessão.
3. Antes de modificar ou importar código de outro workspace (`@docuflow/*`), ler os arquivos alvo e o `src/index.ts` / `exports` públicos do pacote de origem. Nunca inventar imports cross-package nem importar caminhos internos de outro pacote.
4. Informar qual única etapa será executada.
5. Implementar **somente** essa etapa, sem antecipar etapas futuras.
6. Executar exatamente o comando de verificação indicado na etapa; corrigir qualquer falha e repetir até sair com código `0`. Quando contratos compartilhados mudarem, rodar também o `typecheck` dos consumidores afetados.
7. Marcar somente a etapa concluída como `- [x]` após sucesso comprovado, realizar o commit Git da etapa seguindo o padrão Conventional Commits (`<type>(step-XX.YY): <descrição concisa em inglês>`), resumir arquivos alterados, teste executado, resultado, hash do commit e próxima etapa, e parar.

## 2. Idioma e Convenções

- Código, identificadores, arquivos, funções, classes, tabelas e schemas: **inglês**.
- Interface do usuário, mensagens voltadas ao usuário final e documentação do produto: **português do Brasil (`pt-BR`)**.

## 3. Qualidade de Código e TypeScript

- TypeScript com `strict: true`, `noImplicitAny: true`, `strictNullChecks: true` e `noUncheckedIndexedAccess: true`.
- Proibido: `any`, `@ts-ignore`, casts duplos para esconder erros, `eslint-disable`/supressões sem justificativa documentada.
- Proibido: `TODO`, `FIXME`, stubs vazios, valores fictícios em produção, dados falsos como registros reais, ou botões/controles sem ação real e feedback.
- Validar toda entrada na fronteira da API e configuração com **Zod** em runtime.
- Tratar erros explicitamente; nunca capturar e silenciar exceções.
- Preferir funções pequenas, coesas e com contratos explícitos.

## 4. Fronteiras Arquiteturais do Monorepo

- `packages/contracts`: schemas Zod e contratos HTTP públicos. Não importa `apps/*` nem `packages/database`.
- `packages/domain`: entidades, regras de negócio e portas. Nunca importa Fastify, React, Drizzle nem SDKs de storage concretos.
- `packages/storage-core`: interfaces, registry, validação de capacidades, vault e erros normalizados. Independente de SDKs concretos.
- `packages/storage-local` e `packages/storage-s3`: implementam exclusivamente `storage-core`. O SDK S3 fica isolado em `storage-s3`.
- `packages/database`: Drizzle ORM, migrations e repositórios que implementam as portas do domínio. Sem regra de negócio em handlers HTTP.
- `apps/api`: Fastify; compõe módulos, registra adaptadores, autentica/autoriza e orquestra casos de uso. Não acessa filesystem/S3 diretamente.
- `apps/worker`: reutiliza casos de uso e contratos; nunca cria regras paralelas.
- `apps/web`: React + Vite + MUI; consome apenas API/contratos públicos. Nunca importa PostgreSQL/storage SDK, nunca recebe credenciais permanentes de storage e nunca decide autorização final.

## 5. Segurança Documental, Storage e Governança

- **Autorização no servidor:** verificar `action + resource + scope` antes de buscar, contar, paginar, listar, visualizar, baixar ou mutar. Negação explícita vence concessão herdada. Prevenir IDOR e vazamento por contagem.
- **Arquivos e upload seguro:**
  - Nunca confiar em nome, caminho, extensão ou `Content-Type` enviado pelo cliente.
  - Chaves de objeto são opacas e geradas no backend (`org/{organizationId}/documents/{documentId}/versions/{versionId}/{objectId}`), sem nome original nem PII.
  - Upload e download usam streaming ou URL temporária assinada de escopo/validade curtos (nunca carregar arquivos grandes inteiros em memória).
  - Verificar tamanho máximo, MIME detectado pelo conteúdo + allowlist, checksum SHA-256 e scanner antimalware (falha fechada).
  - Nunca liberar download/preview normal para arquivos em `QUARANTINED` ou `REJECTED`.
  - Finalização de upload deve ser idempotente.
- **Separação de entidades e estados:** Documento (`DocumentStatus`), Versão (append-only/imutável, vinculada exatamente a aprovações) e Objeto Binário (`FileObjectStatus`) são distintos.
- **Segredos e auditoria:**
  - Segredos de storage/SMTP são criptografados com chave mestra externa ao banco e nunca aparecem em logs, respostas HTTP ou `.env.example`.
  - `audit_events` é append-only (sem update/delete pela aplicação comum) e nunca registra senhas, tokens, URLs assinadas, segredos ou conteúdo binário.
  - Exclusão física respeita retenção/legal hold e usa `DELETE_PENDING` + reconciliação idempotente.

## 6. Interface Material Design 3 (`apps/web` e `packages/ui`)

- Usar React + MUI (`@mui/material`) com tema próprio (`packages/ui`) inspirado nos tokens e padrões do Material Design 3. Não afirmar que o tema padrão do MUI implementa integralmente MD3.
- Aparência empresarial, clara e orientada a documentos: tabelas legíveis, filtros visíveis, superfícies tonais discretas.
- Proibido: gradientes decorativos, glassmorphism, neon, blobs, excesso de cartões, animações sem função ou emojis como ícones (usar MUI Icons).
- Paginação, filtros e ordenação devem ser executados no PostgreSQL (nunca filtrar toda a coleção no cliente).
- Tratar todos os estados (hover, foco visível, loading, vazio informativo, erro, desabilitado, sucesso) e garantir acessibilidade (WCAG 2.2 AA, teclado, labels, contraste).
