import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import {
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createDocumentSearchRepository,
  createDocumentVersionRepository,
  createOutboxRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTransactionManager,
  createUploadSessionRepository,
  documentVersions,
  documents,
  fileObjects,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@docuflow/database";
import {
  createFinalizeUploadService,
  createStorageRouterService,
  createUploadSessionService,
} from "@docuflow/domain";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createAuthService } from "../../apps/api/src/modules/auth/auth.service.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, "../..");
const MIGRATIONS_FOLDER = path.resolve(REPO_ROOT, "packages/database/drizzle");
const DEFAULT_REPORT_PATH = path.resolve(CURRENT_DIR, "report.md");

const DATASET_DOCUMENT_COUNT = Number(process.env.DOCUFLOW_PERF_DOCS ?? 1000);
const LOGIN_REQUESTS = Number(process.env.DOCUFLOW_PERF_LOGIN_REQS ?? 20);
const LOGIN_CONCURRENCY = Number(process.env.DOCUFLOW_PERF_LOGIN_CONCURRENCY ?? 4);
const LIST_REQUESTS = Number(process.env.DOCUFLOW_PERF_LIST_REQS ?? 120);
const LIST_CONCURRENCY = Number(process.env.DOCUFLOW_PERF_LIST_CONCURRENCY ?? 12);
const SEARCH_REQUESTS = Number(process.env.DOCUFLOW_PERF_SEARCH_REQS ?? 120);
const SEARCH_CONCURRENCY = Number(process.env.DOCUFLOW_PERF_SEARCH_CONCURRENCY ?? 12);
const UPLOAD_FLOWS = Number(process.env.DOCUFLOW_PERF_UPLOAD_FLOWS ?? 24);
const UPLOAD_CONCURRENCY = Number(process.env.DOCUFLOW_PERF_UPLOAD_CONCURRENCY ?? 6);
const UPLOAD_PAYLOAD_BYTES = Number(process.env.DOCUFLOW_PERF_UPLOAD_BYTES ?? 64 * 1024);

interface ScenarioSample {
  readonly durationMs: number;
  readonly statusCode: number;
  readonly ok: boolean;
  readonly errorDetail?: string;
}

interface ScenarioSummary {
  readonly name: string;
  readonly endpointSummary: string;
  readonly totalRequests: number;
  readonly concurrency: number;
  readonly wallDurationMs: number;
  readonly throughputRps: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly avgMs: number;
}

function percentileNearestRank(sortedAsc: readonly number[], percentile: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[index] ?? 0;
}

function summarizeScenario(
  name: string,
  endpointSummary: string,
  concurrency: number,
  wallDurationMs: number,
  samples: readonly ScenarioSample[],
): ScenarioSummary {
  const latencies = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const statusCounts: Record<string, number> = {};
  let successCount = 0;
  let failureCount = 0;
  let totalLatency = 0;

  for (const sample of samples) {
    const key = String(sample.statusCode);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    totalLatency += sample.durationMs;
    if (sample.ok) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }

  const totalRequests = samples.length;
  const avgMs = totalRequests > 0 ? totalLatency / totalRequests : 0;
  const throughputRps = wallDurationMs > 0 ? (totalRequests / wallDurationMs) * 1000 : 0;

  return {
    name,
    endpointSummary,
    totalRequests,
    concurrency,
    wallDurationMs,
    throughputRps,
    successCount,
    failureCount,
    statusCounts,
    minMs: latencies[0] ?? 0,
    p50Ms: percentileNearestRank(latencies, 50),
    p95Ms: percentileNearestRank(latencies, 95),
    p99Ms: percentileNearestRank(latencies, 99),
    maxMs: latencies[latencies.length - 1] ?? 0,
    avgMs,
  };
}

async function runConcurrentWorkload(
  totalTasks: number,
  concurrency: number,
  executeTask: (taskIndex: number) => Promise<ScenarioSample>,
): Promise<{ readonly wallDurationMs: number; readonly samples: readonly ScenarioSample[] }> {
  const samples: ScenarioSample[] = new Array(totalTasks);
  let nextIndex = 0;
  const startedAt = performance.now();

  const worker = async (): Promise<void> => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= totalTasks) {
        return;
      }
      samples[current] = await executeTask(current);
    }
  };

  const workerCount = Math.min(concurrency, totalTasks);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    wallDurationMs: performance.now() - startedAt,
    samples,
  };
}

function extractCookiesMap(response: Response): ReadonlyMap<string, string> {
  const headersObj = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawList =
    typeof headersObj.getSetCookie === "function"
      ? headersObj.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=[^;]+=)/) ?? []);

  const cookies = new Map<string, string>();
  for (const headerLine of rawList) {
    const firstSegment = headerLine.split(";")[0]?.trim() ?? "";
    const eqIndex = firstSegment.indexOf("=");
    if (eqIndex > 0) {
      cookies.set(firstSegment.slice(0, eqIndex), firstSegment.slice(eqIndex + 1));
    }
  }
  return cookies;
}

async function fetchCsrfAndSession(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ readonly cookieHeader: string; readonly csrfToken: string }> {
  const csrfRes = await fetch(`${baseUrl}/api/v1/auth/csrf-token`);
  if (!csrfRes.ok) {
    throw new Error(`Falha ao obter CSRF token: HTTP ${csrfRes.status}`);
  }
  const csrfPayload = (await csrfRes.json()) as { data?: { csrfToken?: string } };
  const csrfToken = csrfPayload.data?.csrfToken;
  if (!csrfToken) {
    throw new Error("CSRF token ausente na resposta.");
  }

  const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `docuflow_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    throw new Error(`Falha ao autenticar usuário de benchmark: HTTP ${loginRes.status}`);
  }

  const loginCookies = extractCookiesMap(loginRes);
  const sessionToken = loginCookies.get("docuflow_session");
  if (!sessionToken) {
    throw new Error("Cookie docuflow_session não emitido no login.");
  }

  return {
    cookieHeader: `docuflow_csrf=${csrfToken}; docuflow_session=${sessionToken}`,
    csrfToken,
  };
}

function buildSeededUploadBuffer(byteLength: number): {
  readonly buffer: Buffer;
  readonly sha256: string;
} {
  const header = Buffer.from("%PDF-1.7\n%DocuFlowPerformanceTest\n", "utf8");
  const footer = Buffer.from("\n%%EOF\n", "utf8");
  const bodySize = Math.max(64, byteLength - header.length - footer.length);
  const filler = Buffer.alloc(bodySize, "A");
  const buffer = Buffer.concat([header, filler, footer]);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { buffer, sha256 };
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

function formatReportMarkdown(params: {
  readonly executedAtIso: string;
  readonly postgresVersion: string;
  readonly datasetDocuments: number;
  readonly datasetCategories: number;
  readonly datasetFolders: number;
  readonly uploadPayloadBytes: number;
  readonly seedDurationMs: number;
  readonly summaries: readonly ScenarioSummary[];
}): string {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "Desconhecido";
  const cpuCount = cpus.length;
  const totalRamGiB = (os.totalmem() / 1024 ** 3).toFixed(2);

  const tableRows = params.summaries
    .map(
      (s) =>
        `| ${s.name} | \`${s.endpointSummary}\` | ${s.totalRequests} | ${s.concurrency} | ${formatMs(s.wallDurationMs)} | ${s.throughputRps.toFixed(2)} | ${s.successCount}/${s.totalRequests} | ${formatMs(s.minMs)} | ${formatMs(s.p50Ms)} | ${formatMs(s.p95Ms)} | ${formatMs(s.p99Ms)} | ${formatMs(s.maxMs)} |`,
    )
    .join("\n");

  return `# Relatório de Teste de Carga Básico — DocuFlow

> **Nota metodológica:** Os resultados abaixo foram medidos empiricamente na execução do script reproduzível [run-load-test.ts](./run-load-test.ts). Não representam metas ou SLAs contratuais nem garantias para hardware distinto.

## 1. Ambiente e Hardware Registrados

- **Data/hora (UTC):** \`${params.executedAtIso}\`
- **Sistema operacional:** \`${os.platform()} ${os.release()} (${os.arch()})\`
- **CPU:** \`${cpuModel}\` (${cpuCount} threads lógicas)
- **Memória RAM total:** \`${totalRamGiB} GiB\`
- **Runtime Node.js:** \`${process.version}\`
- **PostgreSQL:** \`${params.postgresVersion}\` (container local isolado via Testcontainers)
- **Armazenamento utilizado no teste:** Conector local em diretório temporário (\`@docuflow/storage-local\`)

## 2. Dataset Conhecido e Configuração

- **Documentos inseridos no PostgreSQL:** \`${params.datasetDocuments}\` registros (\`documents\`, \`document_versions\`, \`file_objects\`), populados em \`${formatMs(params.seedDurationMs)} ms\`
- **Categorias / Pastas:** \`${params.datasetCategories}\` categorias e \`${params.datasetFolders}\` pastas ativas
- **Autenticação no benchmark:** Hash real \`Argon2id\` (\`memoryCost=8192, timeCost=2, parallelism=1\`) + criação de sessão no PostgreSQL + proteção CSRF; limite de tentativas por IP (\`loginRateLimit\`) ajustado exclusivamente nesta instância de teste para permitir medir a carga de logins sem bloqueio por HTTP 429 do mesmo loopback
- **Payload dos uploads concorrentes:** \`${params.uploadPayloadBytes}\` bytes por arquivo (\`application/pdf\`) executando o fluxo completo em 3 etapas (\`POST /uploads/sessions\` -> \`PUT /uploads/sessions/:id/content\` -> \`POST /uploads/sessions/:id/finalize\`)

## 3. Resultados Medidos

| Cenário | Operação / Endpoints | Requisições | Concorrência | Duração total (ms) | Vazão (req/s ou fluxos/s) | Sucessos | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${tableRows}

## 4. Como Reproduzir

\`\`\`bash
pnpm test:performance
\`\`\`

Variáveis opcionais para ajustar volume/concorrência mantendo a mesma medição:
\`DOCUFLOW_PERF_DOCS\`, \`DOCUFLOW_PERF_LOGIN_REQS\`, \`DOCUFLOW_PERF_LIST_REQS\`, \`DOCUFLOW_PERF_SEARCH_REQS\`, \`DOCUFLOW_PERF_UPLOAD_FLOWS\`, \`DOCUFLOW_PERF_UPLOAD_BYTES\`.
`;
}

async function main(): Promise<void> {
  const localStorageRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-perf-storage-"));
  let container: StartedPostgreSqlContainer | null = null;
  const externalUrl = process.env.DATABASE_URL;
  let connectionString: string;

  if (externalUrl && externalUrl.trim().length > 0) {
    connectionString = externalUrl;
  } else {
    container = await new PostgreSqlContainer("postgres:16.8-alpine3.21").start();
    connectionString = container.getConnectionUri();
  }

  const pool = new Pool({ connectionString, max: 25 });
  pool.on("error", () => {});
  const db = drizzle(pool);
  let app: ReturnType<typeof buildApp> | null = null;

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const pgVersionResult = await pool.query<{ version: string }>("SELECT version()");
    const postgresVersion = pgVersionResult.rows[0]?.version ?? "PostgreSQL";

    // Seed known dataset
    const seedStartedAt = performance.now();
    const orgId = randomUUID();
    const adminId = randomUUID();
    const adminRoleId = randomUUID();
    const storageConnId = randomUUID();
    const email = `perf-admin-${orgId.slice(0, 6)}@docuflow.local`;
    const password = "DocuFlowPerf!2026";

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword(password);

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Performance Benchmark",
      slug: `org-perf-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values({
      id: adminRoleId,
      organizationId: orgId,
      key: "admin",
      name: "Administrador",
      isSystem: true,
    });

    const adminPerms = SYSTEM_ROLE_DEFINITIONS.admin.permissions;
    await db
      .insert(permissions)
      .values(
        adminPerms.map((perm) => ({
          id: randomUUID(),
          action: perm.action,
          resource: perm.resource,
        })),
      )
      .onConflictDoNothing();

    const allPerms = await db.select().from(permissions);
    const permByKey = new Map(allPerms.map((p) => [`${p.action}:${p.resource}`, p.id]));
    const adminPermIds = adminPerms
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);

    await db.insert(rolePermissions).values(
      adminPermIds.map((permissionId) => ({
        roleId: adminRoleId,
        permissionId,
      })),
    );

    await db.insert(users).values({
      id: adminId,
      organizationId: orgId,
      email,
      fullName: "Admin Benchmark",
      passwordHash,
      status: "ACTIVE",
    });

    await db.insert(userRoleScopes).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: adminId,
      roleId: adminRoleId,
      scopeType: "GLOBAL",
      effect: "ALLOW",
    });

    const categoryIds = Array.from({ length: 4 }, () => randomUUID());
    const categoryNames = [
      "Contratos Comerciais",
      "Laudos Técnicos",
      "Políticas Internas",
      "Notas Fiscais",
    ];
    await db.insert(categories).values(
      categoryIds.map((id, idx) => ({
        id,
        organizationId: orgId,
        name: categoryNames[idx] ?? `Categoria ${idx + 1}`,
        isActive: true,
      })),
    );

    const folderIds = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(folders).values(
      folderIds.map((id, idx) => ({
        id,
        organizationId: orgId,
        parentId: null,
        name: `Pasta Benchmark ${idx + 1}`,
        materializedPath: `/${id}`,
        status: "ACTIVE" as const,
      })),
    );

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Perf",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: localStorageRoot },
    });

    const statuses = ["APPROVED", "IN_REVIEW", "DRAFT", "ARCHIVED"] as const;
    const titlePrefixes = [
      "Contrato Fornecedor",
      "Laudo Engenharia",
      "Política Segurança",
      "Relatório Auditoria",
    ];
    const seedChecksum = createHash("sha256").update("seed-perf-placeholder").digest("hex");
    const chunkSize = 250;

    for (let start = 0; start < DATASET_DOCUMENT_COUNT; start += chunkSize) {
      const count = Math.min(chunkSize, DATASET_DOCUMENT_COUNT - start);
      const docRows: Array<typeof documents.$inferInsert> = [];
      const fileRows: Array<typeof fileObjects.$inferInsert> = [];
      const versionRows: Array<typeof documentVersions.$inferInsert> = [];

      for (let offset = 0; offset < count; offset += 1) {
        const idx = start + offset;
        const docId = randomUUID();
        const verId = randomUUID();
        const fileId = randomUUID();
        const catId = categoryIds[idx % categoryIds.length] ?? categoryIds[0] ?? randomUUID();
        const folderId = folderIds[idx % folderIds.length] ?? null;
        const prefix = titlePrefixes[idx % titlePrefixes.length] ?? "Documento";
        const status = statuses[idx % statuses.length] ?? "APPROVED";
        const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + idx * 60_000);

        fileRows.push({
          id: fileId,
          organizationId: orgId,
          storageConnectionId: storageConnId,
          objectKey: `org/${orgId}/documents/${docId}/versions/${verId}/${fileId}`,
          originalFileName: `doc-${idx + 1}.pdf`,
          detectedContentType: "application/pdf",
          sizeBytes: 4096 + (idx % 2048),
          checksumSha256: seedChecksum,
          status: "AVAILABLE",
          createdAt,
          updatedAt: createdAt,
        });

        docRows.push({
          id: docId,
          organizationId: orgId,
          title: `${prefix} #${String(idx + 1).padStart(4, "0")}`,
          categoryId: catId,
          folderId,
          status,
          ownerUserId: adminId,
          metadata: { setor: idx % 2 === 0 ? "Operações" : "Jurídico", lote: Math.floor(idx / 50) },
          version: 1,
          createdAt,
          updatedAt: createdAt,
        });

        versionRows.push({
          id: verId,
          documentId: docId,
          versionNumber: 1,
          fileObjectId: fileId,
          uploadedByUserId: adminId,
          createdAt,
        });
      }

      await db.insert(fileObjects).values(fileRows);
      await db.insert(documents).values(docRows);
      await db.insert(documentVersions).values(versionRows);
      await db.execute(
        sql`UPDATE documents d SET current_version_id = v.id FROM document_versions v WHERE v.document_id = d.id AND d.current_version_id IS NULL`,
      );
    }

    const seedDurationMs = performance.now() - seedStartedAt;

    // Build real Fastify HTTP server
    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const documentSearchRepository = createDocumentSearchRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const connectionRepository = createStorageConnectionRepository(db);
    const outboxRepository = createOutboxRepository(db);

    const sessionService = createSessionService({
      store: {
        async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
          const [row] = await db.insert(sessions).values(input).returning();
          if (!row) {
            throw new Error("Session insert failed");
          }
          return row;
        },
        async findByTokenHash(tokenHash: string) {
          const [row] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenHash))
            .limit(1);
          return row ?? null;
        },
        async revokeById(id: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, id));
        },
        async revokeAllForUser(uid: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, uid));
        },
      } satisfies SessionStorePort,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      audit: {
        async recordAuthEvent(event) {
          await auditRepository.append({
            organizationId: event.organizationId,
            actorUserId: event.actorUserId,
            action: event.action,
            resourceType: "SESSION",
            resourceId: event.actorUserId,
            result: event.result,
            requestId: event.requestId,
            metadata: {},
          });
        },
      },
      users: {
        async findCredentialByEmail(targetEmail) {
          const [row] = await db.select().from(users).where(eq(users.email, targetEmail)).limit(1);
          if (!row) {
            return null;
          }
          return {
            user: {
              id: row.id,
              organizationId: row.organizationId,
              email: row.email,
              fullName: row.fullName,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
            passwordHash: row.passwordHash,
          };
        },
        async findProfileById(uid) {
          const [row] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
          if (!row) {
            return null;
          }
          return {
            user: {
              id: row.id,
              organizationId: row.organizationId,
              email: row.email,
              fullName: row.fullName,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
            groups: [],
            roles: [],
            permissions: [],
          };
        },
      },
    });

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", ({ connection }) =>
      createLocalStorageProvider({
        rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
        fsync: false,
      }),
    );

    const storageRouter = createStorageRouterService({
      connections: connectionRepository,
      routingRules: createStorageRoutingRuleRepository(db),
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const maxUploadBytes = 10 * 1024 * 1024;
    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepository,
      documents: documentRepository,
      storageRouter,
      transactions,
      audit: auditRepository,
      maxUploadBytes,
      generateId: () => randomUUID(),
    });

    const finalizeUploadService = createFinalizeUploadService({
      uploads: uploadRepository,
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      objectVerifier: {
        async verifyUploadedObject({ storageConnectionId, objectKey }) {
          const conn = await connectionRepository.findById(storageConnectionId);
          if (!conn) {
            return null;
          }
          const provider = await storageRegistry.resolveProvider(conn);
          const head = await provider.headObject({ value: objectKey });
          if (!head) {
            return null;
          }
          return {
            objectKey: head.key.value,
            contentLength: head.contentLength,
            contentType: head.contentType,
            checksumSha256: head.checksumSha256,
          };
        },
      },
      transactions,
      audit: auditRepository,
      processingQueue: outboxRepository.asUploadProcessingQueue(),
      generateId: () => randomUUID(),
    });

    app = buildApp({
      logger: false,
      secureCookies: false,
      security: {
        enforceCsrf: true,
        allowedOrigins: ["http://127.0.0.1"],
        loginRateLimit: { maxAttempts: 10_000, windowMs: 60_000 },
      },
      authService,
      uploadDeps: {
        authzRepository,
        documentRepository,
        uploadRepository,
        uploadSessionService,
        finalizeUploadService,
        localUploadDeps: {
          connections: connectionRepository,
          storageRegistry,
          transactions,
          auditRepository,
          maxUploadBytes,
        },
      },
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        documentSearchRepository,
      },
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Obtain authenticated session & CSRF token for read/upload benchmarks
    const sessionAuth = await fetchCsrfAndSession(baseUrl, email, password);

    // Warm up connection pool
    await fetch(`${baseUrl}/api/v1/documents?page=1&pageSize=10`, {
      headers: { cookie: sessionAuth.cookieHeader },
    });

    // Workload 1: Login (POST /api/v1/auth/login)
    const csrfSetupRes = await fetch(`${baseUrl}/api/v1/auth/csrf-token`);
    const csrfSetupJson = (await csrfSetupRes.json()) as { data?: { csrfToken?: string } };
    const loginCsrfToken = csrfSetupJson.data?.csrfToken ?? sessionAuth.csrfToken;

    const loginResult = await runConcurrentWorkload(
      LOGIN_REQUESTS,
      LOGIN_CONCURRENCY,
      async (): Promise<ScenarioSample> => {
        const start = performance.now();
        const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `docuflow_csrf=${loginCsrfToken}`,
            "x-csrf-token": loginCsrfToken,
          },
          body: JSON.stringify({ email, password }),
        });
        await res.arrayBuffer();
        return {
          durationMs: performance.now() - start,
          statusCode: res.status,
          ok: res.status === 200,
        };
      },
    );

    const loginSummary = summarizeScenario(
      "Login autenticado",
      "POST /api/v1/auth/login",
      LOGIN_CONCURRENCY,
      loginResult.wallDurationMs,
      loginResult.samples,
    );

    // Workload 2: Paginated listing (GET /api/v1/documents)
    const listResult = await runConcurrentWorkload(
      LIST_REQUESTS,
      LIST_CONCURRENCY,
      async (idx): Promise<ScenarioSample> => {
        const page = (idx % 10) + 1;
        const start = performance.now();
        const res = await fetch(
          `${baseUrl}/api/v1/documents?page=${page}&pageSize=25&sortBy=updatedAt&sortDirection=desc`,
          {
            headers: { cookie: sessionAuth.cookieHeader },
          },
        );
        const body = (await res.json()) as {
          items?: unknown[];
          pagination?: { totalItems?: number };
        };
        const validPayload =
          res.status === 200 &&
          Array.isArray(body.items) &&
          body.items.length === 25 &&
          body.pagination?.totalItems === DATASET_DOCUMENT_COUNT;
        return {
          durationMs: performance.now() - start,
          statusCode: res.status,
          ok: validPayload,
        };
      },
    );

    const listSummary = summarizeScenario(
      "Listagem paginada",
      "GET /api/v1/documents?page=..&pageSize=25",
      LIST_CONCURRENCY,
      listResult.wallDurationMs,
      listResult.samples,
    );

    // Workload 3: Filtered search in PostgreSQL (GET /api/v1/documents/search)
    const searchTerms = ["Contrato", "Laudo", "Política", "Relatório"];
    const searchResult = await runConcurrentWorkload(
      SEARCH_REQUESTS,
      SEARCH_CONCURRENCY,
      async (idx): Promise<ScenarioSample> => {
        const term = searchTerms[idx % searchTerms.length] ?? "Contrato";
        const catId = categoryIds[idx % categoryIds.length] ?? categoryIds[0] ?? "";
        const start = performance.now();
        const res = await fetch(
          `${baseUrl}/api/v1/documents/search?search=${encodeURIComponent(term)}&categoryId=${encodeURIComponent(catId)}&page=1&pageSize=20`,
          {
            headers: { cookie: sessionAuth.cookieHeader },
          },
        );
        const body = (await res.json()) as { items?: unknown[] };
        return {
          durationMs: performance.now() - start,
          statusCode: res.status,
          ok: res.status === 200 && Array.isArray(body.items) && body.items.length > 0,
        };
      },
    );

    const searchSummary = summarizeScenario(
      "Busca filtrada no servidor",
      "GET /api/v1/documents/search?search=..&categoryId=..",
      SEARCH_CONCURRENCY,
      searchResult.wallDurationMs,
      searchResult.samples,
    );

    // Workload 4: Concurrent 3-step streaming uploads
    const uploadFixture = buildSeededUploadBuffer(UPLOAD_PAYLOAD_BYTES);
    const defaultCatId = categoryIds[0] ?? randomUUID();
    const defaultFolderId = folderIds[0] ?? randomUUID();

    const uploadResult = await runConcurrentWorkload(
      UPLOAD_FLOWS,
      UPLOAD_CONCURRENCY,
      async (idx): Promise<ScenarioSample> => {
        const start = performance.now();
        const createRes = await fetch(`${baseUrl}/api/v1/uploads/sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: sessionAuth.cookieHeader,
            "x-csrf-token": sessionAuth.csrfToken,
          },
          body: JSON.stringify({
            categoryId: defaultCatId,
            folderId: defaultFolderId,
            originalFileName: `carga-${idx + 1}.pdf`,
            declaredSizeBytes: uploadFixture.buffer.byteLength,
            declaredContentType: "application/pdf",
            declaredChecksumSha256: uploadFixture.sha256,
            idempotencyKey: `perf-upload-${orgId}-${idx}-${randomUUID()}`,
          }),
        });
        if (createRes.status !== 201) {
          await createRes.arrayBuffer();
          return {
            durationMs: performance.now() - start,
            statusCode: createRes.status,
            ok: false,
            errorDetail: `session:${createRes.status}`,
          };
        }

        const createJson = (await createRes.json()) as { data?: { id?: string } };
        const sessionId = createJson.data?.id;
        if (!sessionId) {
          return {
            durationMs: performance.now() - start,
            statusCode: 500,
            ok: false,
            errorDetail: "missing session id",
          };
        }

        const contentRes = await fetch(`${baseUrl}/api/v1/uploads/sessions/${sessionId}/content`, {
          method: "PUT",
          headers: {
            "content-type": "application/pdf",
            "content-length": String(uploadFixture.buffer.byteLength),
            cookie: sessionAuth.cookieHeader,
            "x-csrf-token": sessionAuth.csrfToken,
          },
          body: new Uint8Array(uploadFixture.buffer),
        });
        await contentRes.arrayBuffer();
        if (contentRes.status !== 200) {
          return {
            durationMs: performance.now() - start,
            statusCode: contentRes.status,
            ok: false,
            errorDetail: `content:${contentRes.status}`,
          };
        }

        const finalizeRes = await fetch(
          `${baseUrl}/api/v1/uploads/sessions/${sessionId}/finalize`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: sessionAuth.cookieHeader,
              "x-csrf-token": sessionAuth.csrfToken,
            },
            body: JSON.stringify({ expectedChecksumSha256: uploadFixture.sha256 }),
          },
        );
        await finalizeRes.arrayBuffer();

        return {
          durationMs: performance.now() - start,
          statusCode: finalizeRes.status,
          ok: finalizeRes.status === 200,
        };
      },
    );

    const uploadSummary = summarizeScenario(
      "Uploads concorrentes",
      "POST /sessions -> PUT /content -> POST /finalize",
      UPLOAD_CONCURRENCY,
      uploadResult.wallDurationMs,
      uploadResult.samples,
    );

    const summaries = [loginSummary, listSummary, searchSummary, uploadSummary];
    const reportPath = process.env.DOCUFLOW_PERF_REPORT_PATH ?? DEFAULT_REPORT_PATH;
    const reportMarkdown = formatReportMarkdown({
      executedAtIso: new Date().toISOString(),
      postgresVersion,
      datasetDocuments: DATASET_DOCUMENT_COUNT,
      datasetCategories: categoryIds.length,
      datasetFolders: folderIds.length,
      uploadPayloadBytes: uploadFixture.buffer.byteLength,
      seedDurationMs,
      summaries,
    });

    await writeFile(reportPath, reportMarkdown, "utf8");
    console.log(JSON.stringify({ reportPath, seedDurationMs, summaries }, null, 2));

    const totalFailures = summaries.reduce((sum, item) => sum + item.failureCount, 0);
    if (totalFailures > 0) {
      throw new Error(`Teste de carga apresentou ${totalFailures} requisições com falha.`);
    }
  } finally {
    if (app) {
      await app.close();
    }
    await pool.end();
    if (container) {
      await container.stop();
    }
    await rm(localStorageRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
