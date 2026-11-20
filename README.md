# DocuFlow

> **Estado do projeto:** em construção (fase inicial de bootstrap do monorepo). As funcionalidades descritas na especificação ainda estão em implementação conforme o [Plano de Execução](./EXECUTION_PLAN.md).

**DocuFlow** é um GED (Gerenciador Eletrônico de Documentos) *self-hosted* projetado para centralizar arquivos empresariais, estruturar metadados, controlar versões imutáveis e permissões no servidor, acompanhar vencimentos e conduzir fluxos simples de revisão e aprovação.

## Documentação Mestra

- [Documento Mestre de Produto e Arquitetura Técnica](./project.md)
- [Plano Mestre de Execução](./EXECUTION_PLAN.md)
- [Exemplo de Variáveis de Ambiente](./.env.example)

## Stack Prevista

- **Linguagem e Monorepo:** TypeScript (`strict: true`), Node.js `>=22`, `pnpm` workspaces
- **Frontend (`apps/web`):** React, Vite, MUI (`@mui/material`) com tema inspirado em Material Design 3
- **API (`apps/api`):** Fastify, Zod
- **Worker (`apps/worker`):** processamento assíncrono com fila persistida em PostgreSQL
- **Banco de dados (`packages/database`):** PostgreSQL + Drizzle ORM
- **Armazenamento (`packages/storage-*`):** adaptadores desacoplados para filesystem local e S3 compatível
- **Qualidade e Testes:** Biome, Vitest, Playwright, Testcontainers
- **Implantação:** Docker Compose

## Requisitos Locais

- Node.js `>=22`
- `pnpm` (`12.21.0`, gerenciado via Corepack)
- Git

## Comandos da Raiz

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
