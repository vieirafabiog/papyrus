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
  categories,
  categoryFields,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createDocumentSearchRepository,
  createTagRepository,
  documentMetadata,
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

describe("Document search HTTP endpoint validation, sorting, pagination and pre-count authz integration", () => {
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

  it("validates query/body filters, enforces scope permissions before counting, and blocks unauthorized folder/deleted exposure", async () => {
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
    const viewerRoleId = randomUUID();
    const catContractsId = randomUUID();
    const folderPublicId = randomUUID();
    const folderChildId = randomUUID();
    const folderDeniedId = randomUUID();
    const storageId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Search Route Org",
      slug: `search-route-${orgId.slice(0, 8)}`,
    });

    const passwordHash = await passwordService.hashPassword("SearchRoute!2026");
    await db.insert(users).values({
      id: viewerId,
      organizationId: orgId,
      email: `viewer-search-${orgId.slice(0, 6)}@docuflow.local`,
      fullName: "Consulta Pesquisa",
      passwordHash,
      status: "ACTIVE",
    });

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
      id: catContractsId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    const fieldSupplierId = randomUUID();
    const fieldAmountId = randomUUID();
    await db.insert(categoryFields).values([
      {
        id: fieldSupplierId,
        categoryId: catContractsId,
        key: "fornecedor",
        label: "Fornecedor",
        type: "TEXT",
        required: true,
        sortOrder: 0,
      },
      {
        id: fieldAmountId,
        categoryId: catContractsId,
        key: "valor",
        label: "Valor",
        type: "NUMBER",
        required: false,
        sortOrder: 1,
      },
    ]);

    await db.insert(folders).values([
      {
        id: folderPublicId,
        organizationId: orgId,
        parentId: null,
        name: "Pública",
        materializedPath: `/${folderPublicId}`,
        status: "ACTIVE",
      },
      {
        id: folderChildId,
        organizationId: orgId,
        parentId: folderPublicId,
        name: "Subpasta Pública",
        materializedPath: `/${folderPublicId}/${folderChildId}`,
        status: "ACTIVE",
      },
      {
        id: folderDeniedId,
        organizationId: orgId,
        parentId: folderPublicId,
        name: "Subpasta Negada",
        materializedPath: `/${folderPublicId}/${folderDeniedId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerId,
        roleId: viewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderPublicId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerId,
        roleId: viewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderDeniedId,
        effect: "DENY",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageId,
      organizationId: orgId,
      name: "Local Search Route",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/docuflow-search-route-test" },
    });

    const tagRepo = createTagRepository(db);
    const tagUrgent = await tagRepo.create({
      id: randomUUID(),
      organizationId: orgId,
      name: "Urgente",
      normalizedName: "urgente",
      color: "#C62828",
    });

    const docAllowedId = randomUUID();
    const docDeniedId = randomUUID();
    const docDeletedId = randomUUID();
    const fileAllowedId = randomUUID();
    const verAllowedId = randomUUID();

    await db.insert(fileObjects).values({
      id: fileAllowedId,
      organizationId: orgId,
      storageConnectionId: storageId,
      objectKey: `org/${orgId}/doc/${docAllowedId}`,
      originalFileName: "termo_confidencial_fornecedor.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 2048,
      checksumSha256: "f".repeat(64),
      status: "AVAILABLE",
    });

    await db.insert(documents).values([
      {
        id: docAllowedId,
        organizationId: orgId,
        title: "Contrato Autorizado Alpha",
        categoryId: catContractsId,
        folderId: folderChildId,
        status: "APPROVED",
        ownerUserId: viewerId,
        issueDate: "2026-01-10",
        expirationDate: "2026-12-31",
        createdBy: viewerId,
        updatedBy: viewerId,
      },
      {
        id: docDeniedId,
        organizationId: orgId,
        title: "Contrato Negado Alpha",
        categoryId: catContractsId,
        folderId: folderDeniedId,
        status: "APPROVED",
        ownerUserId: viewerId,
        issueDate: "2026-01-10",
        expirationDate: "2026-12-31",
        createdBy: viewerId,
        updatedBy: viewerId,
      },
      {
        id: docDeletedId,
        organizationId: orgId,
        title: "Contrato Excluído Alpha",
        categoryId: catContractsId,
        folderId: folderPublicId,
        status: "DELETED",
        ownerUserId: viewerId,
        createdBy: viewerId,
        updatedBy: viewerId,
      },
    ]);

    await db.insert(documentVersions).values({
      id: verAllowedId,
      documentId: docAllowedId,
      versionNumber: 1,
      fileObjectId: fileAllowedId,
      uploadedByUserId: viewerId,
    });
    await db
      .update(documents)
      .set({ currentVersionId: verAllowedId })
      .where(eq(documents.id, docAllowedId));

    await db.insert(documentMetadata).values([
      {
        documentId: docAllowedId,
        fieldId: fieldSupplierId,
        fieldKey: "fornecedor",
        valueText: "Alpha Engenharia",
      },
      {
        documentId: docAllowedId,
        fieldId: fieldAmountId,
        fieldKey: "valor",
        valueNumber: 45000,
      },
      {
        documentId: docDeniedId,
        fieldId: fieldSupplierId,
        fieldKey: "fornecedor",
        valueText: "Alpha Engenharia",
      },
    ]);

    await tagRepo.attachToDocument({
      documentId: docAllowedId,
      tagId: tagUrgent.id,
      createdBy: viewerId,
    });

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const auditRepository = createAuditRepository(db);
    const documentSearchRepository = createDocumentSearchRepository(db);

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
        documentSearchRepository,
      },
    });
    await app.ready();

    // 1. Unauthenticated access rejected (401)
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/documents/search?search=Alpha" }))
        .statusCode,
    ).toBe(401);

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-search-${orgId.slice(0, 6)}@docuflow.local`,
        password: "SearchRoute!2026",
      },
    });
    const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const cookies = { [SESSION_COOKIE_NAME]: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken };

    // 2. Invalid sortBy or inverted date range rejected (400)
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/documents/search?sortBy=metadata",
          cookies,
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/documents/search",
          cookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: {
            expirationFrom: "2026-12-31",
            expirationTo: "2026-01-01",
          },
        })
      ).statusCode,
    ).toBe(400);

    // 3. GET search matches title or fileName and excludes denied/deleted before counting
    const getSearchRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/search?search=Alpha&folderId=${folderPublicId}&includeSubfolders=true&sortBy=title&sortDirection=asc`,
      cookies,
    });
    expect(getSearchRes.statusCode).toBe(200);
    const getBody = getSearchRes.json() as {
      items: { id: string }[];
      pagination: { totalItems: number; totalPages: number };
    };
    expect(getBody.pagination.totalItems).toBe(1);
    expect(getBody.items.map((item) => item.id)).toEqual([docAllowedId]);

    // 4. POST search with metadataFilters + tagIds returns only authorized doc and zero leakage
    const postSearchRes = await app.inject({
      method: "POST",
      url: "/api/v1/documents/search",
      cookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        tagIds: [tagUrgent.id],
        metadataFilters: [
          { fieldKey: "fornecedor", type: "TEXT", value: "Alpha" },
          { fieldKey: "valor", type: "NUMBER", min: 40000 },
        ],
      },
    });
    expect(postSearchRes.statusCode).toBe(200);
    const postBody = postSearchRes.json() as {
      items: { id: string }[];
      pagination: { totalItems: number };
    };
    expect(postBody.pagination.totalItems).toBe(1);
    expect(postBody.items.map((item) => item.id)).toEqual([docAllowedId]);

    // 5. Querying explicitly inside denied folder returns 0 without leakage
    const deniedFolderRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/search?folderId=${folderDeniedId}`,
      cookies,
    });
    expect(deniedFolderRes.statusCode).toBe(200);
    expect(
      (deniedFolderRes.json() as { pagination: { totalItems: number } }).pagination.totalItems,
    ).toBe(0);

    // 6. Querying explicitly status=DELETED returns 0
    const deletedRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/search?status=DELETED",
      cookies,
    });
    expect(deletedRes.statusCode).toBe(200);
    expect(
      (deletedRes.json() as { pagination: { totalItems: number } }).pagination.totalItems,
    ).toBe(0);

    await app.close();
  }, 60_000);
});
