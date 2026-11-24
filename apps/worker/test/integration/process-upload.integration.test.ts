import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createOutboxRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTransactionManager,
  createUploadSessionRepository,
  documents,
  fileObjects,
  organizations,
  outboxEvents,
  storageConnections,
  users,
} from "@papyrus/database";
import {
  createFinalizeUploadService,
  createStorageRouterService,
  createUploadSessionService,
} from "@papyrus/domain";
import { createClamAvScanner } from "@papyrus/file-processing";
import { createStorageProviderRegistry } from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProcessUploadJobHandler } from "../../src/jobs/process-upload.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function startConfigurableClamdMock(decide: (payload: Buffer) => string): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let commandParsed = false;
      const chunks: Buffer[] = [];
      let awaitingLen = true;
      let expectedLen = 0;

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        if (!commandParsed) {
          const nul = buffer.indexOf(0);
          if (nul < 0) {
            return;
          }
          const cmd = buffer.subarray(0, nul).toString("ascii");
          buffer = buffer.subarray(nul + 1);
          commandParsed = true;
          if (cmd === "zPING") {
            socket.end("PONG\0");
            return;
          }
        }

        while (true) {
          if (awaitingLen) {
            if (buffer.length < 4) {
              break;
            }
            expectedLen = buffer.readUInt32BE(0);
            buffer = buffer.subarray(4);
            if (expectedLen === 0) {
              const payload = Buffer.concat(chunks);
              socket.end(decide(payload));
              break;
            }
            awaitingLen = false;
          } else {
            if (buffer.length < expectedLen) {
              break;
            }
            chunks.push(buffer.subarray(0, expectedLen));
            buffer = buffer.subarray(expectedLen);
            awaitingLen = true;
          }
        }
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Invalid clamd mock address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

describe("Worker upload processing job integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  const tempDirs: string[] = [];

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
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("consumes persisted outbox jobs, executes checksum + MIME + ClamAV checks, approves valid files, rejects threats, and fails closed when scanner is unavailable", async () => {
    const db = drizzle(pool);
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "papyrus-worker-storage-"));
    tempDirs.push(localRoot);

    const orgId = randomUUID();
    const userId = randomUUID();
    const categoryId = randomUUID();
    const docId = randomUUID();
    const connId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Worker Integration",
      slug: "org-worker-integration",
    });

    await db.insert(users).values({
      id: userId,
      organizationId: orgId,
      email: "worker@test.invalid",
      fullName: "Colaborador Worker",
      passwordHash: "$argon2id$v=19$m=8192,t=2,p=1$fakeSalt$fakeHash",
      status: "ACTIVE",
    });

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Documentos Gerais",
    });

    await db.insert(storageConnections).values({
      id: connId,
      organizationId: orgId,
      name: "Local Worker Storage",
      kind: "local",
      isDefault: true,
      status: "ACTIVE",
      nonSecretConfig: { rootDirectory: localRoot },
    });

    await db.insert(documents).values({
      id: docId,
      organizationId: orgId,
      title: "Contrato Empresarial",
      categoryId,
      ownerUserId: userId,
      status: "DRAFT",
      version: 1,
      createdBy: userId,
      updatedBy: userId,
    });

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", ({ connection }) => {
      const rootDirectory = String(connection.nonSecretConfig.rootDirectory ?? "");
      return createLocalStorageProvider({ rootDirectory });
    });

    const uploadRepo = createUploadSessionRepository(db);
    const connectionRepo = createStorageConnectionRepository(db);
    const docRepo = createDocumentRepository(db);
    const versionRepo = createDocumentVersionRepository(db);
    const outboxRepo = createOutboxRepository(db);
    const auditRepo = createAuditRepository(db);
    const txManager = createTransactionManager(db);

    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepo,
      documents: docRepo,
      storageRouter: createStorageRouterService({
        connections: connectionRepo,
        routingRules: createStorageRoutingRuleRepository(db),
      }),
      transactions: txManager,
      audit: auditRepo,
      generateId: () => randomUUID(),
    });

    const connEntity = await connectionRepo.findById(connId);
    if (!connEntity) {
      throw new Error("Expected storage connection");
    }
    const localProvider = await storageRegistry.resolveProvider(connEntity);

    const finalizeService = createFinalizeUploadService({
      uploads: uploadRepo,
      objectVerifier: {
        async verifyUploadedObject({ storageConnectionId, objectKey }) {
          const conn = await connectionRepo.findById(storageConnectionId);
          if (!conn) return null;
          const prov = await storageRegistry.resolveProvider(conn);
          const head = await prov.headObject({ value: objectKey });
          if (!head) return null;
          return {
            objectKey: head.key.value,
            contentLength: head.contentLength,
            contentType: head.contentType,
            checksumSha256: head.checksumSha256,
          };
        },
      },
      transactions: txManager,
      audit: auditRepo,
      documents: docRepo,
      documentVersions: versionRepo,
      processingQueue: outboxRepo.asUploadProcessingQueue(),
      generateId: () => randomUUID(),
    });

    let clockOffsetMs = 0;
    const clamdServer = await startConfigurableClamdMock((payload) => {
      if (payload.includes("EICAR_INFECTED_MARKER")) {
        return "stream: Eicar-Test-Signature FOUND\0";
      }
      return "stream: OK\0";
    });

    try {
      const activeScanner = createClamAvScanner({
        transport: "tcp",
        host: "127.0.0.1",
        port: clamdServer.port,
        timeoutMs: 5_000,
      });

      const workerHandler = createProcessUploadJobHandler({
        outbox: outboxRepo,
        uploads: uploadRepo,
        connections: connectionRepo,
        documents: docRepo,
        documentVersions: versionRepo,
        audit: auditRepo,
        transactions: txManager,
        storageRegistry,
        scanner: activeScanner,
        maxAttempts: 2,
        retryDelayMs: 500,
        now: () => new Date(Date.now() + clockOffsetMs),
      });

      const enqueueUploadedFile = async (params: {
        readonly idempotencyKey: string;
        readonly originalFileName: string;
        readonly declaredContentType: string;
        readonly content: Buffer;
      }) => {
        const checksum = sha256Hex(params.content);
        const created = await uploadSessionService.createSession({
          organizationId: orgId,
          userId,
          requestId: randomUUID(),
          documentId: docId,
          originalFileName: params.originalFileName,
          declaredSizeBytes: params.content.length,
          declaredContentType: params.declaredContentType,
          declaredChecksumSha256: checksum,
          idempotencyKey: params.idempotencyKey,
        });

        await localProvider.putObject({
          key: { value: created.fileObject.objectKey },
          body: Readable.from([params.content]),
          metadata: {
            contentType: params.declaredContentType,
            contentLength: params.content.length,
            checksumSha256: checksum,
          },
        });

        const finalized = await finalizeService.finalizeUpload({
          organizationId: orgId,
          actorUserId: userId,
          requestId: randomUUID(),
          sessionId: created.session.id,
          expectedChecksumSha256: checksum,
          documentId: docId,
        });

        return finalized;
      };

      // 1. Valid PDF -> APPROVED -> fileObject AVAILABLE + document.currentVersionId activated
      const validPdf = Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
        "utf8",
      );
      const validFinalized = await enqueueUploadedFile({
        idempotencyKey: "worker-valid-pdf-1",
        originalFileName: "contrato-v1.pdf",
        declaredContentType: "application/pdf",
        content: validPdf,
      });

      expect(validFinalized.fileObject.status).toBe("QUARANTINED");
      const docBeforeWorker = await docRepo.findById(docId);
      expect(docBeforeWorker?.currentVersionId).toBeNull();

      const validOutcome = await workerHandler.processNextJob();
      expect(validOutcome).toMatchObject({
        outcome: "APPROVED",
        fileObjectId: validFinalized.fileObject.id,
      });

      const [fileRow1] = await db
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, validFinalized.fileObject.id));
      expect(fileRow1?.status).toBe("AVAILABLE");
      expect(fileRow1?.rejectionReason).toBeNull();

      const docAfterValid = await docRepo.findById(docId);
      expect(docAfterValid?.currentVersionId).toBe(validFinalized.documentVersion?.id);

      // 2. Disguised Windows PE executable with .pdf extension -> REJECTED cleanly (currentVersionId unchanged!)
      const disguisedExe = Buffer.from("MZ\x90\x00\x03\x00\x00\x00FakeExecutable", "latin1");
      const spoofFinalized = await enqueueUploadedFile({
        idempotencyKey: "worker-spoof-exe-2",
        originalFileName: "aditivo-malicioso.pdf",
        declaredContentType: "application/pdf",
        content: disguisedExe,
      });

      const spoofOutcome = await workerHandler.processNextJob();
      expect(spoofOutcome).toMatchObject({
        outcome: "REJECTED",
        fileObjectId: spoofFinalized.fileObject.id,
      });

      const [fileRow2] = await db
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, spoofFinalized.fileObject.id));
      expect(fileRow2?.status).toBe("REJECTED");
      expect(fileRow2?.rejectionReason).toBeTruthy();
      expect(fileRow2?.rejectionReason).not.toContain("MZ");
      expect((await docRepo.findById(docId))?.currentVersionId).toBe(
        validFinalized.documentVersion?.id,
      );

      // 3. ClamAV detects malware signature -> REJECTED without leaking signature in rejectionReason
      const infectedPdf = Buffer.from(
        "%PDF-1.7\n1 0 obj\n(EICAR_INFECTED_MARKER)\nendobj\n%%EOF\n",
        "utf8",
      );
      const infectedFinalized = await enqueueUploadedFile({
        idempotencyKey: "worker-infected-3",
        originalFileName: "contrato-infectado.pdf",
        declaredContentType: "application/pdf",
        content: infectedPdf,
      });

      const infectedOutcome = await workerHandler.processNextJob();
      expect(infectedOutcome).toMatchObject({
        outcome: "REJECTED",
        fileObjectId: infectedFinalized.fileObject.id,
      });

      const [fileRow3] = await db
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, infectedFinalized.fileObject.id));
      expect(fileRow3?.status).toBe("REJECTED");
      expect(fileRow3?.rejectionReason).toBeTruthy();
      expect(fileRow3?.rejectionReason).not.toContain("Eicar");
      expect((await docRepo.findById(docId))?.currentVersionId).toBe(
        validFinalized.documentVersion?.id,
      );

      // 4. Storage tampering after finalization -> worker checksum verification rejects object
      const originalGoodBytes = Buffer.from("%PDF-1.7\n%clean bytes\n%%EOF\n", "utf8");
      const tamperedFinalized = await enqueueUploadedFile({
        idempotencyKey: "worker-tampered-4",
        originalFileName: "contrato-adulterado.pdf",
        declaredContentType: "application/pdf",
        content: originalGoodBytes,
      });
      // Mutate object directly on disk without updating DB checksum (same length, different bytes)
      const storedPath = path.join(localRoot, tamperedFinalized.fileObject.objectKey);
      await writeFile(storedPath, Buffer.from("%PDF-1.7\n%Xlean bytes\n%%EOF\n", "utf8"));

      const tamperedOutcome = await workerHandler.processNextJob();
      expect(tamperedOutcome).toMatchObject({
        outcome: "REJECTED",
        fileObjectId: tamperedFinalized.fileObject.id,
      });
      const [fileRow4] = await db
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, tamperedFinalized.fileObject.id));
      expect(fileRow4?.status).toBe("REJECTED");
      expect((await docRepo.findById(docId))?.currentVersionId).toBe(
        validFinalized.documentVersion?.id,
      );

      // 5. Antivirus daemon down -> FAIL CLOSED: stays QUARANTINED, retries once, then terminal FAILED job
      const unavailablePdf = Buffer.from("%PDF-1.7\n%scanner-offline\n%%EOF\n", "utf8");
      const offlineFinalized = await enqueueUploadedFile({
        idempotencyKey: "worker-scanner-offline-5",
        originalFileName: "sem-scanner.pdf",
        declaredContentType: "application/pdf",
        content: unavailablePdf,
      });

      const deadServer = await startConfigurableClamdMock(() => "stream: OK\0");
      const closedPort = deadServer.port;
      await deadServer.close();

      const offlineWorker = createProcessUploadJobHandler({
        outbox: outboxRepo,
        uploads: uploadRepo,
        connections: connectionRepo,
        documents: docRepo,
        documentVersions: versionRepo,
        audit: auditRepo,
        transactions: txManager,
        storageRegistry,
        scanner: createClamAvScanner({
          transport: "tcp",
          host: "127.0.0.1",
          port: closedPort,
          timeoutMs: 1_000,
        }),
        maxAttempts: 2,
        retryDelayMs: 500,
        now: () => new Date(Date.now() + clockOffsetMs),
      });

      const attempt1 = await offlineWorker.processNextJob();
      expect(attempt1).toMatchObject({
        outcome: "DEFERRED",
        fileObjectId: offlineFinalized.fileObject.id,
        failedPermanently: false,
      });

      // Must remain QUARANTINED and outbox job still PENDING before backoff elapsed
      expect(await offlineWorker.processNextJob()).toEqual({ outcome: "NO_JOB" });
      const [fileRow5Mid] = await db
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, offlineFinalized.fileObject.id));
      expect(fileRow5Mid?.status).toBe("QUARANTINED");

      // Advance clock past backoff -> 2nd attempt hits maxAttempts -> outbox job FAILED, object STILL QUARANTINED!
      clockOffsetMs += 1_000;
      const attempt2 = await offlineWorker.processNextJob();
      expect(attempt2).toMatchObject({
        outcome: "DEFERRED",
        fileObjectId: offlineFinalized.fileObject.id,
        failedPermanently: true,
      });

      const [fileRow5End] = await db
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, offlineFinalized.fileObject.id));
      expect(fileRow5End?.status).toBe("QUARANTINED");

      const [failedOutboxRow] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, offlineFinalized.session.id));
      expect(failedOutboxRow?.status).toBe("FAILED");
      expect(failedOutboxRow?.attempts).toBe(2);

      // Audit events recorded for approvals, rejections, and deferred scan
      const orgAuditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.organizationId, orgId));
      const actions = new Set(orgAuditRows.map((r) => r.action));
      expect(actions.has("UPLOAD_FILE_AVAILABLE")).toBe(true);
      expect(actions.has("UPLOAD_FILE_REJECTED")).toBe(true);
      expect(actions.has("UPLOAD_SCAN_DEFERRED")).toBe(true);
    } finally {
      await clamdServer.close();
    }
  }, 120_000);
});
