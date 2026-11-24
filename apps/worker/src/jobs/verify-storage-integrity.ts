import {
  type AuditRepositoryPort,
  type FileObjectStatus,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  createAuditWriter,
} from "@papyrus/domain";
import { ChecksumValidationError, verifyStreamSha256 } from "@papyrus/file-processing";
import {
  type StorageProvider,
  type StorageProviderRegistry,
  sanitizeStorageErrorMessage,
} from "@papyrus/storage-core";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_SCAN_BATCH_PAGES = 1_000;

export type StorageIntegrityFindingStatus =
  | "OK"
  | "MISSING"
  | "SIZE_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "PROVIDER_ERROR";

export interface StorageObjectReferenceRecord {
  readonly fileObjectId: string;
  readonly organizationId: string;
  readonly storageConnectionId: string;
  readonly objectKey: string;
  readonly checksumSha256: string;
  readonly expectedSizeBytes: number;
  readonly status: FileObjectStatus;
}

export interface StorageIntegrityFinding {
  readonly fileObjectId: string;
  readonly organizationId: string;
  readonly storageConnectionId: string;
  readonly objectKey: string;
  readonly status: StorageIntegrityFindingStatus;
  readonly checksumVerified: boolean;
  readonly expectedSizeBytes: number;
  readonly actualSizeBytes: number | null;
  readonly expectedChecksumSha256: string;
  readonly actualChecksumSha256: string | null;
  readonly detail: string | null;
}

export interface UnrecognizedStorageObjectFinding {
  readonly organizationId: string;
  readonly storageConnectionId: string;
  readonly objectKey: string;
}

export interface StorageIntegrityStorePort {
  listReferencedObjects(params: {
    readonly organizationId?: string | undefined;
    readonly storageConnectionId?: string | undefined;
    readonly fileObjectId?: string | undefined;
    readonly afterFileObjectId?: string | undefined;
    readonly limit: number;
  }): Promise<readonly StorageObjectReferenceRecord[]>;
  findKnownObjectKeys?(params: {
    readonly organizationId: string;
    readonly storageConnectionId: string;
    readonly objectKeys: readonly string[];
  }): Promise<ReadonlySet<string>>;
}

export interface UnrecognizedObjectListPort {
  listObjectKeys(params: {
    readonly connection: StorageConnectionEntity;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export interface VerifyStorageIntegrityDependencies {
  readonly store: StorageIntegrityStorePort;
  readonly connections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly unrecognizedObjectScanner?: UnrecognizedObjectListPort | undefined;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface VerifyStorageIntegrityRunOptions {
  readonly organizationId?: string | undefined;
  readonly storageConnectionId?: string | undefined;
  readonly fileObjectId?: string | undefined;
  readonly verifyChecksum?: boolean | undefined;
  readonly scanUnrecognizedObjects?: boolean | undefined;
  readonly actorUserId?: string | null | undefined;
  readonly batchSize?: number | undefined;
}

export interface VerifyStorageIntegrityReport {
  readonly checkedAt: string;
  readonly verifyChecksum: boolean;
  readonly scannedCount: number;
  readonly okCount: number;
  readonly missingObjects: readonly StorageIntegrityFinding[];
  readonly sizeMismatchObjects: readonly StorageIntegrityFinding[];
  readonly checksumMismatchObjects: readonly StorageIntegrityFinding[];
  readonly providerErrorObjects: readonly StorageIntegrityFinding[];
  readonly unrecognizedObjects: readonly UnrecognizedStorageObjectFinding[];
  readonly findings: readonly StorageIntegrityFinding[];
}

export interface VerifyStorageIntegrityHandler {
  runIntegrityCheck(
    options?: VerifyStorageIntegrityRunOptions,
  ): Promise<VerifyStorageIntegrityReport>;
  verifyObjectChecksumOnDemand(
    fileObjectId: string,
    actorUserId?: string | null,
  ): Promise<StorageIntegrityFinding | null>;
}

function clampBatchSize(rawSize: number | undefined): number {
  const candidate = rawSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(candidate) || candidate < 1) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.min(candidate, MAX_BATCH_SIZE);
}

async function resolveConnectionProvider(
  connectionId: string,
  organizationId: string,
  connectionsRepo: StorageConnectionRepositoryPort,
  storageRegistry: StorageProviderRegistry,
  cache: Map<
    string,
    { readonly connection: StorageConnectionEntity; readonly provider: StorageProvider }
  >,
): Promise<{ readonly connection: StorageConnectionEntity; readonly provider: StorageProvider }> {
  const cacheKey = `${organizationId}:${connectionId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const connection = await connectionsRepo.findById(connectionId);
  if (!connection || connection.organizationId !== organizationId) {
    throw new Error("Conexão de armazenamento não encontrada ou fora da organização.");
  }

  const provider = await storageRegistry.resolveProvider(connection, { allowInactive: true });
  const entry = { connection, provider };
  cache.set(cacheKey, entry);
  return entry;
}

async function verifySingleReference(params: {
  readonly ref: StorageObjectReferenceRecord;
  readonly verifyChecksum: boolean;
  readonly provider: StorageProvider;
}): Promise<StorageIntegrityFinding> {
  const { ref, verifyChecksum, provider } = params;
  const head = await provider.headObject({ value: ref.objectKey });

  if (!head) {
    return {
      fileObjectId: ref.fileObjectId,
      organizationId: ref.organizationId,
      storageConnectionId: ref.storageConnectionId,
      objectKey: ref.objectKey,
      status: "MISSING",
      checksumVerified: false,
      expectedSizeBytes: ref.expectedSizeBytes,
      actualSizeBytes: null,
      expectedChecksumSha256: ref.checksumSha256,
      actualChecksumSha256: null,
      detail: "Objeto binário ausente no conector de armazenamento.",
    };
  }

  if (head.contentLength !== ref.expectedSizeBytes) {
    return {
      fileObjectId: ref.fileObjectId,
      organizationId: ref.organizationId,
      storageConnectionId: ref.storageConnectionId,
      objectKey: ref.objectKey,
      status: "SIZE_MISMATCH",
      checksumVerified: false,
      expectedSizeBytes: ref.expectedSizeBytes,
      actualSizeBytes: head.contentLength,
      expectedChecksumSha256: ref.checksumSha256,
      actualChecksumSha256: null,
      detail: "Tamanho do objeto armazenado diverge do tamanho registrado no banco.",
    };
  }

  if (!verifyChecksum) {
    return {
      fileObjectId: ref.fileObjectId,
      organizationId: ref.organizationId,
      storageConnectionId: ref.storageConnectionId,
      objectKey: ref.objectKey,
      status: "OK",
      checksumVerified: false,
      expectedSizeBytes: ref.expectedSizeBytes,
      actualSizeBytes: head.contentLength,
      expectedChecksumSha256: ref.checksumSha256,
      actualChecksumSha256: null,
      detail: null,
    };
  }

  const download = await provider.getObject({ value: ref.objectKey });
  try {
    const verification = await verifyStreamSha256(download.body, {
      expectedChecksumSha256: ref.checksumSha256,
      expectedSizeBytes: ref.expectedSizeBytes,
      allowEmpty: true,
      throwOnMismatch: false,
    });

    if (!verification.sizeMatched) {
      return {
        fileObjectId: ref.fileObjectId,
        organizationId: ref.organizationId,
        storageConnectionId: ref.storageConnectionId,
        objectKey: ref.objectKey,
        status: "SIZE_MISMATCH",
        checksumVerified: true,
        expectedSizeBytes: ref.expectedSizeBytes,
        actualSizeBytes: verification.bytesProcessed,
        expectedChecksumSha256: ref.checksumSha256,
        actualChecksumSha256: verification.actualChecksumSha256,
        detail: "Tamanho real do fluxo binário diverge do registrado no banco.",
      };
    }

    if (!verification.checksumMatched) {
      return {
        fileObjectId: ref.fileObjectId,
        organizationId: ref.organizationId,
        storageConnectionId: ref.storageConnectionId,
        objectKey: ref.objectKey,
        status: "CHECKSUM_MISMATCH",
        checksumVerified: true,
        expectedSizeBytes: ref.expectedSizeBytes,
        actualSizeBytes: verification.bytesProcessed,
        expectedChecksumSha256: ref.checksumSha256,
        actualChecksumSha256: verification.actualChecksumSha256,
        detail: "Checksum SHA-256 calculado diverge do registrado no banco.",
      };
    }

    return {
      fileObjectId: ref.fileObjectId,
      organizationId: ref.organizationId,
      storageConnectionId: ref.storageConnectionId,
      objectKey: ref.objectKey,
      status: "OK",
      checksumVerified: true,
      expectedSizeBytes: ref.expectedSizeBytes,
      actualSizeBytes: verification.bytesProcessed,
      expectedChecksumSha256: ref.checksumSha256,
      actualChecksumSha256: verification.actualChecksumSha256,
      detail: null,
    };
  } catch (error) {
    if (error instanceof ChecksumValidationError) {
      return {
        fileObjectId: ref.fileObjectId,
        organizationId: ref.organizationId,
        storageConnectionId: ref.storageConnectionId,
        objectKey: ref.objectKey,
        status: error.code === "SIZE_MISMATCH" ? "SIZE_MISMATCH" : "CHECKSUM_MISMATCH",
        checksumVerified: true,
        expectedSizeBytes: ref.expectedSizeBytes,
        actualSizeBytes: null,
        expectedChecksumSha256: ref.checksumSha256,
        actualChecksumSha256: null,
        detail: error.message,
      };
    }
    throw error;
  } finally {
    if (!download.body.destroyed) {
      download.body.destroy();
    }
  }
}

/**
 * Verifies consistency between database file references and actual objects stored in providers
 * using `headObject` checks and optional streaming SHA-256 checksum verification on demand.
 * Never deletes unrecognized objects automatically; reports and audits anomalies safely.
 */
export function createVerifyStorageIntegrityHandler(
  deps: VerifyStorageIntegrityDependencies,
): VerifyStorageIntegrityHandler {
  const auditWriter = createAuditWriter({ repository: deps.audit });
  const nowFn = deps.now ?? (() => new Date());

  const runIntegrityCheck = async (
    options: VerifyStorageIntegrityRunOptions = {},
  ): Promise<VerifyStorageIntegrityReport> => {
    const verifyChecksum = options.verifyChecksum === true;
    const scanUnrecognized = options.scanUnrecognizedObjects === true;
    const batchSize = clampBatchSize(options.batchSize ?? deps.batchSize);
    const actorUserId = options.actorUserId ?? null;
    const checkedAt = nowFn().toISOString();

    const findings: StorageIntegrityFinding[] = [];
    const missingObjects: StorageIntegrityFinding[] = [];
    const sizeMismatchObjects: StorageIntegrityFinding[] = [];
    const checksumMismatchObjects: StorageIntegrityFinding[] = [];
    const providerErrorObjects: StorageIntegrityFinding[] = [];
    const unrecognizedObjects: UnrecognizedStorageObjectFinding[] = [];

    const providerCache = new Map<
      string,
      { readonly connection: StorageConnectionEntity; readonly provider: StorageProvider }
    >();
    const checkedConnections = new Map<string, StorageConnectionEntity>();

    let okCount = 0;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_SCAN_BATCH_PAGES; page += 1) {
      const batch = await deps.store.listReferencedObjects({
        organizationId: options.organizationId,
        storageConnectionId: options.storageConnectionId,
        fileObjectId: options.fileObjectId,
        afterFileObjectId: cursor,
        limit: batchSize,
      });

      if (batch.length === 0) {
        break;
      }

      for (const ref of batch) {
        const requestId = deps.generateId();
        let finding: StorageIntegrityFinding;

        try {
          const { connection, provider } = await resolveConnectionProvider(
            ref.storageConnectionId,
            ref.organizationId,
            deps.connections,
            deps.storageRegistry,
            providerCache,
          );
          checkedConnections.set(connection.id, connection);

          finding = await verifySingleReference({
            ref,
            verifyChecksum,
            provider,
          });
        } catch (error) {
          const safeError = sanitizeStorageErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
          finding = {
            fileObjectId: ref.fileObjectId,
            organizationId: ref.organizationId,
            storageConnectionId: ref.storageConnectionId,
            objectKey: ref.objectKey,
            status: "PROVIDER_ERROR",
            checksumVerified: false,
            expectedSizeBytes: ref.expectedSizeBytes,
            actualSizeBytes: null,
            expectedChecksumSha256: ref.checksumSha256,
            actualChecksumSha256: null,
            detail: safeError,
          };
        }

        findings.push(finding);

        if (finding.status === "OK") {
          okCount += 1;
          if (verifyChecksum && options.fileObjectId) {
            await auditWriter.write({
              organizationId: ref.organizationId,
              actorUserId,
              action: "STORAGE_OBJECT_CHECKSUM_VERIFIED",
              resourceType: "FILE_OBJECT",
              resourceId: ref.fileObjectId,
              result: "SUCCESS",
              requestId,
              metadata: {
                storageConnectionId: ref.storageConnectionId,
                status: finding.status,
              },
            });
          }
          continue;
        }

        if (finding.status === "MISSING") {
          missingObjects.push(finding);
        } else if (finding.status === "SIZE_MISMATCH") {
          sizeMismatchObjects.push(finding);
        } else if (finding.status === "CHECKSUM_MISMATCH") {
          checksumMismatchObjects.push(finding);
        } else {
          providerErrorObjects.push(finding);
        }

        await auditWriter.write({
          organizationId: ref.organizationId,
          actorUserId,
          action: "STORAGE_INTEGRITY_ANOMALY_DETECTED",
          resourceType: "FILE_OBJECT",
          resourceId: ref.fileObjectId,
          result: "FAILURE",
          requestId,
          metadata: {
            storageConnectionId: ref.storageConnectionId,
            findingStatus: finding.status,
            checksumVerified: finding.checksumVerified,
          },
        });
      }

      if (options.fileObjectId || batch.length < batchSize) {
        break;
      }
      const last = batch[batch.length - 1];
      if (!last || last.fileObjectId === cursor) {
        break;
      }
      cursor = last.fileObjectId;
    }

    if (scanUnrecognized && deps.unrecognizedObjectScanner && deps.store.findKnownObjectKeys) {
      if (options.storageConnectionId && !checkedConnections.has(options.storageConnectionId)) {
        const directConn = await deps.connections.findById(options.storageConnectionId);
        if (
          directConn &&
          (!options.organizationId || directConn.organizationId === options.organizationId)
        ) {
          checkedConnections.set(directConn.id, directConn);
        }
      }

      for (const connection of checkedConnections.values()) {
        const candidateKeys = await deps.unrecognizedObjectScanner.listObjectKeys({
          connection,
          limit: batchSize,
        });
        if (candidateKeys.length === 0) {
          continue;
        }

        const knownKeys = await deps.store.findKnownObjectKeys({
          organizationId: connection.organizationId,
          storageConnectionId: connection.id,
          objectKeys: candidateKeys,
        });

        for (const objectKey of candidateKeys) {
          if (knownKeys.has(objectKey)) {
            continue;
          }

          unrecognizedObjects.push({
            organizationId: connection.organizationId,
            storageConnectionId: connection.id,
            objectKey,
          });

          await auditWriter.write({
            organizationId: connection.organizationId,
            actorUserId,
            action: "STORAGE_INTEGRITY_UNRECOGNIZED_DETECTED",
            resourceType: "STORAGE_CONNECTION",
            resourceId: connection.id,
            result: "FAILURE",
            requestId: deps.generateId(),
            metadata: {
              objectKey,
              automaticallyDeleted: false,
            },
          });
        }
      }
    }

    return {
      checkedAt,
      verifyChecksum,
      scannedCount: findings.length,
      okCount,
      missingObjects,
      sizeMismatchObjects,
      checksumMismatchObjects,
      providerErrorObjects,
      unrecognizedObjects,
      findings,
    };
  };

  return {
    runIntegrityCheck,

    async verifyObjectChecksumOnDemand(
      fileObjectId: string,
      actorUserId: string | null = null,
    ): Promise<StorageIntegrityFinding | null> {
      const report = await runIntegrityCheck({
        fileObjectId,
        verifyChecksum: true,
        actorUserId,
      });
      return report.findings[0] ?? null;
    },
  };
}
