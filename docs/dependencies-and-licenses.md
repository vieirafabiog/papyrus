# Auditoria de Dependências, Licenças e Política de Atualização (DocuFlow)

Este documento registra o inventário de licenças, o resultado datado da auditoria de vulnerabilidades (CVEs), os bloqueadores resolvidos e a política contínua de manutenção de dependências do **DocuFlow**.

---

## 1. Registro da Auditoria Executada

- **Data de execução:** `2026-11-23`
- **Ferramenta / Scanner oficial:** `pnpm licenses list`, `pnpm audit` e gate automatizado [`scripts/ci/check-dependencies.mjs`](../scripts/ci/check-dependencies.mjs) (`pnpm audit:deps`)
- **Escopo analisado:** todas as 15 unidades do workspace (`apps/*`, `packages/*` e ferramentas de raiz), cobrindo `616` dependências totais no monorepo (`209` no grafo de produção: `187` diretas/transitivas de runtime + `22` opcionais).

---

## 2. Inventário de Licenças (Diretas e Transitivas)

Todas as dependências diretas e transitivas analisadas utilizam **licenças permissivas compatíveis com distribuição empresarial self-hosted**, sem presença de licenças copyleft restritivas (`GPL`, `AGPL`, `SSPL`, `BUSL`) ou desconhecidas.

### 2.1 Dependências de produção (`apps/*` e `packages/*`)

| Licença | Quantidade de pacotes |
| --- | ---: |
| `MIT` | 147 |
| `Apache-2.0` | 27 |
| `ISC` | 7 |
| `BSD-3-Clause` | 6 |
| `BlueOak-1.0.0` | 1 |
| `0BSD` | 1 |

### 2.2 Monorepo completo (incluindo `devDependencies`)

| Licença | Quantidade de pacotes |
| --- | ---: |
| `MIT` | 216 |
| `Apache-2.0` | 25 |
| `ISC` | 25 |
| `BSD-3-Clause` | 17 |
| `BlueOak-1.0.0` | 6 |
| `MIT OR Apache-2.0` (`@biomejs/biome`) | 2 |
| `BSD-2-Clause` | 2 |
| `MIT-0` (`@csstools/color-helpers`) | 1 |
| `Unlicense` | 1 |

---

## 3. CVEs Encontrados, Bloqueadores Resolvidos e Riscos Residuais

### 3.1 Bloqueadores resolvidos antes do release

Durante a auditoria inicial de produção (`pnpm audit --prod`), foram corrigidos os seguintes advisories em dependências de runtime atualizando as versões no workspace e em `pnpm-lock.yaml`:

| Advisory | Severidade | Pacote | Correção aplicada | Status |
| --- | --- | --- | --- | --- |
| `1116251` | Alta (`high`) | `drizzle-orm` | Atualizado `0.41.0` → `^0.45.4` (`0.45.4`) | **Resolvido** |
| `1240982` | Alta (`high`) | `@fastify/busboy` (`@docuflow/api`) | Atualizado `2.1.1` → `^3.2.6` (`3.2.6`) | **Resolvido** |
| `1241276` | Moderada (`moderate`) | `@fastify/busboy` (`@docuflow/api`) | Atualizado `2.1.1` → `^3.2.6` (`3.2.6`) | **Resolvido** |

### 3.2 Resultados atuais em runtime de produção (`pnpm audit --prod`)

Após as atualizações acima (`info: 0`, `low: 0`, `moderate: 0`, `high: 1`, `critical: 0` em `209` pacotes):

| Advisory | Severidade | Pacote | Descrição / Impacto | Classificação e Mitigação |
| --- | --- | --- | --- | --- |
| `1243066` | Alta (`high`) | `zod` (`3.25.x`, requer `>=4.6.6`) | Exaustão de memória ao validar coleções restritas de tamanho arbitrário | **Exceção temporária controlada:** migração para `zod` v4 é quebra de API major em todo o monorepo. Mitigada em runtime por limites explícitos de corpo HTTP (`bodyLimit` no Fastify, `PROXY_MAX_BODY_BYTES`), limites de paginação (`pageSize <= 100`) e limites de string/array nos contratos. |

### 3.3 Resultados em dependências exclusivas de desenvolvimento e testes (`devDependencies`)

Os advisories restantes no grafo completo (`pnpm audit` sem `--prod`: `esbuild`, `undici`, `uuid`, `glob`, `minimatch`, `vitest`, `@vitest/mocker`, `tinypool`) ocorrem **exclusivamente** sob `drizzle-kit`, `vitest` e `testcontainers`/`dockerode`. Nenhum desses pacotes entra nos artefatos de runtime dos containers `api`, `worker` ou `web` (construídos com `pnpm install --prod` / bundle estático Vite).

---

## 4. Integração em CI (`github/workflows/ci.yml`)

O workflow [.github/workflows/ci.yml](../.github/workflows/ci.yml) executa `pnpm audit:deps` em toda branch `main` e Pull Request com instalação `--frozen-lockfile`, garantindo:

1. Bloqueio automático caso qualquer licença fora da lista permissiva aprovada entre no monorepo.
2. Bloqueio automático caso qualquer nova vulnerabilidade `high` ou `critical` não documentada surja nas dependências de produção.

---

## 5. Política Contínua de Atualização

1. **Lockfile determinístico:** `pnpm-lock.yaml` é obrigatório e validado com `--frozen-lockfile` no CI e nos Dockerfiles.
2. **Triagem mensal e pré-release:** executar `pnpm audit:deps` e `pnpm audit` antes de cada tag de release e mensalmente em operação.
3. **SLA interno de resposta a CVEs de produção:**
   - Vulnerabilidade `critical` ou `high` explorável no grafo de runtime bloqueia novo release até correção ou mitigação documentada com prazo.
   - Atualizações patch/minor de segurança (`drizzle-orm`, `fastify`, `@aws-sdk/*`, React, MUI) são aplicadas diretamente após `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
   - Atualizações major (ex.: `zod` v4, Vite, Vitest v4) são avaliadas em branch isolada com validação integral das suítes unitárias, integração e E2E antes da adoção.
