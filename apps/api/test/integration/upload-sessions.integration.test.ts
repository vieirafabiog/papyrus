import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import { CONTRACTS_API_PREFIX, uploadSessionRecordSchema } from "@docuflow/contracts";
import {
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTransactionManager,
  createUploadSessionRepository,
  documentVersions,
  fileObjects,
  folders,
  organizations,
  roles,
  sessions,
  storageConnections,
  storageRoutingRules,
  uploadSessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createStorageRouterService, createUploadSessionService } from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Upload session creation integration", () => {
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

  it("creates upload sessions with routed destination, opaque object key, expiration, and idempotency without creating versions", async () => {
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
          if (!row) throw new Error("Session insert failed");
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
    const uploaderId = randomUUID();
    const viewerId = randomUUID();
    const roleColabId = randomUUID();
    const roleViewerId = randomUUID();
    const catContractsId = randomUUID();
    const folderId = randomUUID();
    const defaultConnId = randomUUID();
    const categoryConnId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Uploads",
      slug: "org-uploads",
    });

    const password = "UploadSessionPass2026!";
    const passwordHash = await passwordService.hashPassword(password);
    await db.insert(users).values([
      {
        id: uploaderId,
        organizationId: orgId,
        email: "uploader@uploads.invalid",
        fullName: "Colaborador Upload",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerId,
        organizationId: orgId,
        email: "viewer@uploads.invalid",
        fullName: "Consulta Somente",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

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

    await db.insert(categories).values({
      id: catContractsId,
      organizationId: orgId,
      name: "Contratos",
    });

    await db.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      parentId: null,
      name: "Operação",
      materializedPath: `/${folderId}`,
    });

    await db.insert(userRoleScopes).values([
      {
        organizationId: orgId,
        userId: uploaderId,
        roleId: roleColabId,
        scopeType: "CATEGORY",
        scopeTargetId: catContractsId,
        effect: "ALLOW",
      },
      {
        organizationId: orgId,
        userId: viewerId,
        roleId: roleViewerId,
        scopeType: "GLOBAL",
        scopeTargetId: null,
        effect: "ALLOW",
      },
    ]);

    await db.insert(storageConnections).values([
      {
        id: defaultConnId,
        organizationId: orgId,
        name: "Local Padrão",
        kind: "local",
        isDefault: true,
        status: "ACTIVE",
        nonSecretConfig: { rootDirectory: "/data/default" },
      },
      {
        id: categoryConnId,
        organizationId: orgId,
        name: "S3 Contratos",
        kind: "s3",
        isDefault: false,
        status: "ACTIVE",
        nonSecretConfig: { bucket: "contratos" },
      },
    ]);

    await db.insert(storageRoutingRules).values({
      organizationId: orgId,
      categoryId: catContractsId,
      storageConnectionId: categoryConnId,
      createdBy: uploaderId,
      updatedBy: uploaderId,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(email) {
          const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
          if (!row) return null;
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
        async findProfileById(id) {
          const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
          if (!row) return null;
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

    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const documentRepository = createDocumentRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const storageRouter = createStorageRouterService({
      connections: createStorageConnectionRepository(db),
      routingRules: createStorageRoutingRuleRepository(db),
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepository,
      documents: documentRepository,
      storageRouter,
      transactions,
      audit: auditRepository,
      maxUploadBytes: 1024 * 1024,
      generateId: () => randomUUID(),
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      uploadDeps: {
        authzRepository: createAuthorizationRepository(db),
        documentRepository,
        uploadRepository,
        uploadSessionService,
      },
    });

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const login = async (email: string): Promise<string> => {
      const res = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password },
      });
      return res.cookies.find((c) => c.name === "docuflow_session")?.value ?? "";
    };

    const uploaderCookie = await login("uploader@uploads.invalid");
    const viewerCookie = await login("viewer@uploads.invalid");

    // 1. Viewer without UPLOAD permission is denied with 403
    const deniedViewerRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: viewerCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId: catContractsId,
        originalFileName: "contrato.pdf",
        declaredSizeBytes: 2048,
        declaredContentType: "application/pdf",
        idempotencyKey: "viewer-attempt-1",
      },
    });
    expect(deniedViewerRes.statusCode).toBe(403);

    // 2. Exceeding max upload size is rejected with 413
    const oversizedRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId: catContractsId,
        originalFileName: "enorme.pdf",
        declaredSizeBytes: 5 * 1024 * 1024,
        declaredContentType: "application/pdf",
        idempotencyKey: "oversized-1",
      },
    });
    expect(oversizedRes.statusCode).toBe(413);

    // 3. Valid session creation resolves category storage connection, creates PENDING session & UPLOADING file object, NO document_version
    const createRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId: catContractsId,
        originalFileName: "../../etc/Secret_Contract_João.pdf",
        declaredSizeBytes: 4096,
        declaredContentType: "application/pdf",
        idempotencyKey: "upload-idem-key-1",
        expiresInSeconds: 600,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdSession = createRes.json().data;
    expect(uploadSessionRecordSchema.safeParse(createdSession).success).toBe(true);
    expect(createdSession.status).toBe("PENDING");
    expect(createdSession.userId).toBe(uploaderId);
    expect(createdSession.storageConnectionId).toBe(categoryConnId);
    expect(createdSession.declaredSizeBytes).toBe(4096);
    expect(createdSession.finalizedAt).toBeNull();
    expect(new Date(createdSession.expiresAt).getTime()).toBeGreaterThan(
      new Date(createdSession.createdAt).getTime(),
    );
    // Opaque key contains NO original filename or PII
    expect(createdSession.objectKey).toMatch(
      new RegExp(
        `^org/${orgId}/documents/[0-9a-f-]+/versions/[0-9a-f-]+/${createdSession.fileObjectId}$`,
      ),
    );
    expect(createdSession.objectKey).not.toContain("Secret_Contract");
    expect(createdSession.objectKey).not.toContain("João");

    // 4. Verify no document version created yet and file_object stays UPLOADING
    const [versionCount] = await db.select({ total: count() }).from(documentVersions);
    expect(Number(versionCount?.total ?? 0)).toBe(0);
    const [fileRow] = await db
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.id, createdSession.fileObjectId))
      .limit(1);
    expect(fileRow?.status).toBe("UPLOADING");
    expect(fileRow?.storageConnectionId).toBe(categoryConnId);

    // 5. Idempotent replay with same idempotencyKey + same payload returns exact same session (200) without duplicate rows
    const replayRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId: catContractsId,
        originalFileName: "Secret_Contract_João.pdf",
        declaredSizeBytes: 4096,
        declaredContentType: "application/pdf",
        idempotencyKey: "upload-idem-key-1",
      },
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().data.id).toBe(createdSession.id);
    expect(replayRes.json().data.fileObjectId).toBe(createdSession.fileObjectId);

    const [sessionCount] = await db.select({ total: count() }).from(uploadSessions);
    expect(Number(sessionCount?.total ?? 0)).toBe(1);

    // 6. Reusing same idempotencyKey with different declared size yields 409 Conflict
    const conflictRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId: catContractsId,
        originalFileName: "outro.pdf",
        declaredSizeBytes: 8192,
        declaredContentType: "application/pdf",
        idempotencyKey: "upload-idem-key-1",
      },
    });
    expect(conflictRes.statusCode).toBe(409);

    // 7. Another user cannot access uploader's session (IDOR -> 403)
    const idorGetRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${createdSession.id}`,
      cookies: { docuflow_session: viewerCookie },
    });
    expect(idorGetRes.statusCode).toBe(403);

    const ownerGetRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${createdSession.id}`,
      cookies: { docuflow_session: uploaderCookie },
    });
    expect(ownerGetRes.statusCode).toBe(200);
    expect(ownerGetRes.json().data.id).toBe(createdSession.id);

    await app.close();
  });
});
