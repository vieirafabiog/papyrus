import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import type { AuthorizationRepository, LoadedAuthorizationSubject } from "@docuflow/database";
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
  type TransactionContext,
  type TransactionManagerPort,
  type UploadSessionEntity,
  type UploadSessionRepositoryPort,
  createFinalizeUploadService,
  createStorageRouterService,
  createUploadSessionService,
  isFileObjectDownloadable,
} from "@docuflow/domain";
import { createClamAvScanner, inspectFileContent } from "@docuflow/file-processing";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  type AuthCredentialRecord,
  createAuthService,
} from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildMultipartPayload(
  boundary: string,
  filename: string,
  contentType: string,
  content: Buffer,
): Buffer {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([header, content, footer]);
}

function createInMemoryUploadHarness(localRoot: string, tempRoot: string, maxUploadBytes = 4096) {
  let clockMs = Date.parse("2026-11-21T12:00:00.000Z");

  const orgId = randomUUID();
  const uploaderId = randomUUID();
  const attackerId = randomUUID();
  const roleId = randomUUID();
  const categoryId = randomUUID();
  const localConnId = randomUUID();

  const sessionStoreMap = new Map<string, StoredSessionRecord>();
  const uploadSessions = new Map<string, UploadSessionEntity>();
  const fileObjects = new Map<string, FileObjectEntity>();
  const documents = new Map<string, DocumentEntity>();
  const versions = new Map<string, DocumentVersionEntity>();
  const connections = new Map<string, StorageConnectionEntity>();
  const auditLogs: AuditEventRecord[] = [];
  const queuedJobs: { uploadSessionId: string; fileObjectId: string }[] = [];

  connections.set(localConnId, {
    id: localConnId,
    organizationId: orgId,
    name: "Local Security Store",
    kind: "local",
    isDefault: true,
    status: "ACTIVE",
    nonSecretConfig: { rootDirectory: localRoot },
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: new Date(clockMs).toISOString(),
    updatedAt: new Date(clockMs).toISOString(),
  });

  const usersByEmail = new Map<string, AuthCredentialRecord>();
  const usersById = new Map<string, LoadedAuthorizationSubject>();

  const sessionStore: SessionStorePort = {
    async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
      const rec: StoredSessionRecord = {
        ...input,
        revokedAt: null,
        createdAt: new Date(clockMs),
      };
      sessionStoreMap.set(rec.id, rec);
      return rec;
    },
    async findByTokenHash(tokenHash) {
      for (const s of sessionStoreMap.values()) {
        if (s.tokenHash === tokenHash) return s;
      }
      return null;
    },
    async revokeById(id, revokedAt) {
      const existing = sessionStoreMap.get(id);
      if (existing) sessionStoreMap.set(id, { ...existing, revokedAt });
    },
    async revokeAllForUser(userId, revokedAt) {
      for (const [id, s] of sessionStoreMap.entries()) {
        if (s.userId === userId) sessionStoreMap.set(id, { ...s, revokedAt });
      }
    },
  };

  const sessionService = createSessionService({
    store: sessionStore,
    now: () => new Date(clockMs),
  });
  const passwordService = createPasswordService({
    memoryCost: 8_192,
    timeCost: 2,
    parallelism: 1,
    minPasswordLength: 10,
  });

  const authService = createAuthService({
    passwordService,
    sessionService,
    users: {
      async findCredentialByEmail(email) {
        return usersByEmail.get(email) ?? null;
      },
      async findProfileById(id) {
        const emailRec = Array.from(usersByEmail.values()).find((u) => u.user.id === id);
        if (!emailRec) return null;
        return {
          user: emailRec.user,
          groups: [],
          roles: [
            {
              id: roleId,
              key: "collaborator",
              name: "Colaborador",
              description: null,
              isSystem: true,
            },
          ],
          permissions: [],
        };
      },
    },
    now: () => new Date(clockMs),
  });

  const authzRepository: AuthorizationRepository = {
    async loadSubject(_orgId, userId) {
      const found = usersById.get(userId);
      if (!found) {
        return {
          userId,
          organizationId: orgId,
          assignments: [],
          rolePermissions: [],
        };
      }
      return found;
    },
    async loadFolderAncestorIds() {
      return [];
    },
    async loadExistingDocumentQueryScope() {
      return {
        hasGlobalDeny: false,
        hasGlobalAllow: true,
        allowedCategoryIds: [],
        allowedFolderIds: [],
        allowedDocumentIds: [],
        deniedCategoryIds: [],
        deniedFolderIds: [],
        deniedDocumentIds: [],
      };
    },
  };

  const uploadRepository: UploadSessionRepositoryPort = {
    async findById(id) {
      return uploadSessions.get(id) ?? null;
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
    async findFileObjectById(id) {
      return fileObjects.get(id) ?? null;
    },
    async createSessionWithFileObject(input) {
      const nowIso = new Date(clockMs).toISOString();
      const fo: FileObjectEntity = {
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
      const sess: UploadSessionEntity = {
        id: input.sessionId,
        organizationId: input.organizationId,
        userId: input.userId,
        storageConnectionId: input.storageConnectionId,
        fileObjectId: fo.id,
        declaredSizeBytes: input.declaredSizeBytes,
        declaredContentType: input.declaredContentType,
        idempotencyKey: input.idempotencyKey,
        status: "PENDING",
        expiresAt: input.expiresAt.toISOString(),
        finalizedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      fileObjects.set(fo.id, fo);
      uploadSessions.set(sess.id, sess);
      return { session: sess, fileObject: fo };
    },
    async markUploadReceived(input: MarkUploadReceivedInput) {
      const existing = uploadSessions.get(input.sessionId);
      const fo = fileObjects.get(input.fileObjectId);
      if (!existing || existing.status !== "PENDING" || !fo) return null;
      const nextSess: UploadSessionEntity = {
        ...existing,
        status: "UPLOADED",
        updatedAt: new Date(clockMs).toISOString(),
      };
      const nextFo: FileObjectEntity = {
        ...fo,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
      };
      uploadSessions.set(nextSess.id, nextSess);
      fileObjects.set(nextFo.id, nextFo);
      return { session: nextSess, fileObject: nextFo };
    },
    async finalizeToQuarantine(input: FinalizeUploadToQuarantineInput) {
      const existing = uploadSessions.get(input.sessionId);
      const fo = fileObjects.get(input.fileObjectId);
      if (!existing || (existing.status !== "PENDING" && existing.status !== "UPLOADED") || !fo) {
        return null;
      }
      const nowIso = input.finalizedAt.toISOString();
      const nextSess: UploadSessionEntity = {
        ...existing,
        status: "FINALIZED",
        finalizedAt: nowIso,
        updatedAt: nowIso,
      };
      const nextFo: FileObjectEntity = {
        ...fo,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        status: "QUARANTINED",
      };
      uploadSessions.set(nextSess.id, nextSess);
      fileObjects.set(nextFo.id, nextFo);
      return { session: nextSess, fileObject: nextFo };
    },
    async markFileObjectProcessed(input: MarkFileObjectProcessedInput) {
      const fo = fileObjects.get(input.fileObjectId);
      if (!fo || fo.status !== "QUARANTINED") return null;
      const nextFo: FileObjectEntity = {
        ...fo,
        status: input.status,
        detectedContentType: input.detectedContentType ?? fo.detectedContentType,
      };
      fileObjects.set(nextFo.id, nextFo);
      return nextFo;
    },
    async markSessionExpired(sessionId) {
      const existing = uploadSessions.get(sessionId);
      if (existing && existing.status === "PENDING") {
        uploadSessions.set(sessionId, {
          ...existing,
          status: "EXPIRED",
          updatedAt: new Date(clockMs).toISOString(),
        });
      }
    },
  };

  const documentRepository: DocumentRepositoryPort = {
    async findById(id) {
      return documents.get(id) ?? null;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
    async create(input) {
      const nowIso = new Date(clockMs).toISOString();
      const doc: DocumentEntity = {
        id: input.id,
        organizationId: input.organizationId,
        title: input.title,
        categoryId: input.categoryId,
        folderId: input.folderId,
        status: "DRAFT",
        currentVersionId: null,
        ownerUserId: input.ownerUserId,
        issueDate: input.issueDate,
        expirationDate: input.expirationDate,
        metadata: input.metadata,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      documents.set(doc.id, doc);
      return doc;
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

  const documentVersionRepository: DocumentVersionRepositoryPort = {
    async findById(id) {
      return versions.get(id) ?? null;
    },
    async findByFileObjectId(fileObjectId) {
      for (const v of versions.values()) {
        if (v.fileObjectId === fileObjectId) return v;
      }
      return null;
    },
    async findLatestByDocumentId() {
      return null;
    },
    async listByDocumentId(documentId) {
      return Array.from(versions.values()).filter((v) => v.documentId === documentId);
    },
    async create(input: CreateDocumentVersionInput) {
      const v: DocumentVersionEntity = {
        ...input,
        createdAt: new Date(clockMs).toISOString(),
      };
      versions.set(v.id, v);
      return v;
    },
  };

  const connectionRepo: StorageConnectionRepositoryPort = {
    async findById(id) {
      return connections.get(id) ?? null;
    },
    async findByName() {
      return null;
    },
    async listByOrganization() {
      return Array.from(connections.values());
    },
    async findDefaultByOrganization() {
      return connections.get(localConnId) ?? null;
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
    async hasLinkedFileObjects() {
      return false;
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
        occurredAt: new Date(clockMs).toISOString(),
      };
      auditLogs.push(rec);
      return rec;
    },
    async list(_filter: AuditListFilter) {
      return {
        items: auditLogs,
        page: 1,
        pageSize: 50,
        totalItems: auditLogs.length,
        totalPages: 1,
      };
    },
  };

  const storageRegistry = createStorageProviderRegistry();
  storageRegistry.registerFactory("local", ({ connection }) =>
    createLocalStorageProvider({
      rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
      maxObjectSizeBytes: maxUploadBytes,
    }),
  );

  const storageRouter = createStorageRouterService({
    connections: connectionRepo,
    routingRules,
  });

  const uploadSessionService = createUploadSessionService({
    uploads: uploadRepository,
    documents: documentRepository,
    storageRouter,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
    maxUploadBytes,
    now: () => new Date(clockMs),
  });

  const finalizeUploadService = createFinalizeUploadService({
    uploads: uploadRepository,
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
    transactions,
    audit: auditRepository,
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    processingQueue: {
      async enqueueProcessing(input) {
        queuedJobs.push({
          uploadSessionId: input.uploadSessionId,
          fileObjectId: input.fileObjectId,
        });
      },
    },
    generateId: () => randomUUID(),
    now: () => new Date(clockMs),
  });

  const app = buildApp({
    authService,
    uploadDeps: {
      authzRepository,
      documentRepository,
      uploadRepository,
      uploadSessionService,
      storageUploadDeps: {
        connections: connectionRepo,
        storageRegistry,
        transactions,
        auditRepository,
        maxUploadBytes,
        tempBaseDirectory: tempRoot,
        now: () => new Date(clockMs),
      },
    },
    security: {
      allowedOrigins: ["http://localhost:5173"],
      enforceCsrf: true,
    },
  });

  const seedUsers = async () => {
    const password = "AbuseSecurityPass2026!";
    const passwordHash = await passwordService.hashPassword(password);
    const nowIso = new Date(clockMs).toISOString();

    const makeAuthUser = (id: string, email: string, fullName: string): AuthCredentialRecord => ({
      user: {
        id,
        organizationId: orgId,
        email,
        fullName,
        status: "ACTIVE",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      passwordHash,
    });

    usersByEmail.set(
      "uploader@abuse.invalid",
      makeAuthUser(uploaderId, "uploader@abuse.invalid", "Uploader"),
    );
    usersByEmail.set(
      "attacker@abuse.invalid",
      makeAuthUser(attackerId, "attacker@abuse.invalid", "Attacker"),
    );

    const colabPermissions = SYSTEM_ROLE_DEFINITIONS.collaborator.permissions.map((perm) => ({
      roleId,
      action: perm.action,
      resource: perm.resource,
    }));

    for (const userId of [uploaderId, attackerId]) {
      usersById.set(userId, {
        userId,
        organizationId: orgId,
        assignments: [
          {
            roleId,
            roleKey: "collaborator",
            scope: { type: "GLOBAL" },
            effect: "ALLOW",
            source: "DIRECT",
          },
        ],
        rolePermissions: colabPermissions,
      });
    }

    const docId = randomUUID();
    await documentRepository.create({
      id: docId,
      organizationId: orgId,
      title: "Documento Base",
      categoryId,
      folderId: null,
      ownerUserId: uploaderId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
    });

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const login = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password },
      });
      const cookie = res.cookies.find((c) => c.name === "docuflow_session")?.value ?? "";
      return { cookie, csrfToken };
    };

    return {
      docId,
      uploader: await login("uploader@abuse.invalid"),
      attacker: await login("attacker@abuse.invalid"),
    };
  };

  return {
    app,
    orgId,
    uploaderId,
    categoryId,
    localConnId,
    uploadSessions,
    fileObjects,
    versions,
    queuedJobs,
    auditLogs,
    storageRegistry,
    connectionRepo,
    uploadSessionService,
    finalizeUploadService,
    advanceMs: (delta: number) => {
      clockMs += delta;
    },
    seedUsers,
  };
}

describe("Upload abuse & security tests", () => {
  const cleanupDirs: string[] = [];

  afterAll(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("blocks oversized payloads, empty files, malicious filenames/traversal, and truncated interrupted uploads without temp leftovers", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-abuse-store-"));
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-abuse-temp-"));
    cleanupDirs.push(localRoot, tempRoot);

    const h = createInMemoryUploadHarness(localRoot, tempRoot, 2048);
    const { uploader } = await h.seedUsers();

    // 1. Oversized declared size at session creation -> 413 UPLOAD_TOO_LARGE
    const oversizedCreateRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        categoryId: h.categoryId,
        originalFileName: "gigante.pdf",
        declaredSizeBytes: 8192,
        declaredContentType: "application/pdf",
        idempotencyKey: "abuse-oversize-session",
      },
    });
    expect(oversizedCreateRes.statusCode).toBe(413);

    // 2. Declared size within limit, but client streams oversized multipart body -> 413 UPLOAD_TOO_LARGE
    const normalSessRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        categoryId: h.categoryId,
        originalFileName: "normal.pdf",
        declaredSizeBytes: 512,
        declaredContentType: "application/pdf",
        idempotencyKey: "abuse-oversize-stream",
      },
    });
    expect(normalSessRes.statusCode).toBe(201);
    const normalSessId = (normalSessRes.json() as { data: { id: string } }).data.id;

    const oversizedMultipart = buildMultipartPayload(
      "----DocuFlowAbuseBoundary",
      "normal.pdf",
      "application/pdf",
      Buffer.alloc(1024, 0x41),
    );
    const oversizedStreamRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${normalSessId}/content`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: uploader.csrfToken,
        "content-type": "multipart/form-data; boundary=----DocuFlowAbuseBoundary",
      },
      payload: oversizedMultipart,
    });
    expect(oversizedStreamRes.statusCode).toBe(413);
    expect(await readdir(tempRoot)).toEqual([]);

    // 3. Empty file (0 bytes) blocked at session creation (400) and streaming (400)
    const emptySessionRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        categoryId: h.categoryId,
        originalFileName: "vazio.pdf",
        declaredSizeBytes: 0,
        declaredContentType: "application/pdf",
        idempotencyKey: "abuse-empty-0",
      },
    });
    expect(emptySessionRes.statusCode).toBe(400);

    const emptyMultipart = buildMultipartPayload(
      "----DocuFlowEmptyBoundary",
      "normal.pdf",
      "application/pdf",
      Buffer.alloc(0),
    );
    const emptyStreamRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${normalSessId}/content`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: uploader.csrfToken,
        "content-type": "multipart/form-data; boundary=----DocuFlowEmptyBoundary",
      },
      payload: emptyMultipart,
    });
    expect(emptyStreamRes.statusCode).toBe(400);

    // 4. Interrupted / truncated upload (fewer bytes than declaredSizeBytes) rejected cleanly without finalizing
    const truncatedRes = await h.app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${normalSessId}/content`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: uploader.csrfToken,
        "content-type": "application/pdf",
      },
      payload: Buffer.from("%PDF-1.7\ntruncated", "utf8"),
    });
    expect(truncatedRes.statusCode).toBe(400);
    expect(h.uploadSessions.get(normalSessId)?.status).toBe("PENDING");
    expect(await readdir(tempRoot)).toEqual([]);

    // Trying to finalize an interrupted/incomplete upload MUST fail with UPLOAD_OBJECT_MISSING
    await expect(
      h.finalizeUploadService.finalizeUpload({
        organizationId: h.orgId,
        actorUserId: h.uploaderId,
        requestId: randomUUID(),
        sessionId: normalSessId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_OBJECT_MISSING" });

    // 5. Malicious traversal filename never escapes opaque object key or writes outside localRoot
    const traversalSessRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        categoryId: h.categoryId,
        originalFileName: "../../../../etc/passwd\u0000.pdf",
        declaredSizeBytes: 64,
        declaredContentType: "application/pdf",
        idempotencyKey: "abuse-traversal-name",
      },
    });
    expect(traversalSessRes.statusCode).toBe(201);
    const traversalSessData = (
      traversalSessRes.json() as { data: { objectKey: string; fileObjectId: string } }
    ).data;
    expect(traversalSessData.objectKey).not.toContain("..");
    expect(traversalSessData.objectKey).not.toContain("passwd");
    expect(traversalSessData.objectKey.startsWith(`org/${h.orgId}/`)).toBe(true);

    // Malicious dot-only / traversal filename blocked by both domain session service & MIME inspector
    const invalidNameRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        categoryId: h.categoryId,
        originalFileName: "/etc/..",
        declaredSizeBytes: 64,
        declaredContentType: "application/pdf",
        idempotencyKey: "abuse-invalid-dotdot",
      },
    });
    expect(invalidNameRes.statusCode).toBe(400);

    await h.app.close();
  });

  it("blocks spoofed MIME/polyglots, prevents replay abuse or duplicate versions, and fails closed on session timeout or unavailable ClamAV", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-abuse-store2-"));
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-abuse-temp2-"));
    cleanupDirs.push(localRoot, tempRoot);

    const h = createInMemoryUploadHarness(localRoot, tempRoot, 10_240);
    const { docId, uploader } = await h.seedUsers();

    // 1. Spoofed MIME: PE executable and GIF+PDF polyglot disguised as PDF rejected safely without leaking internals
    const exeSpoof = Buffer.from("MZ\x90\x00\x03\x00FakeExecutablePayload", "latin1");
    const exeInspection = inspectFileContent(exeSpoof, {
      originalFileName: "contrato-spoof.pdf",
      declaredContentType: "application/pdf",
    });
    expect(exeInspection.accepted).toBe(false);
    if (!exeInspection.accepted) {
      expect(exeInspection.rejection.code).toBe("DANGEROUS_CONTENT");
      expect(exeInspection.rejection.safeMessage).not.toContain("MZ");
    }

    const gifPdfPolyglot = Buffer.concat([
      Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
      Buffer.alloc(32, 0),
      Buffer.from("%PDF-1.7\n", "utf8"),
    ]);
    const polyglotInspection = inspectFileContent(gifPdfPolyglot, {
      originalFileName: "imagem.gif",
      declaredContentType: "image/gif",
    });
    expect(polyglotInspection.accepted).toBe(false);
    if (!polyglotInspection.accepted) {
      expect(polyglotInspection.rejection.code).toBe("POLYGLOT_DETECTED");
    }

    // Double extension blocked even when bytes are benign text
    const doubleExt = inspectFileContent(Buffer.from("ok", "utf8"), {
      originalFileName: "planilha.pdf.exe",
      declaredContentType: "application/pdf",
    });
    expect(doubleExt.accepted).toBe(false);
    if (!doubleExt.accepted) {
      expect(doubleExt.rejection.code).toBe("DANGEROUS_EXTENSION");
    }

    // 2. Replay protection: same idempotencyKey + different payload returns 409 CONFLICT
    const validPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Title (Ok) >>\nendobj\n%%EOF\n", "utf8");
    const checksum = sha256Hex(validPdf);

    const createRes1 = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        documentId: docId,
        originalFileName: "contrato.pdf",
        declaredSizeBytes: validPdf.length,
        declaredContentType: "application/pdf",
        declaredChecksumSha256: checksum,
        idempotencyKey: "replay-check-key",
        expiresInSeconds: 120,
      },
    });
    expect(createRes1.statusCode).toBe(201);
    const sessionId = (createRes1.json() as { data: { id: string } }).data.id;

    const replayConflictingCreate = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        documentId: docId,
        originalFileName: "contrato.pdf",
        declaredSizeBytes: validPdf.length + 100,
        declaredContentType: "application/pdf",
        idempotencyKey: "replay-check-key",
      },
    });
    expect(replayConflictingCreate.statusCode).toBe(409);

    // Upload content once succeeds; second upload attempt blocked (409)
    const uploadOnce = await h.app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionId}/content`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: uploader.csrfToken,
        "content-type": "application/pdf",
      },
      payload: validPdf,
    });
    expect(uploadOnce.statusCode).toBe(200);

    const replayBinaryUpload = await h.app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionId}/content`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: uploader.csrfToken,
        "content-type": "application/pdf",
      },
      payload: validPdf,
    });
    expect(replayBinaryUpload.statusCode).toBe(409);

    // Repeated finalization stays idempotent without creating duplicate document versions
    const fin1 = await h.finalizeUploadService.finalizeUpload({
      organizationId: h.orgId,
      actorUserId: h.uploaderId,
      requestId: randomUUID(),
      sessionId,
      expectedChecksumSha256: checksum,
      documentId: docId,
    });
    const fin2 = await h.finalizeUploadService.finalizeUpload({
      organizationId: h.orgId,
      actorUserId: h.uploaderId,
      requestId: randomUUID(),
      sessionId,
      expectedChecksumSha256: checksum,
      documentId: docId,
    });
    expect(fin1.idempotentReplay).toBe(false);
    expect(fin2.idempotentReplay).toBe(true);
    expect(h.versions.size).toBe(1);
    expect(h.fileObjects.get(fin1.fileObject.id)?.status).toBe("QUARANTINED");
    expect(isFileObjectDownloadable("QUARANTINED")).toBe(false);

    // 3. Session timeout rejects expired session upload attempts (409)
    const expiringRes = await h.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: uploader.csrfToken },
      payload: {
        categoryId: h.categoryId,
        originalFileName: "expirado.pdf",
        declaredSizeBytes: validPdf.length,
        declaredContentType: "application/pdf",
        idempotencyKey: "abuse-expire-session",
        expiresInSeconds: 60,
      },
    });
    expect(expiringRes.statusCode).toBe(201);
    const expiringId = (expiringRes.json() as { data: { id: string } }).data.id;

    h.advanceMs(65_000);
    const expiredUploadAttempt = await h.app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${expiringId}/content`,
      cookies: { docuflow_session: uploader.cookie, [CSRF_COOKIE_NAME]: uploader.csrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: uploader.csrfToken,
        "content-type": "application/pdf",
      },
      payload: validPdf,
    });
    expect(expiredUploadAttempt.statusCode).toBe(409);

    // 4. Antivirus scanner unavailable OR timed out FAILS CLOSED (never approves unscanned files)
    const closedPort = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Invalid addr"));
          return;
        }
        const port = addr.port;
        s.close(() => resolve(port));
      });
    });

    const unavailableScanner = createClamAvScanner({
      transport: "tcp",
      host: "127.0.0.1",
      port: closedPort,
      timeoutMs: 1_000,
    });
    const unavailableResult = await unavailableScanner.scanStream({
      stream: Readable.from([validPdf]),
      declaredSizeBytes: validPdf.length,
    });
    expect(unavailableResult.status).toBe("UNAVAILABLE");
    expect(unavailableResult.approved).toBe(false);
    expect(unavailableResult.disposition).toBe("DEFER_RETRY");

    const stalledSockets: net.Socket[] = [];
    const stalledServer = net.createServer((sock) => {
      stalledSockets.push(sock);
    });
    const stalledPort = await new Promise<number>((resolve, reject) => {
      stalledServer.once("error", reject);
      stalledServer.listen(0, "127.0.0.1", () => {
        const addr = stalledServer.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Invalid addr"));
          return;
        }
        resolve(addr.port);
      });
    });

    try {
      const timeoutScanner = createClamAvScanner({
        transport: "tcp",
        host: "127.0.0.1",
        port: stalledPort,
        timeoutMs: 60,
      });
      const timeoutResult = await timeoutScanner.scanStream({
        stream: Readable.from([validPdf]),
        declaredSizeBytes: validPdf.length,
      });
      expect(timeoutResult.status).toBe("TIMEOUT");
      expect(timeoutResult.approved).toBe(false);
      expect(timeoutResult.disposition).toBe("DEFER_RETRY");
    } finally {
      for (const s of stalledSockets) {
        s.destroy();
      }
      await new Promise<void>((res) => {
        stalledServer.close(() => res());
      });
    }

    await h.app.close();
  });
});
