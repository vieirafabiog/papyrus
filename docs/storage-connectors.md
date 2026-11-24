# Guia de Conectores de Armazenamento (DocuFlow)

Este guia descreve a configuração, os controles de segurança, os testes de saúde e as limitações dos conectores de armazenamento do **DocuFlow** no MVP self-hosted: **Filesystem Local (`local`)** e **S3 Compatível (`s3`)**.

---

## 1. Visão Arquitetural e Chaves Opacas

O domínio documental e a API comunicam-se com arquivos binários exclusivamente através da abstração `@docuflow/storage-core` (`StorageProvider` e `StorageProviderRegistry`):

- **Identidade lógica separada do binário:** cada registro em `file_objects` guarda `storage_connection_id`, `object_key`, `size_bytes`, `detected_content_type` e `checksum_sha256`.
- **Chave opaca gerada no servidor:** todos os objetos seguem o padrão sem PII nem nome original do arquivo:

  ```text
  org/{organizationId}/documents/{documentId}/versions/{versionId}/{objectId}
  ```

- **Matriz de capacidades atual (`StorageCapabilities`):**

| Capacidade | Local (`@docuflow/storage-local`) | S3 Compatível (`@docuflow/storage-s3`) |
| --- | --- | --- |
| Leitura por stream (`streamingRead`) | Sim | Sim |
| Escrita por stream (`streamingWrite`) | Sim | Sim |
| Upload por URL assinada (`signedUpload`) | Não | Sim (opcional com TTL curto) |
| Download por URL assinada (`signedDownload`) | Não | Sim (opcional com TTL curto) |
| Multipart upload nativo (`multipartUpload`) | Não | Não (pós-MVP) |
| Cópia server-side (`serverSideCopy`) | Não | Não (pós-MVP) |

Quando URLs assinadas não estão disponíveis ou suportadas pelo conector, upload e download utilizam streaming autenticado pela API sem carregar o arquivo inteiro em memória.

---

## 2. Conector Filesystem Local (`kind: "local"`)

Implementado em `@docuflow/storage-local` para armazenamentos persistentes locais (disco local, volume Docker, NFS confiável montado no servidor).

### 2.1 Configuração na administração

| Campo | Obrigatório | Descrição |
| --- | --- | --- |
| Nome da conexão | Sim | Identificador único da conexão na organização |
| Diretório raiz (`rootDirectory`) | Sim | Caminho absoluto persistente dentro do container/host (ex.: `/var/lib/docuflow/storage`) |
| Tamanho máximo por objeto (`maxObjectSizeBytes`) | Não | Limite adicional por objeto em bytes aplicado pelo conector |
| Espaço livre mínimo (`minFreeBytes`) | Não | Limiar mínimo em bytes verificado durante o health check |

### 2.2 Permissões mínimas no sistema de arquivos

- Os containers `api` e `worker` executam com usuário não-root **`node` (`UID 1000 / GID 1000`)**.
- No Compose padrão (`infra/compose/docker-compose.yml`), o volume nomeado `docuflow_storage_data` é montado em `/var/lib/docuflow/storage` em ambos os containers (`api` e `worker`).
- Se utilizar bind mount no host, garanta propriedade e permissão restrita:

```bash
mkdir -p /var/lib/docuflow/storage
chown -R 1000:1000 /var/lib/docuflow/storage
chmod 750 /var/lib/docuflow/storage
```

### 2.3 Garantias de segurança local

- Escrita atômica via arquivo temporário `.tmp-*` seguido de `fsync` opcional e `rename`, prevenindo leitura de objetos parciais.
- Metadados técnicos armazenados em sidecar JSON sob `.docuflow-meta/`.
- Rejeição estrita de *path traversal* (`..`, `\`, URL-encoding, bytes nulos, dotfiles ou nomes reservados) e bloqueio de **symlinks** em qualquer componente do caminho (`safe-path.ts`).

---

## 3. Conector S3 Compatível (`kind: "s3"`)

Implementado em `@docuflow/storage-s3` com AWS SDK v3 isolado de domínio, banco e frontend. Testado contra **MinIO** e endpoints compatíveis com API S3.

### 3.1 Parâmetros de configuração

| Campo | Obrigatório | Padrão / Regras de validação |
| --- | --- | --- |
| `endpoint` | Sim | URL `https://...` (sem credenciais embutidas, sem query string nem `#fragment`, máx. 512 chars) |
| `region` | Sim | 3–64 caracteres (`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`, ex.: `us-east-1`, `sa-east-1`) |
| `bucket` | Sim | 3–63 caracteres minúsculos, dígitos, `.` ou `-`, sem `..` e sem formato IPv4 |
| `forcePathStyle` | Não | `false` por padrão; **obrigatório `true` para MinIO** e provedores sem virtual-hosted-style |
| `keyPrefix` | Não | Prefixo lógico opcional validado por segmentos seguros (sem `..`) |
| `tls.rejectUnauthorized` | Não | `true` (exige certificado TLS válido) |
| `tls.allowInsecureHttp` | Não | `false` (HTTPS obrigatório em produção; HTTP exige habilitação explícita em laboratório/rede controlada) |
| `tls.caCertificatePem` | Não | Cadeia PEM opcional para endpoints com Autoridade Certificadora privada |
| `timeouts.connectionTimeoutMs` | Não | `5.000` ms (intervalo permitido: `500`–`60.000` ms) |
| `timeouts.requestTimeoutMs` | Não | `30.000` ms (intervalo permitido: `1.000`–`300.000` ms) |
| `credentials.accessKeyId` | Sim | 3–256 caracteres, sem espaços |
| `credentials.secretAccessKey` | Sim | 8–512 caracteres |
| `credentials.sessionToken` | Não | Token temporário opcional (nunca exposto em URLs pré-assinadas ou resumos públicos) |

### 3.2 Proteção contra SSRF

Antes de cadastrar ou operar um endpoint S3, `validateS3EndpointUrl` e `validateS3EndpointResolution` aplicam fail-closed contra:

1. Endereços de metadados cloud (`169.254.169.254`, `169.254.0.0/16`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`) — **sempre bloqueados**, independentemente de flags.
2. Protocolos não HTTP(S), credenciais embutidas na URL (`https://user:pass@...`), query strings ou fragmentos.
3. IPs privados/reservados (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, CGNAT `100.64.0.0/10`, link-local, `::1`, `fc00::/7`, `fe80::/10`) e hostnames internos (`.local`, `.internal`, `.localhost`, nomes sem ponto), inclusive validando **todos os IPs retornados via DNS** contra *DNS rebinding*, salvo quando explicitamente autorizados pela política do servidor (`S3EndpointSecurityPolicy`).

### 3.3 Permissões mínimas recomendadas no bucket (IAM / MinIO Policy)

O DocuFlow **não cria nem exclui buckets**. Conceda à chave de serviço apenas o conjunto mínimo no bucket/prefixo alvo:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DocuflowBucketCheck",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::SEU_BUCKET"
    },
    {
      "Sid": "DocuflowObjectOperations",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::SEU_BUCKET/*"
    }
  ]
}
```

Se utilizar `keyPrefix`, restrinja o recurso de objetos a `arn:aws:s3:::SEU_BUCKET/<keyPrefix>/*` e adicione condição `StringLike` em `s3:prefix` para o health check e prefixo operacional.

### 3.4 Uso com MinIO (Docker Compose e ambiente controlado)

O repositório disponibiliza o serviço opcional `minio` em [docker-compose.storage.yml](../infra/compose/docker-compose.storage.yml) sob os perfis `minio` e `lab-storage`:

```bash
MINIO_ROOT_USER=docuflow-minio \
MINIO_ROOT_PASSWORD='<SENHA_FORTE_MINIO>' \
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.storage.yml \
  --profile minio up -d
```

Checklist para conectar o MinIO no DocuFlow:

1. Crie o bucket previamente no MinIO (ex.: `docuflow`) e uma *Access Key* com a política mínima da seção 3.3.
2. Utilize **`forcePathStyle: true`** no cadastro da conexão S3.
3. Em produção, exponha o MinIO atrás de TLS válido (`https://storage.suaempresa.com.br`) com certificado confiável ou informe a CA interna em `caCertificatePem`.
4. Apenas em laboratório local sem TLS (`http://127.0.0.1:9000` ou `http://minio:9000`), habilite explicitamente `allowInsecureHttp` e a política controlada de endpoints privados (`S3EndpointSecurityPolicy`); nunca utilize HTTP em produção aberta.

### 3.5 Checksums e URLs pré-assinadas

- No modo padrão `checksumSupport: "auto"`, o conector envia SHA-256 nativo S3 e mantém fallback seguro para validação via metadado `x-amz-meta-docuflow-sha256` combinada à conferência de hash no stream de upload/download quando o provedor não suporta checksum nativo.
- Quando `enableSignedTargets` está habilitado, as URLs geradas impõem TTL curto (limites de `15` a `120` segundos por padrão, teto administrativo `<= 900` s), chave de objeto única sem caracteres de controle, `Content-Disposition` sanitizado contra CRLF/traversal e bloqueio de exposição de segredos ou `sessionToken`.

---

## 4. Proteção de Credenciais e Rotação

- As credenciais S3 (`accessKeyId`, `secretAccessKey`, `sessionToken`) são cifradas em AES-256-GCM pelo `@docuflow/storage-core` (`createStorageSecretVault`) utilizando a chave mestra `ENCRYPTION_KEY` (256 bits) externa ao banco antes de gravar `encrypted_secret_payload` no PostgreSQL.
- A API e a UI **nunca** retornam segredos descriptografados nem URLs com credenciais (`hasCredentials: true` + máscara visual na UI).
- Ao editar uma conexão S3 existente sem informar novas credenciais, os segredos cifrados anteriores são preservados.
- Em erros e logs, URLs assinadas e mensagens com credenciais são sanitizadas antes do registro.
- Caso rotacione `ENCRYPTION_KEY`, mantenha a chave antiga em `ENCRYPTION_KEYRING` até re-encriptar os registros existentes com a chave ativa.

---

## 5. Health Check e Seleção por Categoria

### 5.1 Verificação de saúde (`POST /api/v1/admin/storage-connections/:id/test`)

- **Local:** verifica existência do diretório raiz, ausência de symlinks indevidos, permissões de leitura/escrita/execução, espaço disponível (`minFreeBytes`) e sonda controlada de criação/leitura/remoção (`.docuflow-health-*.tmp`).
- **S3:** valida sintaxe e resolução DNS anti-SSRF, executa `HeadBucket` e, quando habilitada a sonda completa (`verifyReadWrite`), grava e remove um objeto temporário `.docuflow-health-probe-*` respeitando `keyPrefix`.
- O resultado grava `lastHealthCheckAt`, `lastHealthMessage`, atualiza `status` (`ACTIVE` ou `ERROR`) e registra evento na tabela `audit_events`.

### 5.2 Conexão padrão, roteamento por categoria e conexões inativas

- Em **Administração → Armazenamento**, a organização define uma **conexão padrão** e opcionais **regras de roteamento por categoria** (`storage_routing_rules`).
- A resolução de destino para novos uploads prioriza a regra ativa da categoria do documento e, na ausência dela, utiliza a conexão padrão ativa da organização (`createStorageRouterService`).
- **Alterar a regra padrão ou de categoria nunca move arquivos já enviados:** cada objeto existente continua associado ao `storage_connection_id` em que foi gravado.
- Conexões marcadas como `INACTIVE` bloqueiam novos uploads e downloads comuns (`STORAGE_UNAVAILABLE`); apenas o job de reconciliação de expurgo físico (`allowInactive: true`) pode concluir remoções pendentes agendadas.

---

## 6. Limitações Conhecidas (MVP 1.0)

1. **Conectores pós-MVP:** `azure_blob` e `google_cloud` estão declarados no modelo/enum para compatibilidade futura, mas não possuem adaptadores ativos nesta versão (use `local` ou `s3`).
2. **Migração entre storages:** mover binários existentes entre conectores (ex.: de `local` para `s3`) com conferência de checksum será entregue em rotina dedicada pós-MVP.
3. **Multipart S3 nativo:** `multipartUpload` e `serverSideCopy` ainda retornam `false` nas capacidades do provedor; arquivos dentro do limite configurado são enviados via stream único validado.
4. **Checksums nativos heterogêneos:** certos provedores S3 compatíveis antigos rejeitam headers de checksum nativo AWS; o modo `auto` realiza fallback automático mantendo integridade SHA-256 em metadados e validação na leitura/finalização.
