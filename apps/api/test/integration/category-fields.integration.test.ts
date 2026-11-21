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
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createTransactionManager,
  documentMetadata,
  documents,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createCategoryFieldService, createCategoryService } from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
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

describe("Category custom fields configuration and metadata compatibility integration", () => {
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

  it("configures typed fields, blocks incompatible schema changes without migration strategy, and migrates existing document metadata atomically", async () => {
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
    const adminUserId = randomUUID();
    const viewerUserId = randomUUID();
    const roleAdminId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "DocuFlow Category Fields Corp",
      slug: `cat-fields-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values([
      {
        id: roleAdminId,
        organizationId: orgId,
        key: "admin",
        name: "Administrador",
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

    await db.insert(rolePermissions).values(
      allPerms.map((p) => ({
        roleId: roleAdminId,
        permissionId: p.id,
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

    const passwordHash = await passwordService.hashPassword("FieldsTest!2026");
    await db.insert(users).values([
      {
        id: adminUserId,
        organizationId: orgId,
        email: `admin-fields-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Admin Fields",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerUserId,
        organizationId: orgId,
        email: `viewer-fields-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Viewer Fields",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: adminUserId,
        roleId: roleAdminId,
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

    const categoryRepository = createCategoryRepository(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const transactions = createTransactionManager(db);
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
      categoryDeps: {
        authzRepository,
        categoryRepository,
        categoryService,
        categoryFieldService,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `admin-fields-${orgId.slice(0, 6)}@docuflow.local`,
        password: "FieldsTest!2026",
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminSession =
      adminLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const adminCookies = { [SESSION_COOKIE_NAME]: adminSession, [CSRF_COOKIE_NAME]: csrfToken };

    const catRes = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Contratos de Fornecedor" },
    });
    expect(catRes.statusCode).toBe(201);
    const category = (catRes.json() as { data: { id: string } }).data;

    // 1. Add initial typed fields before any document exists
    const invalidSelectRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "modalidade",
        label: "Modalidade",
        type: "SINGLE_SELECT",
        required: true,
      },
    });
    expect(invalidSelectRes.statusCode).toBe(400);

    const priorityRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "prioridade",
        label: "Prioridade",
        type: "SINGLE_SELECT",
        required: true,
        options: ["BAIXA", "MEDIA", "ALTA"],
        sortOrder: 1,
      },
    });
    expect(priorityRes.statusCode).toBe(201);
    const priorityField = (priorityRes.json() as { data: { id: string } }).data;

    const codeFieldRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "codigo_externo",
        label: "Código Externo",
        type: "TEXT",
        required: false,
        sortOrder: 2,
      },
    });
    expect(codeFieldRes.statusCode).toBe(201);
    const codeField = (codeFieldRes.json() as { data: { id: string } }).data;

    // 2. Insert an existing document using those fields
    const existingDocId = randomUUID();
    await db.insert(documents).values({
      id: existingDocId,
      organizationId: orgId,
      title: "Contrato ACME 01",
      categoryId: category.id,
      folderId: null,
      status: "APPROVED",
      ownerUserId: adminUserId,
      metadata: {
        prioridade: "ALTA",
        codigo_externo: "EXT-001",
      },
    });
    await db.insert(documentMetadata).values([
      {
        documentId: existingDocId,
        fieldId: priorityField.id,
        fieldKey: "prioridade",
        valueText: "ALTA",
      },
      {
        documentId: existingDocId,
        fieldId: codeField.id,
        fieldKey: "codigo_externo",
        valueText: "EXT-001",
      },
    ]);

    // 3. Adding optional field succeeds without migration strategy
    const notesFieldRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "observacoes",
        label: "Observações",
        type: "TEXT",
        required: false,
        sortOrder: 3,
      },
    });
    expect(notesFieldRes.statusCode).toBe(201);

    // 4. Adding required field without migration strategy fails with 409
    const requiredBlockedRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "fornecedor",
        label: "Fornecedor",
        type: "TEXT",
        required: true,
        sortOrder: 4,
      },
    });
    expect(requiredBlockedRes.statusCode).toBe(409);
    expect(
      (requiredBlockedRes.json() as { error: { details?: { domainCode?: string } } }).error.details
        ?.domainCode,
    ).toBe("INCOMPATIBLE_CATEGORY_FIELD_CHANGE");

    // 5. Adding required field WITH BACKFILL_DEFAULT succeeds and backfills JSONB + document_metadata
    const requiredBackfillRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "fornecedor",
        label: "Fornecedor",
        type: "TEXT",
        required: true,
        sortOrder: 4,
        migrationStrategy: {
          type: "BACKFILL_DEFAULT",
          defaultValue: "ACME Padrão",
        },
      },
    });
    expect(requiredBackfillRes.statusCode).toBe(201);
    const vendorField = (requiredBackfillRes.json() as { data: { id: string } }).data;

    const [afterBackfillDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, existingDocId))
      .limit(1);
    expect(afterBackfillDoc?.metadata.fornecedor).toBe("ACME Padrão");

    // 6. Narrowing options used by existing doc fails without RESET_TO_DEFAULT, succeeds with it
    const removeUsedOptionBlocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${category.id}/fields/${priorityField.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        options: ["BAIXA", "MEDIA"],
      },
    });
    expect(removeUsedOptionBlocked.statusCode).toBe(409);

    const removeUsedOptionMigrated = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${category.id}/fields/${priorityField.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        options: ["BAIXA", "MEDIA"],
        migrationStrategy: { type: "RESET_TO_DEFAULT", defaultValue: "MEDIA" },
      },
    });
    expect(removeUsedOptionMigrated.statusCode).toBe(200);

    // 7. Changing TEXT -> NUMBER with incompatible text data fails without RESET_TO_DEFAULT, succeeds with it
    const incompatibleTypeBlocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${category.id}/fields/${codeField.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { type: "NUMBER", required: true },
    });
    expect(incompatibleTypeBlocked.statusCode).toBe(409);

    const migratedTypeRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${category.id}/fields/${codeField.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        type: "NUMBER",
        required: true,
        migrationStrategy: { type: "RESET_TO_DEFAULT", defaultValue: 1001 },
      },
    });
    expect(migratedTypeRes.statusCode).toBe(200);

    const [migratedMetaRow] = await db
      .select()
      .from(documentMetadata)
      .where(
        and(
          eq(documentMetadata.documentId, existingDocId),
          eq(documentMetadata.fieldId, codeField.id),
        ),
      )
      .limit(1);
    expect(migratedMetaRow?.valueText).toBeNull();
    expect(migratedMetaRow?.valueNumber).toBe(1001);

    // 8. Removing a field used by existing documents fails without REMOVE_FROM_DOCUMENTS, succeeds with it
    const deleteBlockedRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${category.id}/fields/${vendorField.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(deleteBlockedRes.statusCode).toBe(409);

    const deleteMigratedRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${category.id}/fields/${vendorField.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        migrationStrategy: { type: "REMOVE_FROM_DOCUMENTS" },
      },
    });
    expect(deleteMigratedRes.statusCode).toBe(204);

    const [afterDeleteDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, existingDocId))
      .limit(1);
    expect("fornecedor" in (afterDeleteDoc?.metadata ?? {})).toBe(false);

    // 9. GET /categories/:id and /fields reflect configured ordered fields; viewer cannot mutate fields
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/categories/${category.id}`,
      cookies: adminCookies,
    });
    expect(detailRes.statusCode).toBe(200);
    const detailData = (detailRes.json() as { data: { fields: Array<{ key: string }> } }).data;
    expect(detailData.fields.map((f) => f.key)).toEqual([
      "prioridade",
      "codigo_externo",
      "observacoes",
    ]);

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-fields-${orgId.slice(0, 6)}@docuflow.local`,
        password: "FieldsTest!2026",
      },
    });
    expect(viewerLogin.statusCode).toBe(200);
    const viewerSession =
      viewerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const viewerCookies = { [SESSION_COOKIE_NAME]: viewerSession, [CSRF_COOKIE_NAME]: csrfToken };

    const viewerFieldsRes = await app.inject({
      method: "GET",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: viewerCookies,
    });
    expect(viewerFieldsRes.statusCode).toBe(200);

    const viewerForbiddenCreateField = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${category.id}/fields`,
      cookies: viewerCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        key: "bloqueado",
        label: "Bloqueado",
        type: "TEXT",
        required: false,
      },
    });
    expect(viewerForbiddenCreateField.statusCode).toBe(403);

    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    const actions = recordedAudit.map((row) => row.action);
    expect(actions).toContain("CATEGORY_FIELD_CREATED");
    expect(actions).toContain("CATEGORY_FIELD_UPDATED");
    expect(actions).toContain("CATEGORY_FIELD_REMOVED");

    await app.close();
  }, 60_000);
});
