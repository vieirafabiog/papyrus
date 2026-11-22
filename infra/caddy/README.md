# Proxy HTTPS de Referência (Caddy)

Este diretório contém a configuração de referência do **Caddy** para terminação TLS, cabeçalhos de segurança, controle de tamanho de upload, timeouts de upstream e roteamento reverso unificado entre o frontend (`web`) e a API (`api`) do **DocuFlow**.

## Arquivos

- `Caddyfile`: configuração principal do proxy reverso HTTPS.

## Política configurada

- **TLS automático / HTTPS obrigatório:** o endereço padrão `https://localhost` usa o certificado local gerado pela CA interna do Caddy; em produção, defina `DOCUFLOW_SITE_ADDRESS=https://ged.suaempresa.com.br` e `DOCUFLOW_TLS_EMAIL` para emissão e renovação automática via ACME (Let's Encrypt).
- **Cabeçalhos de segurança na borda:** aplica `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restritiva e remove o cabeçalho `Server`.
- **Limite de corpo coerente com upload:** a rota `/api/*` limita `request_body.max_size` a `52MiB` (`54525952` bytes por padrão via `DOCUFLOW_PROXY_MAX_BODY_SIZE`), alinhado a `UPLOAD_MAX_BYTES=52428800` (50 MiB) + overhead de `PROXY_MAX_BODY_BYTES=54525952` definido em `.env.example` e `@docuflow/config`.
- **Streaming e timeouts:** utiliza `flush_interval -1` na API para evitar bufferização integral de uploads/downloads em memória, além de timeouts explícitos (`dial_timeout 5s`, `response_header_timeout 60s`, `read_timeout 120s`, `write_timeout 120s`).
- **Headers encaminhados confiáveis:** sem `trusted_proxies` permissivo para clientes externos, o Caddy descarta spoofing externo de `X-Forwarded-For` e encaminha `X-Real-IP`, `X-Forwarded-Proto` e `X-Forwarded-Host` reais da conexão TLS terminada.

## Variáveis de ambiente suportadas

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `DOCUFLOW_SITE_ADDRESS` | `https://localhost` | Endereço/domínio HTTPS atendido pelo proxy |
| `DOCUFLOW_TLS_EMAIL` | `admin@localhost` | E-mail de contato ACME em produção |
| `DOCUFLOW_PROXY_MAX_BODY_SIZE` | `52MiB` | Limite máximo de corpo aceito para `/api/*` |
| `DOCUFLOW_API_UPSTREAM` | `api:3000` | Destino interno da API Fastify |
| `DOCUFLOW_WEB_UPSTREAM` | `web:8080` | Destino interno do servidor estático web |

## Validação da configuração

```bash
docker run --rm \
  -v "$(pwd)/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.9.1-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```
