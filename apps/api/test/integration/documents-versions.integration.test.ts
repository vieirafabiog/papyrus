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
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createTransactionManager,
  createUploadSessionRepository,
  documentVersions,
  documents,
  fileObjects,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createDocumentVersionUseCase } from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
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

describe("Append-only document version creation and concurrency control integration", () => {
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

  it("creates sequential append-only versions linked to AVAILABLE FileObjects and prevents duplicate version numbers under concurrent requests", async () => {
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
    const viewerUserId = randomUUID();
    const roleColabId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "DocuFlow Versions Corp",
      slug: `doc-ver-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values([
      {
        id: roleColabId,
        organizationId: orgId,
        key: "collaborator",
        name: "Colaborador",
        isSystem: true,
      },
      {
        id: roleViewerId,
        organizationId: orgId,
        key: "viewer",
        name: "Consulta",
        isSystem: true,
      },
    ]);

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

    const viewerPermIds = SYSTEM_ROLE_DEFINITIONS.viewer.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      viewerPermIds.map((permissionId) => ({
        roleId: roleViewerId,
        permissionId,
      })),
    );

    const passwordHash = await passwordService.hashPassword("Versions!2026");
    await db.insert(users).values([
      {
        id: actorUserId,
        organizationId: orgId,
        email: `colab-ver-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Collaborator Version",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerUserId,
        organizationId: orgId,
        email: `viewer-ver-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Viewer Version",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: actorUserId,
        roleId: roleColabId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerUserId,
        roleId: roleViewerId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
    ]);

    const categoryId = randomUUID();
    const storageConnId = randomUUID();
    const docId = randomUUID();
    const fileV1Id = randomUUID();
    const fileQuarantinedId = randomUUID();
    const fileV2Id = randomUUID();
    const fileRaceAId = randomUUID();
    const fileRaceBId = randomUUID();
    const ver1Id = randomUUID();

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Versions",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/docuflow-versions" },
    });

    await db.insert(fileObjects).values([
      {
        id: fileV1Id,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/v1/${fileV1Id}`,
        originalFileName: "v1.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: "1".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileQuarantinedId,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/vq/${fileQuarantinedId}`,
        originalFileName: "vq.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: "2".repeat(64),
        status: "QUARANTINED",
      },
      {
        id: fileV2Id,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/v2/${fileV2Id}`,
        originalFileName: "v2.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: "3".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileRaceAId,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/v3a/${fileRaceAId}`,
        originalFileName: "v3a.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: "4".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileRaceBId,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/v3b/${fileRaceBId}`,
        originalFileName: "v3b.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: "5".repeat(64),
        status: "AVAILABLE",
      },
    ]);

    await db.insert(documents).values({
      id: docId,
      organizationId: orgId,
      title: "Contrato Versionado",
      categoryId,
      folderId: null,
      status: "APPROVED",
      ownerUserId: actorUserId,
      metadata: {},
      version: 2,
    });

    await db.insert(documentVersions).values({
      id: ver1Id,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: fileV1Id,
      uploadedByUserId: actorUserId,
      changeNote: "Versão inicial",
    });

    await db.update(documents).set({ currentVersionId: ver1Id }).where(eq(documents.id, docId));

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const uploadSessionRepository = createUploadSessionRepository(db);
    const auditRepository = createAuditRepository(db);

    const createDocumentVersionService = createDocumentVersionUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
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
        createDocumentVersionService,
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
        email: `colab-ver-${orgId.slice(0, 6)}@docuflow.local`,
        password: "Versions!2026",
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const cookies = { [SESSION_COOKIE_NAME]: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken };

    // 1. Quarantined file rejected (409)
    const quarantinedRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/versions`,
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: 2,
        fileObjectId: fileQuarantinedId,
      },
    });
    expect(quarantinedRes.statusCode).toBe(409);

    // 2. Reused file object rejected (409)
    const reusedRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/versions`,
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: 2,
        fileObjectId: fileV1Id,
      },
    });
    expect(reusedRes.statusCode).toBe(409);

    // 3. Valid sequential creation produces version 2 and increments document lock version to 3
    const createV2Res = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/versions`,
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: 2,
        fileObjectId: fileV2Id,
        changeNote: "Segunda versão assinada",
      },
    });
    expect(createV2Res.statusCode).toBe(201);
    const v2Body = createV2Res.json() as {
      data: { id: string; versionNumber: number };
      document: { currentVersionId: string; version: number };
    };
    expect(v2Body.data.versionNumber).toBe(2);
    expect(v2Body.document.currentVersionId).toBe(v2Body.data.id);
    expect(v2Body.document.version).toBe(3);

    // 4. Concurrent race with identical expectedVersion (3): exactly 1 wins (201) and 1 fails (409)
    const [raceResA, raceResB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/documents/${docId}/versions`,
        cookies,
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: {
          expectedVersion: 3,
          fileObjectId: fileRaceAId,
          changeNote: "Concorrente A",
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/documents/${docId}/versions`,
        cookies,
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: {
          expectedVersion: 3,
          fileObjectId: fileRaceBId,
          changeNote: "Concorrente B",
        },
      }),
    ]);

    const statuses = [raceResA.statusCode, raceResB.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const versionsInDb = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, docId))
      .orderBy(asc(documentVersions.versionNumber));
    expect(versionsInDb.map((v) => v.versionNumber)).toEqual([1, 2, 3]);

    // 5. Viewer forbidden (403)
    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-ver-${orgId.slice(0, 6)}@docuflow.local`,
        password: "Versions!2026",
      },
    });
    expect(viewerLogin.statusCode).toBe(200);
    const viewerCookie =
      viewerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const viewerRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/versions`,
      cookies: { [SESSION_COOKIE_NAME]: viewerCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: 4,
        fileObjectId: fileRaceBId,
      },
    });
    expect(viewerRes.statusCode).toBe(403);

    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    expect(recordedAudit.map((row) => row.action)).toContain("DOCUMENT_VERSION_CREATED");

    await app.close();
  }, 60_000);
});
