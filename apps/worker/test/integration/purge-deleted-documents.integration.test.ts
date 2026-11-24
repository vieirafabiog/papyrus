import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createDocumentPurgeRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  documentRetentionHolds,
  documentVersions,
  documents,
  fileObjects,
  organizations,
  retentionPolicies,
  storageConnections,
  storageOperations,
  users,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowInstances,
} from "@papyrus/database";
import { type StorageProvider, createStorageProviderRegistry } from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurgeDeletedDocumentsHandler } from "../../src/jobs/purge-deleted-documents.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Worker physical purge of deleted documents integration (Step 13.08)", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let storageRootDir: string;

  beforeAll(async () => {
    const externalUrl = process.env.DATABASE_URL;
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    storageRootDir = await mkdtemp(path.join(os.tmpdir(), "papyrus-purge-integ-"));
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
    if (storageRootDir) {
      await rm(storageRootDir, { recursive: true, force: true });
    }
  });

  it("enforces retention window, holds, active workflows, shared references, DELETE_PENDING, and retryable reconciliation", async () => {
    const db = drizzle(pool);
    const localProvider = createLocalStorageProvider({ rootDirectory: storageRootDir });

    const orgId = randomUUID();
    const userId = randomUUID();
    const categoryId = randomUUID();
    const connectionId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Purge",
      slug: `org-purge-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    await db.insert(users).values({
      id: userId,
      organizationId: orgId,
      email: `purge-${orgId.slice(0, 6)}@papyrus.local`,
      fullName: "Admin Expurgo",
      passwordHash: "hash-placeholder",
      status: "ACTIVE",
    });

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos Retenção",
      isActive: true,
    });

    await db.insert(storageConnections).values({
      id: connectionId,
      organizationId: orgId,
      name: "Local Purge",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: storageRootDir },
    });

    await db.insert(retentionPolicies).values({
      id: randomUUID(),
      organizationId: orgId,
      categoryId,
      name: "Política 30d + 7d carência",
      retentionDays: 30,
      trashGraceDays: 7,
      actionOnExpiry: "PURGE",
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const activeDocId = randomUUID();
    const heldDocId = randomUUID();
    const gracePendingDocId = randomUUID();
    const workflowDocId = randomUUID();
    const eligibleDocId = randomUUID();

    const sharedFileId = randomUUID();
    const exclusiveFileId = randomUUID();
    const heldFileId = randomUUID();
    const graceFileId = randomUUID();
    const workflowFileId = randomUUID();

    const sharedKey = `org/${orgId}/shared-object`;
    const exclusiveKey = `org/${orgId}/exclusive-object`;
    const heldKey = `org/${orgId}/held-object`;
    const graceKey = `org/${orgId}/grace-object`;
    const workflowKey = `org/${orgId}/workflow-object`;

    for (const [id, key] of [
      [sharedFileId, sharedKey],
      [exclusiveFileId, exclusiveKey],
      [heldFileId, heldKey],
      [graceFileId, graceKey],
      [workflowFileId, workflowKey],
    ] as const) {
      const payload = Buffer.from(`content-${key}`);
      const checksumSha256 = createHash("sha256").update(payload).digest("hex");
      await localProvider.putObject({
        key: { value: key },
        body: Readable.from([payload]),
        metadata: {
          contentType: "application/pdf",
          contentLength: payload.length,
          checksumSha256,
        },
      });
      await db.insert(fileObjects).values({
        id,
        organizationId: orgId,
        storageConnectionId: connectionId,
        objectKey: key,
        originalFileName: "arquivo.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: payload.length,
        checksumSha256,
        status: "AVAILABLE",
      });
    }

    const oldCreatedAt = new Date("2026-01-01T10:00:00.000Z");
    const oldDeletedAt = new Date("2026-02-01T10:00:00.000Z");
    const recentDeletedAt = new Date("2026-03-08T10:00:00.000Z");

    await db.insert(documents).values([
      {
        id: activeDocId,
        organizationId: orgId,
        title: "Documento Ativo Compartilhando Binário",
        categoryId,
        status: "APPROVED",
        ownerUserId: userId,
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      },
      {
        id: heldDocId,
        organizationId: orgId,
        title: "Documento Com Legal Hold",
        categoryId,
        status: "DELETED",
        deletedAt: oldDeletedAt,
        ownerUserId: userId,
        createdAt: oldCreatedAt,
        updatedAt: oldDeletedAt,
      },
      {
        id: gracePendingDocId,
        organizationId: orgId,
        title: "Documento Em Carência",
        categoryId,
        status: "DELETED",
        deletedAt: recentDeletedAt,
        ownerUserId: userId,
        createdAt: oldCreatedAt,
        updatedAt: recentDeletedAt,
      },
      {
        id: workflowDocId,
        organizationId: orgId,
        title: "Documento Em Workflow Ativo",
        categoryId,
        status: "DELETED",
        deletedAt: oldDeletedAt,
        ownerUserId: userId,
        createdAt: oldCreatedAt,
        updatedAt: oldDeletedAt,
      },
      {
        id: eligibleDocId,
        organizationId: orgId,
        title: "Documento Elegível Para Expurgo",
        categoryId,
        status: "DELETED",
        deletedAt: oldDeletedAt,
        ownerUserId: userId,
        createdAt: oldCreatedAt,
        updatedAt: oldDeletedAt,
      },
    ]);

    const activeVerId = randomUUID();
    const eligibleSharedVerId = randomUUID();
    const eligibleExclusiveVerId = randomUUID();
    const heldVerId = randomUUID();
    const graceVerId = randomUUID();
    const workflowVerId = randomUUID();

    await db.insert(documentVersions).values([
      {
        id: activeVerId,
        documentId: activeDocId,
        versionNumber: 1,
        fileObjectId: sharedFileId,
        uploadedByUserId: userId,
      },
      {
        id: eligibleSharedVerId,
        documentId: eligibleDocId,
        versionNumber: 1,
        fileObjectId: sharedFileId,
        uploadedByUserId: userId,
      },
      {
        id: eligibleExclusiveVerId,
        documentId: eligibleDocId,
        versionNumber: 2,
        fileObjectId: exclusiveFileId,
        uploadedByUserId: userId,
      },
      {
        id: heldVerId,
        documentId: heldDocId,
        versionNumber: 1,
        fileObjectId: heldFileId,
        uploadedByUserId: userId,
      },
      {
        id: graceVerId,
        documentId: gracePendingDocId,
        versionNumber: 1,
        fileObjectId: graceFileId,
        uploadedByUserId: userId,
      },
      {
        id: workflowVerId,
        documentId: workflowDocId,
        versionNumber: 1,
        fileObjectId: workflowFileId,
        uploadedByUserId: userId,
      },
    ]);

    // Link current versions
    for (const [docId, verId] of [
      [activeDocId, activeVerId],
      [eligibleDocId, eligibleExclusiveVerId],
      [heldDocId, heldVerId],
      [gracePendingDocId, graceVerId],
      [workflowDocId, workflowVerId],
    ] as const) {
      await db.update(documents).set({ currentVersionId: verId }).where(eq(documents.id, docId));
    }

    // Active legal hold on heldDocId + released historical hold on eligibleDocId
    await db.insert(documentRetentionHolds).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        documentId: heldDocId,
        reason: "Processo judicial em curso",
        placedByUserId: userId,
        placedAt: oldDeletedAt,
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        documentId: eligibleDocId,
        reason: "Auditoria concluída",
        placedByUserId: userId,
        placedAt: oldCreatedAt,
        releasedByUserId: userId,
        releasedAt: oldDeletedAt,
        releaseReason: "Encerrada sem ressalvas",
      },
    ]);

    // Active workflow instance referencing workflowDocId
    const wfDefId = randomUUID();
    const wfDefVerId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfDefId,
      organizationId: orgId,
      name: "Fluxo Expurgo Test",
      latestVersionNumber: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    await db.insert(workflowDefinitionVersions).values({
      id: wfDefVerId,
      workflowDefinitionId: wfDefId,
      versionNumber: 1,
      steps: [
        {
          stepOrder: 1,
          name: "Revisar",
          assigneeType: "USER",
          assigneeTargetId: userId,
          dueDays: 3,
        },
      ],
      createdBy: userId,
    });
    await db.insert(workflowInstances).values({
      id: randomUUID(),
      organizationId: orgId,
      documentId: workflowDocId,
      documentVersionId: workflowVerId,
      workflowDefinitionVersionId: wfDefVerId,
      status: "ACTIVE",
      startedByUserId: userId,
    });

    // Inject transient delete failure on first attempt to verify repeatable reconciliation
    let shouldFailDelete = true;
    const controllableProvider: StorageProvider = {
      kind: localProvider.kind,
      capabilities: localProvider.capabilities,
      checkHealth: () => localProvider.checkHealth(),
      putObject: (input) => localProvider.putObject(input),
      getObject: (key) => localProvider.getObject(key),
      headObject: (key) => localProvider.headObject(key),
      async deleteObject(key) {
        if (shouldFailDelete) {
          throw new Error("Simulated transient storage outage (token=secret-value)");
        }
        return localProvider.deleteObject(key);
      },
    };

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", () => controllableProvider);

    let clockMs = Date.parse("2026-03-10T12:00:00.000Z");
    const handler = createPurgeDeletedDocumentsHandler({
      store: createDocumentPurgeRepository(db),
      connections: createStorageConnectionRepository(db),
      storageRegistry,
      transactions: createTransactionManager(db),
      audit: createAuditRepository(db),
      generateId: () => randomUUID(),
      baseRetryDelayMs: 5_000,
      maxDeleteAttempts: 3,
      now: () => new Date(clockMs),
    });

    // Cycle 1: eligibleDocId is purged logically, exclusiveFileId becomes DELETE_PENDING, delete fails transiently
    const firstReport = await handler.runPurgeCycle();

    expect(firstReport.purgedDocumentIds).toEqual([eligibleDocId]);
    expect(firstReport.skippedReferencedFileObjectIds).toEqual([sharedFileId]);
    expect(firstReport.purgedFileObjectIds).toEqual([]);
    expect(firstReport.deferredReconciliationIds).toHaveLength(1);

    const skippedMap = new Map(
      firstReport.skippedDocuments.map((entry) => [entry.documentId, entry.reasons]),
    );
    expect(skippedMap.get(heldDocId)).toContain("ACTIVE_HOLD");
    expect(skippedMap.get(gracePendingDocId)).toContain("TRASH_GRACE_WINDOW_NOT_ELAPSED");
    expect(skippedMap.get(workflowDocId)).toContain("ACTIVE_WORKFLOW_REFERENCE");
    expect(skippedMap.has(activeDocId)).toBe(false);

    // Blocked documents and their binaries remain intact
    for (const [docId, key] of [
      [activeDocId, sharedKey],
      [heldDocId, heldKey],
      [gracePendingDocId, graceKey],
      [workflowDocId, workflowKey],
    ] as const) {
      const [row] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
      expect(row).toBeTruthy();
      expect(await localProvider.headObject({ value: key })).not.toBeNull();
    }

    // Exclusive file stays DELETE_PENDING and object still exists on disk until retry succeeds
    const [pendingFile] = await db
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.id, exclusiveFileId))
      .limit(1);
    expect(pendingFile?.status).toBe("DELETE_PENDING");
    expect(await localProvider.headObject({ value: exclusiveKey })).not.toBeNull();

    const [pendingOp] = await db
      .select()
      .from(storageOperations)
      .where(eq(storageOperations.fileObjectId, exclusiveFileId))
      .limit(1);
    expect(pendingOp?.status).toBe("PENDING");
    expect(pendingOp?.attempts).toBe(1);
    expect(pendingOp?.lastError).not.toContain("secret-value");

    // Cycle 2: Advance clock beyond retry delay and allow storage deletion to succeed
    shouldFailDelete = false;
    clockMs += 10_000;

    const secondReport = await handler.runPurgeCycle();
    expect(secondReport.purgedDocumentIds).toEqual([]);
    expect(secondReport.reconciledFileObjectIds).toEqual([exclusiveFileId]);
    expect(secondReport.failedReconciliationIds).toEqual([]);

    // Verify exclusive object physically removed from disk & reconciled to MISSING + COMPLETED
    expect(await localProvider.headObject({ value: exclusiveKey })).toBeNull();
    expect(await localProvider.headObject({ value: sharedKey })).not.toBeNull();

    const [completedFile] = await db
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.id, exclusiveFileId))
      .limit(1);
    expect(completedFile?.status).toBe("MISSING");

    const [completedOp] = await db
      .select()
      .from(storageOperations)
      .where(eq(storageOperations.fileObjectId, exclusiveFileId))
      .limit(1);
    expect(completedOp?.status).toBe("COMPLETED");
    expect(completedOp?.attempts).toBe(2);

    // Audit trail retains DOCUMENT_PURGED, DOCUMENT_FILE_PURGE_FAILED, and DOCUMENT_FILE_PURGE_RECONCILED
    const orgAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    const actions = orgAudits.map((event) => event.action);
    expect(actions).toContain("DOCUMENT_PURGED");
    expect(actions).toContain("DOCUMENT_FILE_PURGE_FAILED");
    expect(actions).toContain("DOCUMENT_FILE_PURGE_RECONCILED");
  });
});
