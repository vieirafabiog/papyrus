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
} from "@papyrus/auth";
import {
  auditEvents,
  categories,
  categoryFields,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  documentTags,
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
  tags,
  userRoleScopes,
  users,
} from "@papyrus/database";
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

describe("Document details route and authorization integration", () => {
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

  it("returns enriched document details for authorized subjects without exposing objectKey and blocks denied subjects", async () => {
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
    const viewerId = randomUUID();
    const ownerId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "papyrus Detail Corp",
      slug: `doc-detail-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values({
      id: roleViewerId,
      organizationId: orgId,
      key: "viewer",
      name: "Consulta",
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
    const viewerPermIds = SYSTEM_ROLE_DEFINITIONS.viewer.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      viewerPermIds.map((permissionId) => ({
        roleId: roleViewerId,
        permissionId,
      })),
    );

    const passwordHash = await passwordService.hashPassword("DetailTest!2026");
    await db.insert(users).values([
      {
        id: viewerId,
        organizationId: orgId,
        email: `viewer-detail-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Viewer Detail",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: ownerId,
        organizationId: orgId,
        email: `owner-detail-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Ana Souza",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    const categoryId = randomUUID();
    const folderId = randomUUID();
    const deniedFolderId = randomUUID();
    const storageConnId = randomUUID();
    const fileObjectId = randomUUID();
    const docId = randomUUID();
    const deniedDocId = randomUUID();
    const versionId = randomUUID();
    const tagId = randomUUID();

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      color: "#00639B",
      icon: "description",
      isActive: true,
    });

    await db.insert(categoryFields).values({
      id: randomUUID(),
      categoryId,
      key: "fornecedor",
      label: "Fornecedor",
      type: "TEXT",
      required: true,
      sortOrder: 0,
    });

    await db.insert(folders).values([
      {
        id: folderId,
        organizationId: orgId,
        parentId: null,
        name: "Jurídico",
        materializedPath: `/${folderId}`,
        status: "ACTIVE",
      },
      {
        id: deniedFolderId,
        organizationId: orgId,
        parentId: folderId,
        name: "Restrita",
        materializedPath: `/${folderId}/${deniedFolderId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Detail",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/papyrus-detail" },
    });

    await db.insert(fileObjects).values({
      id: fileObjectId,
      organizationId: orgId,
      storageConnectionId: storageConnId,
      objectKey: `org/${orgId}/secret-path/${fileObjectId}`,
      originalFileName: "contrato-assinado.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 2048,
      checksumSha256: "c".repeat(64),
      status: "AVAILABLE",
    });

    await db.insert(documents).values([
      {
        id: docId,
        organizationId: orgId,
        title: "Contrato ACME 2026",
        categoryId,
        folderId,
        status: "APPROVED",
        ownerUserId: ownerId,
        issueDate: "2026-01-10",
        expirationDate: "2026-12-31",
        metadata: { fornecedor: "ACME Serviços" },
      },
      {
        id: deniedDocId,
        organizationId: orgId,
        title: "Contrato Sigiloso",
        categoryId,
        folderId: deniedFolderId,
        status: "APPROVED",
        ownerUserId: ownerId,
        metadata: { fornecedor: "Sigilo" },
      },
    ]);

    await db.insert(documentVersions).values({
      id: versionId,
      documentId: docId,
      versionNumber: 1,
      fileObjectId,
      uploadedByUserId: ownerId,
      changeNote: "Versão assinada",
    });

    await db.update(documents).set({ currentVersionId: versionId }).where(eq(documents.id, docId));

    await db.insert(tags).values({
      id: tagId,
      organizationId: orgId,
      name: "Vigente",
      normalizedName: "vigente",
      createdBy: ownerId,
    });
    await db.insert(documentTags).values({
      documentId: docId,
      tagId,
      createdBy: ownerId,
    });

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerId,
        roleId: roleViewerId,
        scopeType: "FOLDER",
        scopeTargetId: folderId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerId,
        roleId: roleViewerId,
        scopeType: "FOLDER",
        scopeTargetId: deniedFolderId,
        effect: "DENY",
      },
    ]);

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const auditRepository = createAuditRepository(db);

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
        email: `viewer-detail-${orgId.slice(0, 6)}@papyrus.local`,
        password: "DetailTest!2026",
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const cookies = { [SESSION_COOKIE_NAME]: sessionCookie };

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}`,
      cookies,
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = (
      detailRes.json() as {
        data: {
          title: string;
          status: string;
          issueDate: string | null;
          expirationDate: string | null;
          metadata: Record<string, unknown>;
          category: { name: string; fields: Array<{ key: string; label: string }> };
          folder: { name: string } | null;
          owner: { fullName: string };
          currentVersion: {
            versionNumber: number;
            fileObject: Record<string, unknown> | null;
          } | null;
          tags: Array<{ name: string }>;
          permissions: { canUpdate: boolean; canDownload: boolean; canUpload: boolean };
        };
      }
    ).data;

    expect(detail.title).toBe("Contrato ACME 2026");
    expect(detail.status).toBe("APPROVED");
    expect(detail.issueDate).toBe("2026-01-10");
    expect(detail.expirationDate).toBe("2026-12-31");
    expect(detail.metadata).toEqual({ fornecedor: "ACME Serviços" });
    expect(detail.category.name).toBe("Contratos");
    expect(detail.category.fields[0]?.label).toBe("Fornecedor");
    expect(detail.folder?.name).toBe("Jurídico");
    expect(detail.owner.fullName).toBe("Ana Souza");
    expect(detail.currentVersion?.versionNumber).toBe(1);
    expect(detail.currentVersion?.fileObject?.originalFileName).toBe("contrato-assinado.pdf");
    expect("objectKey" in (detail.currentVersion?.fileObject ?? {})).toBe(false);
    expect(detail.tags.map((t) => t.name)).toEqual(["Vigente"]);
    expect(detail.permissions.canUpdate).toBe(false);
    expect(detail.permissions.canDownload).toBe(true);

    // Explicit DENY blocks access cleanly (403)
    const deniedRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${deniedDocId}`,
      cookies,
    });
    expect(deniedRes.statusCode).toBe(403);

    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    expect(recordedAudit.map((row) => row.action)).toContain("DOCUMENT_VIEWED");

    await app.close();
  }, 60_000);
});
