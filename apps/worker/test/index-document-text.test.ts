import { Readable } from "node:stream";
import type { OutboxJobRecord, OutboxRepository } from "@papyrus/database";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  CategoryEntity,
  CategoryRepositoryPort,
  DocumentEntity,
  DocumentRepositoryPort,
  DocumentVersionEntity,
  DocumentVersionRepositoryPort,
  FileObjectEntity,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  TransactionContext,
  TransactionManagerPort,
  UploadSessionRepositoryPort,
} from "@papyrus/domain";
import {
  type ExtractedTextIndexRepository,
  type TextOcrEnginePort,
  createFullContentExtractionPolicy,
} from "@papyrus/file-processing";
import {
  type StorageProvider,
  type StorageProviderRegistry,
  createStorageProviderRegistry,
} from "@papyrus/storage-core";
import { describe, expect, it, vi } from "vitest";
import { createIndexDocumentTextJobHandler } from "../src/jobs/index-document-text.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440002";
const VER_ID = "550e8400-e29b-41d4-a716-446655440003";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440004";
const CONN_ID = "550e8400-e29b-41d4-a716-446655440005";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440006";
const USER_ID = "550e8400-e29b-41d4-a716-446655440007";

function buildHarness(options: {
  readonly categoryMode?: CategoryEntity["textIndexingMode"];
  readonly fileStatus?: FileObjectEntity["status"];
  readonly detectedContentType?: string;
  readonly payloadBytes?: Buffer;
  readonly ocrText?: string;
  readonly ocrThrowsTimeout?: boolean;
}) {
  const payloadBytes = options.payloadBytes ?? Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const auditEvents: AuditEventInput[] = [];
  const publishedJobIds: string[] = [];
  const retriedJobs: string[] = [];
  const indexedWrites: Array<{ documentVersionId: string; text: string; extractorKind: string }> =
    [];

  const job: OutboxJobRecord = {
    id: "550e8400-e29b-41d4-a716-446655440099",
    organizationId: ORG_ID,
    eventType: "DOCUMENT_TEXT_INDEXING_REQUESTED",
    aggregateType: "DOCUMENT_VERSION",
    aggregateId: VER_ID,
    payload: {
      documentId: DOC_ID,
      documentVersionId: VER_ID,
      fileObjectId: FILE_ID,
      storageConnectionId: CONN_ID,
    },
    status: "PENDING",
    attempts: 0,
    availableAt: "2026-11-25T12:00:00.000Z",
    publishedAt: null,
    lastError: null,
    createdAt: "2026-11-25T12:00:00.000Z",
  };

  let claimedOnce = false;
  const outbox: OutboxRepository = {
    async enqueue(input) {
      return { ...job, ...input };
    },
    async claimNextPending() {
      if (claimedOnce) {
        return null;
      }
      claimedOnce = true;
      return job;
    },
    async markPublished(jobId) {
      publishedJobIds.push(jobId);
    },
    async scheduleRetryOrFail(input) {
      retriedJobs.push(input.jobId);
      return { ...job, status: "PENDING", attempts: input.attempts + 1 };
    },
    asUploadProcessingQueue() {
      throw new Error("not used");
    },
    asDocumentTextIndexingQueue() {
      throw new Error("not used");
    },
  };

  const doc: DocumentEntity = {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Comprovante",
    categoryId: CAT_ID,
    folderId: null,
    status: "APPROVED",
    currentVersionId: VER_ID,
    ownerUserId: USER_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-11-25T12:00:00.000Z",
    updatedAt: "2026-11-25T12:00:00.000Z",
  };

  const version: DocumentVersionEntity = {
    id: VER_ID,
    documentId: DOC_ID,
    versionNumber: 1,
    fileObjectId: FILE_ID,
    uploadedByUserId: USER_ID,
    changeNote: null,
    createdAt: "2026-11-25T12:00:00.000Z",
  };

  const fileObject: FileObjectEntity = {
    id: FILE_ID,
    storageConnectionId: CONN_ID,
    objectKey: `org/${ORG_ID}/documents/${DOC_ID}/versions/${VER_ID}/${FILE_ID}`,
    originalFileName: "scan.png",
    detectedContentType: options.detectedContentType ?? "image/png",
    sizeBytes: payloadBytes.length,
    checksumSha256: "a".repeat(64),
    status: options.fileStatus ?? "AVAILABLE",
    createdAt: "2026-11-25T12:00:00.000Z",
  };

  const category: CategoryEntity = {
    id: CAT_ID,
    organizationId: ORG_ID,
    name: "Comprovantes",
    description: null,
    color: null,
    icon: null,
    isActive: true,
    textIndexingMode: options.categoryMode ?? "ALWAYS",
    createdAt: "2026-11-25T12:00:00.000Z",
    updatedAt: "2026-11-25T12:00:00.000Z",
  };

  const connection: StorageConnectionEntity = {
    id: CONN_ID,
    organizationId: ORG_ID,
    name: "Local",
    kind: "local",
    isDefault: true,
    status: "ACTIVE",
    nonSecretConfig: {},
    encryptedSecretRef: null,
    hasCredentials: false,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: "2026-11-25T12:00:00.000Z",
    updatedAt: "2026-11-25T12:00:00.000Z",
  };

  const provider: StorageProvider = {
    kind: "local",
    capabilities: {
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
      streamingRead: true,
      streamingWrite: true,
    },
    async checkHealth() {
      return {
        providerKind: "local",
        healthy: true,
        latencyMs: 1,
        checkedAt: new Date(),
        message: "ok",
      };
    },
    async putObject() {
      throw new Error("not used");
    },
    async getObject() {
      return {
        body: Readable.from([payloadBytes]),
        metadata: {
          contentType: fileObject.detectedContentType,
          contentLength: payloadBytes.length,
          checksumSha256: fileObject.checksumSha256,
        },
      };
    },
    async headObject() {
      return null;
    },
    async deleteObject() {},
  };

  const storageRegistry: StorageProviderRegistry = createStorageProviderRegistry();
  storageRegistry.registerFactory("local", () => provider);

  const policy = createFullContentExtractionPolicy({
    enabled: true,
    ocr: { enabled: true },
  });

  const ocrEngine: TextOcrEnginePort = {
    async recognizeImageBuffer() {
      if (options.ocrThrowsTimeout) {
        const err = new Error("Command timed out") as Error & { killed?: boolean };
        err.killed = true;
        throw err;
      }
      return options.ocrText ?? "Nota fiscal eletrônica autenticada com sucesso";
    },
    async recognizePdfBuffer() {
      return options.ocrText ?? "Contrato PDF digitalizado";
    },
  };

  const indexRepository: ExtractedTextIndexRepository = {
    isEnabled: () => true,
    async saveAndIndex(input) {
      indexedWrites.push({
        documentVersionId: input.documentVersionId,
        text: input.extractedText,
        extractorKind: input.extractorKind,
      });
      return {
        indexed: true,
        documentVersionId: input.documentVersionId,
        charCount: input.charCount,
      };
    },
    async deleteByDocumentId() {},
    async search() {
      return { enabled: true, matches: [] };
    },
  };

  const uploads: UploadSessionRepositoryPort = {
    async findById() {
      return null;
    },
    async findByIdempotencyKey() {
      return null;
    },
    async findFileObjectById(id) {
      return id === FILE_ID ? fileObject : null;
    },
    async createSessionWithFileObject() {
      throw new Error("not used");
    },
    async markUploadReceived() {
      return null;
    },
    async finalizeToQuarantine() {
      return null;
    },
    async markFileObjectProcessed() {
      return null;
    },
    async markSessionExpired() {},
  };

  const documents: DocumentRepositoryPort = {
    async findById(id) {
      return id === DOC_ID ? doc : null;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
    async create() {
      throw new Error("not used");
    },
    async updateWithOptimisticLock() {
      return null;
    },
    async setCurrentVersion() {
      return null;
    },
    async updateStatus() {
      return null;
    },
  };

  const documentVersions: DocumentVersionRepositoryPort = {
    async findById(id) {
      return id === VER_ID ? version : null;
    },
    async findByFileObjectId() {
      return version;
    },
    async findLatestByDocumentId() {
      return version;
    },
    async listByDocumentId() {
      return [version];
    },
    async create() {
      throw new Error("not used");
    },
  };

  const categories: CategoryRepositoryPort = {
    async findById(id) {
      return id === CAT_ID ? category : null;
    },
    async findByName() {
      return null;
    },
    async countExistingDocuments() {
      return 0;
    },
    async listAuthorized() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
    async create() {
      throw new Error("not used");
    },
    async update() {
      return null;
    },
    async listFields() {
      return [];
    },
    async findFieldById() {
      return null;
    },
    async findFieldByKey() {
      return null;
    },
    async createField() {
      throw new Error("not used");
    },
    async updateField() {
      return null;
    },
    async deleteField() {
      return false;
    },
    async listExistingDocumentMetadata() {
      return [];
    },
    async backfillFieldMetadata() {},
    async resetFieldMetadata() {},
    async removeFieldMetadata() {},
  };

  const connections: StorageConnectionRepositoryPort = {
    async findById(id) {
      return id === CONN_ID ? connection : null;
    },
    async findDefaultByOrganizationId() {
      return connection;
    },
    async listByOrganizationId() {
      return [connection];
    },
    async countDocumentsReferencingConnection() {
      return 0;
    },
    async create() {
      throw new Error("not used");
    },
    async update() {
      return null;
    },
  };

  const audit: AuditRepositoryPort = {
    async append(input) {
      auditEvents.push(input);
      return { ...input, id: "audit-1", occurredAt: "2026-11-25T12:00:00.000Z" };
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({ __brand: "TransactionContext" });
    },
  };

  const handler = createIndexDocumentTextJobHandler({
    outbox,
    uploads,
    connections,
    documents,
    documentVersions,
    categories,
    audit,
    transactions,
    storageRegistry,
    policy,
    indexRepository,
    ocrEngine,
  });

  return { handler, indexedWrites, publishedJobIds, retriedJobs, auditEvents };
}

describe("Worker document text indexing job", () => {
  it("extracts image OCR text, saves index, marks published, and audits without leaking raw text", async () => {
    const h = buildHarness({
      categoryMode: "ASK",
      detectedContentType: "image/png",
      ocrText: "Recibo oficial número 998877 emitido em São Paulo",
    });

    const outcome = await h.handler.processNextJob();
    expect(outcome.outcome).toBe("INDEXED");
    expect(h.indexedWrites).toHaveLength(1);
    expect(h.indexedWrites[0]?.extractorKind).toBe("ocr_image");
    expect(h.indexedWrites[0]?.text).toContain("998877");
    expect(h.publishedJobIds).toHaveLength(1);
    expect(h.auditEvents[0]?.action).toBe("DOCUMENT_TEXT_INDEXED");
    expect(JSON.stringify(h.auditEvents[0]?.metadata ?? {})).not.toContain("998877");
  });

  it("skips indexing cleanly when category policy is NEVER or file is still QUARANTINED", async () => {
    const neverHarness = buildHarness({ categoryMode: "NEVER" });
    const neverRes = await neverHarness.handler.processNextJob();
    expect(neverRes).toMatchObject({ outcome: "SKIPPED", reason: "CATEGORY_POLICY_NEVER" });
    expect(neverHarness.indexedWrites).toHaveLength(0);
    expect(neverHarness.publishedJobIds).toHaveLength(1);

    const quarantinedHarness = buildHarness({ fileStatus: "QUARANTINED" });
    const quarRes = await quarantinedHarness.handler.processNextJob();
    expect(quarRes).toMatchObject({
      outcome: "SKIPPED",
      reason: "DOCUMENT_OR_FILE_NOT_AVAILABLE",
    });
    expect(quarantinedHarness.indexedWrites).toHaveLength(0);
    expect(quarantinedHarness.publishedJobIds).toHaveLength(1);
  });

  it("defers job for retry when extraction times out", async () => {
    const timeoutHarness = buildHarness({
      categoryMode: "ALWAYS",
      ocrThrowsTimeout: true,
    });
    const res = await timeoutHarness.handler.processNextJob();
    expect(res).toMatchObject({
      outcome: "DEFERRED",
      diagnosticCode: "TEXT_EXTRACTION_TIMED_OUT",
    });
    expect(timeoutHarness.retriedJobs).toHaveLength(1);
    expect(timeoutHarness.publishedJobIds).toHaveLength(0);
  });
});
