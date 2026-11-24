import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createStorageConnectionRepository,
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
} from "@papyrus/database";
import { createStorageProviderRegistry } from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
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

describe("Authorized PDF preview streaming, CSP, anti-cache and quarantine gate integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let tempStorageDir: string;

  beforeAll(async () => {
    tempStorageDir = await mkdtemp(path.join(os.tmpdir(), "papyrus-preview-test-"));
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
    if (tempStorageDir) {
      await rm(tempStorageDir, { recursive: true, force: true });
    }
  });

  it("streams authorized PDFs with restrictive CSP and no-store caching, while blocking unauthorized and quarantined files", async () => {
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
    const readerId = randomUUID();
    const deniedUserId = randomUUID();
    const viewerRoleId = randomUUID();
    const categoryId = randomUUID();
    const folderId = randomUUID();
    const storageId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org PDF Preview",
      slug: `org-prev-${orgId.slice(0, 8)}`,
    });

    const passwordHash = await passwordService.hashPassword("PreviewPdf!2026");
    await db.insert(users).values([
      {
        id: readerId,
        organizationId: orgId,
        email: `reader-prev-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Leitor Autorizado",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: deniedUserId,
        organizationId: orgId,
        email: `denied-prev-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Usuário Negado",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values({
      id: viewerRoleId,
      organizationId: orgId,
      key: "viewer",
      name: "Consulta",
      isSystem: true,
    });

    for (const pair of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
      const pid = randomUUID();
      await db
        .insert(permissions)
        .values({ id: pid, action: pair.action, resource: pair.resource });
      await db.insert(rolePermissions).values({ roleId: viewerRoleId, permissionId: pid });
    }

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      parentId: null,
      name: "Contratos",
      materializedPath: `/${folderId}`,
      status: "ACTIVE",
    });

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: readerId,
        roleId: viewerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedUserId,
        roleId: viewerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedUserId,
        roleId: viewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderId,
        effect: "DENY",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageId,
      organizationId: orgId,
      name: "Local Preview",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: tempStorageDir },
    });

    const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
    const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngHash = createHash("sha256").update(pngBytes).digest("hex");

    const docPdfId = randomUUID();
    const docQuarantinedId = randomUUID();
    const docImageId = randomUUID();

    const filePdfId = randomUUID();
    const fileQuarantinedId = randomUUID();
    const fileImageId = randomUUID();
    const verPdfId = randomUUID();
    const verQuarantinedId = randomUUID();
    const verImageId = randomUUID();

    const pdfObjectKey = `org/${orgId}/documents/${docPdfId}/versions/${verPdfId}/${filePdfId}`;
    const pngObjectKey = `org/${orgId}/documents/${docImageId}/versions/${verImageId}/${fileImageId}`;

    // Write actual PDF and PNG binaries to local storage provider
    const localProvider = createLocalStorageProvider({ rootDirectory: tempStorageDir });
    await localProvider.putObject({
      key: { value: pdfObjectKey },
      body: Readable.from(pdfBytes),
      metadata: {
        contentType: "application/pdf",
        contentLength: pdfBytes.length,
        checksumSha256: pdfHash,
      },
    });
    await localProvider.putObject({
      key: { value: pngObjectKey },
      body: Readable.from(pngBytes),
      metadata: {
        contentType: "image/png",
        contentLength: pngBytes.length,
        checksumSha256: pngHash,
      },
    });

    await db.insert(fileObjects).values([
      {
        id: filePdfId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: pdfObjectKey,
        originalFileName: "contrato_vigente.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: pdfBytes.length,
        checksumSha256: pdfHash,
        status: "AVAILABLE",
      },
      {
        id: fileQuarantinedId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/quarantined/${fileQuarantinedId}`,
        originalFileName: "suspeito.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 512,
        checksumSha256: "b".repeat(64),
        status: "QUARANTINED",
      },
      {
        id: fileImageId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: pngObjectKey,
        originalFileName: "foto.png",
        detectedContentType: "image/png",
        sizeBytes: pngBytes.length,
        checksumSha256: pngHash,
        status: "AVAILABLE",
      },
    ]);

    await db.insert(documents).values([
      {
        id: docPdfId,
        organizationId: orgId,
        title: "Contrato PDF",
        categoryId,
        folderId,
        status: "APPROVED",
        ownerUserId: readerId,
        createdBy: readerId,
        updatedBy: readerId,
      },
      {
        id: docQuarantinedId,
        organizationId: orgId,
        title: "Contrato Em Quarentena",
        categoryId,
        folderId,
        status: "DRAFT",
        ownerUserId: readerId,
        createdBy: readerId,
        updatedBy: readerId,
      },
      {
        id: docImageId,
        organizationId: orgId,
        title: "Comprovante Imagem",
        categoryId,
        folderId,
        status: "APPROVED",
        ownerUserId: readerId,
        createdBy: readerId,
        updatedBy: readerId,
      },
    ]);

    await db.insert(documentVersions).values([
      {
        id: verPdfId,
        documentId: docPdfId,
        versionNumber: 1,
        fileObjectId: filePdfId,
        uploadedByUserId: readerId,
      },
      {
        id: verQuarantinedId,
        documentId: docQuarantinedId,
        versionNumber: 1,
        fileObjectId: fileQuarantinedId,
        uploadedByUserId: readerId,
      },
      {
        id: verImageId,
        documentId: docImageId,
        versionNumber: 1,
        fileObjectId: fileImageId,
        uploadedByUserId: readerId,
      },
    ]);

    await db
      .update(documents)
      .set({ currentVersionId: verPdfId })
      .where(eq(documents.id, docPdfId));
    await db
      .update(documents)
      .set({ currentVersionId: verQuarantinedId })
      .where(eq(documents.id, docQuarantinedId));
    await db
      .update(documents)
      .set({ currentVersionId: verImageId })
      .where(eq(documents.id, docImageId));

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", async ({ connection }) => {
      const rootDir = connection.nonSecretConfig.rootDirectory;
      if (typeof rootDir !== "string" || rootDir.length === 0) {
        throw new Error("Missing rootDirectory");
      }
      return createLocalStorageProvider({ rootDirectory: rootDir });
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
        authzRepository: createAuthorizationRepository(db),
        documentRepository: createDocumentRepository(db),
        auditRepository: createAuditRepository(db),
        documentVersionRepository: createDocumentVersionRepository(db),
        uploadRepository: createUploadSessionRepository(db),
        storageConnections: createStorageConnectionRepository(db),
        storageRegistry,
      },
    });
    await app.ready();

    // 1. Unauthenticated blocked (401)
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/documents/${docPdfId}/preview` }))
        .statusCode,
    ).toBe(401);

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";

    const readerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `reader-prev-${orgId.slice(0, 6)}@papyrus.local`,
        password: "PreviewPdf!2026",
      },
    });
    const readerCookie =
      readerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const readerCookies = { [SESSION_COOKIE_NAME]: readerCookie, [CSRF_COOKIE_NAME]: csrfToken };

    const deniedLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `denied-prev-${orgId.slice(0, 6)}@papyrus.local`,
        password: "PreviewPdf!2026",
      },
    });
    const deniedCookie =
      deniedLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const deniedCookies = { [SESSION_COOKIE_NAME]: deniedCookie, [CSRF_COOKIE_NAME]: csrfToken };

    // 2. User with DENY on folder receives 403
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${docPdfId}/preview`,
          cookies: deniedCookies,
        })
      ).statusCode,
    ).toBe(403);

    // 3. Quarantined file blocked with 409
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${docQuarantinedId}/preview`,
          cookies: readerCookies,
        })
      ).statusCode,
    ).toBe(409);

    // 4. Non-PDF file rejected with 415
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${docImageId}/preview`,
          cookies: readerCookies,
        })
      ).statusCode,
    ).toBe(415);

    // 5. Authorized PDF preview streams bytes with restrictive CSP & private no-store headers
    const previewRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docPdfId}/preview`,
      cookies: readerCookies,
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.headers["content-type"]).toContain("application/pdf");
    expect(previewRes.headers["cache-control"]).toContain("private");
    expect(previewRes.headers["cache-control"]).toContain("no-store");
    expect(previewRes.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(previewRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(previewRes.rawPayload.equals(pdfBytes)).toBe(true);

    // 6. Authorized PNG content preview streams bytes with restrictive CSP & private no-store headers
    const contentImageRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docImageId}/content`,
      cookies: readerCookies,
    });
    expect(contentImageRes.statusCode).toBe(200);
    expect(contentImageRes.headers["content-type"]).toContain("image/png");
    expect(contentImageRes.headers["cache-control"]).toContain("private");
    expect(contentImageRes.headers["cache-control"]).toContain("no-store");
    expect(contentImageRes.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(contentImageRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(contentImageRes.rawPayload.equals(pngBytes)).toBe(true);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId));
    expect(events.map((e) => e.action)).toContain("DOCUMENT_PREVIEWED");

    await app.close();
  }, 60_000);
});
