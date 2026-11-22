# Guia de Instalação (DocuFlow)

Este guia descreve o passo a passo completo para implantar o **DocuFlow** em um servidor Linux limpo utilizando Docker Compose e Caddy como proxy HTTPS de referência.

---

## 1. Pré-requisitos

### Sistema e ferramentas no servidor
- Linux x86_64 ou arm64 (Ubuntu 24.04 LTS, Debian 12 ou equivalente)
- **Docker Engine** `>= 24` e **Docker Compose v2** (`docker compose version`)
- **OpenSSL** (para geração criptográfica de segredos) e **Git**
- Caso execute scripts Node de manutenção fora do container: **Node.js `>= 22`** e **pnpm `12.21.0`** (`corepack enable`)

### Portas de rede
- **Públicas (internet/rede corporativa):** `80/tcp` e `443/tcp` terminadas no proxy HTTPS (Caddy).
- **Internas (não expor publicamente):**
  - `postgres`: porta `5432` exclusivamente na rede isolada `docuflow_internal` (`internal: true`)
  - `api`: porta `3000` apenas na rede interna/borda
  - `worker`: porta de health `3001` apenas na rede interna
  - `web`: porta `8080` (mapeada por padrão apenas para `127.0.0.1:8080`)

### DNS e HTTPS
- Crie um registro DNS (`A`/`AAAA`) apontando o domínio desejado (ex.: `ged.suaempresa.com.br`) para o IP público/interno do servidor.
- Para emissão automática de certificado TLS via Let's Encrypt com Caddy, garanta que as portas `80` e `443` estejam acessíveis pelo domínio configurado (ou utilize `https://localhost` em ambiente local/intranet).

---

## 2. Obtenção do Código e Permissões

```bash
git clone <URL_DO_REPOSITORIO> /opt/docuflow
cd /opt/docuflow
```

### Permissões de diretórios e volumes
- Os containers `api` e `worker` executam com usuário não-root `node` (**UID `1000` / GID `1000`**).
- O container `web` executa com usuário não-root `nginx` (**UID `101` / GID `101`**).
- O volume nomeado `docuflow_storage_data` (montado em `/var/lib/docuflow/storage`) é gerenciado pelo Docker; caso utilize bind mount ou backup em host local, garanta que o diretório pertença ao UID `1000` e tenha permissão restrita:

```bash
mkdir -p /var/backups/docuflow/postgres /var/backups/docuflow/files
chmod 700 /var/backups/docuflow /var/backups/docuflow/postgres /var/backups/docuflow/files
```

---

## 3. Configuração das Variáveis de Ambiente

Copie o modelo e gere segredos criptográficos exclusivos (nunca reutilize chaves de exemplo):

```bash
cp .env.example .env
chmod 600 .env
```

Gere chaves aleatórias de 256 bits (`64` caracteres hexadecimais):

```bash
openssl rand -hex 32  # usar em SESSION_SECRET
openssl rand -hex 32  # usar em ENCRYPTION_KEY
openssl rand -hex 24  # usar em POSTGRES_PASSWORD
```

Edite `.env` ajustando no mínimo:

```dotenv
NODE_ENV=production
DOCUFLOW_IMAGE_TAG=v1.0.0

APP_URL=https://ged.suaempresa.com.br
API_URL=https://ged.suaempresa.com.br

POSTGRES_DB=docuflow
POSTGRES_USER=docuflow
POSTGRES_PASSWORD=<SENHA_FORTE_GERADA>
DATABASE_URL=postgresql://docuflow:<SENHA_FORTE_GERADA>@postgres:5432/docuflow

SESSION_SECRET=<HEX_64_CHARS_1>
ENCRYPTION_KEY=<HEX_64_CHARS_2>

STORAGE_DEFAULT_CONNECTION=local-default
STORAGE_LOCAL_ROOT=/var/lib/docuflow/storage
UPLOAD_MAX_BYTES=52428800
PROXY_MAX_BODY_BYTES=54525952
UPLOAD_ALLOWED_EXTENSIONS=.pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.txt,.csv,.docx,.xlsx,.pptx
```

> **Importante:** armazene uma cópia segura da `ENCRYPTION_KEY` e do arquivo `.env` fora do servidor (cofre corporativo). Sem `ENCRYPTION_KEY`, segredos de conectores S3/SMTP armazenados no PostgreSQL não podem ser decifrados.

---

## 4. Build e Subida Inicial dos Serviços Base

1. Valide a configuração resolvida do Compose antes de iniciar:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml config
```

2. Construa as imagens e inicie primeiro o PostgreSQL:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml build
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d postgres
```

3. Aguarde o `postgres` atingir estado `healthy`:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml ps postgres
```

### Profile opcional de laboratório (ClamAV e MinIO)

Apenas se a instalação **não** possuir scanner ClamAV externo nem bucket S3 corporativo próprio:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.storage.yml \
  --profile lab-storage up -d clamav minio
```

Clientes que usam volume local (`docuflow_storage_data`) ou S3 externo **não** devem habilitar `minio`.

---

## 5. Execução Segura das Migrations

Execute as migrations antes de liberar o tráfego de usuários. O runner utiliza lock advisory no PostgreSQL e bloqueia qualquer seed destrutivo em `NODE_ENV=production`:

```bash
pnpm --filter @docuflow/database build
NODE_ENV=production DATABASE_URL="postgresql://docuflow:<SENHA>@127.0.0.1:5432/docuflow" \
  ./scripts/maintenance/migrate-entrypoint.sh
```

*(Caso o PostgreSQL esteja acessível apenas na rede Docker `docuflow_docuflow_internal`, execute `node packages/database/dist/migrate-cli.js` em container conectado a essa rede ou via `docker compose exec`.)*

---

## 6. Subida da Aplicação e Proxy HTTPS (Caddy)

Suba os serviços `api`, `worker` e `web`:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d api worker web
```

Valide e inicie o proxy HTTPS usando `infra/caddy/Caddyfile` (veja detalhes em `infra/caddy/README.md`):

```bash
docker run --rm \
  -v "$(pwd)/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.9.1-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Certifique-se de que `DOCUFLOW_SITE_ADDRESS` aponta para `https://ged.suaempresa.com.br` (e `DOCUFLOW_TLS_EMAIL` está preenchido) ao subir o proxy conectado à rede `docuflow_docuflow_edge`.

---

## 7. Criação do Primeiro Administrador

Existem duas formas oficiais (ambas idempotentes — só funcionam enquanto não houver usuários cadastrados):

### Opção A — Via interface web / API de setup inicial
1. Acesse `https://ged.suaempresa.com.br` no navegador (ou verifique `GET /api/v1/setup/status`).
2. Preencha os dados da organização e do primeiro administrador para concluir o bootstrap (`POST /api/v1/setup/bootstrap-admin`).

### Opção B — Via linha de comando administrativa (automação)

Utilizando o pacote compilado `@docuflow/api` (ou dentro do próprio container `api` em execução):

```bash
pnpm --filter @docuflow/api build
DATABASE_URL="postgresql://docuflow:<SENHA>@<HOST_PG>:5432/docuflow" \
DOCUFLOW_ORG_NAME="Sua Empresa" \
DOCUFLOW_ORG_SLUG="sua-empresa" \
DOCUFLOW_ADMIN_NAME="Administrador Inicial" \
DOCUFLOW_ADMIN_EMAIL="admin@suaempresa.com.br" \
DOCUFLOW_ADMIN_PASSWORD="<SENHA_ADMIN_FORTE>" \
pnpm --filter @docuflow/api exec node --input-type=module -e '
import { randomUUID } from "node:crypto";
import { createPasswordService } from "@docuflow/auth";
import { createDatabaseClient } from "@docuflow/database";
import { createDrizzleSetupRepository } from "./dist/modules/setup/setup.repository.js";
import { createSetupService } from "./dist/modules/setup/setup.service.js";
const db = createDatabaseClient({ connectionString: process.env.DATABASE_URL });
try {
  const service = createSetupService({
    repository: createDrizzleSetupRepository(db.db),
    passwordService: createPasswordService(),
  });
  const created = await service.bootstrapFirstAdmin({
    organizationName: process.env.DOCUFLOW_ORG_NAME,
    organizationSlug: process.env.DOCUFLOW_ORG_SLUG,
    email: process.env.DOCUFLOW_ADMIN_EMAIL,
    fullName: process.env.DOCUFLOW_ADMIN_NAME,
    password: process.env.DOCUFLOW_ADMIN_PASSWORD,
  }, randomUUID());
  console.log(JSON.stringify({ status: "created", ...created }));
} finally {
  await db.close();
}
'
```

---

## 8. Verificação Pós-Instalação

1. Confirme a saúde pública da API e conectividade do banco:
   - `GET https://ged.suaempresa.com.br/api/v1/health/live` -> HTTP `200` (`{"status":"ok"}`)
   - `GET https://ged.suaempresa.com.br/api/v1/health/ready` -> HTTP `200` (`{"status":"ready",...}`)
2. Faça login com o administrador inicial na interface web (`https://ged.suaempresa.com.br`).
3. Configure e teste a conexão de armazenamento padrão (local ou S3) em **Administração -> Armazenamento**.
4. Realize o envio, visualização e download de um documento de teste.
