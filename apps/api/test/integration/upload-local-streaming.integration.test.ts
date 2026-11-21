import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import { CONTRACTS_API_PREFIX, uploadContentResponseSchema } from "@docuflow/contracts";
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
  organizations,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createStorageRouterService, createUploadSessionService } from "@docuflow/domain";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
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

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildMultipartPayload(boundary: string, filename: string, fileContent: Buffer): Buffer {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([header, fileContent, footer]);
}

describe("API local storage streaming upload integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  const tempDirs: string[] = [];

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
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("streams multipart and raw binary uploads to temporary local storage with limits and progress state", async () => {
    const db = drizzle(pool);
    const localStorageRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-api-local-upload-"));
    tempDirs.push(localStorageRoot);

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
    const otherUserId = randomUUID();
    const roleColabId = randomUUID();
    const categoryId = randomUUID();
    const localConnId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Local Streaming",
      slug: "org-local-streaming",
    });

    const password = "StreamUploadPass2026!";
    const passwordHash = await passwordService.hashPassword(password);
    await db.insert(users).values([
      {
        id: uploaderId,
        organizationId: orgId,
        email: "uploader@stream.invalid",
        fullName: "Uploader Local",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: otherUserId,
        organizationId: orgId,
        email: "other@stream.invalid",
        fullName: "Outro Usuário",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values({
      id: roleColabId,
      organizationId: orgId,
      key: "collaborator",
      name: "Colaborador",
      isSystem: true,
    });

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos PDF",
    });

    await db.insert(userRoleScopes).values({
      organizationId: orgId,
      userId: uploaderId,
      roleId: roleColabId,
      scopeType: "GLOBAL",
      scopeTargetId: null,
      effect: "ALLOW",
    });

    await db.insert(storageConnections).values({
      id: localConnId,
      organizationId: orgId,
      name: "Local Upload Store",
      kind: "local",
      isDefault: true,
      status: "ACTIVE",
      nonSecretConfig: { rootDirectory: localStorageRoot },
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
    const connectionRepository = createStorageConnectionRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const storageRouter = createStorageRouterService({
      connections: connectionRepository,
      routingRules: createStorageRoutingRuleRepository(db),
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", ({ connection }) =>
      createLocalStorageProvider({
        rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
        fsync: false,
      }),
    );

    const maxUploadBytes = 512 * 1024;
    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepository,
      documents: documentRepository,
      storageRouter,
      transactions,
      audit: auditRepository,
      maxUploadBytes,
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
        localUploadDeps: {
          connections: connectionRepository,
          storageRegistry,
          transactions,
          auditRepository,
          maxUploadBytes,
        },
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

    const uploaderCookie = await login("uploader@stream.invalid");
    const otherCookie = await login("other@stream.invalid");

    // 1. Create session for multipart upload (320 KiB)
    const pdfPayload = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(320 * 1024, 0x41)]);
    const pdfChecksum = sha256Hex(pdfPayload);

    const session1Res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId,
        originalFileName: "contrato-stream.pdf",
        declaredSizeBytes: pdfPayload.length,
        declaredContentType: "application/pdf",
        declaredChecksumSha256: pdfChecksum,
        idempotencyKey: "stream-multipart-1",
      },
    });
    expect(session1Res.statusCode).toBe(201);
    const session1 = session1Res.json().data as {
      id: string;
      fileObjectId: string;
      objectKey: string;
    };

    // 2. Another user cannot upload binary to uploader's session (IDOR -> 403)
    const boundary = "----DocuFlowBoundary777";
    const multipartBody = buildMultipartPayload(boundary, "contrato-stream.pdf", pdfPayload);

    const idorUploadRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${session1.id}/content`,
      cookies: { docuflow_session: otherCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: {
        [CSRF_HEADER_NAME]: csrfToken,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });
    expect(idorUploadRes.statusCode).toBe(403);

    // 3. Sending payload exceeding declaredSizeBytes returns 413 UPLOAD_TOO_LARGE
    const oversizedMultipart = buildMultipartPayload(
      boundary,
      "excesso.pdf",
      Buffer.alloc(pdfPayload.length + 1024, 0x42),
    );
    const oversizedRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${session1.id}/content`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: {
        [CSRF_HEADER_NAME]: csrfToken,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: oversizedMultipart,
    });
    expect(oversizedRes.statusCode).toBe(413);

    // 4. Valid multipart upload streams to local storage, keeps file_object UPLOADING (no available version), returns progress 100%
    const uploadRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${session1.id}/content`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: {
        [CSRF_HEADER_NAME]: csrfToken,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });
    expect(uploadRes.statusCode).toBe(200);
    const uploadData = uploadRes.json().data;
    expect(uploadContentResponseSchema.safeParse(uploadData).success).toBe(true);
    expect(uploadData).toEqual({
      sessionId: session1.id,
      fileObjectId: session1.fileObjectId,
      storageConnectionId: localConnId,
      status: "UPLOADED",
      fileObjectStatus: "UPLOADING",
      bytesReceived: pdfPayload.length,
      expectedBytes: pdfPayload.length,
      progressPercent: 100,
      checksumSha256: pdfChecksum,
    });

    // Verify exact bytes on local storage under opaque objectKey and still 0 document_versions
    const diskBytes = await readFile(path.join(localStorageRoot, session1.objectKey));
    expect(diskBytes).toEqual(pdfPayload);
    const [versionCount] = await db.select({ total: count() }).from(documentVersions);
    expect(Number(versionCount?.total ?? 0)).toBe(0);

    // Repeating upload on already UPLOADED session is rejected with 409 Conflict
    const repeatRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${session1.id}/content`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: {
        [CSRF_HEADER_NAME]: csrfToken,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });
    expect(repeatRes.statusCode).toBe(409);

    // 5. Raw binary PUT stream upload also succeeds and persists temporary object
    const rawPayload = Buffer.from("Binário enviado via PUT application/octet-stream");
    const session2Res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        categoryId,
        originalFileName: "raw-doc.bin",
        declaredSizeBytes: rawPayload.length,
        declaredContentType: "application/octet-stream",
        idempotencyKey: "stream-raw-2",
      },
    });
    expect(session2Res.statusCode).toBe(201);
    const session2 = session2Res.json().data as {
      id: string;
      fileObjectId: string;
      objectKey: string;
    };

    const putRawRes = await app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${session2.id}/content`,
      cookies: { docuflow_session: uploaderCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: {
        [CSRF_HEADER_NAME]: csrfToken,
        "content-type": "application/octet-stream",
      },
      payload: rawPayload,
    });
    expect(putRawRes.statusCode).toBe(200);
    expect(putRawRes.json().data.checksumSha256).toBe(sha256Hex(rawPayload));
    expect(await readFile(path.join(localStorageRoot, session2.objectKey))).toEqual(rawPayload);

    const [fileObj2] = await db
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.id, session2.fileObjectId))
      .limit(1);
    expect(fileObj2?.status).toBe("UPLOADING");
    expect(fileObj2?.checksumSha256).toBe(sha256Hex(rawPayload));

    await app.close();
  });
});
