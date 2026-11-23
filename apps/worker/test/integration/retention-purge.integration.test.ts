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
  createCategoryRepository,
  createDocumentPurgeRepository,
  createDocumentRepository,
  createDocumentRetentionHoldRepository,
  createRetentionPolicyRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  documentRetentionHolds,
  documentVersions,
  documents,
  fileObjects,
  organizations,
  storageConnections,
  storageOperations,
  users,
} from "@docuflow/database";
import { createRetentionGovernanceService } from "@docuflow/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurgeDeletedDocumentsHandler } from "../../src/jobs/purge-deleted-documents.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

async function putBinary(
  provider: StorageProvider,
  objectKey: string,
  content: string,
): Promise<{ sizeBytes: number; checksumSha256: string }> {
  const buf = Buffer.from(content, "utf8");
  const checksumSha256 = createHash("sha256").update(buf).digest("hex");
  await provider.putObject({
    key: { value: objectKey },
    body: Readable.from([buf]),
    metadata: {
      contentType: "application/pdf",
      contentLength: buf.length,
      checksumSha256,
    },
  });
  return { sizeBytes: buf.length, checksumSha256 };
}

describe("Retention hold, retry isolation, and audit preservation integration (Step 16.07)", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let storageDirPrimary: string;
  let storageDirSecondary: string;

  beforeAll(async () => {
    const externalUrl = process.env.DATABASE_URL;
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    storageDirPrimary = await mkdtemp(path.join(os.tmpdir(), "docuflow-ret-p1-"));
    storageDirSecondary = await mkdtemp(path.join(os.tmpdir(), "docuflow-ret-p2-"));
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
    if (storageDirPrimary) {
      await rm(storageDirPrimary, { recursive: true, force: true });
    }
    if (storageDirSecondary) {
      await rm(storageDirSecondary, { recursive: true, force: true });
    }
  });

  it("blocks purge while any hold is active and preserves prior plus retention audit events after hold release and purge", async () => {
    const db = drizzle(pool);
    const localProvider = createLocalStorageProvider({ rootDirectory: storageDirPrimary });

    const orgId = randomUUID();
    const adminId = randomUUID();
    const legalId = randomUUID();
    const catId = randomUUID();
    const connId = randomUUID();
    const docId = randomUUID();
    const verId = randomUUID();
    const fileId = randomUUID();
    const objectKey = `org/${orgId}/documents/${docId}/versions/${verId}/obj-held`;

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Retenção Audit",
      slug: `org-ret-audit-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    await db.insert(users).values([
      {
        id: adminId,
        organizationId: orgId,
        email: `admin-ret-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Gestor Retenção",
        passwordHash: "hash-placeholder",
        status: "ACTIVE",
      },
      {
        id: legalId,
        organizationId: orgId,
        email: `legal-ret-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Jurídico Hold",
        passwordHash: "hash-placeholder",
        status: "ACTIVE",
      },
    ]);

    await db.insert(categories).values({
      id: catId,
      organizationId: orgId,
      name: "Processos Jurídicos",
      isActive: true,
    });

    await db.insert(storageConnections).values({
      id: connId,
      organizationId: orgId,
      name: "Local Principal",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: storageDirPrimary },
    });

    const { sizeBytes, checksumSha256 } = await putBinary(
      localProvider,
      objectKey,
      "%PDF-1.7\nHeld Binary\n%%EOF\n",
    );

    await db.insert(fileObjects).values({
      id: fileId,
      organizationId: orgId,
      storageConnectionId: connId,
      objectKey,
      originalFileName: "processo.pdf",
      detectedContentType: "application/pdf",
      sizeBytes,
      checksumSha256,
      status: "AVAILABLE",
    });

    const oldCreatedAt = new Date("2025-01-01T10:00:00.000Z");
    const oldDeletedAt = new Date("2026-01-01T10:00:00.000Z");

    await db.insert(documents).values({
      id: docId,
      organizationId: orgId,
      title: "Processo Contencioso",
      categoryId: catId,
      status: "DELETED",
      deletedAt: oldDeletedAt,
      ownerUserId: adminId,
      createdAt: oldCreatedAt,
      updatedAt: oldDeletedAt,
    });

    await db.insert(documentVersions).values({
      id: verId,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: fileId,
      uploadedByUserId: adminId,
    });

    await db.update(documents).set({ currentVersionId: verId }).where(eq(documents.id, docId));

    // Seed historical business audits referencing the document before purge
    const auditRepo = createAuditRepository(db);
    await auditRepo.append({
      organizationId: orgId,
      actorUserId: adminId,
      action: "DOCUMENT_CREATED",
      resourceType: "DOCUMENT",
      resourceId: docId,
      result: "SUCCESS",
      requestId: randomUUID(),
      metadata: { title: "Processo Contencioso" },
    });
    await auditRepo.append({
      organizationId: orgId,
      actorUserId: adminId,
      action: "DOCUMENT_TRASHED",
      resourceType: "DOCUMENT",
      resourceId: docId,
      result: "SUCCESS",
      requestId: randomUUID(),
      metadata: { previousStatus: "APPROVED" },
    });

    let clockMs = Date.parse("2026-06-01T12:00:00.000Z");
    const txManager = createTransactionManager(db);
    const retentionService = createRetentionGovernanceService({
      policies: createRetentionPolicyRepository(db),
      holds: createDocumentRetentionHoldRepository(db),
      documents: createDocumentRepository(db),
      categories: createCategoryRepository(db),
      transactions: txManager,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: () => new Date(clockMs),
    });

    await retentionService.createPolicy({
      organizationId: orgId,
      actorUserId: adminId,
      requestId: randomUUID(),
      name: "Janela Curta 5d + 5d",
      categoryId: catId,
      retentionDays: 5,
      trashGraceDays: 5,
      actionOnExpiry: "PURGE",
    });

    const holdLegal = await retentionService.placeHold({
      organizationId: orgId,
      actorUserId: legalId,
      requestId: randomUUID(),
      documentId: docId,
      reason: "Ação trabalhista em tramitação",
    });

    const holdCompliance = await retentionService.placeHold({
      organizationId: orgId,
      actorUserId: adminId,
      requestId: randomUUID(),
      documentId: docId,
      reason: "Conferência regulatória pendente",
    });

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", (config) => {
      const rootDirectory =
        typeof config.rootDirectory === "string" ? config.rootDirectory : storageDirPrimary;
      return createLocalStorageProvider({ rootDirectory });
    });

    const purgeHandler = createPurgeDeletedDocumentsHandler({
      store: createDocumentPurgeRepository(db),
      connections: createStorageConnectionRepository(db),
      storageRegistry,
      transactions: txManager,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: () => new Date(clockMs),
    });

    // Cycle 1: Both holds active -> purge strictly blocked
    const cycle1 = await purgeHandler.runPurgeCycle();
    expect(cycle1.purgedDocumentIds).toEqual([]);
    expect(cycle1.skippedDocuments).toEqual([{ documentId: docId, reasons: ["ACTIVE_HOLD"] }]);
    expect(await localProvider.headObject({ value: objectKey })).not.toBeNull();

    // Release only the first hold -> second hold STILL blocks purge
    clockMs += 60_000;
    await retentionService.releaseHold({
      organizationId: orgId,
      actorUserId: legalId,
      requestId: randomUUID(),
      documentId: docId,
      holdId: holdLegal.id,
      releaseReason: "Acordo homologado",
    });

    const cycle2 = await purgeHandler.runPurgeCycle();
    expect(cycle2.purgedDocumentIds).toEqual([]);
    expect(cycle2.skippedDocuments).toEqual([{ documentId: docId, reasons: ["ACTIVE_HOLD"] }]);
    expect(await localProvider.headObject({ value: objectKey })).not.toBeNull();

    const [docWhileHeld] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    expect(docWhileHeld?.status).toBe("DELETED");

    // Release the final hold -> document & file object are safely purged
    clockMs += 60_000;
    await retentionService.releaseHold({
      organizationId: orgId,
      actorUserId: adminId,
      requestId: randomUUID(),
      documentId: docId,
      holdId: holdCompliance.id,
      releaseReason: "Auditoria concluída",
    });

    const cycle3 = await purgeHandler.runPurgeCycle();
    expect(cycle3.purgedDocumentIds).toEqual([docId]);
    expect(cycle3.purgedFileObjectIds).toEqual([fileId]);
    expect(await localProvider.headObject({ value: objectKey })).toBeNull();

    const [purgedDocRow] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    const remainingHolds = await db
      .select()
      .from(documentRetentionHolds)
      .where(eq(documentRetentionHolds.documentId, docId));
    expect(purgedDocRow).toBeUndefined();
    expect(remainingHolds).toEqual([]);

    // Audit trail is append-only and NEVER cascaded away when document/holds rows are purged
    const preservedDocAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.resourceId, docId)))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));

    expect(preservedDocAudits.map((row) => row.action)).toEqual([
      "DOCUMENT_CREATED",
      "DOCUMENT_TRASHED",
      "RETENTION_HOLD_PLACED",
      "RETENTION_HOLD_PLACED",
      "RETENTION_HOLD_RELEASED",
      "RETENTION_HOLD_RELEASED",
      "DOCUMENT_PURGED",
    ]);

    const fileAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.resourceId, fileId)));
    expect(fileAudits.map((row) => row.action)).toEqual(["DOCUMENT_FILE_PURGE_COMPLETED"]);
  });

  it("never deletes objects on wrong connections, shared references, held docs, premature retries, or exhausted retries", async () => {
    const db = drizzle(pool);
    const providerPrimary = createLocalStorageProvider({ rootDirectory: storageDirPrimary });
    const providerSecondary = createLocalStorageProvider({ rootDirectory: storageDirSecondary });

    const orgId = randomUUID();
    const userId = randomUUID();
    const catId = randomUUID();
    const connPrimaryId = randomUUID();
    const connSecondaryId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Retry Isolation",
      slug: `org-retry-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    await db.insert(users).values({
      id: userId,
      organizationId: orgId,
      email: `retry-${orgId.slice(0, 6)}@docuflow.local`,
      fullName: "Operador Retry",
      passwordHash: "hash-placeholder",
      status: "ACTIVE",
    });

    await db.insert(categories).values({
      id: catId,
      organizationId: orgId,
      name: "Geral Retry",
      isActive: true,
    });

    // Primary storage is NOT default; secondary storage IS default.
    // Reconciled target lives on primary storage, proving retry respects exact storageConnectionId.
    await db.insert(storageConnections).values([
      {
        id: connPrimaryId,
        organizationId: orgId,
        name: "Conexão Primária (Não Padrão)",
        kind: "local",
        status: "ACTIVE",
        isDefault: false,
        nonSecretConfig: {
          rootDirectory: storageDirPrimary,
          connectionTag: "primary",
        },
      },
      {
        id: connSecondaryId,
        organizationId: orgId,
        name: "Conexão Secundária (Padrão)",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: {
          rootDirectory: storageDirSecondary,
          connectionTag: "secondary",
        },
      },
    ]);

    const collidingObjectKey = `org/${orgId}/shared-path/collision-check-object`;
    const sharedObjectKey = `org/${orgId}/shared-path/referenced-by-active`;
    const heldObjectKey = `org/${orgId}/shared-path/held-untouched`;
    const exhaustObjectKey = `org/${orgId}/shared-path/exhaust-retry-object`;

    const primaryTargetFileId = randomUUID();
    const secondarySameKeyFileId = randomUUID();
    const sharedFileId = randomUUID();
    const heldFileId = randomUUID();
    const exhaustFileId = randomUUID();

    const targetMeta = await putBinary(providerPrimary, collidingObjectKey, "primary-delete-me");
    const secondaryMeta = await putBinary(
      providerSecondary,
      collidingObjectKey,
      "secondary-must-survive",
    );
    const sharedMeta = await putBinary(providerPrimary, sharedObjectKey, "shared-must-survive");
    const heldMeta = await putBinary(providerPrimary, heldObjectKey, "held-must-survive");
    const exhaustMeta = await putBinary(providerPrimary, exhaustObjectKey, "exhaust-stays-on-disk");

    await db.insert(fileObjects).values([
      {
        id: primaryTargetFileId,
        organizationId: orgId,
        storageConnectionId: connPrimaryId,
        objectKey: collidingObjectKey,
        originalFileName: "target.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: targetMeta.sizeBytes,
        checksumSha256: targetMeta.checksumSha256,
        status: "AVAILABLE",
      },
      {
        id: secondarySameKeyFileId,
        organizationId: orgId,
        storageConnectionId: connSecondaryId,
        objectKey: collidingObjectKey,
        originalFileName: "innocent-same-key.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: secondaryMeta.sizeBytes,
        checksumSha256: secondaryMeta.checksumSha256,
        status: "AVAILABLE",
      },
      {
        id: sharedFileId,
        organizationId: orgId,
        storageConnectionId: connPrimaryId,
        objectKey: sharedObjectKey,
        originalFileName: "shared.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: sharedMeta.sizeBytes,
        checksumSha256: sharedMeta.checksumSha256,
        status: "AVAILABLE",
      },
      {
        id: heldFileId,
        organizationId: orgId,
        storageConnectionId: connPrimaryId,
        objectKey: heldObjectKey,
        originalFileName: "held.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: heldMeta.sizeBytes,
        checksumSha256: heldMeta.checksumSha256,
        status: "AVAILABLE",
      },
      {
        id: exhaustFileId,
        organizationId: orgId,
        storageConnectionId: connPrimaryId,
        objectKey: exhaustObjectKey,
        originalFileName: "exhaust.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: exhaustMeta.sizeBytes,
        checksumSha256: exhaustMeta.checksumSha256,
        status: "AVAILABLE",
      },
    ]);

    const docActiveSharedId = randomUUID();
    const docActiveSecondaryId = randomUUID();
    const docPurgeTargetId = randomUUID();
    const docHeldId = randomUUID();
    const docExhaustId = randomUUID();

    const oldCreated = new Date("2025-02-01T10:00:00.000Z");
    const oldDeleted = new Date("2026-01-10T10:00:00.000Z");

    await db.insert(documents).values([
      {
        id: docActiveSharedId,
        organizationId: orgId,
        title: "Ativo Compartilha v1",
        categoryId: catId,
        status: "APPROVED",
        ownerUserId: userId,
        createdAt: oldCreated,
        updatedAt: oldCreated,
      },
      {
        id: docActiveSecondaryId,
        organizationId: orgId,
        title: "Ativo Outra Conexão Mesma Chave",
        categoryId: catId,
        status: "APPROVED",
        ownerUserId: userId,
        createdAt: oldCreated,
        updatedAt: oldCreated,
      },
      {
        id: docPurgeTargetId,
        organizationId: orgId,
        title: "Excluído Com Retry Bem-Sucedido",
        categoryId: catId,
        status: "DELETED",
        deletedAt: oldDeleted,
        ownerUserId: userId,
        createdAt: oldCreated,
        updatedAt: oldDeleted,
      },
      {
        id: docHeldId,
        organizationId: orgId,
        title: "Excluído Com Hold Intocável",
        categoryId: catId,
        status: "DELETED",
        deletedAt: oldDeleted,
        ownerUserId: userId,
        createdAt: oldCreated,
        updatedAt: oldDeleted,
      },
      {
        id: docExhaustId,
        organizationId: orgId,
        title: "Excluído Com Falha Permanente",
        categoryId: catId,
        status: "DELETED",
        deletedAt: new Date("2026-01-11T10:00:00.000Z"),
        ownerUserId: userId,
        createdAt: oldCreated,
        updatedAt: oldDeleted,
      },
    ]);

    const verSharedActive = randomUUID();
    const verSecondaryActive = randomUUID();
    const verPurgeShared = randomUUID();
    const verPurgeExclusive = randomUUID();
    const verHeld = randomUUID();
    const verExhaust = randomUUID();

    await db.insert(documentVersions).values([
      {
        id: verSharedActive,
        documentId: docActiveSharedId,
        versionNumber: 1,
        fileObjectId: sharedFileId,
        uploadedByUserId: userId,
      },
      {
        id: verSecondaryActive,
        documentId: docActiveSecondaryId,
        versionNumber: 1,
        fileObjectId: secondarySameKeyFileId,
        uploadedByUserId: userId,
      },
      {
        id: verPurgeShared,
        documentId: docPurgeTargetId,
        versionNumber: 1,
        fileObjectId: sharedFileId,
        uploadedByUserId: userId,
      },
      {
        id: verPurgeExclusive,
        documentId: docPurgeTargetId,
        versionNumber: 2,
        fileObjectId: primaryTargetFileId,
        uploadedByUserId: userId,
      },
      {
        id: verHeld,
        documentId: docHeldId,
        versionNumber: 1,
        fileObjectId: heldFileId,
        uploadedByUserId: userId,
      },
      {
        id: verExhaust,
        documentId: docExhaustId,
        versionNumber: 1,
        fileObjectId: exhaustFileId,
        uploadedByUserId: userId,
      },
    ]);

    for (const [docId, currentVerId] of [
      [docActiveSharedId, verSharedActive],
      [docActiveSecondaryId, verSecondaryActive],
      [docPurgeTargetId, verPurgeExclusive],
      [docHeldId, verHeld],
      [docExhaustId, verExhaust],
    ] as const) {
      await db
        .update(documents)
        .set({ currentVersionId: currentVerId })
        .where(eq(documents.id, docId));
    }

    await db.insert(documentRetentionHolds).values({
      id: randomUUID(),
      organizationId: orgId,
      documentId: docHeldId,
      reason: "Hold ativo durante janela de retry",
      placedByUserId: userId,
      placedAt: oldDeleted,
    });

    const deleteAttempts: Array<{ readonly connectionTag: string; readonly objectKey: string }> =
      [];
    const failKeysOnPrimary = new Set<string>([collidingObjectKey, exhaustObjectKey]);

    const registry = createStorageProviderRegistry();
    registry.registerFactory("local", (config) => {
      const connectionTag = config.connectionTag === "secondary" ? "secondary" : "primary";
      const backing = connectionTag === "secondary" ? providerSecondary : providerPrimary;
      return {
        kind: backing.kind,
        capabilities: backing.capabilities,
        checkHealth: () => backing.checkHealth(),
        putObject: (input) => backing.putObject(input),
        getObject: (key) => backing.getObject(key),
        headObject: (key) => backing.headObject(key),
        async deleteObject(key) {
          deleteAttempts.push({ connectionTag, objectKey: key.value });
          if (connectionTag === "primary" && failKeysOnPrimary.has(key.value)) {
            throw new Error("Simulated S3 timeout (secretAccessKey=DO_NOT_LOG_SECRET)");
          }
          return backing.deleteObject(key);
        },
      };
    });

    let clockMs = Date.parse("2026-06-10T10:00:00.000Z");
    const handler = createPurgeDeletedDocumentsHandler({
      store: createDocumentPurgeRepository(db),
      connections: createStorageConnectionRepository(db),
      storageRegistry: registry,
      transactions: createTransactionManager(db),
      audit: createAuditRepository(db),
      generateId: () => randomUUID(),
      fallbackTrashGraceDays: 30,
      baseRetryDelayMs: 5_000,
      maxDeleteAttempts: 2,
      now: () => new Date(clockMs),
    });

    // Cycle 1: Both primary targets fail transiently on attempt 1 -> backoff = 5s (nextAttemptAt = T0 + 5s)
    const cycle1 = await handler.runPurgeCycle();
    expect(cycle1.purgedDocumentIds).toEqual([docPurgeTargetId, docExhaustId]);
    expect(cycle1.skippedReferencedFileObjectIds).toEqual([sharedFileId]);
    expect(cycle1.deferredReconciliationIds).toHaveLength(2);
    expect(cycle1.skippedDocuments).toEqual([{ documentId: docHeldId, reasons: ["ACTIVE_HOLD"] }]);
    expect(deleteAttempts).toEqual([
      { connectionTag: "primary", objectKey: collidingObjectKey },
      { connectionTag: "primary", objectKey: exhaustObjectKey },
    ]);

    // Cycle 2 BEFORE retry backoff expires (+2s < +5s): MUST make zero deleteObject calls
    clockMs += 2_000;
    const attemptsBeforeCycle2 = deleteAttempts.length;
    const cycle2 = await handler.runPurgeCycle();
    expect(deleteAttempts.length).toBe(attemptsBeforeCycle2);
    expect(cycle2.reconciledFileObjectIds).toEqual([]);
    expect(cycle2.failedReconciliationIds).toEqual([]);

    // Cycle 3 AFTER backoff (+6s total): allow collidingObjectKey to succeed on primary,
    // keep exhaustObjectKey failing so attempt 2 exhausts maxDeleteAttempts=2 -> FAILED.
    failKeysOnPrimary.delete(collidingObjectKey);
    clockMs += 4_000;

    const cycle3 = await handler.runPurgeCycle();
    expect(cycle3.reconciledFileObjectIds).toEqual([primaryTargetFileId]);
    expect(cycle3.failedReconciliationIds).toHaveLength(1);
    expect(deleteAttempts.slice(attemptsBeforeCycle2)).toEqual([
      { connectionTag: "primary", objectKey: collidingObjectKey },
      { connectionTag: "primary", objectKey: exhaustObjectKey },
    ]);

    // Cycle 4 long after completion/exhaustion: idempotent no-op, NEVER retries COMPLETED or FAILED ops
    clockMs += 120_000;
    const attemptsBeforeCycle4 = deleteAttempts.length;
    const cycle4 = await handler.runPurgeCycle();
    expect(deleteAttempts.length).toBe(attemptsBeforeCycle4);
    expect(cycle4.reconciledFileObjectIds).toEqual([]);
    expect(cycle4.failedReconciliationIds).toEqual([]);

    // Crucial object safety assertions:
    // 1) Primary target deleted cleanly;
    // 2) Secondary connection object with IDENTICAL objectKey NEVER touched;
    // 3) Shared object still referenced by active document NEVER touched;
    // 4) Held document binary NEVER touched;
    // 5) Exhausted op stays DELETE_PENDING on disk (not silently lost, not wrongly mapped).
    expect(await providerPrimary.headObject({ value: collidingObjectKey })).toBeNull();
    expect(await providerSecondary.headObject({ value: collidingObjectKey })).not.toBeNull();
    expect(await providerPrimary.headObject({ value: sharedObjectKey })).not.toBeNull();
    expect(await providerPrimary.headObject({ value: heldObjectKey })).not.toBeNull();
    expect(await providerPrimary.headObject({ value: exhaustObjectKey })).not.toBeNull();

    const [secondaryFileRow] = await db
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.id, secondarySameKeyFileId))
      .limit(1);
    const [exhaustOpRow] = await db
      .select()
      .from(storageOperations)
      .where(eq(storageOperations.fileObjectId, exhaustFileId))
      .limit(1);
    expect(secondaryFileRow?.status).toBe("AVAILABLE");
    expect(exhaustOpRow?.status).toBe("FAILED");
    expect(exhaustOpRow?.attempts).toBe(2);
    expect(exhaustOpRow?.nextAttemptAt).toBeNull();
    expect(exhaustOpRow?.lastError).not.toContain("DO_NOT_LOG_SECRET");

    // Audit records preserved without secret exposure
    const orgAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    expect(orgAudits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "DOCUMENT_PURGED",
        "DOCUMENT_FILE_PURGE_FAILED",
        "DOCUMENT_FILE_PURGE_RECONCILED",
      ]),
    );
    expect(JSON.stringify(orgAudits)).not.toContain("DO_NOT_LOG_SECRET");
  });
});
