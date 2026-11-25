import { randomUUID } from "node:crypto";
import {
  type DatabaseClient,
  createAuditRepository,
  createCategoryRepository,
  createDatabaseClient,
  createDocumentPurgeRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createOutboxRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  createUploadPolicyRepository,
  createUploadSessionRepository,
} from "@papyrus/database";
import {
  DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS,
  DOMAIN_DEFAULT_UPLOAD_MAX_BYTES,
  DOMAIN_MAX_SYSTEM_UPLOAD_BYTES,
  DOMAIN_MIN_UPLOAD_MAX_BYTES,
  createUploadLimitsService,
} from "@papyrus/domain";
import {
  createClamAvScanner,
  createExtractedTextIndexRepository,
  createFullContentExtractionPolicy,
  createTesseractOcrEngine,
} from "@papyrus/file-processing";
import {
  type StorageProviderRegistry,
  createStorageProviderRegistry,
  createStorageSecretVault,
} from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
import { createS3StorageProvider } from "@papyrus/storage-s3";
import { createSharePointStorageProvider } from "@papyrus/storage-sharepoint";
import { z } from "zod";
import { createIndexDocumentTextJobHandler } from "./jobs/index-document-text.js";
import { createProcessUploadJobHandler } from "./jobs/process-upload.js";
import { createPurgeDeletedDocumentsHandler } from "./jobs/purge-deleted-documents.js";
import type { WorkerLogger } from "./worker.js";

const standaloneWorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL é obrigatória para o worker."),
  ENCRYPTION_KEY: z.string().trim().min(32, "ENCRYPTION_KEY deve ter pelo menos 32 caracteres."),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(DOMAIN_MIN_UPLOAD_MAX_BYTES)
    .max(DOMAIN_MAX_SYSTEM_UPLOAD_BYTES)
    .default(DOMAIN_DEFAULT_UPLOAD_MAX_BYTES),
  UPLOAD_ALLOWED_EXTENSIONS: z.string().optional(),
  CLAMAV_HOST: z.string().trim().min(1).default("clamav"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  WORKER_PURGE_INTERVAL_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(300_000),
});

function parseAllowedExtensions(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim().length === 0) {
    return [...DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS];
  }
  const items = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  return items.length > 0 ? items : [...DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS];
}

function readNonEmptyString(value: string | number | boolean | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalBoolean(
  value: string | number | boolean | null | undefined,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalPositiveNumber(
  value: string | number | boolean | null | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function createWorkerStorageProviderRegistry(encryptionKey: string): StorageProviderRegistry {
  const secretVault = createStorageSecretVault({ masterKey: encryptionKey });
  const registry = createStorageProviderRegistry({
    secretResolver: secretVault.toStorageSecretResolver(),
  });

  registry.registerFactory("local", ({ connection }) => {
    const rootDirectory = readNonEmptyString(connection.nonSecretConfig.rootDirectory);
    if (!rootDirectory) {
      throw new Error("Local rootDirectory is missing");
    }
    return createLocalStorageProvider({
      rootDirectory,
      maxObjectSizeBytes: readOptionalPositiveNumber(connection.nonSecretConfig.maxObjectSizeBytes),
      minFreeBytes: readOptionalPositiveNumber(connection.nonSecretConfig.minFreeBytes),
    });
  });

  registry.registerFactory("s3", ({ connection, resolvedSecret }) => {
    const endpoint = readNonEmptyString(connection.nonSecretConfig.endpoint);
    const region = readNonEmptyString(connection.nonSecretConfig.region);
    const bucket = readNonEmptyString(connection.nonSecretConfig.bucket);
    const accessKeyId = resolvedSecret?.accessKeyId;
    const secretAccessKey = resolvedSecret?.secretAccessKey;

    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("S3 configuration or decrypted credentials are missing");
    }

    const keyPrefix = readNonEmptyString(connection.nonSecretConfig.keyPrefix) ?? undefined;
    const forcePathStyle = readOptionalBoolean(connection.nonSecretConfig.forcePathStyle, false);
    const rejectUnauthorized = readOptionalBoolean(
      connection.nonSecretConfig.tlsRejectUnauthorized,
      true,
    );
    const allowInsecureHttp = readOptionalBoolean(
      connection.nonSecretConfig.tlsAllowInsecureHttp,
      false,
    );
    const caCertificatePem =
      readNonEmptyString(connection.nonSecretConfig.caCertificatePem) ?? undefined;
    const connectionTimeoutMs =
      readOptionalPositiveNumber(connection.nonSecretConfig.connectionTimeoutMs) ?? 5_000;
    const requestTimeoutMs =
      readOptionalPositiveNumber(connection.nonSecretConfig.requestTimeoutMs) ?? 30_000;

    return createS3StorageProvider({
      endpoint,
      region,
      bucket,
      forcePathStyle,
      ...(keyPrefix ? { keyPrefix } : {}),
      tls: {
        rejectUnauthorized,
        allowInsecureHttp,
        ...(caCertificatePem ? { caCertificatePem } : {}),
      },
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(resolvedSecret.sessionToken ? { sessionToken: resolvedSecret.sessionToken } : {}),
      },
      timeouts: {
        connectionTimeoutMs,
        requestTimeoutMs,
      },
    });
  });

  registry.registerFactory("sharepoint", ({ connection, resolvedSecret }) => {
    const tenantId = readNonEmptyString(connection.nonSecretConfig.tenantId);
    const clientId = readNonEmptyString(connection.nonSecretConfig.clientId);
    const siteUrl = readNonEmptyString(connection.nonSecretConfig.siteUrl);
    const clientSecret = resolvedSecret?.clientSecret;

    if (!tenantId || !clientId || !siteUrl || !clientSecret) {
      throw new Error("SharePoint configuration or decrypted credentials are missing");
    }

    const libraryName = readNonEmptyString(connection.nonSecretConfig.libraryName) ?? undefined;
    const driveId = readNonEmptyString(connection.nonSecretConfig.driveId) ?? undefined;
    const baseFolderPath =
      readNonEmptyString(connection.nonSecretConfig.baseFolderPath) ?? undefined;
    const connectionTimeoutMs =
      readOptionalPositiveNumber(connection.nonSecretConfig.connectionTimeoutMs) ?? 10_000;
    const requestTimeoutMs =
      readOptionalPositiveNumber(connection.nonSecretConfig.requestTimeoutMs) ?? 60_000;

    return createSharePointStorageProvider({
      tenantId,
      clientId,
      siteUrl,
      ...(libraryName ? { libraryName } : {}),
      ...(driveId ? { driveId } : {}),
      ...(baseFolderPath ? { baseFolderPath } : {}),
      timeouts: {
        connectionTimeoutMs,
        requestTimeoutMs,
      },
      credentials: {
        clientSecret,
      },
    });
  });

  return registry;
}

export interface StandaloneWorkerJobs {
  readonly dbClient: DatabaseClient;
  checkDatabase(): Promise<{ readonly healthy: boolean }>;
  checkAntivirus(): Promise<{ readonly healthy: boolean }>;
  start(): void;
  stop(): Promise<void>;
}

export function createStandaloneWorkerJobs(
  logger: WorkerLogger,
  env: Readonly<Record<string, string | undefined>> = process.env,
): StandaloneWorkerJobs {
  const config = standaloneWorkerEnvSchema.parse(env);
  const allowedExtensions = parseAllowedExtensions(config.UPLOAD_ALLOWED_EXTENSIONS);

  const dbClient = createDatabaseClient({
    connectionString: config.DATABASE_URL,
    applicationName: "papyrus-worker",
    logger,
  });

  const { db } = dbClient;
  const transactions = createTransactionManager(db);
  const outboxRepository = createOutboxRepository(db);
  const uploadRepository = createUploadSessionRepository(db);
  const connectionRepository = createStorageConnectionRepository(db);
  const categoryRepository = createCategoryRepository(db);
  const documentRepository = createDocumentRepository(db);
  const documentVersionRepository = createDocumentVersionRepository(db);
  const auditRepository = createAuditRepository(db);
  const uploadPolicyRepository = createUploadPolicyRepository(db);
  const purgeRepository = createDocumentPurgeRepository(db);

  const storageRegistry = createWorkerStorageProviderRegistry(config.ENCRYPTION_KEY);

  const textExtractionPolicy = createFullContentExtractionPolicy({
    enabled: true,
    postgresFtsConfig: "portuguese",
    ocr: {
      enabled: true,
    },
  });
  const ocrEngine = createTesseractOcrEngine();
  const extractedTextIndexRepository = createExtractedTextIndexRepository({
    executor: {
      query: <T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]) =>
        dbClient.pool.query<T>(sqlText, params ? [...params] : undefined),
    },
    policy: textExtractionPolicy,
  });

  const uploadLimitsService = createUploadLimitsService({
    repository: uploadPolicyRepository,
    transactions,
    audit: auditRepository,
    systemMaxUploadBytes: config.UPLOAD_MAX_BYTES,
    defaultAllowedExtensions: allowedExtensions,
  });

  const scanner = createClamAvScanner({
    transport: "tcp",
    host: config.CLAMAV_HOST,
    port: config.CLAMAV_PORT,
    timeoutMs: config.CLAMAV_TIMEOUT_MS,
  });

  const processUploadHandler = createProcessUploadJobHandler({
    outbox: outboxRepository,
    uploads: uploadRepository,
    connections: connectionRepository,
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    audit: auditRepository,
    transactions,
    storageRegistry,
    scanner,
    maxUploadBytes: config.UPLOAD_MAX_BYTES,
    resolveUploadPolicy: async (organizationId) => {
      const effective = await uploadLimitsService.getEffectivePolicy(organizationId);
      return {
        maxFileSizeBytes: effective.maxFileSizeBytes,
        allowedMimeTypes: effective.allowedMimeTypes,
        enforceDeclaredExtensionMatch: effective.enforceDeclaredExtensionMatch,
      };
    },
  });

  const indexDocumentTextHandler = createIndexDocumentTextJobHandler({
    outbox: outboxRepository,
    uploads: uploadRepository,
    connections: connectionRepository,
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    categories: categoryRepository,
    audit: auditRepository,
    transactions,
    storageRegistry,
    policy: textExtractionPolicy,
    indexRepository: extractedTextIndexRepository,
    ocrEngine,
  });

  const purgeHandler = createPurgeDeletedDocumentsHandler({
    store: purgeRepository,
    connections: connectionRepository,
    storageRegistry,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  let running = false;
  let uploadLoopPromise: Promise<void> | null = null;
  let purgeTimer: ReturnType<typeof setInterval> | null = null;
  let purgeInFlight: Promise<void> | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const runUploadLoop = async (): Promise<void> => {
    logger.info("Worker upload and indexing processing loop started", {
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      clamavPort: config.CLAMAV_PORT,
    });

    while (running) {
      let processedAnyJob = false;

      try {
        const result = await processUploadHandler.processNextJob();
        if (result.outcome !== "NO_JOB") {
          processedAnyJob = true;
          logger.info("Processed upload job", {
            outcome: result.outcome,
            jobId: result.jobId,
            fileObjectId: result.fileObjectId,
          });
        }
      } catch (error) {
        logger.error("Error while processing upload job", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!running) {
        break;
      }

      try {
        const indexingResult = await indexDocumentTextHandler.processNextJob();
        if (indexingResult.outcome !== "NO_JOB") {
          processedAnyJob = true;
          logger.info("Processed document text indexing job", {
            outcome: indexingResult.outcome,
            jobId: indexingResult.jobId,
            documentVersionId: indexingResult.documentVersionId,
          });
        }
      } catch (error) {
        logger.error("Error while processing document text indexing job", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (processedAnyJob) {
        continue;
      }

      if (!running) {
        break;
      }
      await sleep(config.WORKER_POLL_INTERVAL_MS);
    }
  };

  const triggerPurgeCycle = (): void => {
    if (!running || purgeInFlight) {
      return;
    }
    purgeInFlight = purgeHandler
      .runPurgeCycle()
      .then((report) => {
        if (report.purgedDocumentIds.length > 0 || report.purgedFileObjectIds.length > 0) {
          logger.info("Completed deleted documents purge cycle", {
            purgedDocuments: report.purgedDocumentIds.length,
            purgedFiles: report.purgedFileObjectIds.length,
          });
        }
      })
      .catch((error: unknown) => {
        logger.error("Error during deleted documents purge cycle", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        purgeInFlight = null;
      });
  };

  return {
    dbClient,

    async checkDatabase(): Promise<{ readonly healthy: boolean }> {
      const outcome = await dbClient.checkHealth();
      return { healthy: outcome.healthy };
    },

    async checkAntivirus(): Promise<{ readonly healthy: boolean }> {
      const outcome = await scanner.checkHealth();
      return { healthy: outcome.healthy };
    },

    start(): void {
      if (running) {
        return;
      }
      running = true;
      uploadLoopPromise = runUploadLoop();
      purgeTimer = setInterval(triggerPurgeCycle, config.WORKER_PURGE_INTERVAL_MS);
      purgeTimer.unref();
    },

    async stop(): Promise<void> {
      running = false;
      if (purgeTimer) {
        clearInterval(purgeTimer);
        purgeTimer = null;
      }
      if (uploadLoopPromise) {
        await uploadLoopPromise;
        uploadLoopPromise = null;
      }
      if (purgeInFlight) {
        await purgeInFlight;
      }
      await dbClient.close();
    },
  };
}
