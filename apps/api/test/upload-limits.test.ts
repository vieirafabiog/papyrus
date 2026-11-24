import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import type {
  AuthorizationRepository,
  LoadedAuthorizationSubject,
  OutboxJobRecord,
  OutboxRepository,
} from "@papyrus/database";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  type CreateDocumentVersionInput,
  type DocumentEntity,
  type DocumentRepositoryPort,
  type DocumentVersionEntity,
  type DocumentVersionRepositoryPort,
  type FileObjectEntity,
  type FinalizeUploadToQuarantineInput,
  type MarkFileObjectProcessedInput,
  type MarkUploadReceivedInput,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  type StorageRoutingRuleRepositoryPort,
  type StoredUploadLimitsRecord,
  type TransactionContext,
  type TransactionManagerPort,
  type UploadLimitsConfig,
  type UploadPolicyRepositoryPort,
  type UploadSessionEntity,
  type UploadSessionRepositoryPort,
  createStorageRouterService,
  createUploadLimitsService,
  createUploadSessionService,
} from "@papyrus/domain";
import type { AntivirusScannerPort } from "@papyrus/file-processing";
import { createStorageProviderRegistry } from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
import { afterAll, describe, expect, it } from "vitest";
import { createProcessUploadJobHandler } from "../../worker/src/jobs/process-upload.js";
import { buildApp } from "../src/app.js";
import { type AuthCredentialRecord, createAuthService } from "../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../src/plugins/security.js";

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function createUploadLimitsHarness(localRoot: string, tempRoot: string) {
  const now = new Date("2026-11-21T12:00:00.000Z");
  const nowIso = now.toISOString();
  const orgId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  const adminRoleId = randomUUID();
  const viewerRoleId = randomUUID();
  const localConnId = randomUUID();

  let storedLimits: StoredUploadLimitsRecord = {
    organizationId: orgId,
    maxFileSizeBytes: null,
    allowedExtensions: null,
    enforceDeclaredExtensionMatch: null,
    updatedAt: nowIso,
  };

  const sessionStoreMap = new Map<string, StoredSessionRecord>();
  const uploadSessions = new Map<string, UploadSessionEntity>();
  const fileObjects = new Map<string, FileObjectEntity>();
  const versions = new Map<string, DocumentVersionEntity>();
  const connections = new Map<string, StorageConnectionEntity>();
  const outboxJobs = new Map<string, OutboxJobRecord>();
  const auditLogs: AuditEventRecord[] = [];
  const usersByEmail = new Map<string, AuthCredentialRecord>();
  const subjectsByUserId = new Map<string, LoadedAuthorizationSubject>();

  connections.set(localConnId, {
    id: localConnId,
    organizationId: orgId,
    name: "Local Primary",
    kind: "local",
    isDefault: true,
    status: "ACTIVE",
    nonSecretConfig: { rootDirectory: localRoot },
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      const tx: TransactionContext = { __brand: "TransactionContext" };
      return fn(tx);
    },
  };

  const auditRepository: AuditRepositoryPort = {
    async append(input: AuditEventInput): Promise<AuditEventRecord> {
      const rec: AuditEventRecord = {
        ...input,
        id: randomUUID(),
        occurredAt: nowIso,
      };
      auditLogs.push(rec);
      return rec;
    },
    async list(_filter: AuditListFilter) {
      return {
        items: auditLogs,
        page: 1,
        pageSize: 20,
        totalItems: auditLogs.length,
        totalPages: 1,
      };
    },
  };

  const uploadPolicyRepository: UploadPolicyRepositoryPort = {
    async getUploadLimits(organizationId: string) {
      return organizationId === orgId ? storedLimits : null;
    },
    async saveUploadLimits(
      organizationId: string,
      input: UploadLimitsConfig & { readonly updatedAt: Date },
    ) {
      if (organizationId !== orgId) {
        return null;
      }
      storedLimits = {
        organizationId,
        maxFileSizeBytes: input.maxFileSizeBytes,
        allowedExtensions: [...input.allowedExtensions],
        enforceDeclaredExtensionMatch: input.enforceDeclaredExtensionMatch,
        updatedAt: input.updatedAt.toISOString(),
      };
      return storedLimits;
    },
  };

  const systemMaxUploadBytes = 10 * 1024 * 1024;
  const proxyMaxBodyBytes = 12 * 1024 * 1024;

  const uploadLimitsService = createUploadLimitsService({
    repository: uploadPolicyRepository,
    transactions,
    audit: auditRepository,
    systemMaxUploadBytes,
    proxyMaxBodyBytes,
    now: () => now,
  });

  const connectionRepo: StorageConnectionRepositoryPort = {
    async findById(id) {
      return connections.get(id) ?? null;
    },
    async findDefaultByOrganization(organizationId) {
      return organizationId === orgId ? (connections.get(localConnId) ?? null) : null;
    },
    async findByName() {
      return null;
    },
    async listByOrganization(organizationId) {
      return organizationId === orgId ? Array.from(connections.values()) : [];
    },
    async hasLinkedFileObjects() {
      return false;
    },
    async create() {
      throw new Error("Unused");
    },
    async update() {
      return null;
    },
    async setDefault() {
      throw new Error("Unused");
    },
    async updateHealth() {
      return null;
    },
  };

  const routingRules: StorageRoutingRuleRepositoryPort = {
    async findByOrganizationAndCategory() {
      return null;
    },
    async findDefaultRuleByOrganization() {
      return null;
    },
    async listByOrganization() {
      return [];
    },
    async upsertRule() {
      throw new Error("Unused");
    },
    async deleteByOrganizationAndCategory() {},
  };

  const storageRouter = createStorageRouterService({
    connections: connectionRepo,
    routingRules,
  });

  const uploadRepository: UploadSessionRepositoryPort = {
    async findById(sessionId) {
      return uploadSessions.get(sessionId) ?? null;
    },
    async findByIdempotencyKey(organizationId, userId, idempotencyKey) {
      for (const s of uploadSessions.values()) {
        if (
          s.organizationId === organizationId &&
          s.userId === userId &&
          s.idempotencyKey === idempotencyKey
        ) {
          return s;
        }
      }
      return null;
    },
    async findFileObjectById(fileObjectId) {
      return fileObjects.get(fileObjectId) ?? null;
    },
    async createSessionWithFileObject(input) {
      const fileObject: FileObjectEntity = {
        id: input.fileObjectId,
        storageConnectionId: input.storageConnectionId,
        objectKey: input.objectKey,
        originalFileName: input.originalFileName,
        detectedContentType: input.declaredContentType,
        sizeBytes: input.declaredSizeBytes,
        checksumSha256: input.checksumSha256,
        status: "UPLOADING",
        createdAt: nowIso,
      };
      const session: UploadSessionEntity = {
        id: input.sessionId,
        organizationId: input.organizationId,
        userId: input.userId,
        storageConnectionId: input.storageConnectionId,
        fileObjectId: input.fileObjectId,
        declaredSizeBytes: input.declaredSizeBytes,
        declaredContentType: input.declaredContentType,
        idempotencyKey: input.idempotencyKey,
        status: "PENDING",
        expiresAt: input.expiresAt.toISOString(),
        finalizedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      fileObjects.set(fileObject.id, fileObject);
      uploadSessions.set(session.id, session);
      return { session, fileObject };
    },
    async markUploadReceived(input: MarkUploadReceivedInput) {
      const session = uploadSessions.get(input.sessionId);
      const fo = fileObjects.get(input.fileObjectId);
      if (!session || !fo || session.status !== "PENDING") {
        return null;
      }
      const nextSession: UploadSessionEntity = {
        ...session,
        status: "UPLOADED",
        updatedAt: nowIso,
      };
      const nextFo: FileObjectEntity = {
        ...fo,
        sizeBytes: input.bytesReceived,
        checksumSha256: input.checksumSha256,
        status: "QUARANTINED",
      };
      uploadSessions.set(nextSession.id, nextSession);
      fileObjects.set(nextFo.id, nextFo);
      return { session: nextSession, fileObject: nextFo };
    },
    async finalizeToQuarantine(input: FinalizeUploadToQuarantineInput) {
      const session = uploadSessions.get(input.sessionId);
      const fo = fileObjects.get(input.fileObjectId);
      if (!session || !fo) {
        return null;
      }
      const nextSession: UploadSessionEntity = {
        ...session,
        status: "FINALIZED",
        finalizedAt: input.finalizedAt.toISOString(),
      };
      const nextFo: FileObjectEntity = {
        ...fo,
        status: "QUARANTINED",
        sizeBytes: input.verifiedSizeBytes,
        checksumSha256: input.verifiedChecksumSha256,
      };
      uploadSessions.set(nextSession.id, nextSession);
      fileObjects.set(nextFo.id, nextFo);
      return { session: nextSession, fileObject: nextFo };
    },
    async markFileObjectProcessed(input: MarkFileObjectProcessedInput) {
      const fo = fileObjects.get(input.fileObjectId);
      if (!fo) {
        return null;
      }
      const nextFo: FileObjectEntity = {
        ...fo,
        status: input.status,
        detectedContentType: input.detectedContentType ?? fo.detectedContentType,
      };
      fileObjects.set(nextFo.id, nextFo);
      return nextFo;
    },
    async expirePendingSessions() {
      return [];
    },
  };

  const documentRepo: DocumentRepositoryPort = {
    async findById(): Promise<DocumentEntity | null> {
      return null;
    },
    async create() {
      throw new Error("Unused");
    },
    async updateMetadata() {
      return null;
    },
    async move() {
      return null;
    },
    async updateStatus() {
      return null;
    },
    async trash() {
      return null;
    },
    async restore() {
      return null;
    },
    async setCurrentVersion() {
      return null;
    },
    async listAuthorized() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const documentVersionRepo: DocumentVersionRepositoryPort = {
    async findById(id) {
      return versions.get(id) ?? null;
    },
    async findLatestByDocumentId() {
      return null;
    },
    async listByDocumentId() {
      return [];
    },
    async create(input: CreateDocumentVersionInput) {
      const v: DocumentVersionEntity = {
        ...input,
        createdAt: nowIso,
      };
      versions.set(v.id, v);
      return v;
    },
  };

  const outboxRepo: OutboxRepository = {
    async enqueue(input) {
      const job: OutboxJobRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: input.payload,
        status: "PENDING",
        attempts: 0,
        availableAt: now,
        publishedAt: null,
        lastError: null,
        createdAt: now,
      };
      outboxJobs.set(job.id, job);
      return job;
    },
    async claimNextPendingJob() {
      return null;
    },
    async markPublished(jobId) {
      const job = outboxJobs.get(jobId);
      if (job) {
        outboxJobs.set(jobId, { ...job, status: "PUBLISHED", publishedAt: now });
      }
    },
    async scheduleRetryOrFail(input) {
      const job = outboxJobs.get(input.jobId);
      if (!job) {
        return null;
      }
      const next: OutboxJobRecord = {
        ...job,
        attempts: input.attempts + 1,
        status: input.attempts + 1 >= input.maxAttempts ? "FAILED" : "PENDING",
        lastError: input.safeErrorSummary,
      };
      outboxJobs.set(next.id, next);
      return next;
    },
  };

  const registry = createStorageProviderRegistry();
  registry.registerFactory("local", ({ connection }) =>
    createLocalStorageProvider({
      rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
    }),
  );

  const authzRepository: AuthorizationRepository = {
    async loadSubject(_organizationId, userId) {
      const subj = subjectsByUserId.get(userId);
      if (!subj) {
        throw new Error(`Missing subject ${userId}`);
      }
      return subj;
    },
    async loadFolderAncestorIds() {
      return [];
    },
    async expandFolderSubtreeIds() {
      return [];
    },
    async listAuthorizedDocuments() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const passwordService = createPasswordService({
    memoryCost: 8_192,
    timeCost: 2,
    parallelism: 1,
    minPasswordLength: 10,
  });

  const sessionService = createSessionService({
    store: {
      async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
        const rec: StoredSessionRecord = { ...input, revokedAt: null, createdAt: now };
        sessionStoreMap.set(rec.id, rec);
        return rec;
      },
      async findByTokenHash(tokenHash: string) {
        for (const s of sessionStoreMap.values()) {
          if (s.tokenHash === tokenHash) {
            return s;
          }
        }
        return null;
      },
      async revokeById() {},
      async revokeAllForUser() {},
    } satisfies SessionStorePort,
    now: () => now,
  });

  const authService = createAuthService({
    passwordService,
    sessionService,
    users: {
      async findCredentialByEmail(normalizedEmail) {
        return usersByEmail.get(normalizedEmail) ?? null;
      },
      async findProfileById(userId) {
        const cred = Array.from(usersByEmail.values()).find((item) => item.user.id === userId);
        if (!cred) {
          return null;
        }
        const isAdmin = userId === adminId;
        return {
          user: cred.user,
          groups: [],
          roles: [
            {
              id: isAdmin ? adminRoleId : viewerRoleId,
              key: isAdmin ? "admin" : "viewer",
              name: isAdmin ? "Administrador" : "Consulta",
              description: null,
              isSystem: true,
            },
          ],
          permissions: [],
        };
      },
    },
    now: () => now,
  });

  const uploadSessionService = createUploadSessionService({
    uploads: uploadRepository,
    documents: documentRepo,
    storageRouter,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
    maxUploadBytes: systemMaxUploadBytes,
    resolveUploadPolicy: (targetOrgId) => uploadLimitsService.getEffectivePolicy(targetOrgId),
    now: () => now,
  });

  const scanner: AntivirusScannerPort = {
    async checkHealth() {
      return { available: true, message: "OK", checkedAt: now };
    },
    async scanStream() {
      return {
        status: "CLEAN",
        approved: true,
        disposition: "APPROVE",
        diagnosticCode: "CLEAN",
        safeMessage: "Arquivo limpo",
        signatureName: null,
        scannedBytes: 0,
      };
    },
  };

  const workerHandler = createProcessUploadJobHandler({
    outbox: outboxRepo,
    uploads: uploadRepository,
    connections: connectionRepo,
    documents: documentRepo,
    documentVersions: documentVersionRepo,
    audit: auditRepository,
    transactions,
    storageRegistry: registry,
    scanner,
    maxUploadBytes: systemMaxUploadBytes,
    resolveUploadPolicy: async (targetOrgId) => {
      const effective = await uploadLimitsService.getEffectivePolicy(targetOrgId);
      return {
        maxFileSizeBytes: effective.maxFileSizeBytes,
        allowedExtensions: effective.allowedExtensions,
        allowedMimeTypes: effective.allowedMimeTypes,
        requireDeclaredTypeMatch: effective.enforceDeclaredExtensionMatch,
      };
    },
    now: () => now,
  });

  const app = buildApp({
    logger: false,
    secureCookies: false,
    authService,
    security: {
      allowedOrigins: ["http://localhost:5173"],
      enforceCsrf: true,
    },
    uploadLimitsDeps: {
      authzRepository,
      uploadLimitsService,
    },
    uploadDeps: {
      authzRepository,
      documentRepository: documentRepo,
      uploadRepository,
      uploadSessionService,
      storageUploadDeps: {
        connections: connectionRepo,
        storageRegistry: registry,
        transactions,
        auditRepository,
        maxUploadBytes: systemMaxUploadBytes,
        proxyMaxBodyBytes,
        resolveUploadPolicy: (targetOrgId) => uploadLimitsService.getEffectivePolicy(targetOrgId),
        tempBaseDirectory: tempRoot,
        now: () => now,
      },
    },
  });

  const seedAndLoginAll = async () => {
    const password = "SenhaForte!Upload2026";
    const passwordHash = await passwordService.hashPassword(password);

    usersByEmail.set("admin@papyrus.local", {
      user: {
        id: adminId,
        organizationId: orgId,
        email: "admin@papyrus.local",
        fullName: "Admin Storage",
        status: "ACTIVE",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      passwordHash,
    });
    usersByEmail.set("viewer@papyrus.local", {
      user: {
        id: viewerId,
        organizationId: orgId,
        email: "viewer@papyrus.local",
        fullName: "Leitor",
        status: "ACTIVE",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      passwordHash,
    });

    subjectsByUserId.set(adminId, {
      userId: adminId,
      organizationId: orgId,
      groupIds: [],
      assignments: [
        {
          roleId: adminRoleId,
          roleKey: "admin",
          scope: { type: "GLOBAL" },
          effect: "ALLOW",
          source: "USER",
        },
      ],
      rolePermissions: SYSTEM_ROLE_DEFINITIONS.admin.permissions.map((p) => ({
        roleId: adminRoleId,
        roleKey: "admin",
        action: p.action,
        resource: p.resource,
      })),
    });

    subjectsByUserId.set(viewerId, {
      userId: viewerId,
      organizationId: orgId,
      groupIds: [],
      assignments: [
        {
          roleId: viewerRoleId,
          roleKey: "viewer",
          scope: { type: "GLOBAL" },
          effect: "ALLOW",
          source: "USER",
        },
      ],
      rolePermissions: SYSTEM_ROLE_DEFINITIONS.viewer.permissions.map((p) => ({
        roleId: viewerRoleId,
        roleKey: "viewer",
        action: p.action,
        resource: p.resource,
      })),
    });

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    expect(csrfRes.statusCode).toBe(200);
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const doLogin = async (email: string) => {
      const loginRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: {
          origin: "http://localhost:5173",
          [CSRF_HEADER_NAME]: csrfToken,
        },
        payload: { email, password },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie = loginRes.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";
      return {
        cookieHeader: `${CSRF_COOKIE_NAME}=${csrfToken}; papyrus_session=${sessionCookie}`,
        csrfToken,
      };
    };

    return {
      adminAuth: await doLogin("admin@papyrus.local"),
      viewerAuth: await doLogin("viewer@papyrus.local"),
    };
  };

  return {
    app,
    orgId,
    fileObjects,
    auditLogs,
    workerHandler,
    seedAndLoginAll,
    uploadLimitsService,
    proxyMaxBodyBytes,
    systemMaxUploadBytes,
  };
}

describe("Upload size and allowed extensions configuration across proxy, API, and worker (Step 14.06)", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("enforces admin permissions, proxy ceiling, and consistent API + worker validation after updating upload limits", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "papyrus-upload-limits-"));
    const localRoot = path.join(baseDir, "storage");
    const tempRoot = path.join(baseDir, "tmp");
    await mkdir(localRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    dirs.push(baseDir);

    const h = createUploadLimitsHarness(localRoot, tempRoot);
    const { adminAuth, viewerAuth } = await h.seedAndLoginAll();

    // 1. Read default limits as viewer -> allowed with canEdit=false
    const readRes = await h.app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/uploads/limits`,
      headers: { cookie: viewerAuth.cookieHeader },
    });
    expect(readRes.statusCode).toBe(200);
    const initialBody = readRes.json().data;
    expect(initialBody.canEdit).toBe(false);
    expect(initialBody.effective.maxFileSizeBytes).toBe(h.systemMaxUploadBytes);
    expect(initialBody.effective.allowedExtensions).toContain(".pdf");
    expect(initialBody.effective.allowedExtensions).toContain(".png");

    // 2. Non-admin cannot mutate upload limits
    const forbiddenRes = await h.app.inject({
      method: "PATCH",
      url: `${CONTRACTS_API_PREFIX}/admin/upload-limits`,
      headers: {
        origin: "http://localhost:5173",
        cookie: viewerAuth.cookieHeader,
        [CSRF_HEADER_NAME]: viewerAuth.csrfToken,
      },
      payload: { maxFileSizeBytes: 2048 },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // 3. Reject dangerous extensions and limits exceeding proxy/API ceiling
    const dangerousRes = await h.app.inject({
      method: "PATCH",
      url: `${CONTRACTS_API_PREFIX}/admin/upload-limits`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: { allowedExtensions: [".pdf", ".exe"] },
    });
    expect(dangerousRes.statusCode).toBe(400);

    const overProxyRes = await h.app.inject({
      method: "PATCH",
      url: `${CONTRACTS_API_PREFIX}/admin/upload-limits`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: { maxFileSizeBytes: h.proxyMaxBodyBytes + 1024 },
    });
    expect(overProxyRes.statusCode).toBe(400);

    // 4. Admin tightens limits: max 2048 bytes, ONLY .pdf allowed
    const updateRes = await h.app.inject({
      method: "PATCH",
      url: `${CONTRACTS_API_PREFIX}/admin/upload-limits`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: {
        maxFileSizeBytes: 2048,
        allowedExtensions: [".pdf"],
        enforceDeclaredExtensionMatch: true,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updatedBody = updateRes.json().data;
    expect(updatedBody.configured.maxFileSizeBytes).toBe(2048);
    expect(updatedBody.configured.allowedExtensions).toEqual([".pdf"]);
    expect(updatedBody.effective.allowedMimeTypes).toEqual(["application/pdf"]);
    expect(h.auditLogs.some((e) => e.action === "UPLOAD_LIMITS_UPDATED")).toBe(true);

    // 5. API session creation rejects disallowed extension (.png) and oversized file (>2048)
    const pngSessionRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: {
        originalFileName: "foto.png",
        declaredSizeBytes: 512,
        declaredContentType: "image/png",
        idempotencyKey: "ext-denied-1",
      },
    });
    expect(pngSessionRes.statusCode).toBe(400);

    const largeSessionRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: {
        originalFileName: "contrato.pdf",
        declaredSizeBytes: 4096,
        declaredContentType: "application/pdf",
        idempotencyKey: "size-denied-1",
      },
    });
    expect(largeSessionRes.statusCode).toBe(413);

    // 6. Valid PDF <= 2048 succeeds on session creation and streaming upload
    const pdfBuffer = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"),
      Buffer.alloc(1200, " "),
      Buffer.from("\ntrailer\n<<>>\n%%EOF\n"),
    ]);
    const pdfSessionRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: {
        originalFileName: "contrato.pdf",
        declaredSizeBytes: pdfBuffer.length,
        declaredContentType: "application/pdf",
        declaredChecksumSha256: sha256Hex(pdfBuffer),
        idempotencyKey: "pdf-ok-1",
      },
    });
    expect(pdfSessionRes.statusCode).toBe(201);
    const createdSession = pdfSessionRes.json().data;

    // 7. Proxy body ceiling exceeded check returns 413 cleanly when streaming > proxyMaxBodyBytes
    const tooBigBuffer = Buffer.alloc(h.proxyMaxBodyBytes + 100);
    const oversizedUploadRes = await h.app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${createdSession.id}/content`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
        "content-type": "application/pdf",
      },
      payload: tooBigBuffer,
    });
    expect(oversizedUploadRes.statusCode).toBe(413);

    // Stream actual valid PDF into storage
    const streamRes = await h.app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${createdSession.id}/content`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
        "content-type": "application/pdf",
      },
      payload: pdfBuffer,
    });
    expect(streamRes.statusCode).toBe(200);

    // 8. Worker enforces the exact same dynamic limits:
    // Tightening maxFileSizeBytes to 1024 (< pdfBuffer.length) causes worker to reject the quarantined object!
    await h.uploadLimitsService.updateLimits({
      organizationId: h.orgId,
      actorUserId: createdSession.userId,
      requestId: randomUUID(),
      maxFileSizeBytes: 1024,
      allowedExtensions: [".pdf"],
    });

    const job: OutboxJobRecord = {
      id: randomUUID(),
      organizationId: h.orgId,
      eventType: "UPLOAD_PROCESSING_REQUESTED",
      aggregateType: "FILE_OBJECT",
      aggregateId: createdSession.fileObjectId,
      payload: {
        uploadSessionId: createdSession.id,
        fileObjectId: createdSession.fileObjectId,
        storageConnectionId: createdSession.storageConnectionId,
        documentId: null,
        documentVersionId: null,
      },
      status: "PENDING",
      attempts: 0,
      availableAt: new Date(),
      publishedAt: null,
      lastError: null,
      createdAt: new Date(),
    };

    const workerOutcome = await h.workerHandler.processClaimedJob(job);
    expect(workerOutcome.outcome).toBe("REJECTED");
    expect(h.fileObjects.get(createdSession.fileObjectId)?.status).toBe("REJECTED");

    await h.app.close();
  });
});
