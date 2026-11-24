import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categories,
  createAuditRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  createUserRepository,
  fileObjects,
  organizations,
  roles,
  userRoleScopes,
} from "../src/index.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../drizzle");
const VALID_SHA256 = "b".repeat(64);

describe("PostgreSQL repositories integration", () => {
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

  it("paginates documents in PostgreSQL, enforces optimistic locking, and rolls back failed transactions", async () => {
    const db = drizzle(pool);
    const txManager = createTransactionManager(db);
    const docRepo = createDocumentRepository(db);
    const versionRepo = createDocumentVersionRepository(db);
    const userRepo = createUserRepository(db);
    const auditRepo = createAuditRepository(db);
    const storageRepo = createStorageConnectionRepository(db);

    const orgId = randomUUID();
    const userId = randomUUID();
    const catId = randomUUID();
    const connId = randomUUID();
    const roleId = randomUUID();

    await db.insert(organizations).values({ id: orgId, name: "papyrus Org", slug: "papyrus-org" });
    await userRepo.create({
      id: userId,
      organizationId: orgId,
      email: "Admin@papyrus.Invalid",
      fullName: "Administrador Principal",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$salt$hash",
      status: "ACTIVE",
    });

    const foundUser = await userRepo.findByEmail(orgId, "admin@papyrus.invalid");
    expect(foundUser?.id).toBe(userId);

    await db.insert(roles).values({
      id: roleId,
      organizationId: orgId,
      key: "admin",
      name: "Administrador",
      isSystem: true,
    });
    await db.insert(userRoleScopes).values({
      organizationId: orgId,
      userId,
      roleId,
      scopeType: "GLOBAL",
      scopeTargetId: null,
      effect: "ALLOW",
    });
    expect(await userRepo.countActiveAdmins(orgId)).toBe(1);

    await db.insert(categories).values({ id: catId, organizationId: orgId, name: "Contratos" });

    await storageRepo.create({
      id: connId,
      organizationId: orgId,
      name: "Storage Local",
      kind: "local",
      isDefault: true,
      nonSecretConfig: { rootPath: "/data/storage" },
      encryptedSecretRef: null,
    });
    expect(await storageRepo.hasLinkedFileObjects(connId)).toBe(false);

    const fileId = randomUUID();
    await db.insert(fileObjects).values({
      id: fileId,
      organizationId: orgId,
      storageConnectionId: connId,
      objectKey: `org/${orgId}/documents/doc/versions/v1/${fileId}`,
      originalFileName: "contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 4096,
      checksumSha256: VALID_SHA256,
      status: "AVAILABLE",
    });
    expect(await storageRepo.hasLinkedFileObjects(connId)).toBe(true);

    const doc1Id = randomUUID();
    const doc2Id = randomUUID();
    const doc3Id = randomUUID();

    await txManager.runInTransaction(async (tx) => {
      await docRepo.create(
        {
          id: doc1Id,
          organizationId: orgId,
          title: "Contrato Alpha",
          categoryId: catId,
          folderId: null,
          ownerUserId: userId,
          issueDate: "2026-11-01",
          expirationDate: null,
          metadata: {},
        },
        tx,
      );
      const versionId = randomUUID();
      await versionRepo.create(
        {
          id: versionId,
          documentId: doc1Id,
          versionNumber: 1,
          fileObjectId: fileId,
          uploadedByUserId: userId,
          changeNote: "Versão inicial",
        },
        tx,
      );
      await docRepo.setCurrentVersion(doc1Id, versionId, 1, tx);
      await auditRepo.append(
        {
          organizationId: orgId,
          actorUserId: userId,
          action: "DOCUMENT_CREATED",
          resourceType: "DOCUMENT",
          resourceId: doc1Id,
          result: "SUCCESS",
          requestId: randomUUID(),
        },
        tx,
      );
    });

    await docRepo.create({
      id: doc2Id,
      organizationId: orgId,
      title: "Contrato Beta",
      categoryId: catId,
      folderId: null,
      ownerUserId: userId,
      issueDate: "2026-11-02",
      expirationDate: null,
      metadata: {},
    });
    await docRepo.create({
      id: doc3Id,
      organizationId: orgId,
      title: "Contrato Gamma",
      categoryId: catId,
      folderId: null,
      ownerUserId: userId,
      issueDate: "2026-11-03",
      expirationDate: null,
      metadata: {},
    });

    // Server-side pagination and allowed sorting
    const page1 = await docRepo.list({
      organizationId: orgId,
      page: 1,
      pageSize: 2,
      sortBy: "title",
      sortDirection: "asc",
    });
    expect(page1.totalItems).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.items.map((item) => item.title)).toEqual(["Contrato Alpha", "Contrato Beta"]);

    const page2 = await docRepo.list({
      organizationId: orgId,
      page: 2,
      pageSize: 2,
      sortBy: "title",
      sortDirection: "asc",
    });
    expect(page2.items.map((item) => item.title)).toEqual(["Contrato Gamma"]);

    // Optimistic locking conflict returns null when expectedVersion is stale
    const updated = await docRepo.updateWithOptimisticLock(doc1Id, 2, {
      title: "Contrato Alpha Atualizado",
    });
    expect(updated?.version).toBe(3);

    const conflict = await docRepo.updateWithOptimisticLock(doc1Id, 2, {
      title: "Conflito",
    });
    expect(conflict).toBeNull();

    // Explicit transaction rollback on error
    const rolledBackDocId = randomUUID();
    await expect(
      txManager.runInTransaction(async (tx) => {
        await docRepo.create(
          {
            id: rolledBackDocId,
            organizationId: orgId,
            title: "Não deve persistir",
            categoryId: catId,
            folderId: null,
            ownerUserId: userId,
            issueDate: null,
            expirationDate: null,
            metadata: {},
          },
          tx,
        );
        throw new Error("Simulated failure");
      }),
    ).rejects.toThrow("Simulated failure");

    expect(await docRepo.findById(rolledBackDocId)).toBeNull();

    // Audit trail is readable and paginated
    const auditPage = await auditRepo.list({
      organizationId: orgId,
      page: 1,
      pageSize: 10,
    });
    expect(auditPage.totalItems).toBe(1);
    expect(auditPage.items[0]?.action).toBe("DOCUMENT_CREATED");
  });
});
