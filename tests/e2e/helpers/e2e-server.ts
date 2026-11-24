import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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
  createCategoryRepository,
  createDashboardRepository,
  createDocumentExpirationRepository,
  createDocumentRepository,
  createDocumentSearchRepository,
  createDocumentTrashRepository,
  createDocumentVersionRepository,
  createFolderRepository,
  createOutboxRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTaskInboxRepository,
  createTransactionManager,
  createUploadSessionRepository,
  createUserRepository,
  createWorkflowAssigneeVerifier,
  createWorkflowDecisionRepository,
  createWorkflowDefinitionRepository,
  createWorkflowInstanceRepository,
  createWorkflowTaskRepository,
  createWorkflowTimelineRepository,
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
  createCategoryFieldService,
  createCategoryService,
  createDecideTaskUseCase,
  createDocumentUseCase,
  createDocumentVersionUseCase,
  createFinalizeUploadService,
  createFolderService,
  createStartWorkflowUseCase,
  createStorageConnectionAdminService,
  createStorageRouterService,
  createUploadSessionService,
  createUserAdministrationService,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
} from "@docuflow/domain";
import type { AntivirusScannerPort } from "@docuflow/file-processing";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { buildApp } from "../../../apps/api/src/app.js";
import { createAuthService } from "../../../apps/api/src/modules/auth/auth.service.js";
import { createStorageHealthTester } from "../../../apps/api/src/modules/storage/storage-health.adapter.js";
import { createProcessUploadJobHandler } from "../../../apps/worker/src/jobs/process-upload.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, "../../..");
const MIGRATIONS_FOLDER = path.resolve(REPO_ROOT, "packages/database/drizzle");
const WEB_DIST_DIR = path.resolve(REPO_ROOT, "apps/web/dist");

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface E2eEnvironment {
  readonly baseUrl: string;
  readonly credentials: {
    readonly email: string;
    readonly password: string;
  };
  readonly reviewerCredentials: {
    readonly email: string;
    readonly password: string;
  };
  readonly workflowDefinitionName: string;
  readonly categoryName: string;
  readonly folderName: string;
  stop(): Promise<void>;
}

function createE2eCleanScanner(): AntivirusScannerPort {
  return {
    providerName: "docuflow-e2e-scanner",
    async checkHealth() {
      return {
        healthy: true,
        status: "AVAILABLE",
        message: "Scanner E2E operacional.",
        checkedAt: new Date(),
      };
    },
    async scanStream(input) {
      let bytesScanned = 0;
      for await (const chunk of input.stream) {
        bytesScanned += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return {
        status: "CLEAN",
        approved: true,
        disposition: "APPROVE",
        retryable: false,
        safeMessage: "Arquivo aprovado na verificação antivírus.",
        diagnosticCode: "CLEAN",
        detectedSignature: null,
        bytesScanned,
        durationMs: 1,
      };
    },
  };
}

function forwardApiRequest(req: IncomingMessage, res: ServerResponse, apiPort: number): void {
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: apiPort,
      path: req.url ?? "/",
      method: req.method ?? "GET",
      headers: {
        ...req.headers,
        host: `127.0.0.1:${apiPort}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: `Falha no proxy E2E: ${err.message}`,
        },
      }),
    );
  });

  req.pipe(proxyReq);
}

async function serveWebAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  const pathname = rawUrl.split("?")[0] ?? "/";
  const normalizedRelative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(WEB_DIST_DIR, normalizedRelative);

  let targetFile = path.join(WEB_DIST_DIR, "index.html");
  if (candidate.startsWith(`${WEB_DIST_DIR}${path.sep}`)) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) {
        targetFile = candidate;
      }
    } catch {
      // Fallback SPA para index.html em rotas do cliente (/login, /documents, etc.)
    }
  }

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
  const content = await readFile(targetFile);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": content.byteLength,
  });
  res.end(content);
}

export async function startE2eEnvironment(): Promise<E2eEnvironment> {
  const indexStat = await stat(path.join(WEB_DIST_DIR, "index.html")).catch(() => null);
  if (!indexStat?.isFile()) {
    throw new Error(
      `Bundle web não encontrado em ${WEB_DIST_DIR}. Execute "pnpm --filter @docuflow/web build" antes dos testes E2E.`,
    );
  }

  const localStorageRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-e2e-storage-"));
  let container: StartedPostgreSqlContainer | null = null;

  const externalUrl = process.env.DATABASE_URL;
  let connectionString: string;
  if (externalUrl && externalUrl.trim().length > 0) {
    connectionString = externalUrl;
  } else {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    connectionString = container.getConnectionUri();
  }

  const pool = new Pool({ connectionString });
  pool.on("error", () => {});
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const orgId = randomUUID();
  const adminId = randomUUID();
  const reviewerId = randomUUID();
  const adminRoleId = randomUUID();
  const reviewerRoleId = randomUUID();
  const categoryId = randomUUID();
  const folderId = randomUUID();
  const storageConnId = randomUUID();

  const categoryName = "Contratos E2E";
  const folderName = "Jurídico E2E";
  const workflowDefinitionName = "Aprovação de Contratos E2E";
  const adminEmail = `admin-e2e-${orgId.slice(0, 6)}@docuflow.local`;
  const adminPassword = "DocuFlowE2E!2026";
  const reviewerEmail = `revisor-e2e-${orgId.slice(0, 6)}@docuflow.local`;
  const reviewerPassword = "RevisorE2E!2026";

  const passwordService = createPasswordService({
    memoryCost: 8_192,
    timeCost: 2,
    parallelism: 1,
    minPasswordLength: 10,
  });
  const passwordHash = await passwordService.hashPassword(adminPassword);
  const reviewerPasswordHash = await passwordService.hashPassword(reviewerPassword);

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
      async revokeAllForUser(userId: string, revokedAt: Date) {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
      },
    } satisfies SessionStorePort,
  });

  await db.insert(organizations).values({
    id: orgId,
    name: "DocuFlow E2E Ltda",
    slug: `org-e2e-${orgId.slice(0, 8)}`,
  });

  await db.insert(roles).values([
    {
      id: adminRoleId,
      organizationId: orgId,
      key: "admin",
      name: "Administrador",
      isSystem: true,
    },
    {
      id: reviewerRoleId,
      organizationId: orgId,
      key: "reviewer",
      name: "Revisor",
      isSystem: true,
    },
  ]);

  const allRolePermissions = [
    ...SYSTEM_ROLE_DEFINITIONS.admin.permissions,
    ...SYSTEM_ROLE_DEFINITIONS.reviewer.permissions,
  ];
  const insertedPerms = await db
    .insert(permissions)
    .values(
      allRolePermissions.map((perm) => ({
        id: randomUUID(),
        action: perm.action,
        resource: perm.resource,
      })),
    )
    .onConflictDoNothing()
    .returning();
  const allPerms = insertedPerms.length > 0 ? insertedPerms : await db.select().from(permissions);
  const permByKey = new Map(allPerms.map((p) => [`${p.action}:${p.resource}`, p.id]));
  const adminPermIds = SYSTEM_ROLE_DEFINITIONS.admin.permissions
    .map((p) => permByKey.get(`${p.action}:${p.resource}`))
    .filter((id): id is string => id !== undefined);
  const reviewerPermIds = SYSTEM_ROLE_DEFINITIONS.reviewer.permissions
    .map((p) => permByKey.get(`${p.action}:${p.resource}`))
    .filter((id): id is string => id !== undefined);
  await db.insert(rolePermissions).values([
    ...adminPermIds.map((permissionId) => ({
      roleId: adminRoleId,
      permissionId,
    })),
    ...reviewerPermIds.map((permissionId) => ({
      roleId: reviewerRoleId,
      permissionId,
    })),
  ]);

  await db.insert(users).values([
    {
      id: adminId,
      organizationId: orgId,
      email: adminEmail,
      fullName: "Administrador E2E",
      passwordHash,
      status: "ACTIVE",
    },
    {
      id: reviewerId,
      organizationId: orgId,
      email: reviewerEmail,
      fullName: "Revisor Jurídico E2E",
      passwordHash: reviewerPasswordHash,
      status: "ACTIVE",
    },
  ]);

  await db.insert(userRoleScopes).values([
    {
      id: randomUUID(),
      organizationId: orgId,
      userId: adminId,
      roleId: adminRoleId,
      scopeType: "GLOBAL",
      effect: "ALLOW",
    },
    {
      id: randomUUID(),
      organizationId: orgId,
      userId: reviewerId,
      roleId: reviewerRoleId,
      scopeType: "GLOBAL",
      effect: "ALLOW",
    },
  ]);

  await db.insert(categories).values({
    id: categoryId,
    organizationId: orgId,
    name: categoryName,
    isActive: true,
  });

  await db.insert(folders).values({
    id: folderId,
    organizationId: orgId,
    parentId: null,
    name: folderName,
    materializedPath: `/${folderId}`,
    status: "ACTIVE",
  });

  await db.insert(storageConnections).values({
    id: storageConnId,
    organizationId: orgId,
    name: "Local E2E",
    kind: "local",
    status: "ACTIVE",
    isDefault: true,
    nonSecretConfig: { rootDirectory: localStorageRoot },
  });

  const transactions = createTransactionManager(db);
  const auditRepository = createAuditRepository(db);
  const authzRepository = createAuthorizationRepository(db);
  const documentRepository = createDocumentRepository(db);
  const documentVersionRepository = createDocumentVersionRepository(db);
  const documentSearchRepository = createDocumentSearchRepository(db);
  const documentExpirationRepository = createDocumentExpirationRepository(db);
  const documentTrashRepository = createDocumentTrashRepository(db);
  const dashboardRepository = createDashboardRepository(db);
  const categoryRepository = createCategoryRepository(db);
  const folderRepository = createFolderRepository(db);
  const userRepository = createUserRepository(db);
  const uploadRepository = createUploadSessionRepository(db);
  const connectionRepository = createStorageConnectionRepository(db);
  const outboxRepository = createOutboxRepository(db);
  const workflowDefinitionRepository = createWorkflowDefinitionRepository(db);
  const workflowInstanceRepository = createWorkflowInstanceRepository(db);
  const workflowTaskRepository = createWorkflowTaskRepository(db);
  const workflowDecisionRepository = createWorkflowDecisionRepository(db);
  const workflowTimelineRepository = createWorkflowTimelineRepository(db);
  const workflowAssigneeVerifier = createWorkflowAssigneeVerifier(db);
  const taskInboxRepository = createTaskInboxRepository(db);

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

  const createDocumentService = createDocumentUseCase({
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    categories: categoryRepository,
    folders: folderRepository,
    users: userRepository,
    uploadSessions: uploadRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const createDocumentVersionService = createDocumentVersionUseCase({
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    uploadSessions: uploadRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const categoryService = createCategoryService({
    categories: categoryRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const categoryFieldService = createCategoryFieldService({
    categories: categoryRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const folderService = createFolderService({
    folders: folderRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const workflowDefinitionService = createWorkflowDefinitionService({
    definitions: workflowDefinitionRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  await workflowDefinitionService.createDefinition({
    organizationId: orgId,
    actorUserId: adminId,
    requestId: randomUUID(),
    name: workflowDefinitionName,
    description: "Fluxo sequencial de revisão jurídica e aprovação final.",
    steps: [
      {
        stepOrder: 1,
        name: "Revisão Jurídica",
        assignee: { type: "USER", userId: reviewerId },
        dueDays: 3,
      },
      {
        stepOrder: 2,
        name: "Aprovação Final",
        assignee: { type: "USER", userId: adminId },
        dueDays: 3,
      },
    ],
  });

  const startWorkflowService = createStartWorkflowUseCase({
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    uploadSessions: uploadRepository,
    definitions: workflowDefinitionRepository,
    workflowInstances: workflowInstanceRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const createWorkflowTasksService = createWorkflowTasksUseCase({
    workflowInstances: workflowInstanceRepository,
    definitions: workflowDefinitionRepository,
    documents: documentRepository,
    tasks: workflowTaskRepository,
    transactions,
    audit: auditRepository,
    assigneeAuthorization: workflowAssigneeVerifier,
    generateId: () => randomUUID(),
  });

  const decideTaskService = createDecideTaskUseCase({
    tasks: workflowTaskRepository,
    decisions: workflowDecisionRepository,
    workflowInstances: workflowInstanceRepository,
    definitions: workflowDefinitionRepository,
    documents: documentRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const authService = createAuthService({
    passwordService,
    sessionService,
    users: {
      async findCredentialByEmail(email) {
        const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
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
        const loaded = await authzRepository.loadSubject(row.organizationId, uid);
        const assignedRoleIds = Array.from(
          new Set(
            loaded.assignments
              .filter((assignment) => assignment.effect === "ALLOW")
              .map((assignment) => assignment.roleId),
          ),
        );
        const roleRows =
          assignedRoleIds.length > 0
            ? await db.select().from(roles).where(inArray(roles.id, assignedRoleIds))
            : [];
        const uniquePermissions = new Map<
          string,
          {
            readonly id: string;
            readonly action: (typeof allPerms)[number]["action"];
            readonly resource: (typeof allPerms)[number]["resource"];
          }
        >();
        for (const perm of loaded.rolePermissions) {
          const permId = permByKey.get(`${perm.action}:${perm.resource}`);
          if (permId) {
            uniquePermissions.set(`${perm.action}:${perm.resource}`, {
              id: permId,
              action: perm.action,
              resource: perm.resource,
            });
          }
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
          roles: roleRows.map((r) => ({
            id: r.id,
            key: r.key,
            name: r.name,
            description: r.description,
            isSystem: r.isSystem,
          })),
          permissions: Array.from(uniquePermissions.values()),
        };
      },
    },
  });

  // Registra o servidor proxy antes do app para conhecer a origem exata permitida no CORS/CSRF.
  let apiPort = 0;
  const proxyServer = http.createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    if (reqUrl.startsWith("/api/")) {
      forwardApiRequest(req, res, apiPort);
      return;
    }
    void serveWebAsset(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(err instanceof Error ? err.message : "Erro interno ao servir frontend");
    });
  });

  await new Promise<void>((resolve) => {
    proxyServer.listen(0, "127.0.0.1", () => resolve());
  });
  const proxyAddress = proxyServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${proxyAddress.port}`;

  const storageAdminService = createStorageConnectionAdminService({
    connections: connectionRepository,
    transactions,
    audit: auditRepository,
    healthTester: createStorageHealthTester(),
    generateId: () => randomUUID(),
  });

  const userAdminService = createUserAdministrationService({
    users: userRepository,
    transactions,
    audit: auditRepository,
    passwordHasher: {
      hashPassword: (plain) => passwordService.hashPassword(plain),
    },
    generateId: () => randomUUID(),
  });

  const app = buildApp({
    logger: false,
    secureCookies: false,
    security: {
      enforceCsrf: true,
      allowedOrigins: [baseUrl],
    },
    authService,
    userAdminService,
    storageAdminService,
    storageRouterService: storageRouter,
    auditDeps: {
      authzRepository,
      auditRepository,
    },
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
      documentExpirationRepository,
      dashboardRepository,
      categoryRepository,
      documentVersionRepository,
      uploadRepository,
      storageConnections: connectionRepository,
      storageRegistry,
      createDocumentService,
      createDocumentVersionService,
      documentTrashRepository,
    },
    categoryDeps: {
      authzRepository,
      categoryRepository,
      categoryService,
      categoryFieldService,
    },
    folderDeps: {
      authzRepository,
      folderRepository,
      folderService,
    },
    taskDeps: {
      authzRepository,
      documentRepository,
      taskInboxRepository,
      decideTaskService,
      createWorkflowTasksService,
    },
    workflowDeps: {
      authzRepository,
      documentRepository,
      workflowDefinitionRepository,
      workflowTimelineRepository,
      startWorkflowService,
      createWorkflowTasksService,
    },
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const apiAddress = app.server.address() as AddressInfo;
  apiPort = apiAddress.port;

  const uploadWorker = createProcessUploadJobHandler({
    outbox: outboxRepository,
    uploads: uploadRepository,
    connections: connectionRepository,
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    audit: auditRepository,
    transactions,
    storageRegistry,
    scanner: createE2eCleanScanner(),
    maxUploadBytes,
  });

  let workerRunning = true;
  const workerLoop = (async () => {
    while (workerRunning) {
      try {
        const result = await uploadWorker.processNextJob();
        if (result.outcome !== "NO_JOB") {
          continue;
        }
      } catch {
        // Mantém loop ativo caso ocorra erro transitório durante desligamento.
      }
      if (!workerRunning) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();

  return {
    baseUrl,
    credentials: {
      email: adminEmail,
      password: adminPassword,
    },
    reviewerCredentials: {
      email: reviewerEmail,
      password: reviewerPassword,
    },
    workflowDefinitionName,
    categoryName,
    folderName,
    async stop() {
      workerRunning = false;
      await workerLoop;
      await new Promise<void>((resolve, reject) => {
        proxyServer.close((err) => (err ? reject(err) : resolve()));
      });
      await app.close();
      await pool.end();
      if (container) {
        await container.stop();
      }
      await rm(localStorageRoot, { recursive: true, force: true });
    },
  };
}
