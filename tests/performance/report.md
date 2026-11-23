# Relatório de Teste de Carga Básico — DocuFlow

> **Nota metodológica:** Os resultados abaixo foram medidos empiricamente na execução do script reproduzível [run-load-test.ts](./run-load-test.ts). Não representam metas ou SLAs contratuais nem garantias para hardware distinto.

## 1. Ambiente e Hardware Registrados

- **Data/hora (UTC):** `2026-11-23T23:37:15.117Z`
- **Sistema operacional:** `linux 7.0.0-43-generic (x64)`
- **CPU:** `AMD Ryzen 5 7520U with Radeon Graphics` (8 threads lógicas)
- **Memória RAM total:** `7.00 GiB`
- **Runtime Node.js:** `v24.22.1`
- **PostgreSQL:** `PostgreSQL 16.8 on x86_64-pc-linux-musl, compiled by gcc (Alpine 14.2.0) 14.2.0, 64-bit` (container local isolado via Testcontainers)
- **Armazenamento utilizado no teste:** Conector local em diretório temporário (`@docuflow/storage-local`)

## 2. Dataset Conhecido e Configuração

- **Documentos inseridos no PostgreSQL:** `1000` registros (`documents`, `document_versions`, `file_objects`), populados em `520.81 ms`
- **Categorias / Pastas:** `4` categorias e `6` pastas ativas
- **Autenticação no benchmark:** Hash real `Argon2id` (`memoryCost=8192, timeCost=2, parallelism=1`) + criação de sessão no PostgreSQL + proteção CSRF; limite de tentativas por IP (`loginRateLimit`) ajustado exclusivamente nesta instância de teste para permitir medir a carga de logins sem bloqueio por HTTP 429 do mesmo loopback
- **Payload dos uploads concorrentes:** `65536` bytes por arquivo (`application/pdf`) executando o fluxo completo em 3 etapas (`POST /uploads/sessions` -> `PUT /uploads/sessions/:id/content` -> `POST /uploads/sessions/:id/finalize`)

## 3. Resultados Medidos

| Cenário | Operação / Endpoints | Requisições | Concorrência | Duração total (ms) | Vazão (req/s ou fluxos/s) | Sucessos | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Login autenticado | `POST /api/v1/auth/login` | 20 | 4 | 167.70 | 119.26 | 20/20 | 19.47 | 28.26 | 60.08 | 61.39 | 61.39 |
| Listagem paginada | `GET /api/v1/documents?page=..&pageSize=25` | 120 | 12 | 476.42 | 251.88 | 120/120 | 20.16 | 41.80 | 107.55 | 121.09 | 130.08 |
| Busca filtrada no servidor | `GET /api/v1/documents/search?search=..&categoryId=..` | 120 | 12 | 411.04 | 291.94 | 120/120 | 24.23 | 39.65 | 46.78 | 55.86 | 56.69 |
| Uploads concorrentes | `POST /sessions -> PUT /content -> POST /finalize` | 24 | 6 | 505.52 | 47.48 | 24/24 | 80.34 | 117.32 | 161.51 | 173.30 | 173.30 |

## 4. Como Reproduzir

```bash
pnpm test:performance
```

Variáveis opcionais para ajustar volume/concorrência mantendo a mesma medição:
`DOCUFLOW_PERF_DOCS`, `DOCUFLOW_PERF_LOGIN_REQS`, `DOCUFLOW_PERF_LIST_REQS`, `DOCUFLOW_PERF_SEARCH_REQS`, `DOCUFLOW_PERF_UPLOAD_FLOWS`, `DOCUFLOW_PERF_UPLOAD_BYTES`.
