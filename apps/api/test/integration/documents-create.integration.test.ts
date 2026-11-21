import { randomUUID } from "node:crypto";
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
  auditEvents,
  categories,
  categoryFields,
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createFolderRepository,
  createTransactionManager,
  createUploadSessionRepository,
  createUserRepository,
  documentMetadata,
  documentVersions,
  fileObjects,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  uploadSessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createDocumentUseCase } from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/modules/auth/auth.routes.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Document creation with metadata, finalized upload link and initial status rules integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;

  beforeAll(async () => {
    const externalUrl = process.env.DATABASE_URL;
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    pool = new Pool({ connectionString });
    pool.on("error", () => {});
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("creates document linked to finalized upload, persists typed metadata & version 1, and blocks APPROVED on initial creation", async () => {
    const db = drizzle(pool);
    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
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

    const orgId = randomUUID();
    const actorUserId = randomUUID();
    const ownerUserId = randomUUID();
    const roleColabId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "DocuFlow Document Create Corp",
      slug: `doc-create-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values({
      id: roleColabId,
      organizationId: orgId,
      key: "collaborator",
      name: "Colaborador",
      isSystem: true,
    });

    const adminPerms = SYSTEM_ROLE_DEFINITIONS.admin.permissions;
    const insertedPerms = await db
      .insert(permissions)
      .values(
        adminPerms.map((p) => ({
          id: randomUUID(),
          action: p.action,
          resource: p.resource,
        })),
      )
      .onConflictDoNothing()
      .returning();

    const allPerms = insertedPerms.length > 0 ? insertedPerms : await db.select().from(permissions);
    const permByKey = new Map(allPerms.map((p) => [`${p.action}:${p.resource}`, p.id]));

    const colabPermIds = SYSTEM_ROLE_DEFINITIONS.collaborator.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      colabPermIds.map((permissionId) => ({
        roleId: roleColabId,
        permissionId,
      })),
    );

    const passwordHash = await passwordService.hashPassword("CreateDoc!2026");
    await db.insert(users).values([
      {
        id: actorUserId,
        organizationId: orgId,
        email: `actor-doc-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Actor Document",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: ownerUserId,
        organizationId: orgId,
        email: `owner-doc-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Owner Document",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: actorUserId,
      roleId: roleColabId,
      scopeType: "GLOBAL",
      effect: "ALLOW",
    });

    const categoryId = randomUUID();
    const fieldId = randomUUID();
    const folderId = randomUUID();
    const storageConnId = randomUUID();
    const fileObjectId = randomUUID();
    const uploadSessionId = randomUUID();

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(categoryFields).values({
      id: fieldId,
      categoryId,
      key: "fornecedor",
      label: "Fornecedor",
      type: "TEXT",
      required: true,
      sortOrder: 0,
    });

    await db.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      parentId: null,
      name: "Contratos Ativos",
      materializedPath: `/${folderId}`,
      status: "ACTIVE",
    });

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Temp",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/docuflow-test" },
    });

    await db.insert(fileObjects).values({
      id: fileObjectId,
      organizationId: orgId,
      storageConnectionId: storageConnId,
      objectKey: `org/${orgId}/tmp/${fileObjectId}`,
      originalFileName: "contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 4096,
      checksumSha256: "b".repeat(64),
      status: "QUARANTINED",
    });

    await db.insert(uploadSessions).values({
      id: uploadSessionId,
      organizationId: orgId,
      userId: actorUserId,
      storageConnectionId: storageConnId,
      fileObjectId,
      declaredSizeBytes: 4096,
      declaredContentType: "application/pdf",
      idempotencyKey: "upload-idem-doc-create",
      status: "FINALIZED",
      expiresAt: new Date(Date.now() + 3_600_000),
      finalizedAt: new Date(),
    });

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const categoryRepository = createCategoryRepository(db);
    const folderRepository = createFolderRepository(db);
    const userRepository = createUserRepository(db);
    const uploadSessionRepository = createUploadSessionRepository(db);
    const auditRepository = createAuditRepository(db);

    const createDocumentService = createDocumentUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      categories: categoryRepository,
      folders: folderRepository,
      users: userRepository,
      uploadSessions: uploadSessionRepository,
      transactions: createTransactionManager(db),
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const authService = createAuthService({
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
        async findProfileById(userId) {
          const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
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
      passwordService,
      sessionService,
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        createDocumentService,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `actor-doc-${orgId.slice(0, 6)}@docuflow.local`,
        password: "CreateDoc!2026",
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const cookies = { [SESSION_COOKIE_NAME]: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken };

    // 1. APPROVED status is blocked on initial submission
    const approvedAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        title: "Contrato Direto Aprovado",
        categoryId,
        folderId,
        ownerUserId,
        metadata: { fornecedor: "ACME" },
        uploadSessionId,
        initialStatus: "APPROVED",
      },
    });
    expect(approvedAttempt.statusCode).toBe(400);

    // 2. IN_REVIEW while file is still QUARANTINED is rejected (409)
    const quarantineReviewAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        title: "Contrato Em Quarentena",
        categoryId,
        folderId,
        ownerUserId,
        metadata: { fornecedor: "ACME" },
        uploadSessionId,
        initialStatus: "IN_REVIEW",
      },
    });
    expect(quarantineReviewAttempt.statusCode).toBe(409);

    // 3. Valid creation in DRAFT persists document, version 1 and typed metadata
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        title: "Contrato ACME Vigente",
        categoryId,
        folderId,
        ownerUserId,
        issueDate: "2026-01-15",
        expirationDate: "2026-12-31",
        metadata: { fornecedor: "  ACME Serviços  " },
        uploadSessionId,
        changeNote: "Envio inicial digitalizado",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdBody = createRes.json() as {
      data: {
        id: string;
        status: string;
        ownerUserId: string;
        currentVersionId: string;
        metadata: Record<string, unknown>;
      };
      initialVersion: { id: string; versionNumber: number; fileObjectId: string };
    };
    expect(createdBody.data.status).toBe("DRAFT");
    expect(createdBody.data.ownerUserId).toBe(ownerUserId);
    expect(createdBody.data.currentVersionId).toBe(createdBody.initialVersion.id);
    expect(createdBody.initialVersion.versionNumber).toBe(1);
    expect(createdBody.initialVersion.fileObjectId).toBe(fileObjectId);
    expect(createdBody.data.metadata).toEqual({ fornecedor: "ACME Serviços" });

    const [persistedMeta] = await db
      .select()
      .from(documentMetadata)
      .where(eq(documentMetadata.documentId, createdBody.data.id))
      .limit(1);
    expect(persistedMeta?.valueText).toBe("ACME Serviços");

    const [persistedVersion] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, createdBody.initialVersion.id))
      .limit(1);
    expect(persistedVersion?.fileObjectId).toBe(fileObjectId);

    // 4. Reusing same finalized upload session is rejected (409)
    const duplicateReuse = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        title: "Reuso indevido",
        categoryId,
        folderId,
        metadata: { fornecedor: "ACME" },
        uploadSessionId,
      },
    });
    expect(duplicateReuse.statusCode).toBe(409);

    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    expect(recordedAudit.map((row) => row.action)).toContain("DOCUMENT_CREATED");

    await app.close();
  }, 60_000);
});
